import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * Provider-agnostic agent layer.
 *
 * Every supported backend is an *agentic coding CLI* — it can read/write files
 * and run commands in a working directory, which is what makes the bridge
 * useful (a plain chat API can't touch your machine). They all share one shape:
 * spawn a binary, feed it a prompt non-interactively, read the result. So each
 * provider is just a declarative spec; the runner below is generic.
 */

export interface RunOpts {
  cwd: string;
  resumeSessionId?: string;
  model?: string;
  /** Receives a cancel handle right after spawn. cancel() kills the whole
   *  process tree (same mechanism as the timeout) and resolves the run
   *  with { isError:true, cancelled:true }, salvaging sessionId. */
  onSpawn?: (handle: { cancel: (reason?: string) => void; pid?: number }) => void;
  /** Receives synthesized progress summaries while the run streams. Only fires
   *  when the provider has a progressFromEvent mapper; enabling it switches
   *  claude to stream-json output (see build()). */
  onProgress?: (ev: ProgressEvent) => void;
}

/** One synthesized progress line — text only, never raw JSON/base64. */
export interface ProgressEvent {
  kind: "tool" | "text";
  summary: string;
}

export interface RunResult {
  text: string;
  /** Opaque id to resume the conversation, if the provider supports it. */
  sessionId?: string;
  isError: boolean;
  costUsd?: number;
  /** The run hit the hard timeout and the process tree was killed. */
  timedOut?: boolean;
  /** Externally cancelled via the onSpawn handle — process tree was killed. */
  cancelled?: boolean;
  /**
   * The stored resume id was stale (provider lost the session) and the task
   * was re-run fresh — the caller should drop its stored sessionId.
   */
  resetSession?: boolean;
  /**
   * Set by parse() ONLY for a CLI-level resume failure (no valid result
   * envelope). Never derived from the model's own output text — a task whose
   * result merely mentions "session not found" must not be re-run (it may
   * already have executed side effects).
   */
  staleSession?: boolean;
}

/** CLI diagnostics that mean the stored --resume id no longer exists.
 * "no rollout found" is codex's phrasing for a missing thread. */
const STALE_SESSION_RE = /no conversation found|no rollout found|session.*not found|invalid.*session/i;

/**
 * Pull the final result out of stream-json output (`--output-format
 * stream-json`, or a claude version that emits an event array/NDJSON instead
 * of the single json envelope). Without this the envelope scan finds no
 * `{...,"result"}` line and the caller used to dump the ENTIRE raw stream —
 * system-init events, the whole tools list, base64 blobs — into WhatsApp.
 */
function extractResultEvent(out: string): { text: string; sessionId?: string; isError: boolean; costUsd?: number } | undefined {
  const consider = (ev: any) => {
    if (!ev || typeof ev !== "object") return undefined;
    if (typeof ev.result === "string" || ev.type === "result") {
      return {
        text: typeof ev.result === "string" ? ev.result : "(no text result)",
        sessionId: ev.session_id,
        isError: Boolean(ev.is_error) || ev.subtype === "error" || ev.subtype === "error_max_turns",
        costUsd: ev.total_cost_usd,
      };
    }
    return undefined;
  };
  // Whole stdout as one JSON value (array of events, or a single object).
  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        const r = consider(parsed[i]);
        if (r) return r;
      }
    } else {
      const r = consider(parsed);
      if (r) return r;
    }
  } catch {
    /* not a single JSON value — try NDJSON below */
  }
  // NDJSON: one event object per line; scan from the end for the result event.
  for (const line of out.split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const r = consider(JSON.parse(t));
      if (r) return r;
    } catch {
      /* not this line */
    }
  }
  return undefined;
}

interface BuiltCall {
  args: string[];
  /** Optional prompt bytes to write to stdin and close immediately. */
  stdin?: string;
  parse: (o: { stdout: string; stderr: string; code: number | null }) => RunResult;
  /** Optional cleanup (e.g. temp files) run after parsing. */
  cleanup?: () => void;
}

interface ProviderSpec {
  name: string;
  bin: string;
  /** Whether resumeSessionId is honored. */
  supportsResume: boolean;
  /** One-liner shown in /use help. */
  blurb: string;
  /** argv/output changes when the caller wants live progress (stream:true). */
  build: (task: string, opts: { model?: string; resumeSessionId?: string; stream?: boolean }) => BuiltCall;
  /** Map one parsed NDJSON event to a progress summary; undefined = ignore.
   *  MUST synthesize text only — never return raw JSON/base64. */
  progressFromEvent?: (ev: unknown) => ProgressEvent | undefined;
}

// ── Provider presets ────────────────────────────────────────────────────────

const claude: ProviderSpec = {
  name: "claude",
  bin: "claude",
  supportsResume: true,
  blurb: "Anthropic Claude Code — full session continuity + cost reporting",
  build(task, { model, resumeSessionId, stream }) {
    const streaming = Boolean(stream);
    // stream-json requires --verbose alongside -p; otherwise identical argv.
    const args = streaming
      ? ["-p", task, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]
      : ["-p", task, "--output-format", "json", "--dangerously-skip-permissions"];
    if (model) args.push("--model", model);
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    return {
      args,
      parse: (o) => {
        if (streaming) {
          // Stream mode: the reverse line scan below false-matches intermediate
          // events (every one carries a string session_id), so NEVER run it.
          // Only a real result event is a valid reply.
          const fromEvents = extractResultEvent(o.stdout.trim());
          if (fromEvents) return fromEvents;

          // No result event (the fake-success bug): salvage the session id from
          // the last event that carries one (id only, never its text), and
          // return a capped diagnostic — not the raw NDJSON stream.
          let sessionId: string | undefined;
          for (const line of o.stdout.trim().split("\n").reverse()) {
            const t = line.trim();
            if (!t.startsWith("{")) continue;
            try {
              const j = JSON.parse(t);
              if (j && typeof j.session_id === "string") {
                sessionId = j.session_id;
                break;
              }
            } catch {
              /* not this line */
            }
          }
          // Prefer stderr; a stream-json stdout blob must never reach the chat.
          const stderr = o.stderr.trim();
          const diag = stderr || o.stdout.trim().slice(0, 400);
          return {
            text: diag
              ? `⚠️ Couldn't parse the agent's reply (exit ${o.code}). First bytes:\n${diag.slice(0, 400)}`
              : `claude exited with code ${o.code}`,
            isError: true,
            ...(sessionId ? { sessionId } : {}),
            // A stale --resume id is a CLI-level diagnostic printed to STDERR.
            // NEVER derive it from the model's own stream output — tool results,
            // greps and 404s can contain "not found"/"no ... session" and would
            // false-match here, silently re-running a task that already executed
            // side effects (the invariant documented on RunResult.staleSession).
            staleSession: o.code !== 0 && STALE_SESSION_RE.test(stderr),
          };
        }
        // The CLI can print stray lines around the JSON payload; scan from the
        // LAST line backwards for something that parses with the expected
        // result/session_id shape, and only fall back to raw text if nothing does.
        const lines = [o.stdout.trim(), ...o.stdout.trim().split("\n").reverse()];
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("{")) continue;
          try {
            const j = JSON.parse(t);
            if (j && (typeof j.result === "string" || typeof j.session_id === "string")) {
              return {
                text: j.result ?? "(no text result)",
                sessionId: j.session_id,
                isError: Boolean(j.is_error),
                costUsd: j.total_cost_usd,
              };
            }
          } catch {
            /* not this line */
          }
        }
        // stream-json / event-array output — extract the real result event
        // instead of dumping the raw stream to the chat.
        const fromEvents = extractResultEvent(o.stdout.trim());
        if (fromEvents) return fromEvents;

        // Genuine parse failure. NEVER forward raw stdout: a multi-KB
        // stream-json blob (system-init + tools list + base64) once flooded
        // WhatsApp. Plain non-JSON text is a safe result; anything JSON-shaped
        // gets a short, capped diagnostic instead.
        const raw = (o.stdout.trim() || o.stderr.trim());
        const jsonish = raw.startsWith("{") || raw.startsWith("[");
        const text =
          o.code === 0 && raw && !jsonish
            ? raw
            : raw
              ? `⚠️ Couldn't parse the agent's reply (exit ${o.code}). First bytes:\n${raw.slice(0, 400)}`
              : `claude exited with code ${o.code}`;
        return {
          text,
          isError: o.code !== 0,
          // Only this non-JSON fallback branch (a CLI diagnostic, not the
          // model's result) may flag a stale --resume id.
          staleSession: o.code !== 0 && STALE_SESSION_RE.test(raw),
        };
      },
    };
  },
  // claude stream-json: assistant events carry a message.content block array.
  progressFromEvent(ev) {
    const e = ev as any;
    if (!e || e.type !== "assistant") return undefined;
    const content = e.message?.content;
    if (!Array.isArray(content)) return undefined;
    const tools: string[] = [];
    let textConcat = "";
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use" && typeof block.name === "string") {
        const input = block.input && typeof block.input === "object" ? block.input : {};
        const name: string = block.name;
        let hint = "";
        if (typeof input.file_path === "string") {
          hint = `: ${basename(input.file_path)}`;
        } else if (name === "Bash" && input.command != null) {
          hint = `: ${String(input.command).slice(0, 60)}`;
        } else if ((name === "Grep" || name === "Glob") && input.pattern != null) {
          hint = `: ${String(input.pattern)}`;
        }
        tools.push(`→ ${name}${hint}`);
      } else if (block.type === "text" && typeof block.text === "string") {
        textConcat += block.text;
      }
      // thinking / other blocks are intentionally ignored (no chat noise).
    }
    if (tools.length) return { kind: "tool", summary: tools.join(", ").slice(0, 200) };
    const t = textConcat.trim();
    if (t) return { kind: "text", summary: t.slice(0, 100) };
    return undefined;
  },
};

const codex: ProviderSpec = {
  name: "codex",
  bin: "codex",
  supportsResume: true,
  blurb: "OpenAI Codex CLI — resumable sessions (run `codex login` first)",
  build(task, { model, resumeSessionId }) {
    // Random suffix: same-pid-same-millisecond concurrent tasks must not
    // share (and clobber) one temp file.
    const outFile = join(tmpdir(), `codex-last-${process.pid}-${randomUUID()}.txt`);
    const flags = [
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-o",
      outFile,
    ];
    if (model) flags.push("-m", model);
    // Codex documents `-` as "read the prompt from stdin". This avoids argv
    // length limits and keeps live WhatsApp transcripts out of process lists;
    // runOnce writes the bytes and closes stdin immediately (the missing EOF
    // was the cause of the 2026-07-10 30-minute @codex hang).
    const args = resumeSessionId
      ? ["exec", "resume", ...flags, resumeSessionId, "-"]
      : ["exec", ...flags, "-"];
    return {
      args,
      stdin: task,
      parse: (o) => {
        let fileText = "";
        try {
          fileText = readFileSync(outFile, "utf8").trim();
        } catch {
          /* file may be absent on error */
        }
        let sessionId: string | undefined;
        let errMsg: string | undefined;
        for (const line of o.stdout.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("{")) continue;
          try {
            const e = JSON.parse(t);
            if (e.type === "thread.started" && e.thread_id) sessionId = e.thread_id;
            if (e.type === "error" && e.message) errMsg = e.message;
          } catch {
            /* non-JSON log line */
          }
        }
        const text = fileText || errMsg || o.stderr.trim() || `codex exited with code ${o.code}`;
        return {
          text,
          sessionId,
          isError: o.code !== 0 || Boolean(errMsg),
          // Only the CLI's own diagnostics (its error event, or — when the run
          // died before producing any task output — its stderr) may flag a
          // stale resume id; never the outFile task output.
          staleSession: Boolean(
            (errMsg && STALE_SESSION_RE.test(errMsg)) ||
              (!fileText && o.code !== 0 && STALE_SESSION_RE.test(o.stderr)),
          ),
        };
      },
      cleanup: () => {
        try {
          unlinkSync(outFile);
        } catch {
          /* already gone */
        }
      },
    };
  },
  // codex --json stdout is already NDJSON; summarize completed items only.
  progressFromEvent(ev) {
    const e = ev as any;
    if (!e || e.type !== "item.completed" || !e.item || typeof e.item !== "object") return undefined;
    const item = e.item;
    if (item.type === "command_execution" && item.command != null) {
      return { kind: "tool", summary: `→ ran: ${String(item.command).slice(0, 60)}` };
    }
    if (item.type === "file_change" || item.type === "patch") {
      return { kind: "tool", summary: "→ edited files" };
    }
    return undefined;
  },
};

/** Plain stdout-to-text providers (no resumable session id exposed). */
function plainTextSpec(name: string, bin: string, blurb: string, modelFlag: string): ProviderSpec {
  return {
    name,
    bin,
    supportsResume: false,
    blurb,
    build(task, { model }) {
      const args = ["-p", task, "--yolo"];
      if (model) args.push(modelFlag, model);
      return {
        args,
        parse: (o) => ({
          text: o.stdout.trim() || o.stderr.trim() || `${name} exited with code ${o.code}`,
          isError: o.code !== 0,
        }),
      };
    },
  };
}

const gemini = plainTextSpec(
  "gemini",
  "gemini",
  "Google Gemini CLI — stateless per message (no session resume)",
  "-m",
);
const grok = plainTextSpec(
  "grok",
  "grok",
  "xAI Grok CLI — stateless; flags are best-effort, may need tuning",
  "-m",
);

const SPECS: Record<string, ProviderSpec> = { claude, codex, gemini, grok };

// ── Generic runner ───────────────────────────────────────────────────────────

/** Is a binary present on PATH? (Checks installed, not authenticated.) */
function onPath(bin: string): boolean {
  const which = process.platform === "win32" ? "where" : "which";
  try {
    return spawnSync(which, [bin], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Windows: npm installs CLIs as .cmd/.ps1 shims, and child_process.spawn with
 * shell:false cannot execute .cmd/.bat (only .exe) — it hard-errors. Resolve
 * the real target via `where`; a .cmd/.bat shim must be run through cmd.exe.
 */
function resolveWinBin(bin: string): string | undefined {
  try {
    const r = spawnSync("where", [bin], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) return undefined;
    return r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

export interface Provider {
  name: string;
  bin: string;
  supportsResume: boolean;
  blurb: string;
  available(): boolean;
  run(task: string, opts: RunOpts, timeoutMs: number): Promise<RunResult>;
}

function runOnce(
  spec: ProviderSpec,
  task: string,
  opts: RunOpts,
  timeoutMs: number,
  resumeSessionId: string | undefined,
): Promise<RunResult> {
  // Streaming is only meaningful when the caller wants progress AND the spec
  // knows how to map events; otherwise argv stays byte-identical to json mode.
  const stream = Boolean(opts.onProgress) && Boolean(spec.progressFromEvent);
  const call = spec.build(task, { model: opts.model, resumeSessionId, stream });
  return new Promise<RunResult>((resolve) => {
    const isWin = process.platform === "win32";
    // Unix: detached gives the child its own process group, so on timeout we
    // can kill the whole tree (agent CLIs spawn grandchildren that a plain
    // child.kill leaves orphaned and still running). Windows has no process
    // groups in that sense — spawn attached and let taskkill /T walk the tree.
    // Windows: a .cmd/.bat npm shim can't be spawned directly (shell:false);
    // run it via cmd.exe, keeping args as an array (no string interpolation).
    let bin = spec.bin;
    let args = call.args;
    if (isWin) {
      const resolved = resolveWinBin(spec.bin);
      if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
        bin = "cmd.exe";
        args = ["/d", "/s", "/c", resolved, ...call.args];
      } else if (resolved) {
        bin = resolved;
      }
    }
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: process.env,
      detached: !isWin,
      windowsHide: true,
      // Providers with explicit stdin receive a pipe that we close below;
      // argv-only providers get /dev/null / NUL rather than an open pipe.
      stdio: [call.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (call.stdin !== undefined && child.stdin) {
      // A CLI can reject flags/auth and exit before consuming a large prompt.
      // Swallow the resulting pipe error into the normal provider diagnostic;
      // an unhandled EPIPE on this stream would otherwise crash the daemon.
      child.stdin.on("error", (err) => {
        stderr += `stdin: ${err.message}\n`;
      });
      child.stdin.end(call.stdin);
    }
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      call.cleanup?.();
      resolve(r);
    };
    // Shared kill path for both the timeout and an external cancel: salvage the
    // opaque resume id from partial output, tree-kill the child, then finish.
    // The `settled` no-op protection in finish makes a late/double call safe.
    const killAndFinish = (text: string, flags: { timedOut?: boolean; cancelled?: boolean }) => {
      // Codex emits `thread.started` near the beginning of its JSONL stream.
      // Preserve that id before killing a genuinely long run so the next
      // WhatsApp request can resume the same thread. The final text still wins;
      // only the opaque resume id is recovered from partial output.
      let sessionId: string | undefined;
      try {
        sessionId = call.parse({ stdout, stderr, code: null }).sessionId;
      } catch {
        /* partial provider output may not be parseable yet */
      }
      try {
        if (isWin && child.pid) {
          // taskkill /T /F kills the whole child process tree.
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else if (child.pid) {
          process.kill(-child.pid, "SIGKILL"); // whole process group
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      finish({
        text,
        isError: true,
        ...flags,
        ...(sessionId ? { sessionId } : {}),
      });
    };
    const timer = setTimeout(
      () => killAndFinish(`Task timed out after ${timeoutMs / 1000}s and was killed.`, { timedOut: true }),
      timeoutMs,
    );
    // Hand the caller a cancel handle: same tree-kill, resolves cancelled:true.
    opts.onSpawn?.({
      cancel: (reason) => killAndFinish(reason ?? "Task was cancelled.", { cancelled: true }),
      pid: child.pid,
    });
    // When progress is wanted, split stdout into complete NDJSON lines and map
    // each to a synthesized summary. Failures (non-JSON, throwing cb) are
    // swallowed — progress must never break the run.
    const wantProgress = Boolean(opts.onProgress) && Boolean(spec.progressFromEvent);
    let lineBuf = "";
    child.stdout?.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      if (!wantProgress) return;
      lineBuf += s;
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        try {
          const ev = JSON.parse(line);
          const p = spec.progressFromEvent!(ev);
          if (p) opts.onProgress!(p);
        } catch {
          /* not JSON / cb error — never break the run */
        }
      }
    });
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      finish({
        text: `Failed to launch \`${spec.bin}\`: ${err.message}. Is it installed and on PATH?`,
        isError: true,
      }),
    );
    child.on("close", (code) => finish(call.parse({ stdout, stderr, code })));
  });
}

export function getProvider(name: string): Provider | undefined {
  const spec = SPECS[name];
  if (!spec) return undefined;
  return {
    name: spec.name,
    bin: spec.bin,
    supportsResume: spec.supportsResume,
    blurb: spec.blurb,
    available: () => onPath(spec.bin),
    run: async (task, opts, timeoutMs) => {
      // Only thread the resume id to providers that support it.
      const resumeSessionId = spec.supportsResume ? opts.resumeSessionId : undefined;
      const first = await runOnce(spec, task, opts, timeoutMs, resumeSessionId);
      // Stale --resume id (provider lost/expired the session): retry ONCE
      // fresh and tell the caller to drop its stored session id. Gated on the
      // parse-level staleSession flag, never on the result text itself.
      if (first.isError && !first.timedOut && !first.cancelled && resumeSessionId && first.staleSession) {
        const retry = await runOnce(spec, task, opts, timeoutMs, undefined);
        return { ...retry, resetSession: true };
      }
      return first;
    },
  };
}

export function providerNames(): string[] {
  return Object.keys(SPECS);
}
