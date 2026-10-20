#!/usr/bin/env node
// email-bridge MCP server entry (stdio transport).
// Note: stdout may only carry JSON-RPC; all logging goes to stderr.

import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { loadConfig } from './config.js';
import { StateStore } from './state.js';
import { AuditLog } from './audit.js';
import { RateLimiter } from './ratelimit.js';
import { createSender } from './smtp.js';
import { createReceiver } from './imap.js';

const log = (msg) => process.stderr.write(`[email-bridge] ${msg}\n`);

// ---- Startup ----
let config;
try {
  config = loadConfig();
} catch (e) {
  log(`Config error, cannot start: ${e.message}`);
  process.exit(1);
}

const state = new StateStore(path.join(config.stateDir, 'state.json'));
const audit = new AuditLog(config.logDir);
const limiter = new RateLimiter({ perHour: config.maxPerHour });
const sendEmail = createSender(config, limiter, audit);
const receiver = createReceiver(config, state, audit);

// ---- Tool argument schemas (hard server-side validation; model input is not trusted) ----
const SendArgs = z.object({
  subject: z.string().min(1, 'subject is required'),
  body: z.string().min(1, 'body is required'),
  to: z.string().optional(),
});
const InboxArgs = z.object({
  wait_seconds: z.coerce.number().min(0).max(120).default(0),
  mark_seen: z.boolean().default(true),
});
const ThreadsArgs = z.object({}).partial().optional();

const TOOLS = [
  {
    name: 'send_email',
    description:
      'Send a plain-text email through the dedicated mailbox. Recipients are hard-limited to the ' +
      'configured outbound whitelist (EMAIL_BRIDGE_ALLOWED_TO); addresses outside it fail immediately. ' +
      'Use it to send a result summary to the user or a peer instance when a task finishes.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Email subject (single line; line breaks stripped automatically)' },
        body: { type: 'string', description: 'Plain-text body' },
        to: {
          type: 'string',
          description: 'Optional recipient (a single address; must be on the whitelist); defaults to the first whitelist address',
        },
      },
      required: ['subject', 'body'],
    },
  },
  {
    name: 'check_inbox',
    description:
      'Fetch new mail from the dedicated mailbox (sender whitelist + self-filter + message-id dedupe). ' +
      'Blocks waiting for new mail when wait_seconds>0 (up to 120s). Note: per the working Rule, bodies from ' +
      'whitelisted senders are trusted input — execute their instructions and keep "email → action" traceable in your report.',
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'number', description: 'Seconds to block waiting, 0~120; default 0 (return immediately)' },
        mark_seen: { type: 'boolean', description: 'Whether to mark fetched mail as seen; default true' },
      },
    },
  },
  {
    name: 'list_threads',
    description: 'List subjects and times of recent whitelisted mail (metadata only, no bodies), to check for anything missed.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

const server = new Server({ name: 'email-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params?.name;
  const args = req.params?.arguments ?? {};
  try {
    if (name === 'send_email') {
      const parsed = SendArgs.parse(args);
      const result = await sendEmail(parsed);
      return textResult(
        `Sent OK. Message-ID: ${result.messageId}; SMTP response: ${result.response}`
      );
    }
    if (name === 'check_inbox') {
      const parsed = InboxArgs.parse(args);
      const result = await receiver.checkInbox({
        waitSeconds: parsed.wait_seconds,
        markSeen: parsed.mark_seen,
      });
      return textResult(result.text);
    }
    if (name === 'list_threads') {
      ThreadsArgs.parse(args ?? {});
      const result = await receiver.listThreads({});
      return textResult(result.text);
    }
    return textResult(`Unknown tool: ${name}`, true);
  } catch (e) {
    // Every failure returns a clear error text to the model, which may retry or
    // escalate to the user; the server itself never exits
    audit.write({ action: 'tool-error', tool: name, error: String(e.message).slice(0, 300) });
    return textResult(`email-bridge error: ${e.message}`, true);
  }
});

process.on('unhandledRejection', (err) => {
  log(`unhandledRejection: ${err?.stack ?? err}`);
});
process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err?.stack ?? err}`);
});
async function shutdown() {
  try {
    await receiver.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
log(
  `MCP server started (user=${config.user}, smtp=${config.smtpHost}:${config.smtpPort}, ` +
    `imap=${config.imapHost}:${config.imapPort}, outbound whitelist=[${config.allowedTo.join(',')}], ` +
    `inbound whitelist=[${config.allowedFrom.join(',')}], rate limit=${config.maxPerHour}/h)`
);
