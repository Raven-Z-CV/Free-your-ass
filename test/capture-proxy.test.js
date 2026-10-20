import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxy } from '../src/capture/proxy.js';

function startUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function proxyRequest(proxyPort, path, bodyObj, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy request timeout')), timeoutMs);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    if (bodyObj) req.write(JSON.stringify(bodyObj));
    req.end();
  });
}

test('proxy: SSE streaming passthrough + incremental full-text assembly + event capture', async () => {
  const sseBody =
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
    'data: [DONE]\n\n';

  const { server: up, port: upPort } = await startUpstream((req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer sk-test');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseBody.slice(0, 40));
    setTimeout(() => {
      res.end(sseBody.slice(40));
    }, 30);
  });

  const events = [];
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upPort}`, onEvent: async (e) => events.push(e) });
  const proxyPort = await proxy.listen(0);

  const r = await proxyRequest(
    proxyPort,
    '/v1/chat/completions',
    {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'say hi' }],
    },
    { authorization: 'Bearer sk-test' }
  );

  assert.equal(r.status, 200);
  assert.equal(r.body, sseBody, 'bytes received by the client must match the upstream exactly');
  assert.equal(events.length, 1);
  assert.equal(events[0].output, 'Hello world');
  assert.equal(events[0].model, 'gpt-test');
  assert.equal(events[0].prompt, 'say hi');
  assert.equal(events[0].status, 200);
  assert.equal(events[0].source, 'api-proxy');

  await proxy.close();
  up.close();
});

test('proxy: non-streaming JSON full-text extraction', async () => {
  const { server: up, port: upPort } = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'full answer' } }] }));
  });
  const events = [];
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upPort}`, onEvent: async (e) => events.push(e) });
  const proxyPort = await proxy.listen(0);

  const r = await proxyRequest(proxyPort, '/v1/chat/completions', { model: 'm1', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(r.status, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0].output, 'full answer');

  await proxy.close();
  up.close();
});

test('proxy: unreachable upstream → 502 + error event, proxy survives', async () => {
  // find a port nobody is listening on
  const free = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

  const events = [];
  const proxy = createProxy({ upstream: `http://127.0.0.1:${free}`, onEvent: async (e) => events.push(e) });
  const proxyPort = await proxy.listen(0);

  const r = await proxyRequest(proxyPort, '/v1/x', { model: 'm' });
  assert.equal(r.status, 502);
  assert.equal(events.length, 1);
  assert.ok(events[0].error);

  const r2 = await proxyRequest(proxyPort, '/v1/x', { model: 'm' });
  assert.equal(r2.status, 502, 'the proxy keeps serving');

  await proxy.close();
});

test('proxy: binary/non-JSON responses pass through untouched and produce no event', async () => {
  const { server: up, port: upPort } = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('plain passthrough');
  });
  const events = [];
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upPort}`, onEvent: async (e) => events.push(e) });
  const proxyPort = await proxy.listen(0);

  const r = await proxyRequest(proxyPort, '/other/path', null);
  assert.equal(r.status, 200);
  assert.equal(r.body, 'plain passthrough');
  assert.equal(events.length, 0, 'no output text → no event');

  await proxy.close();
  up.close();
});
