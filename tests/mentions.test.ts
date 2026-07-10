import assert from "node:assert/strict";
import test from "node:test";

import {
  claimMentionSession,
  getMentionSession,
  matchMention,
  mentionSessionKey,
  parseMentionRouteEntry,
  stripMentionToken,
} from "../src/mentions.js";

const routes = [
  { trigger: "@computer", provider: "claude" },
  { trigger: "@codex", provider: "codex", model: "gpt-5.6" },
];

test("matches configured mention tokens without matching substrings", () => {
  assert.equal(matchMention("please use @codex for this", routes)?.provider, "codex");
  assert.equal(matchMention("please use @codex for this", routes)?.model, "gpt-5.6");
  assert.equal(matchMention("@computer: take a look", routes)?.provider, "claude");
  assert.equal(matchMention("email support@computerstore.com", routes), undefined);
  assert.equal(matchMention("see @codex.com", routes), undefined);
});

test("parses legacy and per-call-sign model routes", () => {
  const providers = new Set(["claude", "codex", "gemini", "grok"]);
  assert.deepEqual(parseMentionRouteEntry("@computer:claude", providers), {
    route: { trigger: "@computer", provider: "claude" },
  });
  assert.deepEqual(parseMentionRouteEntry("@codex:codex:gpt-5.6", providers), {
    route: { trigger: "@codex", provider: "codex", model: "gpt-5.6" },
  });
  assert.deepEqual(
    parseMentionRouteEntry("@ops:urgent:codex:openai:gpt-5.6", providers),
    {
      route: {
        trigger: "@ops:urgent",
        provider: "codex",
        model: "openai:gpt-5.6",
      },
    },
  );
  assert.deepEqual(parseMentionRouteEntry("@review:bogus:model-x", providers), {
    error: "unknown-provider",
    provider: "bogus",
  });
});

test("call signs isolate sessions and claim one legacy provider session", () => {
  const sessions: Record<string, string> = { codex: "legacy-thread" };
  const codex = { trigger: "@codex", provider: "codex" };
  const reviewer = { trigger: "@review", provider: "codex" };

  const first = claimMentionSession(sessions, codex);
  assert.equal(first.key, mentionSessionKey(codex));
  assert.equal(first.sessionId, "legacy-thread");
  assert.equal(first.migratedLegacy, true);
  assert.equal(sessions.codex, undefined);

  // The second call sign cannot inherit or share the first one's thread.
  const second = claimMentionSession(sessions, reviewer);
  assert.notEqual(second.key, first.key);
  assert.equal(second.sessionId, undefined);
  sessions[second.key] = "review-thread";
  assert.equal(claimMentionSession(sessions, codex).sessionId, "legacy-thread");
  assert.equal(claimMentionSession(sessions, reviewer).sessionId, "review-thread");

  // Model changes keep the call sign's continuity; provider changes do not.
  assert.equal(
    mentionSessionKey({ ...codex, model: "another-model" }),
    mentionSessionKey(codex),
  );
  assert.notEqual(mentionSessionKey({ ...codex, provider: "claude" }), first.key);
});

test("a command-group call sign never consumes the plain provider session", () => {
  const sessions: Record<string, string> = { codex: "plain-group-thread" };
  const route = { trigger: "@codex", provider: "codex" };

  const selected = getMentionSession(sessions, route);
  assert.equal(selected.sessionId, undefined);
  assert.equal(selected.migratedLegacy, false);
  assert.equal(sessions.codex, "plain-group-thread");

  sessions[selected.key] = "call-sign-thread";
  assert.equal(getMentionSession(sessions, route).sessionId, "call-sign-thread");
  assert.equal(sessions.codex, "plain-group-thread");
});

test("ordinary-chat matching requires the trigger to lead the message", () => {
  assert.equal(
    matchMention("  @codex are you there?", routes, { leadingOnly: true })?.provider,
    "codex",
  );
  assert.equal(
    matchMention("Nora: Directed at @codex, not me", routes, { leadingOnly: true }),
    undefined,
  );
  assert.equal(
    matchMention("please use @codex for this", routes, { leadingOnly: true }),
    undefined,
  );
  // Dedicated command groups intentionally retain anywhere-token selection.
  assert.equal(matchMention("please use @codex for this", routes)?.provider, "codex");
});

test("a command-group provider selector preserves instructions on both sides", () => {
  const suffix = "Deploy the app using @codex";
  const suffixMatch = matchMention(suffix, routes);
  assert.ok(suffixMatch);
  assert.equal(stripMentionToken(suffix, suffixMatch), "Deploy the app using");

  const middle = "Use project X, then @codex fix the bug";
  const middleMatch = matchMention(middle, routes);
  assert.ok(middleMatch);
  assert.equal(stripMentionToken(middle, middleMatch), "Use project X, then fix the bug");

  const prefix = "@codex: inspect the logs";
  const prefixMatch = matchMention(prefix, routes);
  assert.ok(prefixMatch);
  assert.equal(stripMentionToken(prefix, prefixMatch), "inspect the logs");
});
