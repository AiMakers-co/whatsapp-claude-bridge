import assert from "node:assert/strict";
import test from "node:test";

import {
  agentReplyLabel,
  botReplyPrefixes,
  hasAutomationMarker,
  hasBotReplyPrefix,
  markAutomated,
  prefixReply,
  stripAutomationMarker,
} from "../src/replies.js";
import { chunkForWhatsApp, delayedReplyText } from "../src/outbound.js";

test("reply labels are deterministic and never doubled", () => {
  assert.equal(agentReplyLabel("@computer", "claude"), "Computer");
  assert.equal(agentReplyLabel("@codex", "codex"), "Codex");
  assert.equal(agentReplyLabel(undefined, "claude"), "Computer");
  assert.equal(prefixReply("Codex", "hello"), "Codex: hello");
  assert.equal(prefixReply("Codex", "Codex: hello"), "Codex: hello");
  assert.equal(prefixReply("Codex", "*Codex:* hello"), "Codex: hello");
});

test("automation markers and visible bot prefixes are recognized", () => {
  const marked = markAutomated("Computer: mentions @codex safely");
  assert.equal(hasAutomationMarker(marked), true);
  assert.equal(stripAutomationMarker(marked), "Computer: mentions @codex safely");
  assert.equal(hasAutomationMarker(markAutomated("")), true);

  const prefixes = botReplyPrefixes(["Growth Bot:"]);
  assert.equal(hasBotReplyPrefix("Nora: Directed at @codex", prefixes), true);
  assert.equal(hasBotReplyPrefix("  *Codex:* done", prefixes), true);
  assert.equal(hasBotReplyPrefix("(delayed) Computer: done", prefixes), true);
  assert.equal(hasBotReplyPrefix("Growth Bot: report", prefixes), true);
  assert.equal(hasBotReplyPrefix("Tell Nora: ask @codex", prefixes), false);
  assert.equal(hasBotReplyPrefix("@codex Nora: explain this", prefixes), false);

  // Control-API text must retain both barriers even when its payload begins
  // with a live call sign.
  const apiWire = markAutomated(prefixReply("Bridge", "@codex run this"));
  assert.equal(stripAutomationMarker(apiWire), "Bridge: @codex run this");
  assert.equal(hasBotReplyPrefix(apiWire, prefixes), true);
});

test("every long physical chunk retains its visible source prefix", () => {
  const text = `Codex: ${"a".repeat(8_500)}🙂`;
  const parts = chunkForWhatsApp(text);
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((part) => part.startsWith("Codex: ")));
  assert.ok(parts.every((part) => part.length <= 4_000));
  assert.ok(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part)));
  assert.equal(delayedReplyText("Codex: hello"), "Codex: (delayed) hello");

  const normalizedBold = prefixReply("Codex", `*Codex:* ${"b".repeat(8_500)}`);
  assert.ok(chunkForWhatsApp(normalizedBold).every((part) => part.startsWith("Codex: ")));

  const numericCallSign = prefixReply("123", "c".repeat(8_500));
  assert.ok(chunkForWhatsApp(numericCallSign).every((part) => part.startsWith("123: ")));
});
