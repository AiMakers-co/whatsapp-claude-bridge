import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getProvider, type ProgressEvent } from "../src/providers.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Write a fake CLI (`binName`) onto a fresh temp dir and return that dir. */
function makeFakeBinDir(binName: string, script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wa-bridge-prov-"));
  const bin = join(dir, binName);
  writeFileSync(bin, script, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return dir;
}

// node:test runs top-level tests concurrently, but every test here prepends its
// own fake dir onto the shared process.env.PATH — concurrent runs would pick up
// each other's `claude`/`codex`. Serialize the PATH-sensitive bodies.
let pathLock: Promise<unknown> = Promise.resolve();
function serialTest(name: string, fn: (t: any) => Promise<void>): void {
  test(name, (t) => {
    const result = pathLock.then(() => fn(t));
    pathLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  });
}

serialTest("codex receives a closed stdin prompt and preserves its thread on timeout", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable in this regression test is Unix-only");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "wa-bridge-provider-test-"));
  const fakeCodex = join(dir, "codex");
  const oldPath = process.env.PATH;
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const outIndex = args.indexOf("-o");
const outFile = outIndex >= 0 ? args[outIndex + 1] : "";
if (args.includes("exit-immediately")) process.exit(2);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "test-thread-id" }) + "\\n");
  if (prompt.includes("HANG")) {
    setInterval(() => {}, 10_000);
    return;
  }
  const leakedIntoArgv = args.some((arg) => arg.includes(prompt.trim()));
  writeFileSync(outFile, prompt.trim() + (leakedIntoArgv ? "_ARGV_LEAK" : "_OK"));
});
`,
    { mode: 0o755 },
  );
  chmodSync(fakeCodex, 0o755);
  process.env.PATH = `${dir}:${oldPath ?? ""}`;

  try {
    const provider = getProvider("codex");
    assert.ok(provider);

    const fresh = await provider.run("FRESH", { cwd: dir }, 2_000);
    assert.equal(fresh.isError, false);
    assert.equal(fresh.text, "FRESH_OK");
    assert.equal(fresh.sessionId, "test-thread-id");

    const resumed = await provider.run(
      "RESUME",
      { cwd: dir, resumeSessionId: fresh.sessionId },
      2_000,
    );
    assert.equal(resumed.isError, false);
    assert.equal(resumed.text, "RESUME_OK");
    assert.equal(resumed.sessionId, fresh.sessionId);

    // A fast CLI failure must not turn a large stdin write into an unhandled
    // EPIPE that crashes the long-running bridge daemon.
    const rejected = await provider.run(
      "X".repeat(1024 * 1024),
      { cwd: dir, model: "exit-immediately" },
      2_000,
    );
    assert.equal(rejected.isError, true);

    const timedOut = await provider.run("HANG", { cwd: dir }, 100);
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.sessionId, "test-thread-id");
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── §1 external cancel handle ────────────────────────────────────────────────

serialTest("cancel() kills the process tree and resolves cancelled:true", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable is Unix-only");
    return;
  }
  const dir = makeFakeBinDir(
    "claude",
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const path = require("node:path");
const hb = path.join(process.cwd(), "heartbeat");
setInterval(() => { try { appendFileSync(hb, "x"); } catch {} }, 25);
`,
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    const provider = getProvider("claude");
    assert.ok(provider);

    let handle: { cancel: (r?: string) => void; pid?: number } | undefined;
    const runP = provider.run("hi", { cwd: dir, onSpawn: (h) => (handle = h) }, 60_000);
    await delay(600);
    assert.ok(handle, "onSpawn fired with a handle");
    assert.equal(typeof handle!.pid, "number");
    handle!.cancel();
    const res = await runP;
    assert.equal(res.cancelled, true);
    assert.equal(res.isError, true);

    // The killed tree writes no more heartbeats.
    const hbFile = join(dir, "heartbeat");
    const size1 = statSync(hbFile).size;
    await delay(200);
    const size2 = statSync(hbFile).size;
    assert.equal(size1, size2);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

serialTest("cancel() salvages the sessionId from partial NDJSON", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable is Unix-only");
    return;
  }
  const dir = makeFakeBinDir(
    "codex",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "test-thread-id" }) + "\\n");
setInterval(() => {}, 10_000);
`,
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    const provider = getProvider("codex");
    assert.ok(provider);

    let handle: { cancel: (r?: string) => void } | undefined;
    const runP = provider.run("hi", { cwd: dir, onSpawn: (h) => (handle = h) }, 60_000);
    await delay(600);
    handle!.cancel();
    const res = await runP;
    assert.equal(res.cancelled, true);
    assert.equal(res.isError, true);
    assert.equal(res.sessionId, "test-thread-id");
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

serialTest("cancel after close and double-cancel are no-ops", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable is Unix-only");
    return;
  }
  // Fast fake: exits with a clean json result before any cancel.
  const fastDir = makeFakeBinDir(
    "claude",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "result", result: "done", session_id: "s1", is_error: false }) + "\\n");
`,
  );
  // Hanging fake: for double-cancel mid-run.
  const hangDir = makeFakeBinDir(
    "claude",
    `#!/usr/bin/env node
setInterval(() => {}, 10_000);
`,
  );
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fastDir}:${oldPath ?? ""}`;
    const provider = getProvider("claude");
    assert.ok(provider);
    let handle: { cancel: (r?: string) => void } | undefined;
    const res = await provider.run("hi", { cwd: fastDir, onSpawn: (h) => (handle = h) }, 5_000);
    assert.equal(res.isError, false);
    assert.equal(res.text, "done");
    // Natural close already resolved — cancel is a harmless no-op.
    handle!.cancel();
    handle!.cancel();

    process.env.PATH = `${hangDir}:${oldPath ?? ""}`;
    const provider2 = getProvider("claude");
    let handle2: { cancel: (r?: string) => void } | undefined;
    const runP = provider2!.run("hi", { cwd: hangDir, onSpawn: (h) => (handle2 = h) }, 60_000);
    await delay(500);
    handle2!.cancel();
    handle2!.cancel(); // second cancel is a no-op
    const res2 = await runP;
    assert.equal(res2.cancelled, true);
  } finally {
    process.env.PATH = oldPath;
    rmSync(fastDir, { recursive: true, force: true });
    rmSync(hangDir, { recursive: true, force: true });
  }
});

serialTest("stale-session retry is suppressed after cancel", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable is Unix-only");
    return;
  }
  const dir = makeFakeBinDir(
    "claude",
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
appendFileSync(path.join(process.cwd(), "invocations"), "x");
if (args.includes("--resume")) {
  // A stale resume would exit 1, but hang so the test can cancel first.
  setInterval(() => {}, 10_000);
} else {
  process.stdout.write(JSON.stringify({ type: "result", result: "fresh", session_id: "s2", is_error: false }) + "\\n");
}
`,
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    const provider = getProvider("claude");
    assert.ok(provider);
    let handle: { cancel: (r?: string) => void } | undefined;
    const runP = provider.run(
      "hi",
      { cwd: dir, resumeSessionId: "old", onSpawn: (h) => (handle = h) },
      60_000,
    );
    await delay(600);
    handle!.cancel();
    const res = await runP;
    assert.equal(res.cancelled, true);
    // No fresh retry: only one invocation ever ran.
    assert.equal(readFileSync(join(dir, "invocations"), "utf8").length, 1);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

serialTest("onSpawn is forwarded to the stale-session retry run", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable is Unix-only");
    return;
  }
  const dir = makeFakeBinDir(
    "claude",
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--resume")) {
  process.stderr.write("No conversation found with session ID: old\\n");
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({ type: "result", result: "ok", session_id: "s2", is_error: false }) + "\\n");
}
`,
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    const provider = getProvider("claude");
    assert.ok(provider);
    let spawns = 0;
    const res = await provider.run(
      "hi",
      { cwd: dir, resumeSessionId: "old", onSpawn: () => spawns++ },
      5_000,
    );
    assert.equal(res.resetSession, true);
    assert.equal(res.text, "ok");
    assert.equal(spawns, 2);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── §2 stream-json progress + parse fix ──────────────────────────────────────

serialTest("no onProgress ⇒ claude argv is byte-identical to json mode", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable is Unix-only");
    return;
  }
  const dir = makeFakeBinDir(
    "claude",
    `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ type: "result", result: args.join(" "), session_id: "s", is_error: false }) + "\\n");
`,
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    const provider = getProvider("claude");
    assert.ok(provider);
    const res = await provider.run("hello", { cwd: dir }, 5_000);
    assert.equal(res.isError, false);
    assert.ok(res.text.includes("--output-format json"), res.text);
    assert.ok(!res.text.includes("--verbose"), res.text);
    assert.ok(!res.text.includes("stream-json"), res.text);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

serialTest("stream happy path yields synthesized summaries + a clean result", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable is Unix-only");
    return;
  }
  const dir = makeFakeBinDir(
    "claude",
    `#!/usr/bin/env node
const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
w({ type: "system", subtype: "init", session_id: "sess1", tools: ["Read", "Bash"], blob: "QUJDREVGRw==" });
w({ type: "assistant", session_id: "sess1", message: { content: [{ type: "thinking", thinking: "…" }, { type: "tool_use", name: "Read", input: { file_path: "/tmp/foo/bar.ts" } }] } });
w({ type: "assistant", session_id: "sess1", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test && echo done" } }] } });
w({ type: "assistant", session_id: "sess1", message: { content: [{ type: "text", text: "All good, finished the task." }] } });
w({ type: "result", subtype: "success", is_error: false, result: "All good, finished the task.", session_id: "sess1", total_cost_usd: 0.01 });
`,
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    const provider = getProvider("claude");
    assert.ok(provider);
    const summaries: ProgressEvent[] = [];
    const res = await provider.run("hi", { cwd: dir, onProgress: (ev) => summaries.push(ev) }, 5_000);
    assert.equal(res.isError, false);
    assert.equal(res.text, "All good, finished the task.");
    assert.equal(res.sessionId, "sess1");
    assert.equal(res.costUsd, 0.01);
    // Nothing raw leaked into progress.
    for (const ev of summaries) {
      assert.ok(!ev.summary.includes("{"), ev.summary);
      assert.ok(!ev.summary.includes("QUJDREVG"), ev.summary);
    }
    const joined = summaries.map((s) => s.summary).join("\n");
    assert.ok(joined.includes("Read"), joined);
    assert.ok(joined.includes("bar.ts"), joined);
    assert.ok(joined.includes("Bash"), joined);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

serialTest("stream with no result event ⇒ isError + diagnostic + salvaged sessionId", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable is Unix-only");
    return;
  }
  const dir = makeFakeBinDir(
    "claude",
    `#!/usr/bin/env node
const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
w({ type: "system", subtype: "init", session_id: "sX", tools: ["Read"] });
w({ type: "assistant", session_id: "sX", message: { content: [{ type: "text", text: "working" }] } });
process.exit(1);
`,
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    const provider = getProvider("claude");
    assert.ok(provider);
    const res = await provider.run("hi", { cwd: dir, onProgress: () => {} }, 5_000);
    assert.equal(res.isError, true);
    assert.ok(res.text.startsWith("⚠️ Couldn't parse"), res.text);
    assert.ok(!res.text.includes("(no text result)"), res.text);
    assert.equal(res.sessionId, "sX");
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

serialTest("stream mode never derives staleSession from the model's own output", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable is Unix-only");
    return;
  }
  // Regression: a resumed stream turn dies (exit 1) with NO result event and
  // EMPTY stderr, but its tool output on stdout contains "not found" (a grep, a
  // 404, "file not found"). staleSession must be derived from the CLI diagnostic
  // (stderr) ONLY — otherwise the task is silently re-run fresh, re-executing
  // side effects it already committed. Assert: single invocation (no retry).
  const dir = makeFakeBinDir(
    "claude",
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const path = require("node:path");
appendFileSync(path.join(process.cwd(), "inv3"), "x");
const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
w({ type: "system", subtype: "init", session_id: "sN", tools: ["Bash"] });
w({ type: "assistant", session_id: "sN", message: { content: [{ type: "text", text: "grep says: session file not found, no conversation found here" }] } });
process.exit(1);
`,
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    const provider = getProvider("claude");
    assert.ok(provider);
    const res = await provider.run(
      "hi",
      { cwd: dir, resumeSessionId: "old", onProgress: () => {} },
      5_000,
    );
    assert.equal(res.isError, true);
    assert.notEqual(res.staleSession, true); // NOT flagged from stdout text
    assert.notEqual(res.resetSession, true); // ⇒ no fresh re-run happened
    assert.equal(readFileSync(join(dir, "inv3"), "utf8").length, 1); // invoked once
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

serialTest("stream timeout salvages sessionId from partial output", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable is Unix-only");
    return;
  }
  const dir = makeFakeBinDir(
    "claude",
    `#!/usr/bin/env node
const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
w({ type: "system", subtype: "init", session_id: "sT", tools: ["Read"] });
setInterval(() => {}, 10_000);
`,
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    const provider = getProvider("claude");
    assert.ok(provider);
    // Generous timeout: the fake still hangs forever, so the run always times
    // out, but this leaves ample room for node startup + the init line under
    // concurrent CPU load (a 200ms budget flaked when the emit lost the race).
    const res = await provider.run("hi", { cwd: dir, onProgress: () => {} }, 1_500);
    assert.equal(res.timedOut, true);
    assert.equal(res.sessionId, "sT");
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

serialTest("stream stale-session flows and retries fresh once", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable is Unix-only");
    return;
  }
  const dir = makeFakeBinDir(
    "claude",
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
appendFileSync(path.join(process.cwd(), "inv2"), "x");
if (args.includes("--resume")) {
  process.stderr.write("No conversation found with session ID: old\\n");
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "fresh ok", session_id: "sf" }) + "\\n");
}
`,
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    const provider = getProvider("claude");
    assert.ok(provider);
    const res = await provider.run(
      "hi",
      { cwd: dir, resumeSessionId: "old", onProgress: () => {} },
      5_000,
    );
    assert.equal(res.resetSession, true);
    assert.equal(res.text, "fresh ok");
    assert.equal(readFileSync(join(dir, "inv2"), "utf8").length, 2);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

serialTest("codex item.completed events map to progress summaries", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable is Unix-only");
    return;
  }
  const dir = makeFakeBinDir(
    "codex",
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const oi = args.indexOf("-o");
const outFile = oi >= 0 ? args[oi + 1] : "";
const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  w({ type: "thread.started", thread_id: "th1" });
  w({ type: "item.completed", item: { type: "command_execution", command: "ls -la /tmp && pwd" } });
  w({ type: "item.completed", item: { type: "file_change" } });
  w({ type: "item.completed", item: { type: "reasoning" } });
  writeFileSync(outFile, "codex done");
});
`,
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    const provider = getProvider("codex");
    assert.ok(provider);
    const summaries: ProgressEvent[] = [];
    const res = await provider.run("hi", { cwd: dir, onProgress: (ev) => summaries.push(ev) }, 5_000);
    assert.equal(res.isError, false);
    assert.equal(res.text, "codex done");
    const texts = summaries.map((s) => s.summary);
    // thread.started + reasoning produce nothing; only the two known items map.
    assert.equal(summaries.length, 2);
    assert.ok(texts.some((s) => s.includes("ran: ls -la")), texts.join(" | "));
    assert.ok(texts.some((s) => s === "→ edited files"), texts.join(" | "));
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

serialTest("malformed NDJSON lines and a throwing onProgress never break the run", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fake executable is Unix-only");
    return;
  }
  const dir = makeFakeBinDir(
    "claude",
    `#!/usr/bin/env node
process.stdout.write("not json at all\\n");
process.stdout.write("{ broken json\\n");
process.stdout.write(JSON.stringify({ type: "assistant", session_id: "s", message: { content: [{ type: "text", text: "hi there" }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "final", session_id: "s" }) + "\\n");
`,
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    const provider = getProvider("claude");
    assert.ok(provider);
    const res = await provider.run(
      "hi",
      {
        cwd: dir,
        onProgress: () => {
          throw new Error("boom");
        },
      },
      5_000,
    );
    assert.equal(res.isError, false);
    assert.equal(res.text, "final");
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
