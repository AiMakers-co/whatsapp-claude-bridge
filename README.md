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
 WhatsApp (your phone)  ──▶  Baileys socket  ──▶  claude -p "<your message>"
        ▲                                                │   --output-format json
        │                                                │   --dangerously-skip-permissions
        └──────────────  reply text  ◀───────────────────┘   (run in WORKDIR)
```

- **Hard-locked to one group.** On connect the bridge creates (or finds) a single
  dedicated group and acts **only** there, **only** on messages you send. It never
  touches note-to-self, your own number, DMs, or any other chat — so it can't
  collide with other tools on your WhatsApp. There is no allowlist override.
- **Conversational.** The group keeps a session; follow-up messages continue the
  same conversation (`--resume`). Send `/new` to start fresh.
- **One task at a time**, with a hard timeout you control.
- **`@computer` works anywhere.** Type it in any chat — a DM, a group,
  whatever — and (as long as it's your own message) the bridge reads that
  chat's recent messages and replies right there. See "Anywhere trigger"
  below.

## Anywhere trigger: `@computer`

The dedicated group treats every message as a task. Everywhere else, nothing
happens unless **you** (never anyone else in the chat) write the trigger word
— default `@computer`, configurable via `MENTION_TRIGGER` in `.env`. When you
do, the bridge:

1. Looks at the last ~30 messages it's seen in that chat (from anyone).
2. Runs them — plus whatever you wrote right after the mention — through
   Claude Code, with the same full power (file access, commands) as the
   dedicated group, in `WORKDIR`.
3. Replies directly into that chat.

It's fromMe-gated by design: someone else in a group chat typing `@computer`
does nothing. Set `ENABLE_MENTION_TRIGGER=false` to turn it off entirely.

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

Requires **Node ≥ 20** and the **`claude` CLI** installed and logged in (the bridge
shells out to it; `npm run setup` checks and warns if it's missing). Scanning the QR
is the one step only a human can do — it links your WhatsApp account, by design.

## Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `WORKDIR` | Absolute path of the project Claude Code operates on. |
| `GROUP_NAME` | Name of the dedicated group that is the bridge's **only** command channel. Default `Claude Chat`. |
| `PROVIDER` | Agent CLI: `claude` (default) / `codex` / `gemini` / `grok`. |
| `MODEL` | Optional model override for the provider. Empty = its default. |
| `COMMAND_PREFIX` | If set (e.g. `claude`), only group messages starting with it count as tasks. Empty = every message is a task. |
| `TASK_TIMEOUT_SECONDS` | Kill a task after this long. Default `600`. |
| `ENABLE_MENTION_TRIGGER` | Turn the anywhere-chat `@computer` trigger on/off. Default `true`. |
| `MENTION_TRIGGER` | The trigger word/phrase. Default `@computer`. |

## Provider-agnostic

The bridge drives any **agentic coding CLI** — not just Claude. Pick one with
`PROVIDER` in `.env`, or switch per-chat from WhatsApp with `/use <name>`:

| Provider | CLI | Session continuity | Notes |
| --- | --- | --- | --- |
| `claude` *(default)* | `claude` | ✅ full | + cost reporting |
| `codex` | `codex` | ✅ resumable | run `codex login` first |
| `gemini` | `gemini` | ❌ stateless | one-shot per message |
| `grok` | `grok` | ❌ stateless | flags best-effort |

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
| `/new` | Start a fresh session (drop memory). |
| `/cd <path>` | Switch working directory for this chat. |
| `/use <provider>` | Switch agent CLI (claude/codex/gemini/grok) for this chat. |
| `/status` | Show provider, current dir, session id, busy state. |

## Dashboard

If `WA_API_TOKEN` is set in `.env`, the bridge serves a local web dashboard at
`http://127.0.0.1:8477` (loopback only, port configurable via `WA_API_PORT`):
connection status, chats with message history, a compose box, recent tasks, and
a live log tail. On first load it asks for your `WA_API_TOKEN`; all data
endpoints require it.

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
