import "./helpers/test-home.js"; // must precede any src/config.js importer
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TurnJournal } from "../src/turn-journal.js";

function fixture(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "wa-turn-journal-"));
  return { dir, file: join(dir, "pending-turns.json") };
}

test("pending turns survive reload in accepted order", async () => {
  const { dir, file } = fixture();
  try {
    const journal = new TurnJournal<{ text: string }>(file);
    const first = await journal.add({
      queueKey: "a",
      remoteJid: "a@s.whatsapp.net",
      sourceMessageId: "m1",
      payload: { text: "one" },
    });
    const second = await journal.add({
      queueKey: "a",
      remoteJid: "a@s.whatsapp.net",
      sourceMessageId: "m2",
      payload: { text: "two" },
    });
    const restored = new TurnJournal<{ text: string }>(file).snapshot();
    assert.deepEqual(restored.map((turn) => turn.id), [first.id, second.id]);
    assert.deepEqual(restored.map((turn) => turn.payload.text), ["one", "two"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("running work is distinguishable and pending cancellation leaves it alone", async () => {
  const { dir, file } = fixture();
  try {
    const journal = new TurnJournal(file);
    const running = await journal.add({ queueKey: "chat", remoteJid: "chat", payload: { n: 1 } });
    await journal.add({ queueKey: "chat", remoteJid: "chat", payload: { n: 2 } });
    assert.equal(await journal.claim(running.id), true);
    assert.equal(await journal.cancelPending((turn) => turn.queueKey === "chat"), 1);

    const restored = new TurnJournal(file).snapshot();
    assert.equal(restored.length, 1);
    assert.equal(restored[0].id, running.id);
    assert.equal(restored[0].status, "running");
    assert.equal(await journal.finish(running.id), true);
    assert.deepEqual(new TurnJournal(file).snapshot(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serialized Baileys-style binary and bigint fields revive", async () => {
  const { dir, file } = fixture();
  try {
    const journal = new TurnJournal<any>(file);
    await journal.add({
      queueKey: "chat",
      remoteJid: "chat",
      payload: { mediaKey: new Uint8Array([1, 2, 3]), timestamp: 7n },
    });
    const payload = new TurnJournal<any>(file).snapshot()[0].payload;
    assert.ok(payload.mediaKey instanceof Uint8Array);
    assert.deepEqual([...payload.mediaKey], [1, 2, 3]);
    assert.equal(payload.timestamp, 7n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent journal writes serialize without corrupting state", async () => {
  const { dir, file } = fixture();
  try {
    const journal = new TurnJournal<{ n: number }>(file);
    const added = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        journal.add({ queueKey: "chat", remoteJid: "chat", payload: { n } }),
      ),
    );
    assert.equal(new Set(added.map((turn) => turn.seq)).size, 8); // unique seqs
    const restored = new TurnJournal<{ n: number }>(file).snapshot();
    assert.equal(restored.length, 8);
    assert.deepEqual(
      restored.map((turn) => turn.payload.n).sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt journal is renamed aside and the journal starts empty", () => {
  const { dir, file } = fixture();
  try {
    writeFileSync(file, "{ this is not json", "utf8");
    const journal = new TurnJournal(file);
    assert.deepEqual(journal.snapshot(), []);
    // Parse corruption → renamed to .corrupt-* for inspection, never deleted.
    const names = readdirSync(dir);
    assert.ok(names.some((name) => name.startsWith("pending-turns.json.corrupt-")));
    assert.ok(!names.includes("pending-turns.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transient read error keeps the file in place and starts empty for this boot", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root — chmod 000 does not produce EACCES");
    return;
  }
  const { dir, file } = fixture();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, nextSeq: 2, turns: [] }), "utf8");
    chmodSync(file, 0o000); // read yields EACCES: transient environment trouble
    const journal = new TurnJournal(file);
    assert.deepEqual(journal.snapshot(), []);
    // The (possibly perfectly valid) file must NOT be renamed aside.
    chmodSync(file, 0o600);
    const names = readdirSync(dir);
    assert.ok(names.includes("pending-turns.json"));
    assert.ok(!names.some((name) => name.includes(".corrupt-")));
    assert.deepEqual(new TurnJournal(file).snapshot(), []); // file was valid all along
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flushSync writes the current state synchronously for the exit path", async () => {
  const { dir, file } = fixture();
  try {
    const journal = new TurnJournal<{ n: number }>(file);
    await journal.add({ queueKey: "chat", remoteJid: "chat", payload: { n: 1 } });
    journal.flushSync();
    const restored = new TurnJournal<{ n: number }>(file).snapshot();
    assert.equal(restored.length, 1);
    assert.equal(restored[0].payload.n, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
