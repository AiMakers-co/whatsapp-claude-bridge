import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
}

export interface RunResult {
  text: string;
  /** Opaque id to resume the conversation, if the provider supports it. */
  sessionId?: string;
  isError: boolean;
  costUsd?: number;
  /** The run hit the hard timeout and the process tree was killed. */
  timedOut?: boolean;
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

interface BuiltCall {
  args: string[];
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
  build: (task: string, opts: { model?: string; resumeSessionId?: string }) => BuiltCall;
}

// ── Provider presets ────────────────────────────────────────────────────────

const claude: ProviderSpec = {
  name: "claude",
  bin: "claude",
  supportsResume: true,
  blurb: "Anthropic Claude Code — full session continuity + cost reporting",
  build(task, { model, resumeSessionId }) {
    const args = ["-p", task, "--output-format", "json", "--dangerously-skip-permissions"];
    if (model) args.push("--model", model);
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    return {
      args,
      parse: (o) => {
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
        const text = o.stdout.trim() || o.stderr.trim() || `claude exited with code ${o.code}`;
        return {
          text,
          isError: o.code !== 0,
          // Only this non-JSON fallback branch (a CLI diagnostic, not the
          // model's result) may flag a stale --resume id.
          staleSession: o.code !== 0 && STALE_SESSION_RE.test(text),
        };
      },
    };
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
    const args = resumeSessionId
      ? ["exec", "resume", resumeSessionId, ...flags, task]
      : ["exec", ...flags, task];
    return {
      args,
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
  const call = spec.build(task, { model: opts.model, resumeSessionId });
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
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      call.cleanup?.();
      resolve(r);
    };
    const timer = setTimeout(() => {
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
        text: `Task timed out after ${timeoutMs / 1000}s and was killed.`,
        isError: true,
        timedOut: true,
      });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
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
      if (first.isError && !first.timedOut && resumeSessionId && first.staleSession) {
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
