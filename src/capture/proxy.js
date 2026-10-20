// Local LLM API reverse proxy: the tool points its baseUrl at this process; we
// forward to the real upstream and tee the response.
// - Request side: strip hop-by-hop headers; summarize model + last user input;
// - Response side: SSE streams are incrementally parsed and assembled into full
//   text; non-streaming JSON is extracted directly; bytes are passed through to
//   the client untouched;
// - accept-encoding is stripped so upstream compression cannot break parsing
//   (local loopback; bandwidth is irrelevant).
// Binds 127.0.0.1 only.

import http from 'node:http';
import { SseParser, extractTextDelta, extractFullText, summarizeRequest } from './sse.js';
import { hashId } from './store.js';

const RAW_CAP = 512 * 1024;

function filterRequestHeaders(headers) {
  const drop = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'keep-alive', 'transfer-encoding']);
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!drop.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function filterResponseHeaders(headers) {
  const drop = new Set(['transfer-encoding', 'connection', 'keep-alive', 'content-encoding']);
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!drop.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function readBody(req, cap = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param opts.upstream like https://api.openai.com (no path)
 * @param opts.onEvent  async (event) => void; forwarding failures never block the proxy
 */
export function createProxy({ upstream, onEvent }) {
  const upstreamUrl = new URL(upstream);

  const server = http.createServer(async (req, res) => {
    let bodyBuf;
    try {
      bodyBuf = await readBody(req);
    } catch (e) {
      res.writeHead(413).end(e.message);
      return;
    }

    let summary = { model: undefined, prompt: '' };
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.includes('application/json') && bodyBuf.length) {
      try {
        summary = summarizeRequest(JSON.parse(bodyBuf.toString('utf8')));
      } catch {
        /* non-JSON request body: forward as usual */
      }
    }

    let up;
    try {
      up = await fetch(new URL(req.url, upstreamUrl), {
        method: req.method,
        headers: filterRequestHeaders(req.headers),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf,
      });
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`capture-proxy upstream error: ${e.message}`);
      onEvent?.({
        id: hashId(`${Date.now()}:${req.url}:upstream-error`),
        tool: 'proxy',
        model: summary.model,
        session: req.url,
        ts: new Date().toISOString(),
        output: '',
        error: e.message,
        source: 'api-proxy',
      })?.catch?.(() => {});
      return;
    }

    const resHeaders = filterResponseHeaders(Object.fromEntries(up.headers.entries()));
    const resCt = String(up.headers.get('content-type') ?? '');
    if (resHeaders['content-length'] == null) res.setHeader('transfer-encoding', 'chunked');
    res.writeHead(up.status, resHeaders);

    const dec = new TextDecoder();
    const parser = new SseParser();
    let assembled = '';
    let raw = '';
    let rawCapped = false;

    if (up.body) {
      try {
        for await (const chunk of up.body) {
          res.write(chunk);
          if (raw.length < RAW_CAP) {
            const str = dec.decode(chunk, { stream: true });
            raw += str;
            if (raw.length >= RAW_CAP) {
              raw += '\n…[raw truncated]';
              rawCapped = true;
            }
            if (resCt.includes('event-stream')) {
              for (const payload of parser.push(str)) {
                assembled += extractTextDelta(payload);
              }
            }
          } else if (!rawCapped) {
            raw += '\n…[raw truncated]';
            rawCapped = true;
          }
        }
      } catch {
        /* upstream stream interrupted: the already-passed-through part is valid */
      }
    }
    res.end();

    // Non-streaming JSON: extract the full text from the aggregated raw
    let output = assembled;
    if (!output && resCt.includes('application/json')) {
      try {
        output = extractFullText(JSON.parse(raw));
      } catch {
        /* if unparsable, leave it empty */
      }
    }

    if (output || up.status >= 400) {
      const event = {
        id: hashId(`${req.url}:${summary.model}:${raw.slice(0, 2048)}`),
        tool: 'proxy',
        model: summary.model,
        session: req.url,
        ts: new Date().toISOString(),
        prompt: summary.prompt,
        output,
        status: up.status,
        source: 'api-proxy',
      };
      try {
        await onEvent?.(event);
      } catch {
        /* downstream failure never blocks the proxy response */
      }
    }
  });

  return {
    listen(port = 8787, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
