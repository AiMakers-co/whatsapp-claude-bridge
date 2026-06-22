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
2. Listens for messages **from the user only** (note-to-self by default).
3. Runs each message as a task through `claude -p ... --output-format json
   --dangerously-skip-permissions` in a configured working directory.
4. Sends Claude's result back over WhatsApp. Conversation continuity is preserved
   per chat by threading the returned `session_id` into `--resume`.

Architecture is three files in `src/`: `config.ts` (env), `claude.ts` (spawns the
CLI), `index.ts` (WhatsApp socket, auth, routing, control commands).

## Setup procedure — do this in order

1. **Check prerequisites.** Run `node -v` (need ≥20) and `claude --version`. If the
   `claude` CLI is missing, tell the user to install Claude Code first — the bridge
   shells out to it.
2. **Install deps:** `npm install`.
3. **Create config:** copy `.env.example` to `.env`. Then help the user fill it in:
   - `WORKDIR` — **ask the user which project directory** Claude should operate on.
     This is the single most important setting. Use an absolute path.
   - `ALLOWED_JIDS` — leave **empty** for the secure default (note-to-self only).
     Only populate it if the user explicitly wants to command the bridge from
     another person's number. Format: `<countrycode><number>@s.whatsapp.net`
     (digits only, no `+`, no spaces).
   - `COMMAND_PREFIX` — leave empty unless the user wants to keep using their
     note-to-self chat for other things; then set e.g. `claude` so only messages
     starting with that word are treated as tasks.
   - `CLAUDE_MODEL` — leave empty to use their account default.
4. **Start it:** `npm start`. A QR code prints in the terminal.
5. **Ask the human to link:** "On your phone, open WhatsApp → Settings → Linked
   Devices → Link a Device, and scan the QR code in the terminal." You cannot do
   this step — it requires their physical phone. Wait for the `✅ Bridge live` line.
6. **Verify:** tell them to open the chat **with themselves** (search their own
   name / "(You)") and send a test like `what files are in this directory?`.
   They should get a reply. If they set a `COMMAND_PREFIX`, the test must start
   with it.
7. **Offer to make it permanent.** The bridge only runs while the terminal is open.
   Offer to install a `launchd` service (macOS) or `systemd` unit (Linux) so it
   restarts on boot and after crashes. See "Run it 24/7" below — only do this if
   the user says yes.

## How the user drives it once live

- Any normal message = a task for Claude, run in `WORKDIR`.
- `/new` — start a fresh Claude session (drops conversation memory).
- `/cd <path>` — switch the working directory for this chat (resets the session).
- `/status` — show current dir, session id, and whether a task is running.
- One task runs at a time per chat; a second message while busy is rejected with a
  nudge rather than queued.

## Run it 24/7 (only if the user wants it)

**macOS (launchd):** create `~/Library/LaunchAgents/co.aimakers.whatsapp-claude.plist`
pointing `ProgramArguments` at the absolute path of `npm` (`which npm`) with args
`["start"]`, set `WorkingDirectory` to this repo's absolute path, `RunAtLoad` and
`KeepAlive` to `true`, and `StandardOutPath`/`StandardErrorPath` to a log file.
Load with `launchctl load -w <plist>`. The first run still needs an interactive QR
scan, so start it once with `npm start` and link **before** handing off to launchd
(the `auth/` folder persists the session).

**Linux (systemd --user):** a unit with `ExecStart=/usr/bin/npm start`,
`WorkingDirectory=<repo>`, `Restart=always`. Same caveat: link interactively first.

## Hard rules

- **Never commit `.env` or `auth/`.** `.env` holds config; `auth/` holds the live
  WhatsApp session keys (anyone with it can impersonate the user's WhatsApp).
  Both are in `.gitignore` — keep them there.
- **Do not widen the allowlist** beyond what the user asked for. The default
  (note-to-self only) means no one else can run commands on their machine.
- The bridge runs Claude with `--dangerously-skip-permissions` **by design** — that
  is the whole point (autonomous execution from a text). Make sure the user
  understands `WORKDIR` is where that power applies.
- If linking fails or the session logs out, delete the `auth/` folder and re-run
  `npm start` to get a fresh QR.
