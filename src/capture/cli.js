#!/usr/bin/env node
// Model output capture CLI:
//   node src/capture/cli.js --watch                        # watch ~/.codex/sessions
//   node src/capture/cli.js --proxy --upstream https://api.openai.com --port 8787
//   node src/capture/cli.js --watch --proxy --upstream ... # both can run together
//   Optional: --codex-dir <dir>  --from-start  --no-email
// --no-email mode only writes the event mirror + prints summaries; no SMTP credentials needed (for dry runs).

import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../config.js';
import { RateLimiter } from '../ratelimit.js';
import { AuditLog } from '../audit.js';
import { createSender } from '../smtp.js';
import { StateStore } from '../state.js';
import { JsonFileStore, EventStore } from './store.js';
import { SessionWatcher } from './codex-watcher.js';
import { createProxy } from './proxy.js';
import { createForwarder } from './forwarder.js';

const log = (m) => process.stderr.write(`[capture] ${m}\n`);

// ---- Args ----
const args = process.argv.slice(2);
const flag = (name, dflt = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : dflt;
};
const has = (name) => args.includes(`--${name}`);

const doWatch = has('watch');
const doProxy = has('proxy');
if (!doWatch && !doProxy) {
  log('Usage: node src/capture/cli.js [--watch] [--proxy --upstream https://api.openai.com [--port 8787]] [--no-email] [--from-start]');
  process.exit(1);
}

const noEmail = has('no-email');
const fromStart = has('from-start');
const codexDir = flag('codex-dir') || path.join(os.homedir(), '.codex', 'sessions');
const upstream = flag('upstream');
const port = Number.parseInt(flag('port', '8787'), 10) || 8787;

// ---- Components ----
let cfg = null;
let send;
if (noEmail) {
  send = async ({ subject, body }) => {
    log(`(no-email) Would send: ${subject} (${Buffer.byteLength(body)}B)`);
  };
} else {
  cfg = loadConfig(); // missing credentials exits immediately with an error
  const limiter = new RateLimiter({ perHour: cfg.maxPerHour });
  const audit = new AuditLog(cfg.logDir);
  send = createSender(cfg, limiter, audit);
}

const baseDir = cfg?.stateDir ?? path.join(os.homedir(), '.local', 'state', 'email-bridge', 'capture');
const offsetsStore = new JsonFileStore(path.join(baseDir, 'capture-state.json'), { offsets: {} });
const dedupeStore = new StateStore(path.join(baseDir, 'capture-dedupe.json'));
const eventStore = new EventStore(cfg?.logDir ?? baseDir);

const forwarded = createForwarder({ send, state: dedupeStore });
async function handleEvent(event) {
  eventStore.append(event);
  try {
    const sent = await forwarded(event);
    log(`${sent ? 'forwarded' : dedupeStore.isProcessed(event.id) ? 'duplicate, skipped' : 'processed'}: ${event.tool}/${event.model} ${event.id}`);
  } catch (e) {
    log(`Forwarding failed (event kept in the mirror, will not resend): ${e.message}`);
  }
}

// ---- watcher ----
if (doWatch) {
  const watcher = new SessionWatcher({
    dir: codexDir,
    state: offsetsStore,
    fileModel: new Map(),
  });
  const tick = async () => {
    try {
      const events = await watcher.scanOnce({ markOnly: true, fromStart });
      for (const ev of events) await handleEvent(ev);
    } catch (e) {
      log(`watcher poll failed: ${e.message}`);
    }
  };
  await tick();
  setInterval(tick, 5000);
  log(`watcher started: ${codexDir} (5s polling, fromStart=${fromStart})`);
}

// ---- proxy ----
if (doProxy) {
  if (!upstream || typeof upstream !== 'string') {
    log('--proxy requires --upstream https://api.example.com');
    process.exit(1);
  }
  const proxy = createProxy({ upstream, onEvent: handleEvent });
  const realPort = await proxy.listen(port);
  log(`proxy started: http://127.0.0.1:${realPort} → ${upstream} (point the tool's baseUrl here)`);
}

if (noEmail) log('Note: --no-email mode; events only land in the mirror, no mail is sent.');

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
