# email-bridge

Control the Agent in VSCode by sending and receiving emails — no need to stay at your computer. Whether you're in class, having coffee, or commuting, you can get work done from any device that can receive email (a tablet or phone, for example).

Turn your mailbox into an async collaboration bus for AI agents:

- **Outbound**: the agent emails you a report automatically after finishing a task;
- **Inbound**: replying with an email is how you give instructions — the agent fetches and executes them automatically;
- **Unattended**: with a small helper script, "send an email → the agent starts working", no keyboard needed.

## Components

| Component | Purpose |
|---|---|
| `src/index.js` | MCP server (`send_email` / `check_inbox` / `list_threads`), automatically available inside CodeBuddy sessions |
| `.codebuddy/rules/email-bridge.md` | Working protocol rules that define when the agent sends/fetches email (shipped in the repo, no action needed) |
| `remote-trigger/paste_bot.py` | Optional: on detecting an instruction email, pastes a trigger phrase into the CodeBuddy chat box for unattended operation |
| `src/capture/cli.js` | Optional: mirrors model output of any LLM tool to the mailbox (see the implementation guide) |

## Quick start (3 steps)

1. **Prepare a dedicated mailbox**: enable IMAP/SMTP and get an **auth code** (QQ/163 use a 16-character alphanumeric code — not your login password).
2. **One-shot setup** (writes `.codebuddy/mcp.json`, generates `.env`, and live-tests SMTP/IMAP connectivity — wrong credentials fail on the spot):

   ```bash
   cd email-bridge
   npm install
   npm run setup
   ```

   Fill in 4 items when prompted: the bridge mailbox address, its auth code, your recipient address, and who is allowed to send mail in (defaults to the recipient).
   Non-interactive: `node setup.mjs --user bridge-xxx@163.com --pass AUTHCODE --to xxx@163.com`

3. **Restart CodeBuddy** and confirm `email-bridge` shows as available on the MCP page.
4. **Start the bot** in the background:

   ```bash
   python3 paste_bot.py
   ```

   The bot activates the Agent chat automatically whenever an email with subject `CMD` arrives, letting the AI process the mail according to `Rule.md`.

5. **Choose the chat box**: keep the cursor focused on the Agent's chat input; when a whitelisted mailbox receives an email, the message is injected automatically into the chat box you selected.

## Daily use

- Hand out tasks in the chat as usual; the agent emails a report when done.
- To instruct by email: send mail to the bridge mailbox from a whitelisted address; the agent checks the inbox before starting any task.

## Unattended mode (email → auto execution)

```bash
cd remote-trigger
cp config.example.json config.json   # fill in user / pass / allowed_from
python3 paste_bot.py --dry-run       # dry run, prints actions only
python3 paste_bot.py                 # run for real, Ctrl+C to stop
```

How it works: polls IMAP → only handles mail from **whitelisted senders with subjects starting with `[CMD]`** → pastes a fixed trigger phrase into the focused window and presses Enter → the agent calls `check_inbox` to pull the email body and executes → reports by email.

Notes:

- **WSL users**: the chat UI renders on the Windows side; copy `remote-trigger` to a local Windows folder and run it with Windows Python 3;
- Keep the cursor focused in the CodeBuddy chat input while it runs;
- By default only the trigger phrase is pasted (the agent pulls the email body via `check_inbox`, keeping all server-side defenses); `--paste-body` pastes the raw email body, impersonating a user message and bypassing defenses — **not recommended**.

## Tests

```bash
npm test              # 28 unit tests
node test/smoke.mjs   # stdio smoke test
```

## Common configuration (env in mcp.json or `.env`)

| Variable | Meaning |
|---|---|
| `EMAIL_BRIDGE_USER` / `EMAIL_BRIDGE_PASS` | Dedicated mailbox / auth code (required) |
| `EMAIL_BRIDGE_ALLOWED_TO` | Outbound whitelist (the agent may only send to these addresses), comma-separated |
| `EMAIL_BRIDGE_ALLOWED_FROM` | Inbound whitelist (only these senders are processed), comma-separated |
| `EMAIL_BRIDGE_SUBJECT_PREFIX` | Subject-prefix filter when two instances share one mailbox, e.g. `[FROM-A]` |

SMTP/IMAP hosts are derived from the mailbox domain (qq/163/126/gmail/outlook built in); ports default to 465 / 993.

## Security model (brief)

Send/receive whitelists, self-send filtering, outbound rate limiting (10 mails/hour), 8KB per-message truncation, message-id dedupe, and audit logs are all enforced server-side — see `../email-bridge-implementation-guide-for-codex.md` for details. Known boundary: **a stolen whitelisted account means mail from it can drive the agent to write files / run commands** — guard the auth code carefully; every send/receive is traceable via the audit log.

## Going further

- Full configuration reference, security design, and implementation pitfalls: `../email-bridge-implementation-guide-for-codex.md`
- Dual-instance collaboration, capture output mirroring (watcher / local proxy): same document
