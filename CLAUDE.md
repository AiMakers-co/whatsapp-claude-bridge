# CLAUDE.md — instructions for Claude Code

You are Claude Code, running inside a freshly cloned copy of **whatsapp-claude-bridge**.
The user wants to message their computer on WhatsApp and have *you* do the work.
Your job right now is to **set this bridge up for them, end to end.** Be proactive —
do the steps yourself, only stopping to ask when you genuinely need something only
the human can provide (a phone, a QR scan, a path).

## What this project is

A small TypeScript daemon that:
1. Links to the user's WhatsApp via the official multi-device protocol (Baileys —
   the same mechanism as WhatsApp Web, no Business API, no cloud).
2. Listens **only** inside the dedicated group it creates, and **only** for
   messages the user sent (hard lock — never note-to-self or any other chat).
3. Runs each message as a task through `claude -p ... --output-format json
   --dangerously-skip-permissions` in a configured working directory.
4. Sends Claude's result back over WhatsApp. Conversation continuity is preserved
   per chat by threading the returned `session_id` into `--resume`.

Architecture in `src/`: `config.ts` (env), `providers.ts` (provider-agnostic
agent layer — claude/codex/gemini/grok specs + a generic CLI runner),
`index.ts` (WhatsApp socket, auth, routing, control commands), plus `logger.ts`
and `qr.ts`. The default provider is `claude`; change with `PROVIDER` in `.env`
or `/use <name>` per chat.

## Setup procedure — do this in order

1. **Check prerequisites.** Run `node -v` (need ≥20) and `claude --version`. If the
   `claude` CLI is missing, tell the user to install Claude Code first — the bridge
   shells out to it.
2. **Install deps:** `npm install`.
3. **Create config:** copy `.env.example` to `.env`. Then help the user fill it in:
   - `WORKDIR` — **ask the user which project directory** Claude should operate on.
     This is the single most important setting. Use an absolute path.
   - `GROUP_NAME` — the dedicated group that is the bridge's ONLY command channel.
     Default `Claude Chat`. The bridge is hard-locked to this group; there is no
     allowlist and it never listens anywhere else.
   - `PROVIDER` — `claude` (default), `codex`, `gemini`, or `grok`.
   - `COMMAND_PREFIX` — usually empty. Set e.g. `claude` only if the user wants
     non-task chatter in the group ignored unless it starts with that word.
   - `MODEL` — leave empty to use the provider's default.
4. **Start it:** `npm start`. A QR code prints in the terminal.
5. **Ask the human to link:** "On your phone, open WhatsApp → Settings → Linked
   Devices → Link a Device, and scan the QR code in the terminal." You cannot do
   this step — it requires their physical phone. Wait for the `✅ Bridge live` line.
6. **Verify:** tell them to open the chat **with themselves** (search their own
   name / "(You)") and send a test like `what files are in this directory?`.
   They should get a reply. If they set a `COMMAND_PREFIX`, the test must start
   with it.
7. **Offer to make it permanent.** The bridge only runs while the terminal is open.
   On macOS, `npm run install-service` installs a launchd agent that starts on
   login and restarts on crash (and `npm run uninstall-service` removes it). The
   QR must be scanned interactively once via `npm start` first; after that the
   service reconnects silently from `auth/`. See "Run it 24/7" below. Only do this
   if the user says yes.

## How the user drives it once live

- Any normal message = a task for Claude, run in `WORKDIR`.
- `/new` — start a fresh session (drops conversation memory).
- `/cd <path>` — switch the working directory for this chat (resets the session).
- `/use <provider>` — switch agent CLI (claude/codex/gemini/grok) for this chat.
- `/status` — show provider, current dir, session id, and whether a task is running.
- One task runs at a time per chat; a second message while busy is rejected with a
  nudge rather than queued.

## Run it 24/7

**macOS (launchd):** just run `npm run install-service`. It resolves the absolute
`node`/`tsx`/`claude` paths, writes
`~/Library/LaunchAgents/co.aimakers.whatsapp-claude-bridge.plist` with `RunAtLoad`
+ `KeepAlive`, and bootstraps it. Re-run to update; `npm run uninstall-service`
removes it. The script (`scripts/install-service.sh`) stops any running instance
first so two processes never fight over the WhatsApp session. Link the QR once via
`npm start` before relying on the service — `auth/` persists the session.

**Linux (systemd --user):** create a unit with
`ExecStart=<abs node> <repo>/node_modules/.bin/tsx src/index.ts`,
`WorkingDirectory=<repo>`, `Environment=PATH=...` (include node's dir and the dir
holding the `claude` CLI), and `Restart=always`. Same caveat: link interactively
first.

## Hard rules

- **Never commit `.env` or `auth/`.** `.env` holds config; `auth/` holds the live
  WhatsApp session keys (anyone with it can impersonate the user's WhatsApp).
  Both are in `.gitignore` — keep them there.
- **Do not weaken the hard lock.** The bridge must only ever act inside its
  dedicated group and only on the user's own messages. Never re-introduce a
  note-to-self path or an allowlist that opens other chats — it would collide
  with other AI tools on the user's number.
- The bridge runs Claude with `--dangerously-skip-permissions` **by design** — that
  is the whole point (autonomous execution from a text). Make sure the user
  understands `WORKDIR` is where that power applies.
- If linking fails or the session logs out, delete the `auth/` folder and re-run
  `npm start` to get a fresh QR.
