// Capture-layer storage: generic atomic JSON state + event mirror JSONL
// (0600 permissions, contains sensitive content, never committed to the repo).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function hashId(s) {
  return 'cap-' + crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 20);
}

/** Atomic read/write of arbitrary JSON structures (tmp + rename, no fsync — same reasoning as state.js). */
export class JsonFileStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.data = structuredClone(defaults);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') this.data = { ...this.data, ...raw };
    } catch {
      /* first run */
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

/** Event mirror: JSONL append. The file contains full model inputs/outputs; permissions tightened to 0600. */
export class EventStore {
  constructor(dir, file = 'capture-events.jsonl', maxBytes = 20 * 1024 * 1024) {
    this.dir = dir;
    this.file = path.join(dir, file);
    this.maxBytes = maxBytes;
  }

  append(event) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      try {
        const st = fs.statSync(this.file);
        if (st.size > this.maxBytes) fs.renameSync(this.file, this.file + '.1');
      } catch {
        /* does not exist yet */
      }
      fs.appendFileSync(this.file, JSON.stringify(event) + '\n', { mode: 0o600 });
    } catch {
      /* mirror failure never blocks forwarding */
    }
  }
}
