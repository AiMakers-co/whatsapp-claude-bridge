import "./helpers/test-home.js"; // must precede any src/config.js importer
import assert from "node:assert/strict";
import test from "node:test";

import {
  agentReplyLabel,
  botReplyPrefixes,
  hasAutomationMarker,
  hasBotReplyPrefix,
  markAutomated,
  neutralizeTriggerTokens,
  prefixReply,
  stripAutomationMarker,
} from "../src/replies.js";
import { matchMention } from "../src/mentions.js";
import {
  chunkForWhatsApp,
  delayedReplyText,
  initOutbound,
  safeSend,
} from "../src/outbound.js";

test("reply labels are deterministic and never doubled", () => {
  assert.equal(agentReplyLabel("@computer", "claude"), "Computer");
  assert.equal(agentReplyLabel("@codex", "codex"), "Codex");
  assert.equal(agentReplyLabel(undefined, "claude"), "Computer");
  assert.equal(prefixReply("Codex", "hello"), "Codex: hello");
  assert.equal(prefixReply("Codex", "Codex: hello"), "Codex: hello");
  assert.equal(prefixReply("Codex", "*Codex:* hello"), "Codex: hello");
});

test("neutralizeTriggerTokens defuses a live call sign embedded in a job note", () => {
  const triggers = ["@computer", "@codex"];
  // A job note derived from user/agent text: "/job @codex please rebuild x".
  const note = "@codex please rebuild x";
  const safe = neutralizeTriggerTokens(note, triggers);
  const routes = [
    { trigger: "@computer", provider: "claude" },
    { trigger: "@codex", provider: "codex" },
  ];
  // The RAW note would fire another local automation's matcher…
  assert.ok(matchMention(note, routes));
  // …the neutralized note must NOT — the token is split by the invisible marker.
  assert.equal(matchMention(safe, routes), undefined);
  // Still readable to a human (only an invisible char was inserted).
  assert.equal(safe.replace(/⁣/g, ""), note);
  // Trailing-punctuation form ("@codex;") is defused too, and unrelated "@"
  // handles are left alone.
  assert.equal(matchMention(neutralizeTriggerTokens("ping @codex;", triggers), routes), undefined);
  assert.equal(neutralizeTriggerTokens("email @someone about it", triggers), "email @someone about it");
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

test("invalidated task replies never reach the socket or pending queue", async () => {
  let attempts = 0;
  initOutbound({
    getSock: () =>
      ({
        sendMessage: async () => {
          attempts++;
          return {};
        },
      }) as any,
    isConnected: () => true,
    rememberSent: () => {},
    loggedOut: () => false,
    isGuardValid: () => false,
  });

  const result = await safeSend("chat@s.whatsapp.net", "Codex: stale", {
    guard: { chatKey: "chat@s.whatsapp.net", generation: 7 },
  });
  assert.equal(result.delivered, false);
  assert.equal(attempts, 0);
});

test("delivered sends report the WhatsApp ids assigned to each chunk", async () => {
  const sentIds: string[] = [];
  initOutbound({
    getSock: () =>
      ({
        sendMessage: async (_jid: string, _content: unknown, opts: any) => {
          sentIds.push(opts.messageId);
          return {};
        },
      }) as any,
    isConnected: () => true,
    rememberSent: () => {},
    loggedOut: () => false,
    isGuardValid: () => true,
  });

  const result = await safeSend("chat@s.whatsapp.net", `Codex: ${"a".repeat(8_500)}`);
  assert.equal(result.delivered, true);
  assert.ok(result.ids.length >= 2); // chunked send — one id per chunk
  assert.deepEqual(result.ids, sentIds); // ids surfaced to the caller match the wire
});

test("a fully queued offline reply reports delivered with no sent ids (R4)", async () => {
  // loggedOut short-circuits the retry window, so every chunk lands in the
  // pending-sends queue: delivered (durably queued) but nothing went out live.
  initOutbound({
    getSock: () => undefined,
    isConnected: () => false,
    rememberSent: () => {},
    loggedOut: () => true,
    isGuardValid: () => true,
  });

  const result = await safeSend("offline@s.whatsapp.net", "Codex: queued reply");
  assert.equal(result.delivered, true);
  assert.equal(result.ids.length, 1); // id pre-assigned for the eventual flush
  assert.deepEqual(result.sentIds, []); // nothing actually sent — R4 fallback case
});
