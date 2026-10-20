// Audit log: JSONL append-only; records metadata only (time/direction/addresses/
// first 40 chars of subject/message-id/body hash and byte count) — never the body.
// Rotates to .1 when maxBytes is exceeded. Audit write failures never block the main flow.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function bodyHash(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);
}

export class AuditLog {
  constructor(dir, file = 'audit.jsonl', maxBytes = 5 * 1024 * 1024) {
    this.dir = dir;
    this.file = path.join(dir, file);
    this.maxBytes = maxBytes;
  }

  write(entry) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      try {
        const st = fs.statSync(this.file);
        if (st.size > this.maxBytes) fs.renameSync(this.file, this.file + '.1');
      } catch {
        /* file does not exist yet */
      }
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
      fs.appendFileSync(this.file, line);
    } catch {
      /* audit is best-effort; never block send/receive */
    }
  }
}
