import assert from "node:assert/strict";
import test from "node:test";

import { extractMessageText } from "../src/message-text.js";
import { AUTOMATION_MARKER } from "../src/replies.js";

test("extracts automation markers from direct and wrapped document captions", () => {
  assert.equal(
    extractMessageText({ documentMessage: { caption: AUTOMATION_MARKER } }),
    AUTOMATION_MARKER,
  );
  assert.equal(
    extractMessageText({
      documentWithCaptionMessage: {
        message: { documentMessage: { caption: AUTOMATION_MARKER } },
      },
    }),
    AUTOMATION_MARKER,
  );
  assert.equal(
    extractMessageText({
      ephemeralMessage: {
        message: { imageMessage: { caption: "hello" } },
      },
    }),
    "hello",
  );
});
