import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConversationTranscript,
  injectedChunkIds,
  withMediaReference,
} from "../src/conversation-history.js";

test("excludes future human messages but includes replies completed while queued", () => {
  const transcript = buildConversationTranscript(
    [
      { ts: 10, label: "You", text: "first" },
      { ts: 20, label: "You", text: "queued follow-up" },
      { ts: 30, label: "You", text: "future message" },
    ],
    [{ ts: 25, label: "Codex", text: "answer to first" }],
    { upToTs: 20 },
  );
  assert.match(transcript, /first/);
  assert.match(transcript, /queued follow-up/);
  assert.match(transcript, /Codex: answer to first/);
  assert.doesNotMatch(transcript, /future message/);
});

test("deduplicates merged history, filters Bridge chatter, and honors /new floor", () => {
  const duplicate = { ts: 20, label: "Computer", text: "hello" };
  const transcript = buildConversationTranscript(
    [
      { ts: 5, label: "You", text: "old conversation" },
      { ts: 12, label: "Bridge", text: "queued" },
      { ts: 13, label: "You", text: "Bridge: operational" },
      duplicate,
      duplicate,
    ],
    [],
    { sinceTs: 10 },
  );
  assert.doesNotMatch(transcript, /old conversation|operational|queued/);
  assert.equal((transcript.match(/Computer: hello/g) ?? []).length, 1);
});

test("keeps the newest bounded context under the character cap", () => {
  const transcript = buildConversationTranscript(
    [
      { ts: 1, label: "A", text: "a".repeat(50) },
      { ts: 2, label: "B", text: "b".repeat(50) },
      { ts: 3, label: "C", text: "c".repeat(50) },
    ],
    [],
    { characterLimit: 80 },
  );
  assert.ok(transcript.length <= 80);
  assert.match(transcript, /C:/);
  assert.doesNotMatch(transcript, /A:/);
});

test("same-second queue snapshots admit only message ids present at acceptance", () => {
  const transcript = buildConversationTranscript(
    [
      { id: "earlier", ts: 99, label: "You", text: "earlier" },
      { id: "accepted", ts: 100, label: "You", text: "accepted turn" },
      { id: "later", ts: 100, label: "You", text: "later same-second turn" },
    ],
    [],
    { upToTs: 100, allowedIdsAtCutoff: new Set(["accepted"]) },
  );
  assert.match(transcript, /earlier/);
  assert.match(transcript, /accepted turn/);
  assert.doesNotMatch(transcript, /later same-second turn/);
});

test("message-id dedupe keeps the richer stored attachment entry", () => {
  const transcript = buildConversationTranscript([
    { id: "m1", ts: 10, label: "You", text: "caption\n[Attached image available at: /tmp/photo.jpg]" },
    { id: "m1", ts: 10, label: "You", text: "caption" },
  ]);
  assert.equal((transcript.match(/You:/g) ?? []).length, 1);
  assert.match(transcript, /\/tmp\/photo\.jpg/);
});

test("captioned attachments gain one usable path reference", () => {
  assert.equal(
    withMediaReference("look at this", "/tmp/photo.jpg", "image"),
    "look at this\n[Attached image available at: /tmp/photo.jpg]",
  );
  assert.equal(
    withMediaReference("[image: photo.jpg → /tmp/photo.jpg]", "/tmp/photo.jpg", "image"),
    "[image: photo.jpg → /tmp/photo.jpg]",
  );
});

test("an agent reply appears once when stored and injected copies share an id", () => {
  // F7a: the send path surfaces the delivered chunk ids; recordAgentReply
  // stores them, so the catch-up injection copy and the persisted-store copy
  // collide on the SAME id and dedupe to a single transcript line.
  const transcript = buildConversationTranscript(
    [
      { id: "q1", ts: 10, label: "You", text: "first ask" },
      { id: "r1", ts: 20, label: "Codex", text: "the answer" }, // persisted store copy
    ],
    [{ id: "r1", ts: 20, label: "Codex", text: "the answer" }], // completed-reply injection
    { upToTs: 30 },
  );
  assert.equal((transcript.match(/the answer/g) ?? []).length, 1);
});

test("a stored agent reply in the same second as the cutoff survives via the id allowlist", () => {
  // F7b: formatHistory unions the recorded agent-reply ids into
  // allowedIdsAtCutoff — the reply must survive the same-second cutoff while a
  // LATER human message in that same second is still excluded.
  const transcript = buildConversationTranscript(
    [
      { id: "q1", ts: 99, label: "You", text: "earlier ask" },
      { id: "r1", ts: 100, label: "Codex", text: "reply landing at the cutoff second" },
      { id: "q2", ts: 100, label: "You", text: "next ask at the cutoff second" },
      { id: "q3", ts: 100, label: "You", text: "later human message same second" },
    ],
    [],
    { upToTs: 100, allowedIdsAtCutoff: new Set(["q2", "r1"]) },
  );
  assert.match(transcript, /earlier ask/);
  assert.match(transcript, /reply landing at the cutoff second/);
  assert.match(transcript, /next ask at the cutoff second/);
  assert.doesNotMatch(transcript, /later human message same second/);
});

test("post-flush dedupe drops the id-less offline fallback copy (R4)", () => {
  // While queued offline, the reply exists only as an id-less live-buffer
  // entry. After the pending-send flush, the store gains an id-bearing row
  // (parsed from its "(delayed) Codex: ..." form) — the id-less copy must go.
  const transcript = buildConversationTranscript(
    [
      { id: "q1", ts: 10, label: "You", text: "ask" },
      { id: "r1", ts: 20, label: "Codex", text: "queued  reply" }, // flushed store row
      { ts: 20, label: "Codex", text: "queued reply" }, // id-less fallback copy
    ],
    [],
    { upToTs: 30 },
  );
  assert.equal((transcript.match(/queued\s+reply/g) ?? []).length, 1);

  // Before the flush there is no id-bearing row — the fallback must survive.
  const preFlush = buildConversationTranscript(
    [
      { id: "q1", ts: 10, label: "You", text: "ask" },
      { ts: 20, label: "Codex", text: "queued reply" },
    ],
    [],
    { upToTs: 30 },
  );
  assert.match(preFlush, /queued reply/);

  // Same text from a DIFFERENT label is a different message — never deduped.
  const otherLabel = buildConversationTranscript(
    [
      { id: "r1", ts: 20, label: "Codex", text: "same words" },
      { ts: 21, label: "Computer", text: "same words" },
    ],
    [],
    { upToTs: 30 },
  );
  assert.equal((otherLabel.match(/same words/g) ?? []).length, 2);
});

test("injected replies exclude their stored chunk rows so full text wins (R5)", () => {
  const injected = [
    { id: "c1", ts: 100, label: "Codex", text: "part one part two", ids: ["c1", "c2"] },
  ];
  assert.deepEqual([...injectedChunkIds(injected)].sort(), ["c1", "c2"]);
  assert.deepEqual([...injectedChunkIds([{ ids: [] }, {}])], []);

  // Composed behavior (mirrors formatHistory): the caller drops stored rows
  // whose id is an injected chunk id, so the transcript carries the injected
  // FULL text exactly once — never a partial chunk subset around a cutoff.
  const exclusion = injectedChunkIds(injected);
  const storedRows = [
    { id: "q1", ts: 99, label: "You", text: "ask" },
    { id: "c1", ts: 100, label: "Codex", text: "part one" },
    { id: "c2", ts: 100, label: "Codex", text: "part two" },
  ].filter((row) => !exclusion.has(row.id));
  const transcript = buildConversationTranscript(storedRows, injected, {
    upToTs: 100,
    allowedIdsAtCutoff: new Set(["q1"]),
  });
  assert.equal((transcript.match(/part one part two/g) ?? []).length, 1);
  assert.doesNotMatch(transcript, /Codex: part one\n/);
  assert.match(transcript, /ask/);
});
