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

- **Note-to-self by default.** The bridge only acts on messages **you send to
  yourself**, so nobody else can run commands on your computer.
- **Conversational.** Each chat keeps a Claude session; follow-up messages continue
  the same conversation (`--resume`). Send `/new` to start fresh.
- **One task at a time** per chat, with a hard timeout you control.

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
| `ALLOWED_JIDS` | Comma-separated WhatsApp JIDs allowed to send commands. **Empty = note-to-self only (recommended).** Format: `31612345678@s.whatsapp.net`. |
| `COMMAND_PREFIX` | If set (e.g. `claude`), only messages starting with it count as tasks. Empty = every message is a task. |
| `CLAUDE_MODEL` | Optional `--model` override. Empty = account default. |
| `TASK_TIMEOUT_SECONDS` | Kill a task after this long. Default `600`. |

## Control commands

| Message | Effect |
| --- | --- |
| `/new` | Start a fresh Claude session (drop memory). |
| `/cd <path>` | Switch working directory for this chat. |
| `/status` | Show current dir, session id, busy state. |

## Run it 24/7

`npm start` runs while the terminal is open. To keep it alive across reboots and
crashes, install it as a background service:

```bash
npm run install-service     # macOS (launchd). Re-run any time to update.
npm run uninstall-service   # remove it
```

Link the QR once with `npm start` first; the session persists in `auth/`, so the
service reconnects silently. Logs go to `logs/service.log` and `logs/bridge.log`.
For Linux (`systemd --user`), see [`CLAUDE.md`](./CLAUDE.md#run-it-247).

## Security

- The bridge runs Claude with `--dangerously-skip-permissions` **on purpose** — that
  autonomy is the point. Treat `WORKDIR` as a directory you trust Claude to act in.
- Keep the allowlist tight (the default is just you).
- **Never commit `.env` or `auth/`** — `auth/` contains your live WhatsApp session
  keys. Both are gitignored.

## License

MIT © AI Makers Co
