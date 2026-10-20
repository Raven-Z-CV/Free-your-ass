// Event forwarder: unified event → email.
// - message-id-style dedupe (ids land in the state file; no resend after restart);
// - at-most-once: record state before sending (prefer losing over duplicating,
//   same semantics as the bridge);
// - sending reuses email-bridge's createSender: outbound whitelist, rate limit,
//   and audit all apply.

import { sanitizeSubject, truncateUtf8 } from '../security.js';

const OUTPUT_CAP = 16_000; // byte cap for model output inside the email body

export function formatEventEmail(event) {
  const lines = [];
  lines.push('[model-output capture]');
  lines.push(`Source: ${event.source ?? 'unknown'}`);
  lines.push(`Tool: ${event.tool}`);
  lines.push(`Model: ${event.model ?? '(unknown)'}`);
  lines.push(`Session: ${event.session ?? '-'}`);
  lines.push(`Time: ${event.ts}`);
  if (event.status != null) lines.push(`Status: ${event.status}`);
  if (event.prompt) lines.push(`Last input (truncated): ${event.prompt}`);
  if (event.error) lines.push(`Error: ${event.error}`);
  lines.push('');
  lines.push(truncateUtf8(event.output ?? '', OUTPUT_CAP));
  return lines.join('\n');
}

export function createForwarder({ send, state }) {
  return async function forward(event) {
    if (state.isProcessed(event.id)) return false;
    state.markProcessed(event.id); // record state before sending
    const subject = sanitizeSubject(`[CAPTURE][${event.tool}] ${event.model ?? ''} ${event.error ? 'ERROR' : ''}`);
    const body = formatEventEmail(event);
    await send({ subject, body });
    return true;
  };
}
