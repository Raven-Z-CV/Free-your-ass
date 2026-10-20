import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, extractTextDelta, extractFullText, summarizeRequest } from '../src/capture/sse.js';

test('SseParser: block boundary split across chunks', () => {
  const p = new SseParser();
  const a = p.push('data: {"a":1}\n\ndata: {"b"');
  const b = p.push(':2}\n\n');
  assert.deepEqual(a, [{ a: 1 }]);
  assert.deepEqual(b, [{ b: 2 }]);
});

test('SseParser: \\r\\n\\r\\n separator and [DONE]', () => {
  const p = new SseParser();
  const out = p.push('data: {"x":1}\r\n\r\ndata: [DONE]\r\n\r\n');
  assert.deepEqual(out, [{ x: 1 }]);
});

test('SseParser: block split at the separator loses nothing and duplicates nothing', () => {
  const p = new SseParser();
  const a = p.push('data: {"n":1}\n'); // block not closed yet
  assert.deepEqual(a, []);
  const b = p.push('\ndata: {"n":2}\n\n');
  assert.deepEqual(b, [{ n: 1 }, { n: 2 }]);
});

test('SseParser: non-JSON payloads are kept as strings', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: hello\n\n'), ['hello']);
});

test('extractTextDelta: OpenAI chat chunk', () => {
  assert.equal(extractTextDelta({ choices: [{ delta: { content: 'hello' } }] }), 'hello');
  assert.equal(extractTextDelta({ choices: [{ delta: {} }] }), '');
});

test('extractTextDelta: OpenAI Responses API', () => {
  assert.equal(extractTextDelta({ type: 'response.output_text.delta', delta: 'abc' }), 'abc');
});

test('extractTextDelta: Anthropic content_block_delta', () => {
  assert.equal(extractTextDelta({ type: 'content_block_delta', delta: { text: 'xyz' } }), 'xyz');
});

test('extractFullText: non-streaming shapes', () => {
  assert.equal(extractFullText({ choices: [{ message: { content: 'hi' } }] }), 'hi');
  assert.equal(
    extractFullText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, 'b'] } }] }),
    'ab'
  );
  assert.equal(extractFullText({ output_text: 'resp' }), 'resp');
  assert.equal(extractFullText({}), '');
});

test('summarizeRequest: chat messages take the last user entry', () => {
  const s = summarizeRequest({
    model: 'gpt-test',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: [{ type: 'text', text: '  last   question  ' }] },
    ],
  });
  assert.equal(s.model, 'gpt-test');
  assert.equal(s.prompt, 'last question');
});

test('summarizeRequest: Responses API input array and string', () => {
  assert.equal(summarizeRequest({ input: [{ role: 'user', content: 'q1' }] }).prompt, 'q1');
  assert.equal(summarizeRequest({ input: 'raw string' }).prompt, 'raw string');
  assert.equal(summarizeRequest({}).prompt, '');
});

test('summarizeRequest: overlong prompt truncated', () => {
  const s = summarizeRequest({ messages: [{ role: 'user', content: 'x'.repeat(1000) }] }, 100);
  assert.ok(s.prompt.length <= 102);
  assert.ok(s.prompt.endsWith('…'));
});
