import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "./logger.js";
import { ProgressReporter } from "./progress.js";
import type { ProgressEvent, Provider, RunResult } from "./providers.js";
import { taskFinished, taskStarted, type TaskRecord } from "./runtime.js";
import { loadJsonSafe } from "./store.js";

/**
 * Background jobs: long work delegated off the per-lane FIFO so a chat turn can
 * reply within seconds while a build/test-suite/refactor runs on its own.
 *
 * Two pieces plus pure helpers, all Baileys-free (unit-testable):
 *  - JobStore: the same durable-write discipline as TurnJournal — a serialized
 *    promise-lock, atomic tmp+rename writes, a distinct .tmp-exit flush, and
 *    corruption move-aside on load. Unlike the journal, terminal rows are
 *    RETAINED (that is the /jobs history + suppressed-result store), pruned only
 *    beyond a cap.
 *  - JobRunner: FIFO admission with a concurrency cap, lazy generation-supersede,
 *    external kill (tree-kill via the provider cancel handle), and restart
 *    recovery (orphan reaping + re-admit/drop of queued rows). Jobs ALWAYS run a
 *    fresh provider session — never --resume, never a session writeback — so the
 *    chat-lane session continuity is never touched.
 */

export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "timeout"
  | "killed"
  | "superseded"
  | "suppressed"
  | "interrupted";

/** A terminal row is finished for good — kept as history, never re-run. */
const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "done",
  "error",
  "timeout",
  "killed",
  "superseded",
  "suppressed",
  "interrupted",
]);

function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Two-tier guard captured at spawn, re-checked before every job side effect. A
 * chat-wide reset (/stop, /cd, /use, group /new) bumps `generation`; a sticky
 * /new on one lane bumps only that lane's `laneGeneration`. Command-spawned jobs
 * carry a chat-wide guard only (no laneId); delegated jobs inherit the turn's
 * full lane guard.
 */
export interface JobGuard {
  chatKey: string;
  generation: number;
  laneId?: string;
  laneGeneration?: number;
}

export interface JobRecord {
  version: 1;
  id: string;
  seq: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  chatKey: string;
  remoteJid: string;
  /** PRE-SANITIZED display label (agentReplyLabel) — never a live trigger token. */
  sourceLabel: string;
  provider: string;
  model?: string;
  cwd: string;
  task: string;
  /** Short human label, <= 80 chars. */
  note: string;
  origin: "delegated" | "command";
  guard: JobGuard;
  status: JobStatus;
  /** For orphan reaping across a restart. */
  pid?: number;
  binHint?: string;
  /** Capped copy of the final result, retained even when delivery is suppressed. */
  resultPreview?: string;
  costUsd?: number;
}

interface JobsFile {
  version: 1;
  nextSeq: number;
  jobs: JobRecord[];
}

/** Beyond this many terminal rows, the oldest (by seq) are pruned on each write. */
const TERMINAL_RETENTION = 50;

const MAX_TASK_BYTES = 32 * 1024;
const MAX_NOTE_CHARS = 80;

// ── JobStore ────────────────────────────────────────────────────────────────

/**
 * Durable job table. Modeled byte-for-byte on TurnJournal's discipline:
 * mutations + their write are serialized through a promise lock so two writes
 * never race the shared tmp path, callers await add/update so a row is on disk
 * before the runner admits it, and flushSync() uses a distinct .tmp-exit path
 * for the process-exit flush.
 */
export class JobStore {
  private state: JobsFile;
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {
    this.state = this.load();
  }

  private async lock(): Promise<() => void> {
    const prior = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => (release = resolve));
    try {
      await prior;
    } catch {
      /* the prior op already surfaced its own error to its awaiter */
    }
    return release;
  }

  /** Durable-before-admitted: resolves only once the row is on disk. */
  async add(input: Omit<JobRecord, "seq" | "version">): Promise<JobRecord> {
    const release = await this.lock();
    try {
      const job: JobRecord = { version: 1, seq: this.state.nextSeq++, ...input };
      this.state.jobs.push(job);
      this.prune();
      try {
        await this.persist();
        return job;
      } catch (error) {
        const i = this.state.jobs.indexOf(job);
        if (i >= 0) this.state.jobs.splice(i, 1);
        this.state.nextSeq = Math.max(1, this.state.nextSeq - 1);
        throw error;
      }
    } finally {
      release();
    }
  }

  /** Patch a row in place. A terminal status is RETAINED (history/suppressed). */
  async update(id: string, patch: Partial<JobRecord>): Promise<boolean> {
    const release = await this.lock();
    try {
      const job = this.state.jobs.find((j) => j.id === id);
      if (!job) return false;
      const before = { ...job };
      Object.assign(job, patch);
      this.prune();
      try {
        await this.persist();
        return true;
      } catch (error) {
        Object.assign(job, before);
        throw error;
      }
    } finally {
      release();
    }
  }

  snapshot(): JobRecord[] {
    return [...this.state.jobs].sort((a, b) => a.seq - b.seq);
  }

  /** Keep every live row plus the newest TERMINAL_RETENTION terminal rows. */
  private prune(): void {
    const terminal = this.state.jobs.filter((j) => isTerminal(j.status));
    if (terminal.length <= TERMINAL_RETENTION) return;
    const keep = new Set(
      terminal
        .sort((a, b) => b.seq - a.seq)
        .slice(0, TERMINAL_RETENTION)
        .map((j) => j.id),
    );
    this.state.jobs = this.state.jobs.filter((j) => !isTerminal(j.status) || keep.has(j.id));
  }

  private load(): JobsFile {
    const empty: JobsFile = { version: 1, nextSeq: 1, jobs: [] };
    const parsed = loadJsonSafe<JobsFile>(this.file, "jobs.json");
    if (parsed === undefined) return empty;
    if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
      log.error("jobs.json has an unexpected shape — moving aside and starting empty.");
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* leave it in place if it cannot be moved */
      }
      return empty;
    }
    const jobs = parsed.jobs
      .filter(
        (j): j is JobRecord =>
          !!j &&
          j.version === 1 &&
          typeof j.id === "string" &&
          typeof j.seq === "number" &&
          typeof j.chatKey === "string" &&
          typeof j.remoteJid === "string" &&
          typeof j.task === "string" &&
          typeof j.status === "string" &&
          !!j.guard &&
          typeof j.guard === "object",
      )
      .sort((a, b) => a.seq - b.seq);
    const nextSeq = Math.max(
      Number.isSafeInteger(parsed.nextSeq) ? parsed.nextSeq : 1,
      ...jobs.map((j) => j.seq + 1),
    );
    return { version: 1, nextSeq, jobs };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** Synchronous last-write for the process-exit path ONLY (distinct tmp path). */
  flushSync(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-exit`;
      writeFileSync(tmp, JSON.stringify(this.state), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      /* exiting regardless */
    }
  }
}

// ── JobRunner ─────────────────────────────────────────────────────────────

export interface JobSpawnRequest {
  remoteJid: string;
  chatKey: string;
  sourceLabel: string;
  provider: string;
  model?: string;
  cwd: string;
  task: string;
  note: string;
  origin: "delegated" | "command";
  guard: JobGuard;
}

export type JobSpawnResult = { ok: true; id: string } | { ok: false; reason: string };

export type JobKillResult = "killed" | "cancelled-queued" | "not-found" | "already-done";

/** Live re-validation closures consulted during restart recovery. */
export interface JobRecoverChecks {
  providerKnown: (provider: string) => boolean;
  cwdIsDir: (cwd: string) => boolean;
  guardValid: (guard: JobGuard) => boolean;
}

export interface JobRunnerDeps {
  store: JobStore;
  getProvider: (name: string) => Provider | undefined;
  modelFor: (provider: string) => string | undefined;
  /** guardMatchesState(chats.get(...), g) — lazy supersede + delivery re-check. */
  isGuardValid: (guard: JobGuard) => boolean;
  /** index.ts-side completion: re-checks the guard, posts, may markSuppressed. */
  deliver: (job: JobRecord, res: RunResult, elapsedMs: number) => Promise<void>;
  /** Guard-less Bridge-labeled notice (restart notifications). */
  notify: (remoteJid: string, text: string) => void;
  /** Ephemeral progress line into the origin chat. */
  progressSend: (job: JobRecord, text: string) => void;
  jobTimeoutMs: number;
  maxConcurrent: number;
  maxQueued: number;
  progressIntervalMs: number;
  progressMaxUpdates: number;
}

type CancelHandle = { cancel: (reason?: string) => void; pid?: number };

export class JobRunner {
  private readonly fifo: JobRecord[] = [];
  private runningCount = 0;
  private readonly handles = new Map<string, CancelHandle>();
  private readonly killRequested = new Set<string>();

  constructor(private readonly deps: JobRunnerDeps) {}

  /**
   * Validate + durably persist a job, then admit it to the FIFO. The row is on
   * disk (add awaited) before the runner ever admits it; a write failure spawns
   * NOTHING.
   */
  async spawn(req: JobSpawnRequest): Promise<JobSpawnResult> {
    const task = req.task ?? "";
    if (!task.trim()) return { ok: false, reason: "empty task" };
    if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) {
      return { ok: false, reason: "task too large (max 32KB)" };
    }
    if (!this.deps.getProvider(req.provider)) {
      return { ok: false, reason: `unknown provider "${req.provider}"` };
    }
    const queued = this.fifo.length;
    if (queued >= this.deps.maxQueued) return { ok: false, reason: "queue full" };

    const note = (req.note ?? "").trim().slice(0, MAX_NOTE_CHARS) || task.trim().slice(0, 60);
    const id = this.freshId();
    let job: JobRecord;
    try {
      job = await this.deps.store.add({
        id,
        createdAt: Date.now(),
        chatKey: req.chatKey,
        remoteJid: req.remoteJid,
        sourceLabel: req.sourceLabel,
        provider: req.provider,
        ...(req.model ? { model: req.model } : {}),
        cwd: req.cwd,
        task,
        note,
        origin: req.origin,
        guard: req.guard,
        status: "queued",
      });
    } catch (e: any) {
      log.error(`Could not save job ${id}: ${e?.message ?? e}`);
      return { ok: false, reason: "could not save job" };
    }
    this.fifo.push(job);
    void this.pump();
    return { ok: true, id: job.id };
  }

  /** `"j" + 4 base36 chars`, re-rolled against the store to avoid a collision. */
  private freshId(): string {
    const taken = new Set(this.deps.store.snapshot().map((j) => j.id));
    for (let i = 0; i < 50; i++) {
      const id = "j" + Math.random().toString(36).slice(2, 6).padEnd(4, "0");
      if (!taken.has(id) && !this.fifo.some((j) => j.id === id)) return id;
    }
    return "j" + Date.now().toString(36).slice(-4);
  }

  /** Fill free slots FIFO. Lazy supersede drops guard-invalid rows without spawn. */
  private async pump(): Promise<void> {
    while (this.runningCount < this.deps.maxConcurrent && this.fifo.length > 0) {
      const job = this.fifo.shift()!;
      if (!this.deps.isGuardValid(job.guard)) {
        await this.deps.store.update(job.id, { status: "superseded", endedAt: Date.now() });
        continue;
      }
      this.runningCount++;
      void this.execute(job);
    }
  }

  /**
   * Run one job to completion. Wrapped whole so a single job's throw can never
   * stall the runner: the slot is always released and pump() re-run in finally.
   */
  private async execute(job: JobRecord): Promise<void> {
    const startedAt = Date.now();
    let rec: TaskRecord | undefined;
    try {
      await this.deps.store.update(job.id, { status: "running", startedAt });
      rec = taskStarted({
        jid: job.remoteJid,
        kind: "job",
        preview: job.note,
        provider: job.provider,
      });
      const reporter = new ProgressReporter(
        (text) => {
          this.deps.progressSend(job, text);
          return Promise.resolve();
        },
        this.deps.progressIntervalMs,
        this.deps.progressMaxUpdates,
      );
      let res: RunResult;
      try {
        const provider = this.deps.getProvider(job.provider);
        if (!provider) {
          res = { text: `Provider "${job.provider}" is not available.`, isError: true };
        } else {
          res = await provider.run(
            job.task,
            {
              cwd: job.cwd,
              // Fresh session by design: never --resume, never a writeback.
              model: job.model ?? this.deps.modelFor(job.provider),
              onSpawn: (h) => {
                this.handles.set(job.id, h);
                // Close the /kill race: a kill() that landed in the window
                // between pump() admitting the job and this handle registering
                // set killRequested but had nothing to cancel — honor it now.
                if (this.killRequested.has(job.id)) h.cancel("Killed by user (/kill).");
                void this.deps.store.update(job.id, {
                  ...(h.pid ? { pid: h.pid } : {}),
                  binHint: provider.bin,
                });
              },
              // The PROGRESS_INTERVAL_SECONDS=0 kill switch must reach jobs too:
              // omit onProgress entirely so claude keeps today's plain-json argv
              // (runOnce derives stream mode from Boolean(opts.onProgress)).
              ...(this.deps.progressIntervalMs > 0
                ? { onProgress: (ev: ProgressEvent) => reporter.push(ev) }
                : {}),
            },
            this.deps.jobTimeoutMs,
          );
        }
      } finally {
        this.handles.delete(job.id);
        reporter.stop();
      }
      const endedAt = Date.now();
      const elapsed = endedAt - startedAt;
      let status: JobStatus;
      if (this.killRequested.has(job.id)) status = "killed";
      else if (res.timedOut) status = "timeout";
      else if (res.isError) status = "error";
      else status = "done";
      this.killRequested.delete(job.id);
      await this.deps.store.update(job.id, {
        status,
        endedAt,
        resultPreview: res.text.slice(0, 4000),
        ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
      });
      if (rec) {
        taskFinished(rec, {
          status:
            status === "done"
              ? "done"
              : status === "timeout"
                ? "timeout"
                : status === "killed"
                  ? "cancelled"
                  : "error",
          ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
        });
      }
      // A killed job was already confirmed to the user by /kill — no delivery.
      if (status !== "killed") {
        try {
          await this.deps.deliver(job, res, elapsed);
        } catch (e: any) {
          log.error(`Job ${job.id} delivery failed: ${e?.message ?? e}`);
        }
      }
    } catch (e: any) {
      log.error(`Job ${job.id} crashed the runner path: ${e?.message ?? e}`);
      if (rec) taskFinished(rec, { status: "error" });
      void this.deps.store.update(job.id, { status: "error", endedAt: Date.now() });
    } finally {
      this.runningCount--;
      void this.pump();
    }
  }

  /**
   * /kill: a queued job is removed before it starts; a running job is
   * tree-killed via its cancel handle (Step 1) and its result suppressed.
   */
  kill(id: string): JobKillResult {
    const qi = this.fifo.findIndex((j) => j.id === id);
    if (qi >= 0) {
      this.fifo.splice(qi, 1);
      void this.deps.store.update(id, { status: "killed", endedAt: Date.now() });
      return "cancelled-queued";
    }
    const handle = this.handles.get(id);
    if (handle) {
      this.killRequested.add(id);
      handle.cancel("Killed by user (/kill).");
      return "killed";
    }
    // Race window: pump() has shifted the job off the FIFO and set it "running"
    // but onSpawn has not registered the cancel handle yet (the awaited
    // store.update to "running" widens this). The row exists in a non-terminal
    // state with no handle — request the kill so onSpawn cancels the instant it
    // registers and execute()'s classification suppresses the result. Without
    // this the caller was wrongly told "already finished" and the job delivered.
    const row = this.deps.store.snapshot().find((j) => j.id === id);
    if (!row) return "not-found";
    if (!isTerminal(row.status)) {
      this.killRequested.add(id);
      return "killed";
    }
    return "already-done";
  }

  /** deliver() calls this when the guard went stale — retain the result row. */
  markSuppressed(id: string): void {
    void this.deps.store.update(id, { status: "suppressed" });
  }

  list(chatKey: string): JobRecord[] {
    return this.deps.store.snapshot().filter((j) => j.chatKey === chatKey);
  }

  counts(): { running: number; queued: number } {
    return { running: this.runningCount, queued: this.fifo.length };
  }

  /** Active (running/queued) jobs in OTHER chats — the /jobs footer count. */
  countsElsewhere(chatKey: string): number {
    return this.deps.store
      .snapshot()
      .filter((j) => j.chatKey !== chatKey && (j.status === "running" || j.status === "queued"))
      .length;
  }

  /**
   * Restart recovery. Re-validate against LIVE config, never persisted copies:
   *  - a "running" row is an interrupted job — best-effort reap the orphan child
   *    (only when ps still shows the recorded bin at that pid), mark
   *    "interrupted", and notify. NEVER auto-re-run (it may have made changes).
   *  - a "queued" row is re-admitted when its provider/cwd/guard still validate
   *    live, else dropped as "superseded" with a reason.
   *  - terminal rows are kept as history.
   */
  recover(checks: JobRecoverChecks): void {
    for (const job of this.deps.store.snapshot()) {
      if (job.status === "running") {
        if (job.pid && job.binHint && shouldReapOrphan(job.pid, psCommandOutput(job.pid), job.binHint)) {
          try {
            if (process.platform === "win32") {
              spawnSync("taskkill", ["/pid", String(job.pid), "/T", "/F"], { stdio: "ignore" });
            } else {
              process.kill(-job.pid, "SIGKILL");
            }
          } catch {
            /* already gone — nothing to reap */
          }
        }
        void this.deps.store.update(job.id, { status: "interrupted", endedAt: Date.now() });
        this.deps.notify(
          job.remoteJid,
          `💤 Background job ${job.id} ("${job.note}") was interrupted by a restart — it was NOT re-run (it may already have made changes). Send /job again to redo it.`,
        );
      } else if (job.status === "queued") {
        const providerOk = checks.providerKnown(job.provider);
        const cwdOk = checks.cwdIsDir(job.cwd);
        const guardOk = checks.guardValid(job.guard);
        if (providerOk && cwdOk && guardOk) {
          this.fifo.push(job);
        } else {
          const reason = !providerOk
            ? `provider "${job.provider}" is no longer available`
            : !cwdOk
              ? "its working dir no longer exists"
              : "the chat was reset";
          void this.deps.store.update(job.id, { status: "superseded", endedAt: Date.now() });
          this.deps.notify(
            job.remoteJid,
            `🚫 Background job ${job.id} ("${job.note}") was dropped after a restart — ${reason}.`,
          );
        }
      }
      // terminal rows: kept as history.
    }
    void this.pump();
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────

/** Compact "45s"/"3m" elapsed label. */
function shortElapsed(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.round(secs / 60)}m`;
}

/** Leading glyph: `•` while live, a status-specific glyph once terminal. */
function jobGlyph(status: JobStatus): string {
  switch (status) {
    case "done":
      return "✅";
    case "error":
      return "⚠️";
    case "timeout":
      return "⏱";
    case "killed":
      return "🛑";
    case "interrupted":
      return "💤";
    case "superseded":
      return "🚫";
    case "suppressed":
      return "📪";
    default:
      return "•"; // running / queued
  }
}

/**
 * Render one chat's job list for /jobs: up to 10 rows, running/queued first
 * then newest-first, with a "(+N in other chats)" footer. Labels come from the
 * stored PRE-SANITIZED sourceLabel — never a live trigger token.
 */
export function formatJobsList(jobs: JobRecord[], elsewhere: number): string {
  if (jobs.length === 0) {
    return "No jobs yet. Start one with /job <task> or let the agent delegate.";
  }
  const isLive = (j: JobRecord) => j.status === "running" || j.status === "queued";
  const ordered = [...jobs].sort((a, b) => {
    if (isLive(a) !== isLive(b)) return isLive(a) ? -1 : 1;
    return b.seq - a.seq;
  });
  const now = Date.now();
  const rows = ordered.slice(0, 10).map((j) => {
    const state =
      j.status === "running"
        ? `running ${shortElapsed(now - (j.startedAt ?? now))}`
        : j.status;
    const note = j.note.length > 40 ? j.note.slice(0, 39) + "…" : j.note;
    const suffix = j.status === "suppressed" ? " — result kept, chat was reset" : "";
    return `${jobGlyph(j.status)} ${j.id} · ${j.sourceLabel} · ${state} · ${note}${suffix}`;
  });
  let out = "🗂 Jobs\n" + rows.join("\n");
  if (elsewhere > 0) out += `\n(+${elsewhere} in other chats)`;
  return out;
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/**
 * PID-reuse protection: a recorded pid is only safe to tree-kill after a restart
 * when the OS still shows the SAME binary running at it. True only when the
 * trimmed ps output is non-empty AND contains binHint. Always false on win32
 * (no reliable per-pid command lookup — leave the orphan and report).
 */
export function shouldReapOrphan(pid: number, psCommandOutput: string, binHint: string): boolean {
  if (process.platform === "win32") return false;
  const out = (psCommandOutput ?? "").trim();
  if (!out) return false;
  return !!binHint && out.includes(binHint);
}

/** `ps -o command= -p <pid>` output, or "" (win32 / absent process / error). */
function psCommandOutput(pid: number): string {
  if (process.platform === "win32") return "";
  try {
    const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return typeof r.stdout === "string" ? r.stdout : "";
  } catch {
    return "";
  }
}

/**
 * Consume the delegation drop-dir: read every *.json job-request file, ALWAYS
 * unlinking it (valid or not), and return the parsed requests plus per-file
 * error strings. At most 5 files are processed; the rest are reported and still
 * removed. A missing dir yields an empty result. Pure fs — no runner deps.
 */
export function sweepJobRequests(jobsDir: string): {
  requests: Array<{ task: string; note: string }>;
  errors: string[];
} {
  const requests: Array<{ task: string; note: string }> = [];
  const errors: string[] = [];
  let files: string[];
  try {
    files = readdirSync(jobsDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return { requests, errors }; // missing dir → nothing to sweep
  }
  const MAX_FILES = 5;
  let processed = 0;
  for (const f of files) {
    const full = join(jobsDir, f);
    // The drop-dir is agent-writable. Reject anything that is not a plain
    // regular file BEFORE reading it: readFileSync on a FIFO blocks the event
    // loop forever (freezing the whole bridge — worse than any crash, since
    // launchd's KeepAlive never restarts a frozen-but-alive process), and a
    // symlink to a multi-GB target would buffer unbounded bytes. lstat (not
    // stat) so a symlink is seen as a symlink, never followed.
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(full);
    } catch {
      st = undefined;
    }
    const badKind = !st || !st.isFile();
    const tooBig = !!st && st.size > MAX_TASK_BYTES + 4096; // task cap + JSON slack
    let raw: string | undefined;
    if (!badKind && !tooBig) {
      try {
        raw = readFileSync(full, "utf8");
      } catch {
        /* read may fail — still consume below */
      }
    }
    try {
      unlinkSync(full); // ALWAYS consume the file
    } catch {
      /* already gone */
    }
    if (processed >= MAX_FILES) {
      errors.push(`${f}: ignored (max ${MAX_FILES} job files per reply)`);
      continue;
    }
    processed++;
    if (badKind) {
      errors.push(`${f}: not a regular file (symlink/fifo rejected)`);
      continue;
    }
    if (tooBig) {
      errors.push(`${f}: file too large (max 32KB)`);
      continue;
    }
    if (raw === undefined) {
      errors.push(`${f}: could not be read`);
      continue;
    }
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch {
      errors.push(`${f}: not valid JSON`);
      continue;
    }
    if (!obj || typeof obj.task !== "string") {
      errors.push(`${f}: missing string "task"`);
      continue;
    }
    const task: string = obj.task;
    if (task.length < 1 || Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) {
      errors.push(`${f}: task must be 1..32768 bytes`);
      continue;
    }
    const rawNote = typeof obj.note === "string" ? obj.note.trim() : "";
    const note = (rawNote || task.trim().slice(0, 60)).slice(0, MAX_NOTE_CHARS);
    requests.push({ task, note });
  }
  return { requests, errors };
}
