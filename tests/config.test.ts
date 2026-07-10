import "./helpers/test-home.js"; // must precede any src/config.js importer
import assert from "node:assert/strict";
import test from "node:test";

import { parseConversationMinutes } from "../src/config.js";

test("blank CONVERSATION_MODE_MINUTES defaults to 120, explicit 0 disables", () => {
  const silent = () => {};
  // Unset and blank (the settings UI saves '' when the field is cleared) must
  // default like the other numerics — NOT silently become 0/disabled.
  assert.equal(parseConversationMinutes(undefined, silent), 120);
  assert.equal(parseConversationMinutes("", silent), 120);
  assert.equal(parseConversationMinutes("   ", silent), 120);

  // Explicit '0' keeps its documented meaning: sticky mode disabled.
  assert.equal(parseConversationMinutes("0", silent), 0);

  // Normal values parse.
  assert.equal(parseConversationMinutes("45", silent), 45);

  // Invalid values warn and fall back to 120.
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  assert.equal(parseConversationMinutes("banana", warn), 120);
  assert.equal(parseConversationMinutes("-5", warn), 120);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /invalid/);

  // Absurdly high values clamp (with a warning).
  assert.equal(parseConversationMinutes("999999", warn), 10_080);
  assert.equal(warnings.length, 3);
});
