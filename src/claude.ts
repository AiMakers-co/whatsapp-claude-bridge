import { spawn, spawnSync } from "node:child_process";
import { config } from "./config.js";

/** Verify the `claude` CLI is callable. Returns its version, or null. */
export function checkClaudeCli(): string | null {
  try {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
    if (r.status === 0) return (r.stdout || "").trim() || "unknown";
  } catch {
    /* not found */
  }
  return null;
}

export interface ClaudeResult {
  text: string;
  sessionId?: string;
  isError: boolean;
  costUsd?: number;
}

/**
 * Run Claude Code headlessly on a single task.
 *
 * Uses `claude -p ... --output-format json` so we get a structured result
 * with the session id, which we thread back in via `--resume` to keep a
 * conversation going across WhatsApp messages.
 */
export function runClaude(
  task: string,
  opts: { cwd: string; resumeSessionId?: string },
): Promise<ClaudeResult> {
  const args = [
    "-p",
    task,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
  ];
  if (config.model) args.push("--model", config.model);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);

  return new Promise((resolvePromise) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolvePromise({
        text: `Task timed out after ${config.taskTimeoutMs / 1000}s and was killed.`,
        isError: true,
      });
    }, config.taskTimeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        text: `Failed to launch Claude Code: ${err.message}. Is the \`claude\` CLI on PATH?`,
        isError: true,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const json = JSON.parse(stdout.trim());
        resolvePromise({
          text:
            json.result ??
            "(Claude returned no text result.)",
          sessionId: json.session_id,
          isError: Boolean(json.is_error),
          costUsd: json.total_cost_usd,
        });
      } catch {
        resolvePromise({
          text:
            stdout.trim() ||
            stderr.trim() ||
            `Claude exited with code ${code} and no output.`,
          isError: code !== 0,
        });
      }
    });
  });
}
