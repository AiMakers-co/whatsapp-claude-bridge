import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "./logger.js";
import { loadJsonSafe } from "./store.js";

export type DurableTurnStatus = "pending" | "running";

export interface DurableTurn<T = unknown> {
  version: 1;
  id: string;
  seq: number;
  queueKey: string;
  remoteJid: string;
  sourceMessageId?: string;
  acceptedAt: number;
  status: DurableTurnStatus;
  payload: T;
}

export interface NewDurableTurn<T> {
  queueKey: string;
  remoteJid: string;
  sourceMessageId?: string;
  payload: T;
}

interface JournalFile<T> {
  version: 1;
  nextSeq: number;
  turns: Array<DurableTurn<T>>;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { __bridgeType: "bigint", value: value.toString() };
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return { __bridgeType: "uint8array", value: Buffer.from(value).toString("base64") };
  }
  return value;
}

function jsonReviver(_key: string, value: any): unknown {
  if (value?.__bridgeType === "bigint" && typeof value.value === "string") {
    return BigInt(value.value);
  }
  if (value?.__bridgeType === "uint8array" && typeof value.value === "string") {
    return new Uint8Array(Buffer.from(value.value, "base64"));
  }
  // Buffer.toJSON runs before the replacer. Restore Baileys media keys and
  // other binary fields that therefore use Node's standard tagged shape.
  if (value?.type === "Buffer" && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return value;
}

/**
 * Small write-ahead journal for accepted WhatsApp turns.
 *
 * The queue is capped at roughly 100 entries, so a full atomic rewrite is
 * cheap and gives us the ordering guarantee we need: a turn is on disk before
 * it can start. Pending work is replayable; running work is deliberately not
 * replayed after a crash because the provider may already have caused side
 * effects.
 *
 * Writes are async (never blocking the socket event loop) and compact, but
 * fully SERIALIZED through an internal promise lock so a mutation and its write
 * are atomic w.r.t. other operations and two writes never race on the shared
 * tmp path. Callers await add/claim/finish so a turn is durable before it is
 * admitted/acked (the admission barrier). A synchronous variant exists only for
 * the process-exit flush.
 */
export class TurnJournal<T = unknown> {
  private state: JournalFile<T>;
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {
    this.state = this.load();
  }

  /**
   * Acquire the serialization lock: wait for the prior op (mutation + write) to
   * finish, then return a release fn the caller MUST call in a finally.
   */
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

  async add(input: NewDurableTurn<T>): Promise<DurableTurn<T>> {
    const release = await this.lock();
    try {
      const turn: DurableTurn<T> = {
        version: 1,
        id: randomUUID(),
        seq: this.state.nextSeq++,
        queueKey: input.queueKey,
        remoteJid: input.remoteJid,
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        acceptedAt: Date.now(),
        status: "pending",
        payload: input.payload,
      };
      this.state.turns.push(turn);
      try {
        await this.persist();
        return turn;
      } catch (error) {
        this.state.turns.pop();
        this.state.nextSeq = Math.max(1, this.state.nextSeq - 1);
        throw error;
      }
    } finally {
      release();
    }
  }

  async claim(id: string): Promise<boolean> {
    const release = await this.lock();
    try {
      const turn = this.state.turns.find((entry) => entry.id === id);
      if (!turn || turn.status !== "pending") return false;
      turn.status = "running";
      try {
        await this.persist();
        return true;
      } catch (error) {
        turn.status = "pending";
        throw error;
      }
    } finally {
      release();
    }
  }

  async finish(id: string): Promise<boolean> {
    const release = await this.lock();
    try {
      const index = this.state.turns.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      const [removed] = this.state.turns.splice(index, 1);
      try {
        await this.persist();
        return true;
      } catch (error) {
        this.state.turns.splice(index, 0, removed);
        throw error;
      }
    } finally {
      release();
    }
  }

  /**
   * Cancel pending rows selected by a predicate (running rows are never
   * touched). Predicate-based because queue keys are per-agent LANES now: a
   * chat-wide cancel matches every lane of the chat (plus legacy chat-keyed
   * rows), while a lane-scoped cancel matches exactly one.
   */
  async cancelPending(
    shouldCancel: (turn: DurableTurn<T>) => boolean,
    beforeRemove: (turn: DurableTurn<T>) => void = () => {},
  ): Promise<number> {
    const release = await this.lock();
    try {
      const removed = this.state.turns.filter(
        (turn) => turn.status === "pending" && shouldCancel(turn),
      );
      if (!removed.length) return 0;
      for (const turn of removed) beforeRemove(turn);
      const removedIds = new Set(removed.map((turn) => turn.id));
      const prior = this.state.turns;
      this.state.turns = prior.filter((turn) => !removedIds.has(turn.id));
      try {
        await this.persist();
        return removed.length;
      } catch (error) {
        this.state.turns = prior;
        throw error;
      }
    } finally {
      release();
    }
  }

  hasSourceMessage(id: string): boolean {
    return this.state.turns.some((turn) => turn.sourceMessageId === id);
  }

  snapshot(): Array<DurableTurn<T>> {
    return [...this.state.turns].sort((a, b) => a.seq - b.seq);
  }

  private load(): JournalFile<T> {
    const empty: JournalFile<T> = { version: 1, nextSeq: 1, turns: [] };
    // loadJsonSafe distinguishes a transient read error (keep the file, warn,
    // start empty) from genuine parse corruption (rename aside, error log), and
    // always logs the caught error — the previous inline catch did neither.
    const parsed = loadJsonSafe<JournalFile<T>>(this.file, "pending-turns.json", jsonReviver);
    if (parsed === undefined) return empty;
    if (parsed.version !== 1 || !Array.isArray(parsed.turns)) {
      log.error("pending-turns.json has an unexpected shape — moving aside and starting empty.");
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* leave it in place if it cannot be moved */
      }
      return empty;
    }
    const turns = parsed.turns
      .filter(
        (turn) =>
          turn?.version === 1 &&
          typeof turn.id === "string" &&
          typeof turn.seq === "number" &&
          typeof turn.queueKey === "string" &&
          typeof turn.remoteJid === "string" &&
          (turn.status === "pending" || turn.status === "running"),
      )
      .sort((a, b) => a.seq - b.seq);
    const nextSeq = Math.max(
      Number.isSafeInteger(parsed.nextSeq) ? parsed.nextSeq : 1,
      ...turns.map((turn) => turn.seq + 1),
    );
    return { version: 1, nextSeq, turns };
  }

  /** Async atomic write; only ever runs while the serialization lock is held. */
  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, jsonReplacer), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, this.file);
  }

  /**
   * Synchronous last-write for the process-exit path ONLY. Uses a distinct tmp
   * path so it can never race an in-flight async write on `${file}.tmp`.
   */
  flushSync(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-exit`;
      writeFileSync(tmp, JSON.stringify(this.state, jsonReplacer), {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(tmp, this.file);
    } catch {
      /* exiting regardless */
    }
  }
}
