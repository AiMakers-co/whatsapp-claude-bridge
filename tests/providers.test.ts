import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getProvider } from "../src/providers.js";

test("codex receives a closed stdin prompt and preserves its thread on timeout", async (t) => {
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
