// Pure-function security utilities: address normalization, whitelist comparison,
// byte-safe truncation, subject sanitization, HTML downgrade.
// All side-effect-free and unit-testable; no network dependency.

import { htmlToText } from 'html-to-text';

// Strict single address: rejects display names, multi-addresses, whitespace,
// CRLF, control characters. Intentionally stricter than RFC5322 — for the
// outbound whitelist, prefer rejecting over accepting.
const ADDR_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Normalize an email address; returns null when invalid.
 * Rejects: "Name <a@b.c>", comma lists, mailto:, input containing CRLF/whitespace/control characters.
 */
export function normalizeAddress(raw) {
  if (typeof raw !== 'string') return null;
  // Check forbidden characters on the raw input (including surrounding whitespace)
  // before normalizing — prevents trimming from swallowing trailing \r\n and
  // similar characters first, which would allow a bypass.
  if (/[<>,;\s'"\\]/.test(raw)) return null;
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  const a = raw.trim().toLowerCase();
  if (!a) return null;
  return ADDR_RE.test(a) ? a : null;
}

/** Exact equality comparison (arguments must be an already-normalized address and an already-normalized whitelist). */
export function inWhitelist(addr, whitelist) {
  return typeof addr === 'string' && Array.isArray(whitelist) && whitelist.includes(addr);
}

/**
 * Byte-safe truncation: never splits a UTF-8 multi-byte sequence into partial bytes.
 * Returned text may carry the suffix (suffix is not counted in maxBytes).
 */
export function truncateUtf8(str, maxBytes, suffix = '\n…[truncated]') {
  const s = String(str ?? '');
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  // Locate the character containing the last kept byte:
  // if it is a continuation byte, walk back to its leading byte; if the whole
  // character fits, keep it whole, otherwise drop the whole character. Never
  // produces U+FFFD or partial sequences.
  let end = maxBytes;
  let i = end - 1;
  if (i >= 0 && (buf[i] & 0xc0) === 0x80) {
    while (i >= 0 && (buf[i] & 0xc0) === 0x80) i--; // i = index of the leading byte
  }
  if (i >= 0) {
    const b = buf[i];
    let seq = 1;
    if ((b & 0xe0) === 0xc0) seq = 2;
    else if ((b & 0xf0) === 0xe0) seq = 3;
    else if ((b & 0xf8) === 0xf0) seq = 4;
    end = i + seq <= maxBytes ? i + seq : i;
  }
  return buf.subarray(0, end).toString('utf8') + suffix;
}

/** Subject sanitization: flatten to one line, strip CRLF (prevents header / Bcc injection), limit length. */
export function sanitizeSubject(raw, maxLen = 200) {
  const oneLine = String(raw ?? '')
    .replace(/[\r\n\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateUtf8(oneLine, maxLen, '…');
}

/** Downgrade HTML to plain text (uses a real parser to prevent tag-stripping bypasses). */
export function htmlToPlainText(html) {
  try {
    return htmlToText(String(html ?? ''), {
      wordwrap: false,
      preserveNewlines: true,
      selectors: [
        { selector: 'img', format: 'skip' },
        { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      ],
    }).trim();
  } catch {
    // If the parser fails, rather lose the body than inject unsanitized HTML
    return String(html ?? '').replace(/<[^>]*>/g, ' ');
  }
}

/** Attachment filename sanitization (display only, never written to disk). */
export function sanitizeFilename(name) {
  const s = String(name ?? '(unnamed)')
    .replace(/[\r\n\x00-\x1f\x7f]+/g, '_')
    .trim();
  return truncateUtf8(s || '(unnamed)', 60, '…');
}

/**
 * Parse the Authentication-Results header. Returns:
 *   true  = dmarc=pass
 *   false = dmarc explicitly failed / soft-failed
 *   null  = header absent, unknown (the caller decides how to present it)
 */
export function checkAuthResults(headerValue) {
  if (headerValue == null) return null;
  const s = Array.isArray(headerValue) ? headerValue.join(' ') : String(headerValue);
  if (/dmarc\s*=\s*pass/i.test(s)) return true;
  if (/dmarc\s*=\s*(fail|softfail|quarantine)/i.test(s)) return false;
  return null;
}
