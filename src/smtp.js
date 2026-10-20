// Outbound: SMTP sending.
// Security points:
//  1. Hard recipient whitelist (normalizeAddress strict single address + equality
//     comparison), preventing prompt injection from mailing code/credentials anywhere;
//  2. Subject sanitization (prevents CRLF header injection / Bcc injection);
//  3. From and envelope From are pinned to the authenticated account;
//  4. Message-ID is pre-generated and reused across retries (idempotent);
//  5. Rate-limit check first; audit records metadata only.
// Reliability:
//  Some Tencent SMTP 465 edge nodes are broken (the TLS handshake reads non-TLS
//  content and reports "wrong version number"; DNS round-robin hits them randomly),
//  so on 465 failure we automatically fall back to 587 STARTTLS and remember the
//  last successful port combo with priority. Once a bad edge node recovers, we
//  naturally return to 465.

import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import tls from 'node:tls';
import fs from 'node:fs';
import { normalizeAddress, sanitizeSubject } from './security.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_BODY_BYTES = 200_000;

// Temporary diagnostic probe: on failure, write parse/probe results to
// /tmp/eb-smtp-debug.jsonl (remove after the observation window)
function debugProbe(cfg, port, secure, err, attempt) {
  try {
    const rec = {
      ts: new Date().toISOString(),
      stage: 'send-error', attempt,
      host: cfg.smtpHost, port, secure,
      err: String(err.message).slice(0, 220),
    };
    const sock = tls.connect(
      { host: cfg.smtpHost, port, servername: cfg.smtpHost, timeout: 8000 },
      function () {
        rec.probe = `OK remote=${this.remoteAddress} auth=${this.authorized}`;
        this.end();
        try { fs.appendFileSync('/tmp/eb-smtp-debug.jsonl', JSON.stringify(rec) + '\n'); } catch { }
      }
    );
    sock.on('error', (e3) => {
      rec.probe = 'ERR ' + e3.message;
      try { fs.appendFileSync('/tmp/eb-smtp-debug.jsonl', JSON.stringify(rec) + '\n'); } catch { }
    });
    sock.setTimeout(8000, function () {
      this.destroy();
      rec.probe = 'probe-timeout';
      try { fs.appendFileSync('/tmp/eb-smtp-debug.jsonl', JSON.stringify(rec) + '\n'); } catch { }
    });
  } catch { /* diagnostic failure never affects the main flow */ }
}

export function createSender(cfg, limiter, audit) {
  const transports = new Map(); // `${port}:${secure}` -> transport

  function transportFor(port, secure) {
    const key = `${port}:${secure}`;
    if (!transports.has(key)) {
      transports.set(
        key,
        nodemailer.createTransport({
          host: cfg.smtpHost,
          port,
          secure,
          auth: { user: cfg.user, pass: cfg.pass },
          pool: false, // a hanging attempt would dead-occupy the pooled connection; low-frequency sending needs no pooling
          tls: { rejectUnauthorized: true, ...(cfg.tlsCa ? { ca: [cfg.tlsCa] } : {}) },
          connectionTimeout: 15_000,
          greetingTimeout: 15_000,
        })
      );
    }
    return transports.get(key);
  }

  const isTlsPathError = (e) =>
    /wrong version number|SSL routines|handshake|EPROTO/i.test(String(e?.message ?? ''));

  let preferred = null; // the last successful [port, secure]

  return async function sendEmail({ to, subject, body }) {
    // ---- Outbound whitelist (mandatory) ----
    const addr = normalizeAddress(to ?? cfg.allowedTo[0] ?? '');
    if (!addr) {
      throw new Error(
        `Recipient is not a valid single mailbox address (display names / multi-addresses / special chars rejected): ${JSON.stringify(to ?? null)}`
      );
    }
    if (!cfg.allowedTo.includes(addr)) {
      throw new Error(
        `Recipient ${addr} is not on the outbound whitelist; refused. Allowed recipients: [${cfg.allowedTo.join(', ')}]` +
          `. To add a recipient, the user must change the EMAIL_BRIDGE_ALLOWED_TO config — it cannot be driven by email content.`
      );
    }

    const subj = sanitizeSubject(subject);
    if (!subj) throw new Error('subject is empty or empty after sanitization');
    const text = String(body ?? '');
    const bodyBytes = Buffer.byteLength(text, 'utf8');
    if (bodyBytes > MAX_BODY_BYTES) {
      throw new Error(`body too large (${bodyBytes} bytes > limit ${MAX_BODY_BYTES}); trim it and resend`);
    }

    const gate = limiter.allow();
    if (!gate.ok) {
      audit.write({ action: 'rate-limited', to: addr, subject: subj.slice(0, 40) });
      throw new Error(gate.reason);
    }

    // Send path planning: configured port first; a 587 STARTTLS fallback is appended
    // only when the configured port is 465
    const fullPlan = [[cfg.smtpPort, cfg.smtpPort === 465]];
    if (cfg.smtpPort === 465) fullPlan.push([587, false]);
    const plan = preferred
      ? [preferred, ...fullPlan.filter(([p, s]) => !(p === preferred[0] && s === preferred[1]))]
      : fullPlan;

    // Pre-generate the Message-ID and reuse it across retries for idempotency
    const messageId = `<${crypto.randomUUID()}@email-bridge>`;

    let lastErr = null;
    for (const [port, secure] of plan) {
      const transport = transportFor(port, secure);
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          let timer;
          const deadline = new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error('SMTP path timed out (12s; suspected broken edge node)')), 12_000);
          });
          deadline.catch(() => {}); // prevent unhandled rejection
          const pending = transport.sendMail({
            from: cfg.user,
            to: addr,
            subject: subj,
            text,
            messageId,
            envelope: { from: cfg.user, to: [addr] },
          });
          pending.catch(() => {}); // after giving up on timeout, late failures must not trigger unhandledRejection
          const info = await Promise.race([pending, deadline]);
          clearTimeout(timer);
          preferred = [port, secure];
          audit.write({
            action: 'send',
            to: addr,
            subject: subj.slice(0, 40),
            messageId: info.messageId || messageId,
            via: `${port}${secure ? ' implicit-TLS' : ' STARTTLS'}`,
            bytes: bodyBytes,
            sha: crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
          });
          return {
            messageId: info.messageId || messageId,
            response: info.response,
            via: `${port}${secure ? ' implicit-TLS' : ' STARTTLS'}`,
          };
        } catch (e) {
          lastErr = e;
          audit.write({
            action: 'send-error', to: addr, attempt, port,
            error: String(e.message).slice(0, 200),
          });
          debugProbe(cfg, port, secure, e, attempt);
          if (isTlsPathError(e) || /SMTP path timed out/.test(String(e?.message ?? ''))) {
            break; // TLS path broken/hanging → switch to the next path; do not retry the same port
          }
          if (attempt < 2) await sleep(2000);
        }
      }
    }
    throw new Error(`SMTP send failed (tried ${plan.length} paths): ${lastErr?.message ?? 'unknown'}`);
  };
}
