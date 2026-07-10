import "./helpers/test-home.js"; // must precede any src/config.js importer
import assert from "node:assert/strict";
import test from "node:test";

import { MentionLoopGuard } from "../src/loop-guard.js";
import {
  applyLoopTripHalt,
  applyUserStop,
  startConversation,
  type StickyState,
} from "../src/conversation-mode.js";
import { KeyedTurnQueue } from "../src/turn-queue.js";
import { initOutbound, safeSend } from "../src/outbound.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

test("the strict guard trips at 3/30s and the conversation guard at 8/30s", () => {
  // F2: dedicated-group plain messages and explicit call-sign mentions use the
  // STRICT 3-hits/30s barrier (the CLAUDE.md hard-rule breaker); only sticky
  // conversation follow-ups get the looser 8/30s allowance.
  const strict = new MentionLoopGuard(30_000, 3, 2 * 60_000);
  const now = 1_000_000;
  assert.equal(strict.record("chat", now).allowed, true);
  assert.equal(strict.record("chat", now + 1).allowed, true);
  const strictTrip = strict.record("chat", now + 2);
  assert.equal(strictTrip.allowed, false);
  assert.equal(strictTrip.tripped, true);
  // During the pause: denied silently (no second trip notice).
  const paused = strict.record("chat", now + 3);
  assert.equal(paused.allowed, false);
  assert.equal(paused.tripped, false);

  const conversation = new MentionLoopGuard(30_000, 8, 2 * 60_000);
  for (let i = 0; i < 7; i++) {
    assert.equal(conversation.record("chat", now + i).allowed, true, `hit ${i + 1}`);
  }
  const conversationTrip = conversation.record("chat", now + 7);
  assert.equal(conversationTrip.allowed, false);
  assert.equal(conversationTrip.tripped, true);
});

test("a loop trip clears waiting turns but the running task still delivers", async () => {
  // F4: the trip transition ends sticky mode and cancels WAITING turns WITHOUT
  // bumping the chat generation — so the RUNNING turn's guarded reply still
  // passes the outbound send-guard. Generation bumps stay reserved for
  // explicit user resets (/stop shown at the end for contrast).
  const chatKey = "chat@s.whatsapp.net";
  const chat: StickyState = {
    conversation: startConversation("@codex", Date.now(), 60_000),
    generation: 3,
  };
  const chats = new Map<string, StickyState>([[chatKey, chat]]);

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
    // Same shape as index.ts: a missing chat counts as generation 0 (F5).
    isGuardValid: (guard) => (chats.get(guard.chatKey)?.generation ?? 0) === guard.generation,
  });

  const queue = new KeyedTurnQueue();
  const gate = deferred();
  const runningGuard = { chatKey, generation: chat.generation };
  let runningDelivered = false;
  const running = queue.enqueue(chatKey, async () => {
    await gate.promise; // trip happens while this turn is running
    const sent = await safeSend(chatKey, "Codex: finished result", { guard: runningGuard });
    runningDelivered = sent.delivered;
  });
  let waitingRan = false;
  queue.enqueue(chatKey, async () => {
    waitingRan = true;
  });

  // ── Trip ──
  applyLoopTripHalt(chat);
  const cleared = queue.cancelWaiting(chatKey);

  assert.equal(cleared, 1); // waiting turns cleared
  assert.equal(chat.conversation, undefined); // sticky mode ended
  assert.equal(chat.generation, 3); // NO generation bump

  gate.resolve();
  if (running.accepted) await running.done;
  assert.equal(runningDelivered, true); // the running task's reply delivered
  assert.equal(waitingRan, false);
  assert.ok(wire.some((text) => text.includes("finished result")));

  // ── Contrast: user /stop bumps the generation and suppresses the reply ──
  applyUserStop(chat);
  assert.equal(chat.generation, 4);
  const stale = await safeSend(chatKey, "Codex: late result", { guard: runningGuard });
  assert.equal(stale.delivered, false);
  assert.ok(!wire.some((text) => text.includes("late result")));
});
