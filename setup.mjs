#!/usr/bin/env node
// One-shot setup for email-bridge:
//   npm run setup
// Interactive prompts for: dedicated mailbox / auth code (hidden input) /
// outbound whitelist / inbound whitelist.
// Automatically:
//   1. Address validity checks (reuses normalizeAddress) and full config validation (reuses loadConfig)
//   2. Generates <repo root>/.codebuddy/mcp.json (auto-detects the Node absolute path)
//   3. Generates email-bridge/.env (for the capture CLI)
//   4. Live-tests SMTP login + IMAP connectivity (--no-check to skip)
// Non-interactive: node setup.mjs --user a@qq.com --pass xx --to b@qq.com [--from c@qq.com] [--no-check] [--force]

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { normalizeAddress } from './src/security.js';
import { loadConfig } from './src/config.js';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(pkgDir, '..');
const mcpJsonPath = path.join(workspaceRoot, '.codebuddy', 'mcp.json');
const envPath = path.join(pkgDir, '.env');

const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (k) => argv.includes(`--${k}`);
const noCheck = has('no-check');

const say = (m) => process.stdout.write(m + '\n');
const die = (m) => {
  process.stderr.write(`[setup] Error: ${m}\n`);
  process.exit(1);
};

// ---------- Interaction ----------
// Note: never keep a global readline instance — it interferes with the raw mode
// used for hidden input (causing password echo / stdin misread as EOF with a
// silent exit). Use a fresh instance per question and close it right after.

function ask(question, dflt = '') {
  return new Promise((resolve) => {
    const rli = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rli.question(dflt ? `${question}[${dflt}]: ` : `${question}: `, (ans) => {
      rli.close();
      resolve(ans.trim() || dflt);
    });
  });
}

function parseList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => normalizeAddress(s.trim()))
    .filter(Boolean);
}

// ---------- Main flow ----------
async function main() {
  say('=== email-bridge one-shot setup ===');
  say('Prerequisite: the dedicated mailbox must have IMAP/SMTP enabled and you need its auth code (not the login password).\n');

  // All three essentials present → non-interactive mode (no prompts for defaults; ④ defaults to ③)
  const flagsMode =
    argOf('user') !== undefined && argOf('pass') !== undefined && argOf('to') !== undefined;

  let user = argOf('user') ?? (await ask('(1) Dedicated mailbox (bridge account, e.g. bridge-xxx@163.com)'));
  let pass = argOf('pass') ?? (await ask('(2) Auth code'));
  let toRaw = argOf('to') ?? (await ask('(3) Outbound whitelist (who gets the reports, comma-separated)'));
  let fromRaw = argOf('from') ?? (flagsMode ? toRaw : await ask(`(4) Inbound whitelist (who may reply with instructions; Enter = same as (3))`, toRaw));

  const toList = parseList(toRaw);
  const fromList = parseList(fromRaw);
  if (!normalizeAddress(user)) die(`Invalid dedicated mailbox: ${user} (must be a single bare address)`);
  if (!pass) die('Auth code is empty');
  if (!toList.length) die(`Outbound whitelist is empty or contains invalid addresses: ${toRaw}`);
  if (!fromList.length) die(`Inbound whitelist is empty or contains invalid addresses: ${fromRaw}`);

  // Full-package validation: reuse loadConfig (includes domain host derivation); fail loudly
  process.env.EMAIL_BRIDGE_USER = normalizeAddress(user);
  process.env.EMAIL_BRIDGE_PASS = pass;
  process.env.EMAIL_BRIDGE_ALLOWED_TO = toList.join(',');
  process.env.EMAIL_BRIDGE_ALLOWED_FROM = fromList.join(',');
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (e) {
    die(e.message);
  }

  say(
    `\nConfig summary:\n  Mailbox: ${cfg.user}\n  SMTP: ${cfg.smtpHost}:${cfg.smtpPort}  IMAP: ${cfg.imapHost}:${cfg.imapPort}` +
      `\n  Outbound whitelist: [${cfg.allowedTo.join(', ')}]\n  Inbound whitelist: [${cfg.allowedFrom.join(', ')}]\n  Rate limit: ${cfg.maxPerHour} mails/hour\n`
  );

  // ---------- Write .codebuddy/mcp.json ----------
  const mcp = {
    mcpServers: {
      'email-bridge': {
        command: process.execPath, // the node running this script, i.e. an absolute path
        args: [path.join(pkgDir, 'src', 'index.js')],
        env: {
          EMAIL_BRIDGE_USER: cfg.user,
          EMAIL_BRIDGE_PASS: pass,
          EMAIL_BRIDGE_ALLOWED_TO: cfg.allowedTo.join(','),
          EMAIL_BRIDGE_ALLOWED_FROM: cfg.allowedFrom.join(','),
          EMAIL_BRIDGE_MAX_PER_HOUR: String(cfg.maxPerHour),
        },
      },
    },
  };

  // ---------- Write .codebuddy/mcp.json (direct overwrite) ----------
  fs.mkdirSync(path.dirname(mcpJsonPath), { recursive: true });
  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcp, null, 2) + '\n');
  say(`✓ Wrote ${mcpJsonPath} (overwritten)`);

  // ---------- Also register into the user-level ~/.codebuddy/mcp.json (what the CodeBuddy IDE actually reads) ----------
  // Merge-write: preserve other MCP servers the user already registered
  const userMcpPath = path.join(os.homedir(), '.codebuddy', 'mcp.json');
  let userCfg = { mcpServers: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(userMcpPath, 'utf8'));
    if (raw && typeof raw === 'object' && raw.mcpServers && typeof raw.mcpServers === 'object') {
      userCfg = raw;
    }
  } catch {
    /* missing or corrupt: start from an empty skeleton */
  }
  userCfg.mcpServers['email-bridge'] = mcp.mcpServers['email-bridge'];
  fs.mkdirSync(path.dirname(userMcpPath), { recursive: true });
  fs.writeFileSync(userMcpPath, JSON.stringify(userCfg, null, 2) + '\n');
  say(`✓ Registered into user-level ${userMcpPath} (${Object.keys(userCfg.mcpServers).length} servers total; others preserved)`);

  // ---------- WSL scenario: generate the Windows-side registration file ----------
  // Reuses this WSL's server via wsl.exe (credentials/state/dedupe cursor single-sourced,
  // avoiding dual-instance divergence). Windows needs no Node or Python installed.
  const distro = process.env.WSL_DISTRO_NAME;
  if (distro && process.platform === 'linux' && fs.existsSync('/mnt/c/')) {
    const winEntry = {
      command: 'wsl.exe',
      args: ['-d', distro, '--cd', pkgDir, '-e', process.execPath, 'src/index.js'],
      env: { ...mcp.mcpServers['email-bridge'].env },
    };
    const stagePath = path.join(os.homedir(), '.codebuddy', 'mcp.windows.json');
    fs.writeFileSync(stagePath, JSON.stringify({ mcpServers: { 'email-bridge': winEntry } }, null, 2) + '\n');
    say(`✓ Generated Windows-side registration file: ${stagePath}`);
    say(`  To hook up the Windows side (either way):`);
    say(`  a) Open \\wsl$\${distro}\${stagePath.replace(/^\//, '')}, copy the content,`);
    say(`     then paste it in Windows CodeBuddy: Settings → MCP → Add MCP;`);
    say(`  b) Or merge that file's content into %USERPROFILE%\.codebuddy\mcp.json from Windows PowerShell.`);
    say(`  How it works: wsl.exe starts the same server inside this WSL; Windows needs no dependencies installed.`);
  }

  // ---------- Write .env (direct overwrite; used by the capture CLI) ----------
  const envContent =
    `EMAIL_BRIDGE_USER=${cfg.user}\n` +
    `EMAIL_BRIDGE_PASS=${pass}\n` +
    `EMAIL_BRIDGE_ALLOWED_TO=${cfg.allowedTo.join(',')}\n` +
    `EMAIL_BRIDGE_ALLOWED_FROM=${cfg.allowedFrom.join(',')}\n`;
  fs.writeFileSync(envPath, envContent, { mode: 0o600 });
  say(`✓ Wrote ${envPath} (overwritten)`);

  if (noCheck) {
    say('\n(--no-check: connectivity verification skipped)');
    finish();
    return;
  }

  // ---------- Live connectivity test ----------
  say('\nVerifying connectivity (up to 15s each)...');
  const timeout = (p, ms = 15_000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  let smtpOk = false;
  try {
    const tr = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      auth: { user: cfg.user, pass },
      connectionTimeout: 15_000,
    });
    await timeout(tr.verify());
    smtpOk = true;
    say('✓ SMTP login OK');
  } catch (e) {
    say(`✗ SMTP failed: ${e.message} (check: are you using the auth code rather than the login password; is IMAP/SMTP service enabled)`);
  }

  let imapOk = false;
  try {
    const client = new ImapFlow({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: true,
      auth: { user: cfg.user, pass },
      logger: false,
      tls: { rejectUnauthorized: true },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
    });
    await timeout(client.connect());
    await client.logout().catch(() => client.close());
    imapOk = true;
    say('✓ IMAP connection OK');
  } catch (e) {
    say(`✗ IMAP failed: ${e.message} (check: is the IMAP service enabled; is the account throttled by the provider)`);
  }

  finish(smtpOk && imapOk);
}

function finish(allOk = true) {
  say('\n=== Done ===');
  say('Next steps:');
  say('  1. Restart CodeBuddy (or refresh the MCP page), confirm email-bridge appears and Try to Run');
  say('  2. In the chat, ask it to "call send_email to send a test email"');
  if (!allOk) say('  3. Connectivity checks did not all pass: fix and re-run npm run setup');
  say('\nSecurity reminder: .codebuddy/mcp.json and email-bridge/.env contain credentials; both are gitignored — never commit them.');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => die(e.stack ?? e.message));
