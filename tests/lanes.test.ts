import "./helpers/test-home.js"; // must precede any src/config.js importer
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { formatLaneStatuses, laneKeyFor, laneMatchesChat } from "../src/lanes.js";
import { mentionSessionKey } from "../src/mentions.js";
import { KeyedTurnQueue } from "../src/turn-queue.js";
import { MentionLoopGuard } from "../src/loop-guard.js";
import { TurnJournal } from "../src/turn-journal.js";

const chatKey = "12025550123@s.whatsapp.net";
const computerLane = laneKeyFor(chatKey, mentionSessionKey({ trigger: "@computer", provider: "claude" }));
const codexLane = laneKeyFor(chatKey, mentionSessionKey({ trigger: "@codex", provider: "codex" }));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

test("lane keys separate call signs within a chat and derive deterministically", () => {
  assert.notEqual(computerLane, codexLane);
  // Same route (any trigger case) always lands in the same lane — recovery
  // derives the identical lane from the persisted route.
  assert.equal(
    laneKeyFor(chatKey, mentionSessionKey({ trigger: "@CODEX", provider: "codex" })),
    codexLane,
  );
  // Chat-wide matching covers every lane of the chat plus legacy chat-level
  // keys, and never another chat's lanes.
  assert.ok(laneMatchesChat(computerLane, chatKey));
  assert.ok(laneMatchesChat(codexLane, chatKey));
  assert.ok(laneMatchesChat(chatKey, chatKey)); // legacy row
  assert.ok(!laneMatchesChat(laneKeyFor("other@s.whatsapp.net", "claude"), chatKey));
});

test("two call signs in one chat run concurrently; one call sign stays FIFO", async () => {
  const queue = new KeyedTurnQueue();
  const gate = deferred();
  const events: string[] = [];

  // @computer holds its lane busy...
  const computerFirst = queue.enqueue(computerLane, async () => {
    events.push("computer-1-start");
    await gate.promise;
    events.push("computer-1-end");
  });
  // ...a second @computer turn must WAIT (same lane, strict FIFO)...
  const computerSecond = queue.enqueue(computerLane, async () => {
    events.push("computer-2");
  });
  // ...but @codex in the SAME chat starts immediately (independent lane).
  const codexTurn = queue.enqueue(codexLane, async () => {
    events.push("codex-1");
  });

  assert.equal(queue.activeFor(computerLane), 1);
  assert.equal(queue.activeFor(codexLane), 1); // both active at once
  if (codexTurn.accepted) await codexTurn.done;
  assert.deepEqual(events, ["computer-1-start", "codex-1"]); // codex finished while computer runs

  gate.resolve();
  await Promise.all([
    computerFirst.accepted ? computerFirst.done : Promise.resolve(),
    computerSecond.accepted ? computerSecond.done : Promise.resolve(),
  ]);
  // Same-lane order strictly preserved: 2 never overtakes 1.
  assert.deepEqual(events, ["computer-1-start", "codex-1", "computer-1-end", "computer-2"]);
});

test("chat-wide cancel clears every lane; lane cancel clears only its own", async () => {
  const queue = new KeyedTurnQueue();
  const gateA = deferred();
  const gateB = deferred();
  queue.enqueue(computerLane, () => gateA.promise);
  queue.enqueue(computerLane, async () => {});
  queue.enqueue(codexLane, () => gateB.promise);
  queue.enqueue(codexLane, async () => {});

  // Lane-scoped (sticky /new on @codex): only codex's waiting turn goes.
  assert.equal(queue.cancelWaiting(codexLane), 1);
  assert.equal(queue.waiting(computerLane), 1);

  // Chat-wide (/stop, loop trip): every lane in the chat.
  assert.equal(queue.cancelWaitingMatching((key) => laneMatchesChat(key, chatKey)), 1);
  assert.equal(queue.totalWaiting(), 0);
  gateA.resolve();
  gateB.resolve();
});

test("per-lane strict guards keep independent 3/30s budgets (D2)", () => {
  const guard = new MentionLoopGuard(30_000, 3, 2 * 60_000);
  const now = 1_000_000;
  // @computer burns its budget and trips...
  assert.equal(guard.record(computerLane, now).allowed, true);
  assert.equal(guard.record(computerLane, now + 1).allowed, true);
  assert.equal(guard.record(computerLane, now + 2).tripped, true);
  // ...while @codex in the SAME chat still has its full budget.
  assert.equal(guard.record(codexLane, now + 3).allowed, true);
  assert.equal(guard.record(codexLane, now + 4).allowed, true);
  const codexTrip = guard.record(codexLane, now + 5);
  assert.equal(codexTrip.tripped, true); // bounded at 3 x call signs per chat
});

test("recovered turns replay into their stored lanes in per-lane FIFO order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-lanes-recovery-"));
  const file = join(dir, "pending-turns.json");
  try {
    const journal = new TurnJournal<{ n: number }>(file);
    // Interleaved admissions across two lanes of one chat.
    await journal.add({ queueKey: computerLane, remoteJid: chatKey, payload: { n: 1 } });
    await journal.add({ queueKey: codexLane, remoteJid: chatKey, payload: { n: 2 } });
    await journal.add({ queueKey: computerLane, remoteJid: chatKey, payload: { n: 3 } });
    await journal.add({ queueKey: codexLane, remoteJid: chatKey, payload: { n: 4 } });

    // Recovery: snapshot() is seq-ordered; each row re-enqueues into its
    // STORED lane (the same derivation used at admission).
    const restored = new TurnJournal<{ n: number }>(file).snapshot();
    const queue = new KeyedTurnQueue();
    const ran: Array<{ lane: string; n: number }> = [];
    const done: Array<Promise<void>> = [];
    for (const turn of restored) {
      const accepted = queue.enqueue(turn.queueKey, async () => {
        ran.push({ lane: turn.queueKey, n: turn.payload.n });
      });
      if (accepted.accepted) done.push(accepted.done);
    }
    await Promise.all(done);
    // Per-lane FIFO matches admission order.
    assert.deepEqual(ran.filter((r) => r.lane === computerLane).map((r) => r.n), [1, 3]);
    assert.deepEqual(ran.filter((r) => r.lane === codexLane).map((r) => r.n), [2, 4]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queueing is silent: the position ceremony is gone from the bridge (D3)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, "..", "src", "index.ts"), "utf8");
  // Regression tripwire: no '⏳ Queued for X — N turns ahead' notice anywhere.
  assert.ok(!source.includes("Queued for"));
  assert.ok(!source.includes("turns ahead"));
  // The queue-full rejection and loop-trip notices must remain.
  assert.ok(source.includes("turns waiting in this chat"));
  assert.ok(source.includes("Loop protection: paused"));
});

test("/status lane lines read like independent terminals (D4)", () => {
  assert.equal(
    formatLaneStatuses([
      { label: "Computer", running: true, waiting: 1 },
      { label: "Codex", running: false, waiting: 0 },
    ]),
    "Computer: running, 1 queued · Codex: idle",
  );
  assert.equal(formatLaneStatuses([{ label: "Codex", running: true, waiting: 0 }]), "Codex: running");
  assert.equal(formatLaneStatuses([]), "idle");
});

// ── Round 4 (G1-G4) coverage ────────────────────────────────────────────────

import {
  guardMatchesState,
  laneLabelFromId,
  mergeLaneGenerations,
  type LaneGenerationState,
} from "../src/lanes.js";
import { generationStillValid } from "../src/recovery.js";
import { initOutbound, safeSend } from "../src/outbound.js";

const computerLaneId = "mention:claude:@computer";
const codexLaneId = "mention:codex:@codex";

test("a sticky /new on one lane suppresses only that lane's running turn (G1)", () => {
  // Both lanes dispatched their running turns under this state...
  const chat: LaneGenerationState = { generation: 2, laneGenerations: { [codexLaneId]: 1 } };
  const computerGuard = { generation: 2, laneId: computerLaneId, laneGeneration: 0 };
  const codexGuard = { generation: 2, laneId: codexLaneId, laneGeneration: 1 };
  assert.ok(guardMatchesState(chat, computerGuard));
  assert.ok(guardMatchesState(chat, codexGuard));

  // ...then the user sends "@codex /new": ONLY codex's lane generation bumps.
  chat.laneGenerations = { ...chat.laneGenerations, [codexLaneId]: 2 };
  assert.ok(guardMatchesState(chat, computerGuard)); // lane A delivers + writes back
  assert.ok(!guardMatchesState(chat, codexGuard)); // lane B's own turn suppressed

  // A chat-wide reset (/stop, /cd, /use, group /new) still kills both.
  chat.generation = 3;
  assert.ok(!guardMatchesState(chat, computerGuard));
  assert.ok(!guardMatchesState(chat, codexGuard));

  // Legacy lane-less guards keep the old chat-only semantics.
  assert.ok(guardMatchesState({ generation: 3 }, { generation: 3 }));
  // Missing chat = generation 0; missing lane entry = lane generation 0 (F5/G1).
  assert.ok(guardMatchesState(undefined, { generation: 0, laneId: "x", laneGeneration: 0 }));
});

test("lane B's /new does not drop lane A's reply at the socket (G1, outbound)", async () => {
  const chatKeyLocal = "lane-gen@s.whatsapp.net";
  const state: LaneGenerationState = { generation: 0, laneGenerations: {} };
  const chats = new Map([[chatKeyLocal, state]]);
  const wire: string[] = [];
  initOutbound({
    getSock: () =>
      ({
        sendMessage: async (_jid: string, content: { text: string }) => {
          wire.push(content.text);
          return {};
        },
      }) as any,
    isConnected: () => true,
    rememberSent: () => {},
    loggedOut: () => false,
    isGuardValid: (guard) => guardMatchesState(chats.get(guard.chatKey), guard),
  });

  const computerGuard = { chatKey: chatKeyLocal, generation: 0, laneId: computerLaneId, laneGeneration: 0 };
  const codexGuard = { chatKey: chatKeyLocal, generation: 0, laneId: codexLaneId, laneGeneration: 0 };
  // "@codex /new" while both run:
  state.laneGenerations = { [codexLaneId]: 1 };

  const codexReply = await safeSend(chatKeyLocal, "Codex: stale result", { guard: codexGuard });
  assert.equal(codexReply.delivered, false); // its own lane was reset

  const computerReply = await safeSend(chatKeyLocal, "Computer: fresh result", { guard: computerGuard });
  assert.equal(computerReply.delivered, true); // the other lane is untouched
  assert.ok(wire.some((text) => text.includes("fresh result")));
  assert.ok(!wire.some((text) => text.includes("stale result")));
});

test("after lane B /new + crash, lane A's journal rows survive recovery (G1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-lane-gen-recovery-"));
  const file = join(dir, "pending-turns.json");
  try {
    const journal = new TurnJournal<{ laneId: string; laneGeneration: number }>(file);
    await journal.add({
      queueKey: computerLane,
      remoteJid: chatKey,
      payload: { laneId: computerLaneId, laneGeneration: 0 },
    });
    await journal.add({
      queueKey: codexLane,
      remoteJid: chatKey,
      payload: { laneId: codexLaneId, laneGeneration: 0 },
    });

    // "@codex /new" bumps codex's lane generation and persists it; the crash
    // happens before the journal cancel lands. Recovery validates each row's
    // stored laneGeneration against the persisted lane epochs.
    const persistedLaneGenerations: Record<string, number> = { [codexLaneId]: 1 };
    const restored = new TurnJournal<{ laneId: string; laneGeneration: number }>(file).snapshot();
    const verdicts = restored.map((turn) =>
      generationStillValid(
        turn.payload.laneGeneration,
        persistedLaneGenerations[turn.payload.laneId] ?? 0,
      ),
    );
    assert.deepEqual(
      restored.map((turn, i) => ({ lane: turn.payload.laneId, ok: verdicts[i].ok })),
      [
        { lane: computerLaneId, ok: true }, // lane A replays
        { lane: codexLaneId, ok: false }, // lane B dropped (superseded)
      ],
    );
    // Legacy rows without a stored laneGeneration pass, like the chat generation.
    assert.ok(generationStillValid(undefined, 5).ok);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PN/LID alias merge takes the higher epoch per lane (G1)", () => {
  assert.deepEqual(
    mergeLaneGenerations(
      { [computerLaneId]: 2, [codexLaneId]: 1 },
      { [codexLaneId]: 3, extra: 1 },
    ),
    { [computerLaneId]: 2, [codexLaneId]: 3, extra: 1 },
  );
  assert.deepEqual(mergeLaneGenerations(undefined, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeLaneGenerations({ a: 1 }, undefined), { a: 1 });
  assert.equal(mergeLaneGenerations(undefined, undefined), undefined);
});

test("lane labels never expose a live trigger token (G3/G4)", () => {
  assert.equal(laneLabelFromId("mention:codex:@codex"), "Codex");
  assert.equal(laneLabelFromId("mention:claude:@computer"), "Computer");
  assert.equal(laneLabelFromId("claude"), "Computer"); // group/provider lane
  assert.equal(laneLabelFromId("gemini"), "Gemini");
  assert.equal(laneLabelFromId(""), "unknown"); // legacy chat-level key
  assert.ok(!laneLabelFromId("mention:codex:@codex").includes("@")); // hard rule
});
