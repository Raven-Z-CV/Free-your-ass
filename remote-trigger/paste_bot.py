#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""paste_bot.py — trigger CodeBuddy remotely from whitelisted email (cross-platform)

Flow: poll IMAP → whitelist + subject-prefix filter → write the "trigger phrase"
      to the clipboard → simulate Ctrl/Cmd+V into the currently focused window
      (keep your cursor in the chat input) → simulate Enter.

Security design:
- Default paste_mode=trigger: only the fixed trigger phrase is pasted; the email
  body is pulled by the agent via check_inbox (server-side defenses — whitelist,
  dedupe, banner, audit — all preserved).
- Full-body paste mode (--paste-body) risks impersonating a "user message" —
  an injection risk, not recommended.
- Every action is written to the local audit log paste-log.jsonl; message-id
  dedupe prevents replay.

Platform paste dependencies:
- Linux X11:     xclip + xdotool    (apt install xclip xdotool)
- Linux Wayland: wl-copy + wtype    (keyboard injection is limited on Wayland; best effort)
- Windows:       PowerShell (built in, nothing to install)
- macOS:         osascript; grant the terminal accessibility permission
"""
import argparse
import base64
import email
import html
import imaplib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from email.header import decode_header, make_header
from email.utils import parseaddr
from pathlib import Path

HOST_MAP = {
    'qq.com': 'imap.qq.com',
    '163.com': 'imap.163.com',
    '126.com': 'imap.126.com',
    'gmail.com': 'imap.gmail.com',
    'outlook.com': 'outlook.office365.com',
    'hotmail.com': 'outlook.office365.com',
}

ADDR_RE = re.compile(r'[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}')

ONCE = False


# ---------- Pure logic ----------

def derive_host(addr):
    domain = addr.rsplit('@', 1)[1].lower()
    return HOST_MAP.get(domain, 'imap.' + domain)


def normalize_addr(raw):
    """Strict address normalization: rejects whitespace/CRLF/display names etc.;
    same strength as email-bridge/src/security.js."""
    if not isinstance(raw, str):
        return None
    if re.search(r'[<>,;\s\'"\\]', raw):
        return None
    if re.search(r'[\x00-\x1f\x7f]', raw):
        return None
    a = raw.strip().lower()
    return a if ADDR_RE.fullmatch(a) else None


def decode_subject(raw):
    try:
        return str(make_header(decode_header(raw or ''))).strip()
    except Exception:
        return ''


def subject_matches(subj, prefix):
    return bool(subj) and subj.upper().startswith(prefix.upper())


def extract_body(msg):
    """Return the (bytes, charset) of the text/plain part; (None, None) if absent."""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == 'text/plain' and not part.get_filename():
                return part.get_payload(decode=True), part.get_content_charset() or 'utf-8'
        return None, None
    return msg.get_payload(decode=True), msg.get_content_charset() or 'utf-8'


def body_to_text(raw, charset, max_bytes):
    if raw is None:
        return ''
    s = raw.decode(charset or 'utf-8', errors='replace')
    if '<html' in s.lower() or '<body' in s.lower():
        s = re.sub(r'<[^>]+>', ' ', s)
        s = html.unescape(s)
    s = s.replace('\r\n', '\n').replace('\r', '\n')
    b = s.encode('utf-8')
    if len(b) > max_bytes:
        s = b[:max_bytes].decode('utf-8', 'ignore') + '\n…[truncated]'
    return s.strip()


def build_trigger_text(cfg):
    return cfg['trigger_text']


# ---------- Platform paste layer ----------

def _ps(script, stdin_text=None):
    """Run PowerShell via EncodedCommand to sidestep quote-escaping issues."""
    enc = base64.b64encode(script.encode('utf-16-le')).decode()
    subprocess.run(
        ['powershell', '-NoProfile', '-EncodedCommand', enc],
        input=stdin_text.encode('utf-8') if stdin_text is not None else None,
        check=True, timeout=15,
    )


def _x11_available():
    return bool(os.environ.get('DISPLAY'))


def paste_and_enter(text, dry_run):
    if dry_run:
        print(f'[dry-run] Would write clipboard and paste+Enter: {text[:100]!r}')
        return
    plat = sys.platform
    # WSL: call the Windows-side PowerShell via interop to run the fixed helper
    # script paste-helper.ps1. Do NOT use -EncodedCommand/command-line Base64
    # (that shape gets flagged as malware by antivirus); the text goes into
    # _paste-text.txt (UTF-8 BOM) and the helper reads it, sets the clipboard,
    # then simulates paste + Enter.
    if plat == 'linux' and shutil.which('powershell.exe'):
        helper = Path(__file__).with_name('paste-helper.ps1')
        Path(helper.parent / '_paste-text.txt').write_text(text, encoding='utf-8-sig')
        unc = '\\\\wsl$\\' + os.environ.get('WSL_DISTRO_NAME', 'Ubuntu-22.04') + helper.as_posix().replace('/', '\\')
        subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                        '-File', unc], check=True, timeout=20, capture_output=True)
        return
    if plat == 'win32':
        _ps('[Console]::In.ReadToEnd() | Set-Clipboard', stdin_text=text)
        _ps('Add-Type -AssemblyName System.Windows.Forms;'
            '[System.Windows.Forms.SendKeys]::SendWait("^v");'
            'Start-Sleep -Milliseconds 200;'
            '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")')
    elif plat == 'darwin':
        env = dict(os.environ, PB_TEXT=text)
        script = (
            'set pb to (system attribute "PB_TEXT")\n'
            'set the clipboard to pb\n'
            'delay 0.2\n'
            'tell application "System Events" to keystroke "v" using command down\n'
            'delay 0.2\n'
            'tell application "System Events" to key code 36'
        )
        subprocess.run(['osascript', '-e', script], check=True, timeout=15, env=env)
    else:  # Linux / BSD
        if os.environ.get('WAYLAND_DISPLAY'):
            if subprocess.run(['which', 'wl-copy'], capture_output=True).returncode == 0:
                subprocess.run(['wl-copy', text], check=True, timeout=10)
            if subprocess.run(['which', 'wtype'], capture_output=True).returncode == 0:
                # wtype types the text directly (including Enter); no out-of-focus injection chain needed
                subprocess.run(['wtype', '-s', '50', text, '-k', 'Return'], check=True, timeout=15)
                return
            raise RuntimeError('Wayland requires wtype (keyboard injection); install wtype or switch to an X11 session')
        if not _x11_available():
            raise RuntimeError('No DISPLAY / WAYLAND_DISPLAY: run this script inside a graphical session')
        subprocess.run(['xclip', '-selection', 'clipboard'], input=text.encode('utf-8'),
                       check=True, timeout=10)
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+v'],
                       check=True, timeout=10)
        time.sleep(0.25)
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'Return'],
                       check=True, timeout=10)


# ---------- State & audit ----------

def load_json(path, default):
    try:
        return json.loads(Path(path).read_text('utf-8'))
    except Exception:
        return default


def save_json(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False), 'utf-8')


def audit(log_path, record):
    with open(log_path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(record, ensure_ascii=False) + '\n')


# ---------- Polling ----------

def poll_once(cfg, dry_run, dirpath):
    """After connecting, enter the long-connection polling loop (checks unseen mail every poll_seconds seconds)."""
    user = cfg['user']
    host = cfg.get('imap_host') or derive_host(user)
    while True:
        try:
            mail = imaplib.IMAP4_SSL(host, 993)
            mail.login(user, cfg['pass'])
            mail.select('INBOX')
            print(f'[{time.strftime("%H:%M:%S")}] IMAP connected: {host} (checking every {cfg.get("poll_seconds", 5)}s)')
            while True:
                poll_connected(mail, cfg, dry_run, dirpath)
                if ONCE:
                    return
                time.sleep(cfg.get('poll_seconds', 5))
                mail.noop()  # keepalive
        except KeyboardInterrupt:
            raise
        except Exception as e:
            print(f'[warn] Connection error, reconnecting in 5s: {e}', file=sys.stderr)
            time.sleep(5)


def poll_connected(mail, cfg, dry_run, dirpath):
    user = cfg['user']
    allowed = set(cfg['allowed_from'])
    prefix = cfg.get('subject_prefix', '[CMD]')
    state_path = dirpath / 'state.json'
    log_path = dirpath / 'paste-log.jsonl'
    state = load_json(state_path, {'processed': []})
    processed = set(state['processed'][-500:])

    if True:
        typ, data = mail.search(None, 'UNSEEN')
        if typ != 'OK':
            return
        ids = data[0].split()
        if not ids:
            return
        fired = 0
        for num in ids[: cfg.get('max_per_poll', 5)]:
            typ, msgdata = mail.fetch(num, '(RFC822)')
            if typ != 'OK' or not msgdata or not msgdata[0]:
                continue
            raw = msgdata[0][1]
            msg = email.message_from_bytes(raw)
            from_addr = normalize_addr(parseaddr(msg.get('From', ''))[1])
            subject = decode_subject(msg.get('Subject', ''))
            mid = (msg.get('Message-ID') or '').strip()
            # Filter chain: self-send / non-whitelisted / subject prefix / already processed
            if not from_addr:
                continue
            if from_addr == user.lower() and not cfg.get('allow_self'):
                continue  # self-send filtered by default; with allow_self=true the subject prefix decides
            if from_addr not in allowed:
                continue
            if not subject_matches(subject, prefix):
                continue
            if mid and mid in processed:
                mail.store(num, '+FLAGS', '\\Seen')
                continue

            if cfg.get('paste_mode') == 'body':
                raw_body, charset = extract_body(msg)
                text = body_to_text(raw_body, charset, cfg.get('max_body_bytes', 4096))
                mode = 'body'
            else:
                text = build_trigger_text(cfg)
                mode = 'trigger'
            paste_and_enter(text, dry_run)
            if mid:
                processed.add(mid)
                state['processed'] = list(processed)[-500:]
                save_json(state_path, state)
            mail.store(num, '+FLAGS', '\\Seen')
            audit(log_path, {
                'ts': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
                'from': from_addr, 'subject': subject[:80],
                'message_id': mid, 'mode': mode, 'fired': True,
            })
            print(f"[paste] {from_addr} {subject[:60]} mode={mode}")
            fired += 1
            if fired >= cfg.get('max_per_poll', 5):
                break


def main():
    ap = argparse.ArgumentParser(description='Whitelisted email → auto-paste trigger for CodeBuddy')
    ap.add_argument('--config', default=str(Path(__file__).with_name('config.json')))
    ap.add_argument('--dry-run', action='store_true', help='print actions only, do not really paste')
    ap.add_argument('--once', action='store_true', help='poll once then exit')
    ap.add_argument('--paste-body', action='store_true', help='paste the email body (not recommended; bypasses server defenses)')
    args = ap.parse_args()
    global ONCE
    ONCE = args.once

    cfg = load_json(args.config, None)
    if not cfg or not cfg.get('user') or not cfg.get('pass') or not cfg.get('allowed_from'):
        sys.exit(f'Config missing or invalid: {args.config} (see config.example.json)')
    for k in ('user', 'pass'):
        try:
            str(cfg[k]).encode('ascii')
        except UnicodeEncodeError:
            sys.exit(f'Config key {k} contains non-ASCII characters: enter the mailbox account and the provider auth code verbatim '
                     f'(the auth code is purely alphanumeric, not a "fill in…" placeholder)')
    cfg.setdefault('subject_prefix', '[CMD]')
    cfg.setdefault('poll_seconds', 20)
    cfg.setdefault('paste_mode', 'trigger')
    if args.paste_body:
        cfg['paste_mode'] = 'body'
    dirpath = Path(args.config).resolve().parent
    print(f"paste_bot starting: user={cfg['user']} host={cfg.get('imap_host') or derive_host(cfg['user'])} "
          f"prefix={cfg['subject_prefix']} mode={cfg['paste_mode']} poll={cfg['poll_seconds']}s")
    print('Keep the cursor focused inside the CodeBuddy chat input. Ctrl+C to exit.')
    try:
        poll_once(cfg, args.dry_run, dirpath)
    except KeyboardInterrupt:
        raise
    except Exception as e:
        print(f'[warn] Polling failed: {e}', file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nExited')
