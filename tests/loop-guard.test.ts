import assert from "node:assert/strict";
import test from "node:test";

import { canonicalChatKeyFor, MentionLoopGuard } from "../src/loop-guard.js";

test("phone and LID self-chat aliases share one canonical bucket", () => {
  const phone = "31627597658@s.whatsapp.net";
  const lid = "151479235166379@lid";
  assert.equal(canonicalChatKeyFor(lid, lid, phone, lid), phone);
  assert.equal(canonicalChatKeyFor(phone, phone, phone, lid), phone);
  assert.equal(
    canonicalChatKeyFor("someone:4@s.whatsapp.net", "someone@s.whatsapp.net", phone, lid),
    "someone:4@s.whatsapp.net",
  );
});

test("third rapid task attempt trips a one-shot cooldown", () => {
  const guard = new MentionLoopGuard(30_000, 3, 120_000);
  assert.deepEqual(guard.record("self", 1_000), { allowed: true, tripped: false });
  assert.deepEqual(guard.record("self", 2_000), { allowed: true, tripped: false });

  const third = guard.record("self", 3_000);
  assert.equal(third.allowed, false);
  assert.equal(third.tripped, true);
  assert.equal(third.pausedUntil, 123_000);

  const fourth = guard.record("self", 4_000);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.tripped, false);
  assert.equal(fourth.pausedUntil, 123_000);

  assert.deepEqual(guard.record("other-chat", 5_000), { allowed: true, tripped: false });
  assert.deepEqual(guard.record("self", 123_001), { allowed: true, tripped: false });
});
