import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEventEmail, createForwarder } from '../src/capture/forwarder.js';
import { StateStore } from '../src/state.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const event = {
  id: 'cap-abc',
  tool: 'codex',
  model: 'gpt-5.2',
  session: 'rollout-1-uuid.jsonl',
  ts: '2026-10-12T08:00:00.000Z',
  prompt: 'user question',
  output: 'model output content',
  source: 'session-log',
};

test('formatEventEmail: metadata complete', () => {
  const body = formatEventEmail(event);
  assert.ok(body.includes('[model-output capture]'));
  assert.ok(body.includes('Tool: codex'));
  assert.ok(body.includes('Model: gpt-5.2'));
  assert.ok(body.includes('model output content'));
  assert.ok(body.includes('Last input (truncated): user question'));
});

test('formatEventEmail: overlong output truncated', () => {
  const body = formatEventEmail({ ...event, output: 'x'.repeat(20000) });
  assert.ok(Buffer.byteLength(body) < 20000, 'should be truncated to around the cap');
});

test('createForwarder: same id sent only once', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eb-fwd-')), 'state.json');
  const state = new StateStore(file);
  const sent = [];
  const forward = createForwarder({ send: async (m) => sent.push(m), state });

  assert.equal(await forward(event), true);
  assert.equal(await forward(event), false, 'duplicate events are deduped');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].subject.startsWith('[CAPTURE][codex]'));
  assert.ok(!sent[0].subject.includes('\n'), 'subject is single-line');
});

test('createForwarder: error events carry the ERROR flag in the subject', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eb-fwd-')), 'state.json');
  const state = new StateStore(file);
  const sent = [];
  const forward = createForwarder({ send: async (m) => sent.push(m), state });
  await forward({ ...event, id: 'cap-err', error: 'upstream boom', output: '' });
  assert.ok(sent[0].subject.includes('ERROR'));
});

test('createForwarder: state persists; a fresh instance does not resend', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-fwd-'));
  const file = path.join(dir, 'state.json');
  const sent = [];
  await createForwarder({ send: async (m) => sent.push(m), state: new StateStore(file) })(event);
  const sent2 = [];
  await createForwarder({ send: async (m) => sent2.push(m), state: new StateStore(file) })(event);
  assert.equal(sent.length, 1);
  assert.equal(sent2.length, 0, 'dedupe state survives a restart');
});
