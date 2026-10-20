import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, synthMessageId } from '../src/state.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-state-'));
  return path.join(dir, 'state.json');
}

test('markProcessed / isProcessed persist across instances', () => {
  const file = tmpFile();
  const s1 = new StateStore(file);
  assert.equal(s1.isProcessed('<m1@x>'), false);
  s1.markProcessed('<m1@x>');
  const s2 = new StateStore(file); // simulate a server restart
  assert.equal(s2.isProcessed('<m1@x>'), true);
});

test('processed list has a capacity cap', () => {
  const file = tmpFile();
  const s = new StateStore(file);
  for (let i = 0; i < 5200; i++) s.markProcessed(`<m${i}@x>`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(raw.processed.length <= 5000);
  assert.equal(s.isProcessed('<m0@x>'), false, 'the oldest entry should be evicted');
  assert.equal(s.isProcessed('<m5199@x>'), true);
});

test('UIDVALIDITY change triggers a cursor reset', () => {
  const file = tmpFile();
  const s = new StateStore(file);
  s.checkUidValidity(111);
  s.setLastUid(50);
  assert.equal(s.lastUid, 50);
  const r = s.checkUidValidity(222); // mailbox was rebuilt
  assert.equal(r.reset, true);
  assert.equal(s.lastUid, 0);
  assert.equal(s.checkUidValidity(222).reset, false, 'same value does not reset again');
});

test('lastUid only moves forward', () => {
  const file = tmpFile();
  const s = new StateStore(file);
  s.setLastUid(10);
  s.setLastUid(5);
  assert.equal(s.lastUid, 10);
  s.setLastUid('20'); // non-numbers are ignored
  assert.equal(s.lastUid, 10);
});

test('atomic write: no half-written file before rename; written content is valid JSON', () => {
  const file = tmpFile();
  const s = new StateStore(file);
  s.markProcessed('<a@x>');
  const raw = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(raw).processed, ['<a@x>']);
  assert.ok(!fs.existsSync(file + '.tmp'), 'the tmp file should have been consumed by rename');
});

test('corrupt state file is not fatal; falls back to initial values', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{corrupted!!!');
  const s = new StateStore(file);
  assert.equal(s.lastUid, 0);
  s.markProcessed('<x@y>'); // and can still overwrite-write afterwards
  assert.equal(new StateStore(file).isProcessed('<x@y>'), true);
});

test('synthMessageId: stable and content-sensitive', () => {
  const a = synthMessageId(Buffer.from('hello'));
  const b = synthMessageId(Buffer.from('hello'));
  const c = synthMessageId(Buffer.from('hellp'));
  assert.equal(a, b);
  assert.notEqual(a, c);
});
