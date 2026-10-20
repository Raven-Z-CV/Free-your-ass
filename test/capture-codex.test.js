import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCodexLine, SessionWatcher } from '../src/capture/codex-watcher.js';
import { JsonFileStore } from '../src/capture/store.js';

const LINE_META =
  '{"timestamp":"2026-10-12T08:00:00Z","type":"session_meta","payload":{"id":"s1","model":"gpt-5.2"}}';
const LINE_ASSISTANT =
  '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"part one"},{"type":"output_text","text":"part two"}]}}';
const LINE_AGENT_MSG = '{"type":"event_msg","payload":{"type":"agent_message","message":"direct message shape"}}';
const LINE_USER = '{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"question"}]}}';

test('parseCodexLine: the three shapes of interest', () => {
  assert.deepEqual(parseCodexLine(LINE_META), { kind: 'meta', model: 'gpt-5.2' });
  assert.deepEqual(parseCodexLine(LINE_ASSISTANT), { kind: 'assistant', text: 'part onepart two' });
  assert.deepEqual(parseCodexLine(LINE_AGENT_MSG), { kind: 'assistant', text: 'direct message shape' });
  assert.deepEqual(parseCodexLine(LINE_USER), { kind: 'user', text: 'question' });
});

test('parseCodexLine: noise lines return null', () => {
  assert.equal(parseCodexLine('not json'), null);
  assert.equal(parseCodexLine('{}'), null);
  assert.equal(parseCodexLine('{"type":"turn_aborted"}'), null);
  assert.equal(parseCodexLine('{"type":"response_item","payload":{"role":"assistant","content":[]}}'), null);
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eb-codex-'));
}

function setup(dir) {
  const state = new JsonFileStore(path.join(dir, 'state.json'), { offsets: {} });
  return { state, watcher: new SessionWatcher({ dir: path.join(dir, 'sessions'), state }) };
}

test('SessionWatcher: first scan only marks the watermark; new content produces events', async () => {
  const dir = tmpDir();
  const sess = path.join(dir, 'sessions', '2026', '10', '12');
  fs.mkdirSync(sess, { recursive: true });
  const file = path.join(sess, 'rollout-1-uuid.jsonl');
  fs.writeFileSync(file, LINE_META + '\n' + LINE_ASSISTANT + '\n');

  const { state, watcher } = setup(dir);
  const first = await watcher.scanOnce({ markOnly: true }); // first scan: mark the watermark only
  assert.equal(first.length, 0);

  fs.appendFileSync(file, LINE_ASSISTANT.replace('part one', 'appended output') + '\n');
  const second = await watcher.scanOnce({ markOnly: true });
  assert.equal(second.length, 1);
  assert.equal(second[0].tool, 'codex');
  assert.equal(second[0].output, 'appended outputpart two');
  assert.equal(second[0].model, 'gpt-5.2', 'the model from meta is remembered');
  assert.match(second[0].session, /rollout-1-uuid\.jsonl$/);

  // scan again with nothing new → no events
  assert.equal((await watcher.scanOnce({ markOnly: true })).length, 0);
});

test('SessionWatcher: partial trailing lines wait until complete before being consumed', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const file = path.join(dir, 'sessions', 'rollout-2.jsonl');
  fs.writeFileSync(file, LINE_META + '\n');
  const { watcher } = setup(dir);
  await watcher.scanOnce({ markOnly: true });

  // write a partial line (no trailing newline)
  const half = '{"type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"hal';
  fs.appendFileSync(file, half);
  assert.equal((await watcher.scanOnce({ markOnly: true })).length, 0, 'a partial line must not produce an event');

  // complete it
  fs.appendFileSync(file, 'f"}]}}\n');
  const evs = await watcher.scanOnce({ markOnly: true });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].output, 'half');
});

test('SessionWatcher: truncated rewrite resets the cursor to zero and re-reads', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const file = path.join(dir, 'sessions', 'rollout-3.jsonl');
  fs.writeFileSync(file, LINE_ASSISTANT + '\n');
  const { watcher } = setup(dir);
  await watcher.scanOnce({ markOnly: true });
  fs.appendFileSync(file, LINE_ASSISTANT + '\n');
  assert.equal((await watcher.scanOnce({ markOnly: true })).length, 1);

  // the file got truncated and rewritten (smaller)
  fs.writeFileSync(file, LINE_ASSISTANT + '\n');
  const evs = await watcher.scanOnce({ markOnly: true });
  assert.equal(evs.length, 1, 're-read from zero, produced again');
});

test('SessionWatcher: fromStart produces history on the first scan', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', 'rollout-4.jsonl'), LINE_ASSISTANT + '\n');
  const { watcher } = setup(dir);
  const evs = await watcher.scanOnce({ markOnly: true, fromStart: true });
  assert.equal(evs.length, 1);
});

test('SessionWatcher: missing directory returns empty silently', async () => {
  const dir = tmpDir();
  const { watcher } = setup(dir); // sessions dir never created
  assert.equal((await watcher.scanOnce({ markOnly: true })).length, 0);
});
