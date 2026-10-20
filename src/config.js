// Config loading: everything comes from env (injected via the CodeBuddy MCP config);
// an optional .env file makes local development easier.
// Credentials never go into the repo; .gitignore already excludes .env.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeAddress } from './security.js';

const HOST_MAP = {
  'qq.com': ['imap.qq.com', 'smtp.qq.com'],
  '163.com': ['imap.163.com', 'smtp.163.com'],
  '126.com': ['imap.126.com', 'smtp.126.com'],
  'gmail.com': ['imap.gmail.com', 'smtp.gmail.com'],
  'outlook.com': ['outlook.office365.com', 'smtp.office365.com'],
};

function loadDotEnv(env) {
  const file = path.join(process.cwd(), '.env');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (env[key] === undefined || env[key] === '') env[key] = val;
  }
}

function intEnv(env, key, dflt, min, max) {
  const n = Number.parseInt(env[key] ?? '', 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export function loadConfig(env = process.env) {
  loadDotEnv(env);

  const user = normalizeAddress(env.EMAIL_BRIDGE_USER ?? '');
  if (!user) {
    throw new Error(
      'EMAIL_BRIDGE_USER is unset or not a valid single mailbox address (display names / multi-addresses rejected)'
    );
  }
  const pass = env.EMAIL_BRIDGE_PASS ?? '';
  if (!pass) throw new Error('EMAIL_BRIDGE_PASS is unset (use the provider auth code, not the login password)');

  const domain = user.split('@')[1];
  const [imapHostGuess, smtpHostGuess] = HOST_MAP[domain] ?? [
    `imap.${domain}`,
    `smtp.${domain}`,
  ];

  const parseList = (key, dflt = '') =>
    String(env[key] ?? dflt)
      .split(',')
      // env is trusted config, so we trim explicitly here; normalizeAddress itself rejects any whitespace
      .map((s) => normalizeAddress(s.trim()))
      .filter(Boolean);

  // Inbound whitelist: defaults to trusting only ourselves (self mail is normally
  // skipped by the self-filter, so by default no external instructions are accepted)
  const allowedFrom = parseList('EMAIL_BRIDGE_ALLOWED_FROM', user);
  // Outbound whitelist: defaults to sending only to ourselves
  const allowedTo = parseList('EMAIL_BRIDGE_ALLOWED_TO', user);
  if (!allowedTo.length) {
    throw new Error('EMAIL_BRIDGE_ALLOWED_TO resolved to empty: the outbound whitelist needs at least one valid address');
  }

  const safeUser = user.replace(/[^a-z0-9._-]/g, '_');
  const defaultStateDir = path.join(os.homedir(), '.local', 'state', 'email-bridge', safeUser);

  // Optional: self-signed CA certificate path (to trust a specific CA for
  // self-hosted/test servers; rejectUnauthorized stays true — never relaxed)
  let tlsCa = null;
  const caPath = env.EMAIL_BRIDGE_TLS_CA ?? '';
  if (caPath) {
    tlsCa = fs.readFileSync(caPath, 'utf8');
  }

  return {
    user,
    pass,
    imapHost: env.EMAIL_BRIDGE_IMAP_HOST ?? imapHostGuess,
    imapPort: intEnv(env, 'EMAIL_BRIDGE_IMAP_PORT', 993, 1, 65535),
    smtpHost: env.EMAIL_BRIDGE_SMTP_HOST ?? smtpHostGuess,
    smtpPort: intEnv(env, 'EMAIL_BRIDGE_SMTP_PORT', 465, 1, 65535),
    allowedFrom,
    allowedTo,
    // Dual-instance protocol subject prefix; unset for single instance. Only matching mail proceeds past the whitelist checks.
    subjectPrefix: (env.EMAIL_BRIDGE_SUBJECT_PREFIX ?? '').trim() || null,
    maxBytes: intEnv(env, 'EMAIL_BRIDGE_MAX_BYTES', 8192, 1024, 65536),
    maxMessages: intEnv(env, 'EMAIL_BRIDGE_MAX_MESSAGES', 5, 1, 20),
    listLimit: intEnv(env, 'EMAIL_BRIDGE_LIST_LIMIT', 20, 1, 50),
    maxPerHour: intEnv(env, 'EMAIL_BRIDGE_MAX_PER_HOUR', 10, 1, 1000),
    stateDir: env.EMAIL_BRIDGE_STATE_DIR || defaultStateDir,
    logDir: env.EMAIL_BRIDGE_LOG_DIR || defaultStateDir,
    tlsCa,
  };
}
