import assert from "node:assert/strict";
import test from "node:test";

import { KeyedTurnQueue } from "../src/turn-queue.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

test("serializes turns per chat while allowing other chats to run", async () => {
  const queue = new KeyedTurnQueue();
  const gate = deferred();
  const events: string[] = [];

  const first = queue.enqueue("a", async () => {
    events.push("a1-start");
    await gate.promise;
    events.push("a1-end");
  });
  const second = queue.enqueue("a", async () => {
    events.push("a2");
  });
  const other = queue.enqueue("b", async () => {
    events.push("b1");
  });

  assert.equal(first.accepted && first.position, 0);
  assert.equal(second.accepted && second.position, 1);
  assert.equal(other.accepted && other.position, 0);
  assert.equal(queue.activeFor("a"), 1);
  assert.equal(queue.activeFor("b"), 1);
  assert.equal(queue.activeFor("missing"), 0);
  if (other.accepted) await other.done;
  assert.deepEqual(events, ["a1-start", "b1"]);

  gate.resolve();
  await Promise.all([
    first.accepted ? first.done : Promise.resolve(),
    second.accepted ? second.done : Promise.resolve(),
  ]);
  assert.deepEqual(events, ["a1-start", "b1", "a1-end", "a2"]);
  assert.equal(queue.activeFor("a"), 0);
});

test("a failed turn does not poison the next turn", async () => {
  const queue = new KeyedTurnQueue();
  const first = queue.enqueue("chat", async () => {
    throw new Error("boom");
  });
  const second = queue.enqueue("chat", async () => {});
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  await assert.rejects(first.accepted ? first.done : Promise.resolve(), /boom/);
  await (second.accepted ? second.done : Promise.resolve());
  assert.equal(queue.waiting("chat"), 0);
});

test("bounds waiting turns without rejecting the active turn", async () => {
  const queue = new KeyedTurnQueue(2);
  const gate = deferred();
  const active = queue.enqueue("chat", () => gate.promise);
  const one = queue.enqueue("chat", async () => {});
  const two = queue.enqueue("chat", async () => {});
  const overflow = queue.enqueue("chat", async () => {});

  assert.equal(active.accepted, true);
  assert.equal(one.accepted && one.position, 1);
  assert.equal(two.accepted && two.position, 2);
  assert.deepEqual(overflow, { accepted: false, position: 3, limit: "chat" });
  assert.deepEqual(queue.canAccept("chat"), { ok: false, limit: "chat" });
  gate.resolve();
  await Promise.all([
    active.accepted ? active.done : Promise.resolve(),
    one.accepted ? one.done : Promise.resolve(),
    two.accepted ? two.done : Promise.resolve(),
  ]);
});

test("controls can cancel waiting turns without killing the active one", async () => {
  const queue = new KeyedTurnQueue();
  const gate = deferred();
  let ran = false;
  const active = queue.enqueue("chat", () => gate.promise);
  const waiting = queue.enqueue("chat", async () => {
    ran = true;
  });
  assert.equal(queue.totalWaiting(), 1);
  assert.equal(queue.cancelWaiting("chat"), 1);
  assert.equal(queue.totalWaiting(), 0);
  if (waiting.accepted) await waiting.done;
  assert.equal(ran, false);
  gate.resolve();
  if (active.accepted) await active.done;
});

test("bounds total waiting work across chats", async () => {
  const queue = new KeyedTurnQueue(10, 1);
  const gateA = deferred();
  const gateB = deferred();
  const activeA = queue.enqueue("a", () => gateA.promise);
  const activeB = queue.enqueue("b", () => gateB.promise);
  const waitingA = queue.enqueue("a", async () => {});
  const rejectedB = queue.enqueue("b", async () => {});
  assert.equal(waitingA.accepted, true);
  assert.equal(rejectedB.accepted, false);
  // The GLOBAL cap rejected it (the per-chat queue for "b" was empty) — the
  // user-facing message must be able to name the right limit.
  assert.equal(!rejectedB.accepted && rejectedB.limit, "global");
  assert.deepEqual(queue.canAccept("b"), { ok: false, limit: "global" });
  gateA.resolve();
  gateB.resolve();
  await Promise.all([
    activeA.accepted ? activeA.done : Promise.resolve(),
    activeB.accepted ? activeB.done : Promise.resolve(),
    waitingA.accepted ? waitingA.done : Promise.resolve(),
  ]);
});

test("a queued turn resolves mutable session state only when it starts", async () => {
  const queue = new KeyedTurnQueue();
  let session: string | undefined;
  let secondSaw: string | undefined;
  const first = queue.enqueue("chat", async () => {
    await Promise.resolve();
    session = "thread-from-turn-one";
  });
  const second = queue.enqueue("chat", async () => {
    secondSaw = session;
  });
  await Promise.all([
    first.accepted ? first.done : Promise.resolve(),
    second.accepted ? second.done : Promise.resolve(),
  ]);
  assert.equal(secondSaw, "thread-from-turn-one");
});
