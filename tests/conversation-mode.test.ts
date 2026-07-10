import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLoopTripHalt,
  applyUserStop,
  parseConversationControl,
  parseGroupCommand,
  resolveConversation,
  shouldRefreshConversation,
  startConversation,
  type StickyState,
} from "../src/conversation-mode.js";

const routes = [
  { trigger: "@computer", provider: "claude" },
  { trigger: "@codex", provider: "codex", model: "gpt-test" },
];

test("parses explicit conversation controls without eating normal prompts", () => {
  assert.deepEqual(parseConversationControl("/chat"), { kind: "chat", rest: "" });
  assert.deepEqual(parseConversationControl("/talk carry on"), {
    kind: "chat",
    rest: "carry on",
  });
  assert.deepEqual(parseConversationControl(" /STOP "), { kind: "stop" });
  assert.deepEqual(parseConversationControl("/new"), { kind: "new" });
  assert.deepEqual(parseConversationControl("/status"), { kind: "status" });
  assert.equal(parseConversationControl("please /stop"), undefined);
});

test("known verbs with trailing text execute the verb instead of running as tasks", () => {
  // R7: match the dedicated-group behavior — args to /stop //new //status are
  // ignored, they never ship to the agent as task text.
  assert.deepEqual(parseConversationControl("/stop now"), { kind: "stop" });
  assert.deepEqual(parseConversationControl("/new please"), { kind: "new" });
  assert.deepEqual(parseConversationControl("/new idea"), { kind: "new" });
  assert.deepEqual(parseConversationControl("/status?"), { kind: "status" });
  // /chat keeps its <rest> semantics (first prompt of the conversation).
  assert.deepEqual(parseConversationControl("/chat let's go"), {
    kind: "chat",
    rest: "let's go",
  });
  // Prefix-overlapping words stay conversational.
  assert.equal(parseConversationControl("/stopped by the office"), undefined);
  assert.equal(parseConversationControl("/chats are broken"), undefined);
  assert.equal(parseConversationControl("/newsletter draft"), undefined);
});

test("sticky chats recognize /cd and /use so they never ship to the agent", () => {
  // F8: same command set as the dedicated-group handlers.
  assert.deepEqual(parseConversationControl("/cd /Users/me/projects/app"), {
    kind: "cd",
    path: "/Users/me/projects/app",
  });
  assert.deepEqual(parseConversationControl("/cd /path with spaces/dir"), {
    kind: "cd",
    path: "/path with spaces/dir",
  });
  assert.deepEqual(parseConversationControl("/cd"), { kind: "cd", path: "" });
  assert.deepEqual(parseConversationControl(" /USE codex "), {
    kind: "use",
    provider: "codex",
  });
  assert.deepEqual(parseConversationControl("/use"), { kind: "use", provider: "" });
  // Unknown '/'-leading conversational text still goes to the agent.
  assert.equal(parseConversationControl("/etc/hosts looks wrong"), undefined);
  assert.equal(parseConversationControl("/cdimage is a directory"), undefined);
});

test("group command parsing closes the attachment and mention bypasses", () => {
  // F8: leading '/' is ALWAYS a command (known or unknown), even when the
  // message carries an attachment — never an agent task.
  assert.deepEqual(parseGroupCommand("/new", false), {
    cmd: "new",
    arg: "",
    droppedAttachment: false,
  });
  assert.deepEqual(parseGroupCommand("/cd /tmp/project", true), {
    cmd: "cd",
    arg: "/tmp/project",
    droppedAttachment: true,
  });
  // Unknown commands are still commands — they fall to the "Unknown command"
  // notice, not to the task runner (and the attachment is not run either).
  assert.deepEqual(parseGroupCommand("/destroy everything", true), {
    cmd: "destroy",
    arg: "everything",
    droppedAttachment: true,
  });
  // Non-command bodies run as tasks as before.
  assert.equal(parseGroupCommand("deploy the /api service", true), undefined);
  assert.equal(parseGroupCommand("", true), undefined);
});

test("a loop trip preserves the generation while /stop bumps it", () => {
  // F4: the trip transition must not invalidate the running task's reply.
  const tripped: StickyState = {
    conversation: startConversation("@codex", 1_000, 60_000),
    generation: 7,
  };
  applyLoopTripHalt(tripped);
  assert.equal(tripped.conversation, undefined);
  assert.equal(tripped.generation, 7);

  const stopped: StickyState = {
    conversation: startConversation("@codex", 1_000, 60_000),
    generation: 7,
  };
  applyUserStop(stopped);
  assert.equal(stopped.conversation, undefined);
  assert.equal(stopped.generation, 8);
});

test("only self-chat or an explicitly active chat becomes sticky", () => {
  assert.equal(shouldRefreshConversation(true, true, false), true);
  assert.equal(shouldRefreshConversation(true, false, false), false);
  assert.equal(shouldRefreshConversation(true, false, true), true);
  assert.equal(shouldRefreshConversation(false, false, true), true);
  assert.equal(shouldRefreshConversation(false, false, false), false);
});

test("resolves a live call sign from current routing and expires safely", () => {
  const active = startConversation("@CODEX", 1_000, 60_000);
  assert.deepEqual(active, { trigger: "@CODEX", expiresAt: 61_000 });
  assert.deepEqual(resolveConversation(active, routes, 5_000), {
    route: routes[1],
    clear: false,
  });
  assert.deepEqual(resolveConversation(active, routes, 61_000), { clear: true });
  assert.deepEqual(
    resolveConversation({ trigger: "@removed", expiresAt: 99_000 }, routes, 5_000),
    { clear: true },
  );
  assert.equal(startConversation("@codex", 1_000, 0), undefined);
});

test("recovered command-shaped bodies are detected for replay drops (R6)", () => {
  // index.ts DROPS (finishes) any RECOVERED group turn whose body parses as a
  // command — a legacy journal row like "/new" or an unknown "/verb" must
  // never reach provider.run on replay after the command-hardening upgrade.
  assert.ok(parseGroupCommand("/new", false));
  assert.ok(parseGroupCommand("/anything at all", false));
  assert.equal(parseGroupCommand("normal task text", false), undefined);
});
