import { spawn, spawnSync } from "node:child_process";
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
}

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
        try {
          const j = JSON.parse(o.stdout.trim());
          return {
            text: j.result ?? "(no text result)",
            sessionId: j.session_id,
            isError: Boolean(j.is_error),
            costUsd: j.total_cost_usd,
          };
        } catch {
          return {
            text: o.stdout.trim() || o.stderr.trim() || `claude exited with code ${o.code}`,
            isError: o.code !== 0,
          };
        }
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
    const outFile = join(tmpdir(), `codex-last-${process.pid}-${Date.now()}.txt`);
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
        let text = "";
        try {
          text = readFileSync(outFile, "utf8").trim();
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
        if (!text) text = errMsg || o.stderr.trim() || `codex exited with code ${o.code}`;
        return { text, sessionId, isError: o.code !== 0 || Boolean(errMsg) };
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

export interface Provider {
  name: string;
  bin: string;
  supportsResume: boolean;
  blurb: string;
  available(): boolean;
  run(task: string, opts: RunOpts, timeoutMs: number): Promise<RunResult>;
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
    run: (task, opts, timeoutMs) => {
      // Only thread the resume id to providers that support it.
      const resumeSessionId = spec.supportsResume ? opts.resumeSessionId : undefined;
      const call = spec.build(task, { model: opts.model, resumeSessionId });
      return new Promise<RunResult>((resolve) => {
        const child = spawn(spec.bin, call.args, { cwd: opts.cwd, env: process.env });
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
          child.kill("SIGKILL");
          finish({ text: `Task timed out after ${timeoutMs / 1000}s and was killed.`, isError: true });
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
    },
  };
}

export function providerNames(): string[] {
  return Object.keys(SPECS);
}
