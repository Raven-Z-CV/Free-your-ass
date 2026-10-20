// SSE parsing and text extraction for the various model API families
// (OpenAI chat completions / Responses / Anthropic).
// Pure functions + a streaming parser; unit-testable.

/**
 * Streaming SSE parser: feed text chunks incrementally; splits on blank lines and
 * extracts all `data:` payloads. Compatible with both \n\n and \r\n\r\n separators.
 */
export class SseParser {
  constructor() {
    this.buf = '';
  }

  push(str) {
    this.buf += str;
    const out = [];
    for (;;) {
      let sep = -1;
      let sepLen = 0;
      const i1 = this.buf.indexOf('\n\n');
      const i2 = this.buf.indexOf('\r\n\r\n');
      if (i1 >= 0 && (i2 < 0 || i1 < i2)) {
        sep = i1;
        sepLen = 2;
      } else if (i2 >= 0) {
        sep = i2;
        sepLen = 4;
      }
      if (sep < 0) break;
      const block = this.buf.slice(0, sep);
      this.buf = this.buf.slice(sep + sepLen);
      out.push(...parseSseBlock(block));
    }
    return out;
  }
}

function parseSseBlock(block) {
  const datas = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      datas.push(JSON.parse(payload));
    } catch {
      datas.push(payload); // non-JSON payloads are kept verbatim
    }
  }
  return datas;
}

/** Incremental text within a streaming chunk. */
export function extractTextDelta(obj) {
  if (!obj || typeof obj !== 'object') return '';
  // OpenAI chat completions chunk
  const d = obj.choices?.[0]?.delta?.content;
  if (typeof d === 'string') return d;
  // OpenAI Responses API
  if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') return obj.delta;
  // Anthropic messages
  if (obj.type === 'content_block_delta' && typeof obj.delta?.text === 'string') return obj.delta.text;
  return '';
}

/** Full text within a non-streaming response. */
export function extractFullText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const c = obj.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('');
  if (typeof obj.output_text === 'string') return obj.output_text;
  if (typeof obj.output?.content === 'string') return obj.output.content;
  return '';
}

/** Request body summary: model name + last user input (truncated). */
export function summarizeRequest(bodyObj, promptMax = 500) {
  const model = typeof bodyObj?.model === 'string' ? bodyObj.model : undefined;
  let prompt = '';
  let msgs = Array.isArray(bodyObj?.messages) ? bodyObj.messages : null;
  if (!msgs && Array.isArray(bodyObj?.input)) msgs = bodyObj.input;
  if (!msgs && typeof bodyObj?.input === 'string') {
    // Responses API's string-input shape
    msgs = [{ role: 'user', content: bodyObj.input }];
  }
  msgs ??= [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (typeof m === 'string') {
      prompt = m;
      break;
    }
    if (m?.role === 'user') {
      const c = m.content;
      if (typeof c === 'string') prompt = c;
      else if (Array.isArray(c)) prompt = c.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('');
      break;
    }
  }
  prompt = prompt.replace(/\s+/g, ' ').trim();
  return {
    model,
    prompt: prompt.length > promptMax ? prompt.slice(0, promptMax) + '…' : prompt,
  };
}
