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

There are two independent trigger paths, both in `index.ts`:
1. **Dedicated group(s)** — every message is an unprompted task. Hard-locked:
   fromMe or allowlisted only, never any other chat.
2. **Per-call-sign mention triggers** — opt-in, work in ANY chat, but only fire
   on messages YOU send (fromMe). `MENTION_TRIGGERS` can route e.g.
   `@computer:claude:sonnet,@codex:codex:gpt-5.6`; model suffixes are optional
   and sessions are independent per call sign per chat. In ordinary chats the
   trigger must be the first token; monitored groups retain an anywhere-token
   provider override. A self-chat trigger starts a sliding sticky conversation;
   other ordinary chats require explicit `@call-sign /chat`. See "Hard rules".

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
   name / "(You)") and send a test like `@computer what files are in this directory?`.
   They should get a reply. If they set a `COMMAND_PREFIX`, the test must start
   with it.
7. **Offer to make it permanent.** The bridge only runs while the terminal is open.
   On macOS, `npm run install-service` installs a launchd agent that starts on
   login and restarts on crash (and `npm run uninstall-service` removes it). The
   QR must be scanned interactively once via `npm start` first; after that the
   service reconnects silently from `auth/`. See "Run it 24/7" below. Only do this
   if the user says yes.

## How the user drives it once live

- In a dedicated group, any authorised normal message is a task. In self-chat,
  start with a call sign once and then continue normally during sticky mode.
- `/new` — start a fresh session (drops conversation memory). In a command
  group it resets EVERY provider's session; in a sticky chat only that call
  sign's session.
- `/chat` — explicitly activate sticky mode outside self-chat.
- `/stop` — end sticky mode and clear waiting turns.
- `/cd <path>` — switch the working directory for this chat (resets the
  session). Works in command groups and sticky chats.
- `/use <provider>` — switch agent CLI (claude/codex/gemini/grok) for this
  chat. Works in command groups and sticky chats.
- `/status` — show provider, current dir, session state, and per-agent lane activity.
- `/job <task>` — run a task as a background job instead of inline: it replies
  `🚀 Job <id> started …` immediately, frees the lane, then posts the result to
  this chat when done. Jobs run a FRESH agent session in this chat's working
  directory (no conversation memory — put everything the task needs in the text).
- `/jobs` — list this chat's background jobs (running/queued first), with a
  `(+N in other chats)` footer. Status glyphs: ✅ done, ⚠️ error, ⏱ timeout,
  🛑 killed, 💤 interrupted (by a restart), 🚫 superseded, 📪 suppressed.
- `/kill <id>` — kill a running job (its process tree) or cancel a queued one.
  `/kill` also suppresses that job's result. See the semantics table below.
- The agent can also **delegate** long work itself: when a normal task would
  take more than about a minute (builds, full test suites, big refactors,
  research sweeps), it spins the work off as a background job and replies fast
  with a `🚀 Started job <id>` line — same result-when-done behavior as `/job`.
- Known commands never run as agent tasks — even with trailing words
  ("/stop now") or an attachment. In command groups NO `/`-leading message
  ever runs as a task; in sticky chats, unknown `/`-text stays conversational.
- **Ack + progress messages** are throwaway status lines, never queued offline
  and never recorded to the transcript: a `🤖 On it…` ack fires the instant a
  task is accepted (silence it with `ACK_ENABLED=0`), and while a long task runs
  a coalesced `⏳ …` progress rail reports what the agent is doing. Tune the rail
  with `PROGRESS_INTERVAL_SECONDS` (delay before the first line; `0` disables it
  and keeps claude in plain json mode) and `PROGRESS_MAX_UPDATES`. Job settings:
  `JOB_TIMEOUT_SECONDS`, `MAX_CONCURRENT_JOBS`, `MAX_QUEUED_JOBS`.
- Each agent (call sign in ordinary chats, provider in command groups) is an
  independent execution LANE per chat: `@computer` and `@codex` in one chat run
  CONCURRENTLY, like separate terminals. Within one lane, turns stay strictly
  FIFO (turn N+1 sees turn N's result) in a bounded queue. Queueing is silent —
  no position notices.
- The strict burst breaker is keyed per lane (3 hits/30s, 2-min pause, per
  agent per chat), so parallel agents don't consume each other's budget; the
  total burst per chat stays bounded at 3 x the configured call signs per
  window. The sticky-conversation breaker (8/30s) stays per chat. All other
  loop barriers are unchanged.
- On a loop-guard trip, every lane's queued turns in that chat are cleared and
  sticky mode ends (only the tripped lane is paused — the notice names it by
  label), but tasks already running still deliver. Only explicit user resets
  cancel a running task's delivery: /stop, /cd, /use (and group /new) are
  chat-wide; a sticky /new cancels only its OWN call sign's lane, so the other
  agent's running turn keeps delivering and keeps its session.

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
- **Do not weaken the hard lock on unprompted tasks.** Every-message-is-a-task
  must only ever run inside the dedicated group(s) and only on the user's own
  (or allowlisted) messages. Never make an unprompted task run in an
  arbitrary chat, and never let anyone but the user (fromMe) invoke the
  `@computer` mention trigger — that would collide with other AI tools on the
  user's number or leak into chats with other people watching.
- The mention triggers (`ENABLE_MENTION_TRIGGER`, `MENTION_TRIGGER`, and
  `MENTION_TRIGGERS` in `.env`) are an intentional, narrow exception the user
  explicitly asked for: they reply in ANY chat, but are strictly fromMe-gated.
  Sticky follow-ups are allowed automatically only in self-chat; every other
  ordinary chat requires an explicit `/chat` activation with a sliding expiry.
- `fromMe` includes every linked automation using the owner's WhatsApp account,
  not just human typing. Preserve all loop barriers: visible source prefixes,
  the invisible outbound marker, bot-prefix suppression, leading-only ordinary
  triggers, PN/LID self-chat canonicalization, bounded per-chat FIFO, and the
  burst circuit breakers. Never interpolate a live trigger token into an
  operational notice.
  This is not a bug and not scope creep to be reverted — if asked to touch
  this area again, preserve the fromMe-only invariant above all else.
- **Background-job control semantics (do not blur these):**
  - `/kill <id>` is **job-scoped**: it kills the job's process tree AND suppresses
    its result. It bumps no generation and touches no chat lane or session.
  - `/stop`, `/cd`, `/use` (and a group `/new`) suppress a running job's
    **delivery** via its guard, but the process keeps running to completion and
    stays visible in `/jobs`; its result is retained as 📪 suppressed. They never
    kill a job — only `/kill` kills.
  - A **loop-guard trip** touches jobs not at all — it clears queued chat turns
    and pauses the tripped lane, but running jobs keep running and keep delivering.
  - Jobs **always run FRESH sessions** — never `--resume`, never session
    writeback. Chat-lane FIFO and per-lane session continuity are unchanged by
    jobs; the two never share state.
  - Jobs **interrupted by a restart are never auto-rerun** (they may already have
    made changes) — the user gets one 💤 notice and re-issues `/job` if wanted.
    A queued job that had not started is re-admitted after restart.
  - Ephemeral sends (ack + progress `⏳`/`🤖`) are **never** enqueued to
    pending-sends and **never** recorded to the transcript, so a reconnect never
    replays a stale ack and future turns never see progress noise as context.
- The bridge runs Claude with `--dangerously-skip-permissions` **by design** — that
  is the whole point (autonomous execution from a text). Make sure the user
  understands `WORKDIR` is where that power applies.
- If linking fails or the session logs out, delete the `auth/` folder and re-run
  `npm start` to get a fresh QR.
