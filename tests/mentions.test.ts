import assert from "node:assert/strict";
import test from "node:test";

import { matchMention, stripMentionToken } from "../src/mentions.js";

const routes = [
  { trigger: "@computer", provider: "claude" },
  { trigger: "@codex", provider: "codex" },
];

test("matches configured mention tokens without matching substrings", () => {
  assert.equal(matchMention("please use @codex for this", routes)?.provider, "codex");
  assert.equal(matchMention("@computer: take a look", routes)?.provider, "claude");
  assert.equal(matchMention("email support@computerstore.com", routes), undefined);
  assert.equal(matchMention("see @codex.com", routes), undefined);
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
