// Inbound: IMAP fetch + wait.
// Design notes:
//  - UID cursor (including UIDVALIDITY handling) advances to the max UID; filtered
//    mail is also skipped by the cursor, avoiding rescans every round; message-id
//    dedupe acts as the second line of defense after a UIDVALIDITY reset;
//  - accepted mail is markProcessed'd before being returned (at-most-once: prefer
//    losing over duplicating);
//  - imapflow auto-IDLEs when idle and emits 'exists' → used for fast wakeup, with
//    a 5s polling fallback;
//  - on connect, imapflow sends the IMAP ID command automatically (required by QQ/163);
//  - a tool-level mutex serializes concurrent check_inbox calls.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import dns from 'node:dns';
import {
  normalizeAddress,
  inWhitelist,
  truncateUtf8,
  htmlToPlainText,
  sanitizeSubject,
  sanitizeFilename,
  checkAuthResults,
} from './security.js';
import { synthMessageId } from './state.js';
import { bodyHash } from './audit.js';
import { formatInbox, formatThreads } from './format.js';

export function createReceiver(cfg, state, audit) {
  let client = null;
  let connecting = null;
  let chain = Promise.resolve();

  const enqueue = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const onConnDown = () => {
    client = null; // connection error/closed: reconnect on next operation
  };

  async function ensureClient() {
    if (client) return client;
    // Resolve all IPs and try them one by one: some Tencent edge nodes have broken
    // TLS (same handling as smtp.js on 465); when DNS round-robin hits them randomly,
    // bad nodes are skipped automatically. Direct IP connections need an explicit
    // servername so SNI/certificate validation still works.
    let addrs = [{ address: cfg.imapHost }];
    try {
      const all = await dns.promises.lookup(cfg.imapHost, { all: true });
      if (all && all.length) { addrs = all.sort((a, b) => a.family - b.family); }
    } catch { /* resolution failed: fall back to connecting by hostname */ }

    let lastErr = null;
    for (const { address } of addrs) {
      const c = new ImapFlow({
        host: address,
        servername: cfg.imapHost,
        port: cfg.imapPort,
        secure: true,
        auth: { user: cfg.user, pass: cfg.pass },
        logger: false,
        clientInfo: { name: 'email-bridge', version: '0.1.0' },
        tls: { rejectUnauthorized: true, ...(cfg.tlsCa ? { ca: [cfg.tlsCa] } : {}) },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
      });
      c.on('error', onConnDown);
      c.on('close', onConnDown);
      try {
        connecting = (async () => c.connect())();
        client = c;
        await connecting;
        connecting = null;
        return client;
      } catch (e) {
        client = null;
        connecting = null;
        lastErr = e;
        try { c.close(); } catch { /* never connected: just close */ }
      }
    }
    throw new Error(
      `IMAP connection failed (${cfg.imapHost}:${cfg.imapPort}, tried ${addrs.length} IPs): ${lastErr?.message ?? 'unknown'}`
    );
  }

  /** Per-mail verdict and extraction. Returns the consumed filter count (0/1); on accept, pushes to accOut. */
  async function processMessage(msg, accOut) {
    let parsed;
    try {
      parsed = await simpleParser(msg.source);
    } catch (e) {
      audit.write({ action: 'parse-error', uid: msg.uid, error: String(e.message).slice(0, 120) });
      return 1;
    }

    const fromAddrs = (parsed.from?.value ?? [])
      .map((v) => normalizeAddress(v.address))
      .filter(Boolean);
    const fromAddr = fromAddrs[0] ?? null;
    const rawSubject = String(parsed.subject ?? '(no subject)');
    const subject = sanitizeSubject(rawSubject, 200);
    const messageId = String(parsed.messageId ?? '').trim() || synthMessageId(msg.source);

    const meta = {
      from: fromAddr ?? '(unknown)',
      internalDate: msg.internalDate instanceof Date ? msg.internalDate.toISOString() : String(msg.internalDate),
      subject,
      messageId,
    };

    // ---- Filter chain (fixed order; everything advances the cursor) ----
    // 1. Self-send: single-instance infinite-loop protection.
    //    Exception (user instruction channel): self-mail passes when the subject
    //    starts with [CMD] and DMARC=pass.
    //    send_email never uses [CMD] subjects (see Rule); external forgery of
    //    From: this account always fails DMARC.
    const isSelfCmd =
      fromAddrs.includes(cfg.user) &&
      rawSubject.startsWith('[CMD]') &&
      checkAuthResults(parsed.headers?.get('authentication-results') ?? null) === true;
    if (fromAddrs.includes(cfg.user) && !isSelfCmd) {
      audit.write({ action: 'skip-self', ...meta });
      return 1;
    }
    // 2. Dual-instance protocol prefix
    if (cfg.subjectPrefix && !rawSubject.startsWith(cfg.subjectPrefix)) {
      audit.write({ action: 'skip-prefix', ...meta });
      return 1;
    }
    // 3. Sender whitelist: compares the parsed real address only, exact equality
    if (!inWhitelist(fromAddr, cfg.allowedFrom)) {
      audit.write({ action: 'reject', ...meta });
      return 1;
    }
    // 4. Dedupe (prevents double injection after a UIDVALIDITY reset)
    if (state.isProcessed(messageId)) {
      audit.write({ action: 'skip-dup', ...meta });
      return 1;
    }

    // ---- Accept: extract body ----
    let text = parsed.text;
    if (!text && parsed.html) text = htmlToPlainText(parsed.html);
    if (!text) text = '(no text body)';
    text = truncateUtf8(text, cfg.maxBytes);

    const ar = parsed.headers?.get('authentication-results') ?? null;
    const attachments = (parsed.attachments ?? [])
      .slice(0, 5)
      .map((a) => sanitizeFilename(a.filename));

    // at-most-once: record state before returning content
    state.markProcessed(messageId);
    audit.write({
      action: 'recv',
      from: fromAddr,
      subject: subject.slice(0, 40),
      messageId,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha: bodyHash(text),
    });

    accOut.push({
      ...meta,
      text,
      attachments,
      authVerified: checkAuthResults(ar),
    });
    return 0;
  }

  async function fetchNew(c, markSeen, accOut) {
    const lock = await c.getMailboxLock('INBOX');
    try {
      const mb = c.mailbox;
      if (!mb) return { rejected: 0 };

      const { reset } = state.checkUidValidity(mb.uidValidity);
      if (reset) {
        audit.write({ action: 'warn', detail: 'UIDVALIDITY changed; UID cursor reset; message-id dedupe guards against double injection' });
      }

      let maxUid = state.lastUid;
      let rejected = 0;
      const uids = [];

      // IMAP syntax: N:* always includes the highest-UID message, so we must
      // re-filter by uid > lastUid
      const range = `${maxUid + 1}:*`;
      for await (const msg of c.fetch(range, { uid: true, source: true, internalDate: true }, { uid: true })) {
        if (msg.uid <= state.lastUid) continue;
        uids.push(msg.uid);
        if (msg.uid > maxUid) maxUid = msg.uid;
        rejected += await processMessage(msg, accOut);
      }

      if (markSeen && uids.length) {
        try {
          await c.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
        } catch (e) {
          audit.write({ action: 'warn', detail: `failed to mark seen: ${String(e.message).slice(0, 120)}` });
        }
      }
      state.setLastUid(maxUid);
      return { rejected };
    } finally {
      lock.release();
    }
  }

  /** Wait for new mail: imapflow auto-IDLE emits 'exists' for fast wakeup; a 5s timer polls as a fallback. */
  function waitSignal(c, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        c.off('exists', onExists);
        resolve();
      };
      const onExists = () => finish();
      const timer = setTimeout(finish, Math.min(remaining, 5000));
      c.once('exists', onExists);
    });
  }

  async function checkInboxImpl({ waitSeconds = 0, markSeen = true }) {
    const c = await ensureClient();
    const deadline = Date.now() + waitSeconds * 1000;
    const accepted = [];
    let rejected = 0;
    for (;;) {
      const r = await fetchNew(c, markSeen, accepted);
      rejected += r.rejected;
      if (accepted.length >= cfg.maxMessages || Date.now() >= deadline) break;
      await waitSignal(c, deadline);
    }
    audit.write({ action: 'check', accepted: accepted.length, rejected });
    return { text: formatInbox({ accepted, rejected }), count: accepted.length };
  }

  async function listThreadsImpl({ limit = cfg.listLimit } = {}) {
    const c = await ensureClient();
    const lock = await c.getMailboxLock('INBOX');
    try {
      const total = c.mailbox?.exists ?? 0;
      if (!total) return { text: formatThreads([], limit), count: 0 };
      const start = Math.max(1, total - 49); // filter within the most recent 50
      const items = [];
      for await (const msg of c.fetch(`${start}:*`, { uid: true, envelope: true, internalDate: true })) {
        const fromAddr = msg.envelope?.from?.[0]?.address
          ? normalizeAddress(String(msg.envelope.from[0].address))
          : null;
        const rawSubject = String(msg.envelope?.subject ?? '(no subject)');
        if (fromAddr === cfg.user) continue; // same filter chain as check_inbox
        if (cfg.subjectPrefix && !rawSubject.startsWith(cfg.subjectPrefix)) continue;
        if (!inWhitelist(fromAddr, cfg.allowedFrom)) continue;
        items.push({
          date: msg.internalDate instanceof Date ? msg.internalDate.toISOString() : '',
          from: fromAddr ?? '(unknown)',
          subject: sanitizeSubject(rawSubject, 120),
        });
      }
      items.reverse(); // newest first
      const out = items.slice(0, limit);
      return { text: formatThreads(out, limit), count: out.length };
    } finally {
      lock.release();
    }
  }

  async function closeImpl() {
    const c = client;
    client = null;
    if (c) {
      try {
        await c.logout();
      } catch {
        try {
          c.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  return {
    checkInbox: (args) => enqueue(() => checkInboxImpl(args)),
    listThreads: (args) => enqueue(() => listThreadsImpl(args)),
    close: () => enqueue(closeImpl),
  };
}
