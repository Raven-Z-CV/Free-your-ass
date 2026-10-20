// Consumption state: UID cursor + message-id dedupe, atomic write (tmp + fsync + rename).
// Semantic choice: prefer losing a mail over injecting it twice (duplicates = instructions
// executed twice); the audit log allows manual recovery.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PROCESSED_CAP = 5000;

/** Synthetic ID for mail lacking a Message-ID (hash of the whole raw source). */
export function synthMessageId(sourceBuf) {
  return 'sha256-' + crypto.createHash('sha256').update(sourceBuf).digest('hex').slice(0, 32);
}

export class StateStore {
  #loaded;
  constructor(file) {
    this.file = file;
    this.data = { uidvalidity: null, lastUid: 0, processed: [] };
    this.#loaded = false;
  }

  #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return; // first run or corrupt file: start from initial values
    }
    if (raw && typeof raw === 'object') {
      this.data = {
        uidvalidity: raw.uidvalidity ?? null,
        lastUid: Number.isFinite(raw.lastUid) ? raw.lastUid : 0,
        processed: Array.isArray(raw.processed) ? raw.processed.filter((x) => typeof x === 'string') : [],
      };
    }
  }

  save() {
    this.#load();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    // No fsync on purpose: rename atomicity (readers always see complete JSON) is what
    // makes this file correct. Losing the last few dedupe records on power loss
    // (possibly re-injecting one old mail) can be compensated manually via the audit log.
    // Also, on some network/container filesystems fsync can take seconds to tens of
    // seconds, which would stall the send/receive path.
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  isProcessed(id) {
    this.#load();
    return this.data.processed.includes(id);
  }

  markProcessed(id) {
    this.#load();
    if (!this.data.processed.includes(id)) this.data.processed.push(id);
    if (this.data.processed.length > PROCESSED_CAP) {
      this.data.processed = this.data.processed.slice(-PROCESSED_CAP);
    }
    this.save();
  }

  /** Returns {reset:true} when UIDVALIDITY changed and the cursor was zeroed (mailbox rebuilt/migrated). */
  checkUidValidity(v) {
    this.#load();
    const s = String(v);
    if (this.data.uidvalidity !== s) {
      this.data.uidvalidity = s;
      this.data.lastUid = 0;
      this.save();
      return { reset: true };
    }
    return { reset: false };
  }

  setLastUid(uid) {
    this.#load();
    if (Number.isFinite(uid) && uid > this.data.lastUid) {
      this.data.lastUid = uid;
      this.save();
    }
  }

  get lastUid() {
    this.#load();
    return this.data.lastUid;
  }
}
