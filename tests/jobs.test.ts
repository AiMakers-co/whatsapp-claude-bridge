import "./helpers/test-home.js"; // must precede any src/config.js importer
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  JobRunner,
  JobStore,
  shouldReapOrphan,
  sweepJobRequests,
  type JobGuard,
  type JobRecord,
  type JobRunnerDeps,
} from "../src/jobs.js";
import type { Provider, RunResult } from "../src/providers.js";

const delay = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

function storeFixture(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "wa-jobs-"));
  return { dir, file: join(dir, "jobs.json") };
}

function jobInput(over: Partial<JobRecord> = {}): Omit<JobRecord, "seq" | "version"> {
  return {
    id: over.id ?? "j" + Math.random().toString(36).slice(2, 6),
    createdAt: Date.now(),
    chatKey: "chat",
    remoteJid: "chat@s.whatsapp.net",
    sourceLabel: "Computer",
    provider: "stub",
    cwd: "/tmp",
    task: "do the thing",
    note: "note",
    origin: "command",
    guard: { chatKey: "chat", generation: 0 },
    status: "queued",
    ...over,
  };
}

// ── JobStore (§4.17) ────────────────────────────────────────────────────────

test("JobStore.add resolves only after the row is durably on disk", async () => {
  const { dir, file } = storeFixture();
  try {
    const store = new JobStore(file);
    const job = await store.add(jobInput({ id: "jaaa1", task: "persist-me" }));
    // Read the file INSIDE the await's continuation: it must already be there.
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(onDisk.jobs.length, 1);
    assert.equal(onDisk.jobs[0].id, "jaaa1");
    assert.equal(onDisk.jobs[0].task, "persist-me");
    assert.equal(job.seq, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent JobStore updates serialize without corrupting the file", async () => {
  const { dir, file } = storeFixture();
  try {
    const store = new JobStore(file);
    await store.add(jobInput({ id: "jc0", status: "running" }));
    await Promise.all(
      Array.from({ length: 8 }, (_, n) => store.update("jc0", { costUsd: n })),
    );
    const onDisk = JSON.parse(readFileSync(file, "utf8")); // parses => never half-written
    assert.equal(onDisk.jobs.length, 1);
    assert.equal(store.snapshot()[0].costUsd, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt jobs.json is renamed aside and the store starts empty", () => {
  const { dir, file } = storeFixture();
  try {
    writeFileSync(file, "{ not json at all", "utf8");
    const store = new JobStore(file);
    assert.deepEqual(store.snapshot(), []);
    const names = readdirSync(dir);
    assert.ok(names.some((n) => n.startsWith("jobs.json.corrupt-")));
    assert.ok(!names.includes("jobs.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal rows are pruned beyond 50, keeping the newest by seq", async () => {
  const { dir, file } = storeFixture();
  try {
    const store = new JobStore(file);
    for (let i = 0; i < 60; i++) {
      await store.add(jobInput({ id: `jt${i}`, status: "done" }));
    }
    const snap = store.snapshot();
    assert.equal(snap.length, 50);
    // seqs 1..60 were assigned; the newest 50 (11..60) survive.
    assert.equal(snap[0].seq, 11);
    assert.equal(snap[snap.length - 1].seq, 60);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live (running) row is never pruned even past the terminal cap", async () => {
  const { dir, file } = storeFixture();
  try {
    const store = new JobStore(file);
    await store.add(jobInput({ id: "jlive", status: "running" }));
    for (let i = 0; i < 60; i++) await store.add(jobInput({ id: `jd${i}`, status: "done" }));
    const snap = store.snapshot();
    assert.ok(snap.some((j) => j.id === "jlive"));
    assert.equal(snap.filter((j) => j.status === "done").length, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flushSync persists the current state for the exit path", async () => {
  const { dir, file } = storeFixture();
  try {
    const store = new JobStore(file);
    await store.add(jobInput({ id: "jexit", task: "flush-me" }));
    store.flushSync();
    const restored = new JobStore(file).snapshot();
    assert.equal(restored.length, 1);
    assert.equal(restored[0].id, "jexit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── JobRunner harness ───────────────────────────────────────────────────────

interface Harness {
  runner: JobRunner;
  store: JobStore;
  runOrder: string[];
  posted: string[];
  notes: Array<{ jid: string; text: string }>;
  /** Resolve a job's provider.run by task string. */
  finish: (task: string, res: RunResult) => void;
  /** Was a running job's cancel handle invoked? */
  cancelled: Set<string>;
  setGuardValid: (fn: (g: JobGuard) => boolean) => void;
  cleanup: () => Promise<void>;
}

function makeHarness(over: Partial<JobRunnerDeps> = {}): Harness {
  const { file } = storeFixture();
  const store = new JobStore(file);
  const runOrder: string[] = [];
  const posted: string[] = [];
  const notes: Array<{ jid: string; text: string }> = [];
  const cancelled = new Set<string>();
  const pending = new Map<string, (res: RunResult) => void>();
  let guardValid: (g: JobGuard) => boolean = () => true;

  const stub: Provider = {
    name: "stub",
    bin: "stub-bin",
    supportsResume: false,
    blurb: "",
    available: () => true,
    run: (task, opts) =>
      new Promise<RunResult>((resolve) => {
        runOrder.push(task);
        opts.onSpawn?.({
          cancel: () => {
            cancelled.add(task);
            resolve({ text: "cancelled", isError: true, cancelled: true });
          },
          pid: 4242,
        });
        pending.set(task, resolve);
      }),
  };

  const runner = new JobRunner({
    store,
    getProvider: (name) => (name === "stub" ? stub : undefined),
    modelFor: () => undefined,
    isGuardValid: (g) => guardValid(g),
    deliver: async (job) => {
      if (!guardValid(job.guard)) {
        runner.markSuppressed(job.id);
        return;
      }
      posted.push(job.id);
    },
    notify: (jid, text) => void notes.push({ jid, text }),
    progressSend: () => {},
    jobTimeoutMs: 60_000,
    maxConcurrent: 3,
    maxQueued: 10,
    progressIntervalMs: 0, // inert reporter — no dangling timers in tests
    progressMaxUpdates: 8,
    ...over,
  });

  return {
    runner,
    store,
    runOrder,
    posted,
    notes,
    cancelled,
    finish: (task, res) => pending.get(task)?.(res),
    setGuardValid: (fn) => (guardValid = fn),
    cleanup: async () => {
      // Leave still-hanging runs UNRESOLVED (an unsettled promise with no timer
      // keeps nothing alive). Settle first so any fire-and-forget store write
      // already in flight (e.g. the onSpawn pid/binHint patch) lands before the
      // dir is removed — otherwise its persist would mkdir into a deleted path.
      await delay(20);
      rmSync(join(file, ".."), { recursive: true, force: true });
    },
  };
}

function spawnReq(over: Partial<Parameters<JobRunner["spawn"]>[0]> = {}) {
  return {
    remoteJid: "chat@s.whatsapp.net",
    chatKey: "chat",
    sourceLabel: "Computer",
    provider: "stub",
    cwd: "/tmp",
    task: "t",
    note: "n",
    origin: "command" as const,
    guard: { chatKey: "chat", generation: 0 },
    ...over,
  };
}

// ── JobRunner (§4.18–23) ────────────────────────────────────────────────────

test("durable-before-admitted: the row is on disk before the provider runs", async () => {
  const h = makeHarness();
  try {
    const res = await h.runner.spawn(spawnReq({ task: "durable" }));
    assert.ok(res.ok);
    await delay();
    // spawn awaits store.add, and execute awaits store.update(running) before
    // provider.run — so by the time the provider ran, the row is on disk.
    assert.ok(h.store.snapshot().some((j) => j.task === "durable"));
    assert.deepEqual(h.runOrder, ["durable"]);
  } finally {
    await h.cleanup();
  }
});

test("concurrency cap holds a 4th job queued in FIFO order until one settles", async () => {
  const h = makeHarness({ maxConcurrent: 3 });
  try {
    for (const t of ["t1", "t2", "t3", "t4"]) await h.runner.spawn(spawnReq({ task: t }));
    await delay();
    assert.deepEqual(h.runOrder, ["t1", "t2", "t3"]);
    assert.deepEqual(h.runner.counts(), { running: 3, queued: 1 });

    h.finish("t1", { text: "done", isError: false });
    await delay();
    assert.deepEqual(h.runOrder, ["t1", "t2", "t3", "t4"]); // FIFO: t4 admitted
    assert.equal(h.runner.counts().running, 3);
  } finally {
    await h.cleanup();
  }
});

test("maxQueued rejection returns {ok:false, reason}", async () => {
  const h = makeHarness({ maxConcurrent: 1, maxQueued: 1 });
  try {
    await h.runner.spawn(spawnReq({ task: "run" })); // runs
    await h.runner.spawn(spawnReq({ task: "wait" })); // queued (fills maxQueued)
    const third = await h.runner.spawn(spawnReq({ task: "reject" }));
    assert.deepEqual(third, { ok: false, reason: "queue full" });
    assert.deepEqual(h.runOrder, ["run"]);
  } finally {
    await h.cleanup();
  }
});

test("empty task and unknown provider are rejected before any spawn", async () => {
  const h = makeHarness();
  try {
    assert.equal((await h.runner.spawn(spawnReq({ task: "   " }))).ok, false);
    assert.equal((await h.runner.spawn(spawnReq({ provider: "nope" }))).ok, false);
    assert.deepEqual(h.runOrder, []);
  } finally {
    await h.cleanup();
  }
});

test("lazy supersede: a guard-invalid queued job is superseded, never run", async () => {
  const h = makeHarness();
  try {
    h.setGuardValid(() => false); // stale before pump reaches it
    const res = await h.runner.spawn(spawnReq({ task: "stale" }));
    assert.ok(res.ok);
    await delay();
    assert.deepEqual(h.runOrder, []); // provider never invoked
    const job = h.store.snapshot().find((j) => j.task === "stale");
    assert.equal(job?.status, "superseded");
  } finally {
    await h.cleanup();
  }
});

test("delivery guard: a chat reset before settle suppresses delivery, retains result", async () => {
  const h = makeHarness();
  try {
    const res = await h.runner.spawn(spawnReq({ task: "work", id: undefined }));
    assert.ok(res.ok);
    const id = res.ok ? res.id : "";
    await delay();
    assert.deepEqual(h.runOrder, ["work"]);

    h.setGuardValid(() => false); // chat reset while the job ran
    h.finish("work", { text: "the result", isError: false });
    await delay();

    const job = h.store.snapshot().find((j) => j.id === id);
    assert.equal(job?.status, "suppressed");
    assert.equal(job?.resultPreview, "the result"); // retained
    assert.deepEqual(h.posted, []); // never posted to the chat
  } finally {
    await h.cleanup();
  }
});

test("kill(queued) removes it before it runs; kill(unknown) is not-found", async () => {
  const h = makeHarness({ maxConcurrent: 1 });
  try {
    const r1 = await h.runner.spawn(spawnReq({ task: "runner" }));
    const r2 = await h.runner.spawn(spawnReq({ task: "waiter" }));
    await delay();
    const waiterId = r2.ok ? r2.id : "";
    assert.equal(h.runner.kill(waiterId), "cancelled-queued");
    assert.equal(h.runner.kill("jzzzz"), "not-found");
    await delay(); // the queued-kill store write is fire-and-forget
    const waiter = h.store.snapshot().find((j) => j.id === waiterId);
    assert.equal(waiter?.status, "killed");
    assert.deepEqual(h.runOrder, ["runner"]); // waiter never ran
    void r1;
  } finally {
    await h.cleanup();
  }
});

test("kill(running) cancels the handle, marks killed, and never delivers", async () => {
  const h = makeHarness();
  try {
    const res = await h.runner.spawn(spawnReq({ task: "victim" }));
    const id = res.ok ? res.id : "";
    await delay();
    assert.equal(h.runner.kill(id), "killed");
    await delay();
    assert.ok(h.cancelled.has("victim")); // cancel handle fired (tree-kill)
    const job = h.store.snapshot().find((j) => j.id === id);
    assert.equal(job?.status, "killed");
    assert.deepEqual(h.posted, []); // /kill already confirmed — no completion post
  } finally {
    await h.cleanup();
  }
});

test("kill() during the pump→onSpawn window still kills (race)", async () => {
  // The job is admitted and set "running" but its cancel handle has not
  // registered yet (onSpawn deferred). The OLD code found it in neither the
  // FIFO nor the handles map and wrongly returned "already-done", letting the
  // job run to completion and deliver despite the /kill.
  let fireSpawn: (() => void) | undefined;
  let raceCancelled = false;
  const deferred: Provider = {
    name: "stub",
    bin: "stub-bin",
    supportsResume: false,
    blurb: "",
    available: () => true,
    run: (_task, opts) =>
      new Promise<RunResult>((resolve) => {
        fireSpawn = () =>
          opts.onSpawn?.({
            cancel: () => {
              raceCancelled = true;
              resolve({ text: "cancelled", isError: true, cancelled: true });
            },
            pid: 4242,
          });
      }),
  };
  const h = makeHarness({ getProvider: (n) => (n === "stub" ? deferred : undefined) });
  try {
    const res = await h.runner.spawn(spawnReq({ task: "racer" }));
    const id = res.ok ? res.id : "";
    await delay(); // admitted + status "running", but onSpawn not yet fired
    assert.equal(h.store.snapshot().find((j) => j.id === id)?.status, "running");
    assert.equal(h.runner.kill(id), "killed"); // race branch — not "already-done"
    fireSpawn!(); // handle registers → honors the pending kill immediately
    await delay();
    assert.ok(raceCancelled);
    assert.equal(h.store.snapshot().find((j) => j.id === id)?.status, "killed");
    assert.deepEqual(h.posted, []); // result suppressed, never delivered
  } finally {
    await h.cleanup();
  }
});

test("PROGRESS_INTERVAL_SECONDS=0 keeps jobs off stream mode (no onProgress)", async () => {
  // The progress kill switch must reach the job path too: with the interval at
  // 0, provider.run must receive NO onProgress callback, so claude keeps today's
  // plain-json argv (runOnce derives stream mode from Boolean(opts.onProgress)).
  const seen: Array<unknown> = [];
  const stub: Provider = {
    name: "stub",
    bin: "stub-bin",
    supportsResume: false,
    blurb: "",
    available: () => true,
    run: (_task, opts) =>
      new Promise<RunResult>((resolve) => {
        seen.push(opts.onProgress);
        opts.onSpawn?.({ cancel: () => resolve({ text: "x", isError: true }), pid: 1 });
        resolve({ text: "done", isError: false });
      }),
  };
  const off = makeHarness({
    getProvider: (n) => (n === "stub" ? stub : undefined),
    progressIntervalMs: 0,
  });
  try {
    await off.runner.spawn(spawnReq({ task: "quiet" }));
    await delay(20);
    assert.equal(seen[0], undefined); // kill switch honored — no streaming
  } finally {
    await off.cleanup();
  }
  const on = makeHarness({
    getProvider: (n) => (n === "stub" ? stub : undefined),
    progressIntervalMs: 15_000,
  });
  try {
    await on.runner.spawn(spawnReq({ task: "loud" }));
    await delay(20);
    assert.equal(typeof seen[1], "function"); // streaming wired when interval > 0
  } finally {
    await on.cleanup();
  }
});

test("kill(done) reports already-done", async () => {
  const h = makeHarness();
  try {
    const res = await h.runner.spawn(spawnReq({ task: "quick" }));
    const id = res.ok ? res.id : "";
    await delay();
    h.finish("quick", { text: "ok", isError: false });
    await delay();
    assert.equal(h.runner.kill(id), "already-done");
    assert.deepEqual(h.posted, [id]); // it delivered normally
  } finally {
    await h.cleanup();
  }
});

test("job ids re-roll on collision with an existing stored id", async () => {
  const h = makeHarness();
  try {
    await h.store.add(jobInput({ id: "jabcd", status: "done" }));
    // Force the first id roll to collide with the seeded "jabcd", then hand out
    // a free "jefgh" on the re-roll. `+0.5` centres each value in its base36
    // bucket so the 4-digit prefix survives float rounding.
    const realRandom = Math.random;
    const seq = [
      (parseInt("abcd", 36) + 0.5) / 36 ** 4,
      (parseInt("efgh", 36) + 0.5) / 36 ** 4,
    ];
    let i = 0;
    Math.random = () => seq[Math.min(i++, seq.length - 1)];
    let r: Awaited<ReturnType<JobRunner["spawn"]>>;
    try {
      r = await h.runner.spawn(spawnReq({ task: "collide" }));
    } finally {
      Math.random = realRandom;
    }
    assert.ok(r.ok);
    assert.equal(r.ok && r.id, "jefgh"); // never reuses the stored id
  } finally {
    await h.cleanup();
  }
});

// ── Restart recovery (§5.26) ─────────────────────────────────────────────────

test("recover: interrupts running, re-admits valid queued, drops stale/vanished", async () => {
  // A live trigger token must NEVER leak into a notice — the seeded label/note
  // are pre-sanitized, and the interrupted notice must not echo any "@" token.
  const h = makeHarness();
  try {
    // running → interrupted (reap consulted via a dead pid; no live process).
    await h.store.add(
      jobInput({
        id: "jrun1",
        status: "running",
        note: "nightly build",
        sourceLabel: "Computer",
        pid: 2147483646,
        binHint: "definitely-not-a-real-bin",
        guard: { chatKey: "chat", generation: 0 },
      }),
    );
    // queued + valid → re-admitted (same id, provider stub runs).
    await h.store.add(
      jobInput({ id: "jok01", status: "queued", task: "readmit-me", guard: { chatKey: "chat", generation: 0 } }),
    );
    // queued + stale generation → superseded + notify.
    await h.store.add(
      jobInput({ id: "jstale", status: "queued", task: "stale", guard: { chatKey: "chat", generation: 5 } }),
    );
    // queued + vanished cwd → dropped + notify.
    await h.store.add(
      jobInput({
        id: "jgone",
        status: "queued",
        task: "gone",
        cwd: "/gone",
        guard: { chatKey: "chat", generation: 0 },
      }),
    );
    // terminal row → untouched.
    await h.store.add(jobInput({ id: "jdone", status: "done" }));

    h.runner.recover({
      providerKnown: (p) => p === "stub",
      cwdIsDir: (cwd) => cwd !== "/gone",
      guardValid: (g) => g.generation === 0,
    });
    await delay(30);

    const byId = new Map(h.store.snapshot().map((j) => [j.id, j]));
    assert.equal(byId.get("jrun1")!.status, "interrupted");
    assert.equal(byId.get("jstale")!.status, "superseded");
    assert.equal(byId.get("jgone")!.status, "superseded");
    assert.equal(byId.get("jdone")!.status, "done"); // terminal untouched
    // valid queued was re-admitted, ran on the stub, same id (no new row).
    assert.ok(h.runOrder.includes("readmit-me"));
    assert.equal(h.store.snapshot().filter((j) => j.id === "jok01").length, 1);

    // Exactly three notices: one interrupted + two superseded.
    assert.equal(h.notes.length, 3);
    const interrupted = h.notes.find((n) => n.text.includes("jrun1"))!;
    assert.ok(interrupted.text.includes("nightly build"));
    assert.ok(!interrupted.text.includes("@")); // no trigger token ever
    assert.ok(h.notes.some((n) => n.text.includes("jstale")));
    assert.ok(h.notes.some((n) => n.text.includes("jgone")));
  } finally {
    await h.cleanup();
  }
});

// ── Pure helpers (§4.24–25) ─────────────────────────────────────────────────

test("sweepJobRequests parses valid files, consumes every file, and caps at 5", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-jobsweep-"));
  try {
    // 1 valid
    writeFileSync(join(dir, "a.json"), JSON.stringify({ task: "build it", note: "b" }));
    // >32KB task
    writeFileSync(join(dir, "b.json"), JSON.stringify({ task: "x".repeat(33_000) }));
    // non-JSON
    writeFileSync(join(dir, "c.json"), "not json {");
    // note >80 chars → capped; note absent handled elsewhere
    writeFileSync(join(dir, "d.json"), JSON.stringify({ task: "t", note: "n".repeat(200) }));
    // note absent → derived from task
    writeFileSync(join(dir, "e.json"), JSON.stringify({ task: "derive my note please" }));
    // two more to push past the 5-file cap
    writeFileSync(join(dir, "f.json"), JSON.stringify({ task: "sixth" }));
    writeFileSync(join(dir, "g.json"), JSON.stringify({ task: "seventh" }));
    // a non-json extension is ignored entirely
    writeFileSync(join(dir, "ignore.txt"), "whatever");

    const { requests, errors } = sweepJobRequests(dir);
    // 5 processed: a (ok), b (err), c (err), d (ok), e (ok) => 3 requests, 2 errors
    // f, g beyond cap => 2 more errors. Total 4 errors, 3 requests.
    assert.equal(requests.length, 3);
    assert.equal(errors.length, 4);
    assert.ok(requests.some((r) => r.task === "build it" && r.note === "b"));
    assert.ok(requests.some((r) => r.note.length === 80)); // >80 capped
    assert.ok(requests.some((r) => r.task === "derive my note please" && r.note === "derive my note please"));

    // ALWAYS unlink: every *.json is gone; the .txt is untouched.
    const left = readdirSync(dir);
    assert.deepEqual(left, ["ignore.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepJobRequests rejects symlinks, oversized files, and fifos without hanging", () => {
  // The drop-dir is agent-writable. A FIFO would block readFileSync forever
  // (freezing the whole event loop); a symlink could point at a blocking/huge
  // target. Guard with lstat().isFile() + a size cap BEFORE reading.
  const dir = mkdtempSync(join(tmpdir(), "wa-jobsweep-guard-"));
  try {
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ task: "fine" }));
    // symlink (target need not exist) — lstat sees a symlink, never followed.
    symlinkSync(join(dir, "nowhere-target"), join(dir, "link.json"));
    // oversized regular file: > MAX_TASK_BYTES (32KB) + 4KB slack.
    writeFileSync(join(dir, "big.json"), "{" + " ".repeat(40_000) + "}");
    // a real FIFO — the whole point of the guard (Unix only).
    const haveFifo = process.platform !== "win32" && spawnSync("mkfifo", [join(dir, "pipe.json")]).status === 0;

    const { requests, errors } = sweepJobRequests(dir);
    assert.deepEqual(
      requests.map((r) => r.task),
      ["fine"],
    );
    assert.ok(errors.some((e) => e.startsWith("link.json")), errors.join("; "));
    assert.ok(errors.some((e) => e.startsWith("big.json")), errors.join("; "));
    if (haveFifo) assert.ok(errors.some((e) => e.startsWith("pipe.json")), errors.join("; "));

    // Every *.json (incl. the symlink + fifo) was consumed.
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith(".json")),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepJobRequests on a missing dir returns an empty result", () => {
  const res = sweepJobRequests(join(tmpdir(), "definitely-not-a-real-dir-" + Date.now()));
  assert.deepEqual(res, { requests: [], errors: [] });
});

test("shouldReapOrphan requires the bin to still be present at the pid", () => {
  assert.equal(shouldReapOrphan(123, "/usr/local/bin/claude -p ...", "claude"), true);
  assert.equal(shouldReapOrphan(123, "/usr/bin/some-unrelated-daemon", "claude"), false);
  assert.equal(shouldReapOrphan(123, "   ", "claude"), false);
  assert.equal(shouldReapOrphan(123, "", "claude"), false);
});

test("shouldReapOrphan always returns false on win32", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    assert.equal(shouldReapOrphan(123, "claude -p ...", "claude"), false);
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
});
