// Codex CLI session log watcher.
// Directory layout: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, line-per-record JSON.
// Known line shapes (defensive parsing; unmatched lines are silently skipped —
// schema evolution is not fatal):
//   {"type":"session_meta","payload":{...,"model":"gpt-5"}}
//   {"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}]}}
//   {"type":"event_msg","payload":{"type":"agent_message","message":"..."}}

import fs from 'node:fs';
import path from 'node:path';
import { hashId } from './store.js';

/** Extract all text from a content array. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p?.text ?? '')))
      .join('');
  }
  return '';
}

/**
 * Parse a single line. Returns:
 *   {kind:'meta', model}        session metadata
 *   {kind:'assistant', text}    model output
 *   {kind:'user', text}         user input (context only, body never forwarded)
 *   null                        line of no interest
 */
export function parseCodexLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  if (obj.type === 'session_meta') {
    const model = typeof obj.payload?.model === 'string' ? obj.payload.model : undefined;
    return { kind: 'meta', model };
  }
  const p = obj.payload ?? obj; // tolerate legacy shapes without the payload wrapper
  if (p?.role === 'assistant' || p?.type === 'agent_message') {
    const text = p.type === 'agent_message' ? String(p.message ?? '') : contentText(p.content);
    if (text.trim()) return { kind: 'assistant', text };
    return null;
  }
  if (p?.role === 'user') {
    const text = contentText(p.content ?? p.message);
    if (text.trim()) return { kind: 'user', text };
  }
  return null;
}

/**
 * Incrementally scan all *.jsonl under the directory:
 *  - when a file is seen for the first time (no offset record), by default only its
 *    size is recorded and no events are produced (avoids flooding with history);
 *    it is read from the start only when markOnly=false and fromStart is explicit;
 *  - only complete lines (ending with \n) are consumed; partial trailing lines
 *    wait for the next round;
 *  - file shrank (truncated rewrite) → cursor resets to zero and re-reads.
 */
export class SessionWatcher {
  /**
   * @param opts.state {JsonFileStore} offsets live in state.data.offsets
   * @param opts.fileModel {Map} file→model mapping preserved across scans (pass new Map())
   */
  constructor({ dir, state, parseLine = parseCodexLine, fileModel = new Map() }) {
    this.dir = dir;
    this.state = state;
    this.parseLine = parseLine;
    this.fileModel = fileModel;
  }

  async scanOnce({ markOnly = true, fromStart = false } = {}) {
    const events = [];
    let files = [];
    try {
      files = fs.readdirSync(this.dir, { recursive: true });
    } catch {
      return events; // directory missing (e.g. codex not installed): wait silently
    }
    files = files.filter((f) => f.endsWith('.jsonl'));

    for (const rel of files) {
      const full = path.join(this.dir, rel);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      const offsets = this.state.data.offsets ?? {};
      const prev = offsets[full];
      let offset = typeof prev?.offset === 'number' ? prev.offset : 0;

      if (prev === undefined) {
        // New file: by default only record the watermark. With fromStart, read from the beginning.
        if (markOnly && !fromStart) {
          this.#metaScan(full, st.size); // still extract historical meta (model name); just no events
          this.#setOffset(full, st.size);
          continue;
        }
        offset = 0;
      } else if (st.size < offset) {
        offset = 0; // truncated rewrite
      }
      if (st.size === offset) continue;

      let fh;
      try {
        fh = fs.openSync(full, 'r');
        const len = st.size - offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fh, buf, 0, len, offset);
        let text = buf.toString('utf8');
        let consumed = offset + len;
        const lastNl = text.lastIndexOf('\n');
        if (lastNl < 0) continue; // no complete line in the whole chunk; wait for next round
        if (lastNl < text.length - 1) {
          text = text.slice(0, lastNl + 1);
          consumed = offset + Buffer.byteLength(text, 'utf8');
        }

        for (const line of text.split('\n')) {
          const s = line.trim();
          if (!s) continue;
          const parsed = this.parseLine(s);
          if (!parsed) continue;
          if (parsed.kind === 'meta') {
            if (parsed.model) this.fileModel.set(full, parsed.model);
            continue;
          }
          if (parsed.kind === 'user') continue; // user input only affects prompt context; never forwarded
          events.push({
            id: hashId(full + ':' + s.slice(0, 512)),
            tool: 'codex',
            model: this.fileModel.get(full) ?? '(unknown)',
            session: path.basename(full),
            ts: new Date().toISOString(),
            output: parsed.text,
            source: 'session-log',
          });
        }
        this.#setOffset(full, consumed);
      } catch {
        /* read failed: retry next round */
      } finally {
        if (fh != null) fs.closeSync(fh);
      }
    }
    this.state.save();
    return events;
  }

  /** Scan metadata only (first 512KB at most) to remember the session's model name; produces no events. */
  #metaScan(full, size) {
    if (this.fileModel.has(full)) return;
    let fh;
    try {
      fh = fs.openSync(full, 'r');
      const len = Math.min(size, 512 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fh, buf, 0, len, 0);
      for (const line of buf.toString('utf8').split('\n')) {
        const parsed = this.parseLine(line.trim());
        if (parsed?.kind === 'meta' && parsed.model) {
          this.fileModel.set(full, parsed.model);
          return;
        }
      }
    } catch {
      /* try again next round */
    } finally {
      if (fh != null) fs.closeSync(fh);
    }
  }

  #setOffset(full, size) {
    if (!this.state.data.offsets) this.state.data.offsets = {};
    this.state.data.offsets[full] = { offset: size };
  }
}
