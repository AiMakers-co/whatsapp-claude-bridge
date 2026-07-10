# whatsapp-claude-bridge

**Message your computer on WhatsApp and have Claude Code do the work.**

A tiny, self-hosted bridge: WhatsApp → [Claude Code](https://claude.com/claude-code)
(headless) → WhatsApp. Text your machine "fix the failing test in the api package"
or "what changed in the repo today?" and get the answer back in the chat — wherever
you are.

No Business API, no cloud, no webhook. It links to your WhatsApp the same way
WhatsApp Web does (via [Baileys](https://github.com/WhiskeySockets/Baileys)) and
runs entirely on your own machine.

> ⚡ **Built to be set up *by* Claude Code.** Clone it, open Claude Code in the
> folder, and say *"set this up"*. The bundled [`CLAUDE.md`](./CLAUDE.md) walks
> Claude through the whole installation for you. The manual steps are below if you
> prefer.

---

## How it works

```
 WhatsApp (your phone)  ──▶  Baileys socket  ──▶  Claude / Codex agent CLI
        ▲                                                │
        │                                                │  (run in WORKDIR)
        └──────────────  reply text  ◀───────────────────┘
```

- **Unprompted tasks are hard-locked.** The bridge only treats every message as
  a task inside its configured command group(s), and only for you or explicitly
  allowlisted senders. Other chats require one of your fromMe-only agent triggers.
- **Conversational.** The group keeps a session; follow-up messages continue the
  same conversation (`--resume`). Your self-chat also becomes sticky after a
  call sign, so follow-ups need no prefix. Send `/new` to start fresh.
- **Independent agent lanes.** Each agent in a chat is its own execution lane:
  `@computer` and `@codex` in the same chat run concurrently, like separate
  terminals. Turns for one agent stay strictly FIFO in a bounded queue (so a
  follow-up always sees the previous result); queueing is silent.
- **Agent triggers work anywhere.** For example, route `@computer` to Claude
  and `@codex` to Codex. Type either in a DM, ordinary group, or dedicated
  command group; only your own messages can trigger an agent.

## Anywhere triggers: `@computer` and `@codex`

The dedicated group treats every message as a task. Everywhere else, nothing
happens unless **you** (never anyone else in the chat) write a configured
trigger. For example,
`MENTION_TRIGGERS=@computer:claude:sonnet,@codex:codex:gpt-5.6` routes each
call sign to its own agent and model. The model suffix is optional, so existing
`trigger:provider` routes remain valid. Each call sign keeps an independent
resumable session inside that chat, even if two call signs use the same
provider. In ordinary chats the trigger must be the first token
(`@codex do this`); inside a dedicated command group it may also select the
provider mid-message. When you use one, the bridge:

1. Looks at the last ~30 messages it's seen in that chat (from anyone).
2. Runs them — plus whatever you wrote right after the mention — through the
   selected agent CLI/model, with the same full power (file access, commands)
   as the dedicated group, in `WORKDIR`.
3. Replies directly into that chat.

In your personal self-chat, that first call sign also starts a sliding
conversation window (two hours by default). Keep writing normally and each
turn continues with the same agent. Use `/new` for a clean thread or `/stop`
to leave conversation mode. In a chat with other people, stickiness never
starts implicitly: use `@codex /chat` or `@computer /chat` to opt in, preventing
an old AI turn from hijacking normal human messages. Follow-ups received while
an agent is working are queued silently and handled in order per agent —
different agents in the same chat run concurrently.

It's fromMe-gated by design: someone else typing `@computer` or `@codex` does
nothing. In a dedicated command group, an explicit trigger overrides the
group’s default provider for that task only. Set `ENABLE_MENTION_TRIGGER=false`
to turn all mention triggers off.

Replies are source-labelled (`Computer:`, `Codex:`, or `Bridge:`). Because
WhatsApp marks messages from every linked automation as `fromMe`, the bridge
also ignores those labels plus `Nora:` and any prefixes configured in
`BOT_REPLY_PREFIXES`. An invisible wire marker and burst circuit breakers
provide two additional safeguards against bot-to-bot loops: dedicated-group
messages, explicit call-sign mentions, and control commands trip a strict
breaker at 3 hits in 30 s (2-minute pause) — keyed per agent lane (per call
sign / provider per chat), so the total burst per chat is bounded at 3 x the
configured call signs per window; sticky-conversation follow-ups get a looser
8 hits in 30 s per chat. A trip clears every lane's queued turns in that chat
and ends sticky mode (only the tripped lane is paused), but a task already
running still delivers its reply — only an explicit `/stop`, `/new`, `/cd`,
or `/use` cancels the running task's delivery.

## Quick start

```bash
git clone <this-repo> && cd whatsapp-claude-bridge
npm run setup               # checks prereqs, installs, starts — a QR opens
```

Scan the QR (WhatsApp → **Settings → Linked Devices → Link a Device**). The bridge
creates a **Claude Chat** group automatically — text a task into it. To keep it
running 24/7:

```bash
npm run install-service     # macOS launchd; auto-starts on login
```

Requires **Node ≥ 20** and whichever agent CLI you select installed and logged in
(`claude`, `codex`, `gemini`, or `grok`). Scanning the QR is the one step only a
human can do — it links your WhatsApp account, by design.

## Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `WORKDIR` | Absolute path of the project Claude Code operates on. |
| `GROUP_NAME` | Name of the dedicated group that is the bridge's **only** command channel. Default `Claude Chat`. |
| `PROVIDER` | Agent CLI: `claude` (default) / `codex` / `gemini` / `grok`. |
| `MODEL` | Legacy model override for the default provider only. |
| `CLAUDE_MODEL`, `CODEX_MODEL`, `GEMINI_MODEL`, `GROK_MODEL` | Optional per-provider model overrides. Empty = that CLI's default. |
| `COMMAND_PREFIX` | If set (e.g. `claude`), only group messages starting with it count as tasks. Empty = every message is a task. |
| `TASK_TIMEOUT_SECONDS` | Kill a task after this long. Default `600`. |
| `ENABLE_MENTION_TRIGGER` | Turn the anywhere-chat `@computer` trigger on/off. Default `true`. |
| `MENTION_TRIGGER` | The trigger word/phrase. Default `@computer`. |
| `MENTION_TRIGGERS` | Optional comma-separated `trigger:provider[:model]` call-sign routes, e.g. `@computer:claude:sonnet,@codex:codex:gpt-5.6`. Model is optional; sessions are isolated per call sign. |
| `BOT_REPLY_PREFIXES` | Additional comma-separated bot prefixes that must never run as tasks. Core prefixes `Nora:`, `Computer:`, `Codex:`, and `Bridge:` are always ignored. |
| `CONVERSATION_MODE_MINUTES` | Sliding sticky-chat timeout. Default `120`; `0` disables. Self-chat activates automatically, other chats require `/chat`. |
| `CONVERSATION_QUEUE_LIMIT` | Maximum follow-up turns waiting per chat. Default `10`, maximum `50`. |

## Provider-agnostic

The bridge drives any **agentic coding CLI** — not just Claude. Pick one with
`PROVIDER` in `.env`, or switch per-chat from WhatsApp with `/use <name>`:

| Provider | CLI | Session continuity | Notes |
| --- | --- | --- | --- |
| `claude` *(default)* | `claude` | ✅ full | + cost reporting |
| `codex` | `codex` | ✅ resumable | run `codex login` first |
| `gemini` | `gemini` | bridge-managed | CLI is stateless; bridge supplies bounded recent history |
| `grok` | `grok` | bridge-managed | CLI is stateless; flags best-effort |

Each must be installed and authenticated. Only `claude`/`codex` expose a
resumable session id; for `gemini`/`grok`, every message is fresh. Adding a new
provider is a ~10-line spec in [`src/providers.ts`](./src/providers.ts).

## Files

You can send and receive files, not just text.

- **Send a file to the agent:** attach a photo or document (with an optional
  caption as your instruction). The bridge downloads it to `WORKDIR/inbox/` and
  tells the agent the path — e.g. send a PDF + "summarise this", or a screenshot
  + "what's broken here?".
- **Get files back:** the agent saves anything it wants to send you into
  `WORKDIR/outbox/`. After each task the bridge delivers those files over
  WhatsApp and clears the folder. So "make a chart of X" → it writes
  `outbox/chart.png` → it lands in your chat.

Files over WhatsApp's ~16 MB limit are skipped with a notice. Both folders are
created on demand and live under the active working directory (so `/cd` moves
them too).

## Control commands

| Message | Effect |
| --- | --- |
| `/new` | Start a fresh session (drop memory). In a command group this resets **every provider's** session; in a sticky ordinary chat it resets **only that call sign's** session. |
| `/chat` | Keep talking without repeating the call sign (ordinary chats require `@call-sign /chat`). |
| `/stop` | End sticky conversation mode and clear waiting turns (sticky chats only — command groups point you to `/new`). |
| `/cd <path>` | Switch working directory for this chat (works in command groups and sticky chats; resets sessions). |
| `/use <provider>` | Switch agent CLI (claude/codex/gemini/grok) for this chat (works in command groups and sticky chats). |
| `/status` | Show provider/conversation, current dir, resumable state, and per-agent lane activity (running/queued per call sign). |

Command-shaped messages (anything starting with `/`, known or unknown) never
run as agent tasks — including when they carry an attachment. Known verbs
tolerate trailing text ("/stop now", "/status?") and still execute. In sticky
chats, unknown `/`-leading text is still treated as conversation for the agent.

## Dashboard

If `WA_API_TOKEN` is set in `.env`, the bridge serves a local web dashboard at
`http://127.0.0.1:8477` (loopback only, port configurable via `WA_API_PORT`):
connection status, chats with message history, a compose box, recent tasks, and
a live log tail. On first load it asks for your `WA_API_TOKEN`; all data
endpoints require it.

The **⚙ Settings** panel configures the whole bridge from the UI — working
directory, agent CLI and model, the command group, the `@computer` trigger, and
extra monitored groups — plus an editor for each project's `CLAUDE.md` steering
file. Save writes `.env` (surgically, preserving comments; kept at mode `600`);
**Save & Restart** respawns the daemon, which reconnects from `auth/` with no new
QR. The API token and port are intentionally not editable there, so the dashboard
can't sever its own connection.

## Run it 24/7

`npm start` runs while the terminal is open. To keep it alive across reboots and
crashes, install it as a background service:

```bash
npm run install-service     # macOS (launchd). Re-run any time to update.
npm run uninstall-service   # remove it
```

On Windows, use the Scheduled Task installer instead (starts on login, restarts
on crash):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1
```

It runs the compiled daemon (`dist-bin\wa-bridge-daemon.exe`) if present,
otherwise `node_modules\.bin\tsx src/index.ts`, and stops any already-running
instance first.

Link the QR once with `npm start` first; the session persists in `auth/`, so the
service reconnects silently. Logs go to `logs/service.log` and `logs/bridge.log`.
For Linux (`systemd --user`), see [`CLAUDE.md`](./CLAUDE.md#run-it-247).

## Native app (Mac/Windows)

A Tauri v2 tray app ("WhatsApp Bridge") wraps the daemon for people who don't
want a terminal: it runs the bridge as a bundled sidecar binary (compiled with
`bun build --compile`, so end machines need no Node) and shows the dashboard
in a native window. macOS (Apple Silicon) and Windows (x64).

**Where installers come from.** Every push to `main` runs the
[`build` workflow](.github/workflows/build.yml) (also runnable manually via
*Actions → build → Run workflow*). Download the artifacts from the workflow run:

- `whatsapp-bridge-macos-aarch64` — `.dmg` and `.app.tar.gz`
- `whatsapp-bridge-windows-x64` — `.msi` and NSIS `.exe`

**Unsigned-build caveats.** CI builds are not code-signed:

- **macOS:** Gatekeeper blocks the first launch. Right-click the app →
  *Open* → *Open* (or `xattr -dr com.apple.quarantine "/Applications/WhatsApp Bridge.app"`).
- **Windows:** SmartScreen shows "Windows protected your PC". Click
  *More info* → *Run anyway*.

**Dev commands.**

```bash
# compile the daemon sidecar for your machine (from repo root)
bun install
bun build --compile src/index.ts \
  --outfile app/src-tauri/binaries/wa-bridge-daemon-$(rustc -vV | sed -n 's/host: //p')

# run the tray app against it
cd app && npm install && npx tauri dev

# production bundle (installers land in app/src-tauri/target/release/bundle/)
cd app && npx tauri build
```

## Security

- The bridge runs Claude with `--dangerously-skip-permissions` **on purpose** — that
  autonomy is the point. Treat `WORKDIR` as a directory you trust Claude to act in.
- **Hard-locked to its own group, your messages only** — it can't be triggered from
  any other chat, so it won't fight with other AI tools on your number.
- **Never commit `.env` or `auth/`** — `auth/` contains your live WhatsApp session
  keys. Both are gitignored.

## Known limitations

Deliberate scope decisions, not oversights:

- **Single instance assumed.** Temp/state files in `data/` use fixed names; running two
  bridge processes against the same folder is unsupported (the launchd service
  guarantees one instance — stop it before re-linking with `npm start`).
- **Loopback trust model.** The dashboard token protects the API from casual local
  access; a malicious local process that grabs port 8477 after the bridge dies could
  receive the token from an open dashboard tab. Loopback-only by design.
- **No orphan reaping after a daemon crash.** A provider CLI run that survives a bridge
  crash keeps running in its own process group until it finishes or times out on its own.
- **No watchdog for a hung startup.** If the initial connect stalls silently (rare
  network edge), a manual/launchd restart is the recovery path.
- **No push alerting.** A logged-out or disconnected bridge is visible on `/health`,
  `/status`, and the dashboard banner — nothing actively notifies you.
- **Baileys "Bad MAC" / signal-session corruption is upstream.** Undecryptable incoming
  messages are dropped silently (the Baileys logger runs silent); re-link if it recurs.
- **Message history grows unbounded.** `data/messages/*.jsonl` is append-only with no
  rotation; reads only tail the file, so it stays cheap — rotate manually if it bothers you.
- **Logger serializes objects naively.** Log arguments should be strings; objects are
  `JSON.stringify`'d as-is.

## Credits

Built by **[AI Makers Co](https://aimakers.co)**. Conceived by **Mark Austen** —
designed and built together with Claude (Anthropic) through Claude Code. The same
human-directs-AI collaboration this tool puts in your pocket.

## License

MIT © AI Makers Co
