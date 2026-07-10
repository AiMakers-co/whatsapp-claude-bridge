import "./helpers/test-home.js"; // must precede any src/config.js importer
import assert from "node:assert/strict";
import test from "node:test";

import {
  generationStillValid,
  resolveRecoveredMentionRoute,
  validateRecoveredGroupTurn,
} from "../src/recovery.js";
import type { GroupConfig } from "../src/config.js";

const routes = [
  { trigger: "@computer", provider: "claude" },
  { trigger: "@codex", provider: "codex", model: "gpt-test" },
];

const groupCfg: GroupConfig = {
  name: "Claude Chat",
  workdir: "/tmp/live-workdir",
  allowedJids: ["12025550123@s.whatsapp.net"],
  participants: [],
};

test("recovered mention turns require live mention config", () => {
  // Mentions disabled since admission → dropped.
  const disabled = resolveRecoveredMentionRoute("@codex", false, routes);
  assert.equal(disabled.ok, false);
  assert.match(!disabled.ok ? disabled.reason : "", /disabled/);

  // Call sign removed since admission → dropped.
  const removed = resolveRecoveredMentionRoute("@removed", true, routes);
  assert.equal(removed.ok, false);
  assert.match(!removed.ok ? removed.reason : "", /no longer configured/);

  // Still configured → replays with the LIVE route (current provider/model).
  const live = resolveRecoveredMentionRoute("@CODEX", true, routes);
  assert.ok(live.ok);
  assert.deepEqual(live.ok ? live.route : undefined, routes[1]);
});

test("recovered group turns require a live monitored group and authorisation", () => {
  // Group removed from monitoring since admission → dropped.
  const unmonitored = validateRecoveredGroupTurn(undefined, true, "x@s.whatsapp.net", "Old Group");
  assert.equal(unmonitored.ok, false);
  assert.match(!unmonitored.ok ? unmonitored.reason : "", /no longer monitored/);
  assert.match(!unmonitored.ok ? unmonitored.reason : "", /Old Group/);

  // Sender de-authorised since admission (and not fromMe) → dropped.
  const revoked = validateRecoveredGroupTurn(groupCfg, false, "9999@s.whatsapp.net");
  assert.equal(revoked.ok, false);
  assert.match(!revoked.ok ? revoked.reason : "", /no longer authorised/);

  // fromMe always passes the sender gate; the LIVE config is what replays.
  const own = validateRecoveredGroupTurn(groupCfg, true, "9999@s.whatsapp.net");
  assert.ok(own.ok);
  assert.equal(own.ok ? own.cfg.workdir : "", "/tmp/live-workdir");

  // A still-allowlisted sender passes too.
  const allowed = validateRecoveredGroupTurn(groupCfg, false, "12025550123@s.whatsapp.net");
  assert.ok(allowed.ok);
});

test("generation mismatches drop recovered turns; legacy rows replay", () => {
  // Cancelled by /new//stop//cd//use before the crash → dropped.
  const stale = generationStillValid(2, 3);
  assert.equal(stale.ok, false);
  assert.match(!stale.ok ? stale.reason : "", /superseded by a reset/);

  // Matching generation replays.
  assert.deepEqual(generationStillValid(3, 3), { ok: true });

  // A never-persisted chat counts as generation 0.
  assert.deepEqual(generationStillValid(0, 0), { ok: true });
  assert.equal(generationStillValid(1, 0).ok, false);

  // Pre-upgrade journal rows carry no generation — allowed through.
  assert.deepEqual(generationStillValid(undefined, 5), { ok: true });
});

// ── Second-round coverage (R1/R2/R3) ────────────────────────────────────────

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pendingSourceIds,
  seedRecoveryGroupPins,
  turnAlreadyHandled,
  verifiedResolvedConfigs,
} from "../src/recovery.js";
import { TurnJournal } from "../src/turn-journal.js";

const extraCfg: GroupConfig = {
  name: "Deploys",
  workdir: "/tmp/deploys",
  allowedJids: [],
  participants: [],
};

test("recovery seeding is gated on CREATE_GROUP and skips resolved jids (R2)", () => {
  const pins = { "Claude Chat": "111@g.us", Deploys: "222@g.us", Stale: "999@g.us" };

  // CREATE_GROUP=false: stale pins must not resurrect group monitoring.
  assert.deepEqual(seedRecoveryGroupPins(false, [groupCfg, extraCfg], pins, new Set()), []);

  // Enabled: only CONFIGURED groups seed, and already-resolved jids are kept.
  const seeded = seedRecoveryGroupPins(true, [groupCfg, extraCfg], pins, new Set(["111@g.us"]));
  assert.deepEqual(seeded, [{ jid: "222@g.us", cfg: extraCfg }]);

  // No pin for a config → nothing seeded for it (999@g.us is unconfigured).
  assert.deepEqual(
    seedRecoveryGroupPins(true, [groupCfg], {}, new Set()),
    [],
  );
});

test("seeded pins never count as resolved, so dead pins are re-verified (R1)", () => {
  // One VERIFIED entry (Claude Chat) and one recovery-SEEDED entry (Deploys).
  const entries: Array<[string, GroupConfig]> = [
    ["111@g.us", groupCfg],
    ["222@g.us", extraCfg],
  ];
  const resolved = verifiedResolvedConfigs(entries, new Set(["222@g.us"]));
  // ensureGroups may skip the verified config, but MUST re-resolve the seeded
  // one against the live fetch — a group deleted while the bridge was down
  // must fall through to subject match / re-creation, not stay a dead jid.
  assert.ok(resolved.has(groupCfg));
  assert.ok(!resolved.has(extraCfg));
  // Once the pin is verified (no longer marked seeded), it counts.
  assert.ok(verifiedResolvedConfigs(entries, new Set()).has(extraCfg));
});

test("trip-cancelled turns are pre-marked synchronously and skipped by recovery (R3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-recovery-r3-"));
  const file = join(dir, "pending-turns.json");
  try {
    const journal = new TurnJournal<{ n: number }>(file);
    const running = await journal.add({
      queueKey: "chat",
      remoteJid: "chat",
      sourceMessageId: "m-running",
      payload: { n: 0 },
    });
    await journal.claim(running.id);
    await journal.add({ queueKey: "chat", remoteJid: "chat", sourceMessageId: "m1", payload: { n: 1 } });
    await journal.add({ queueKey: "chat", remoteJid: "chat", sourceMessageId: "m2", payload: { n: 2 } });
    await journal.add({ queueKey: "other", remoteJid: "other", sourceMessageId: "m3", payload: { n: 3 } });

    // The trip path marks THIS chat's PENDING rows synchronously — the running
    // turn and other chats are untouched.
    const processed = new Set<string>();
    for (const id of pendingSourceIds(journal.snapshot(), (t) => t.queueKey === "chat")) {
      processed.add(id);
    }
    assert.deepEqual([...processed].sort(), ["m1", "m2"]);

    // Simulate a crash BEFORE the async journal cancel lands: reload the
    // journal — the rows are still there, but recovery must skip exactly the
    // pre-marked ones and replay the rest.
    const reloaded = new TurnJournal<{ n: number }>(file).snapshot();
    const skipped = reloaded.filter((turn) => turnAlreadyHandled(turn.sourceMessageId, processed));
    const replayable = reloaded.filter(
      (turn) => turn.status === "pending" && !turnAlreadyHandled(turn.sourceMessageId, processed),
    );
    assert.deepEqual(skipped.map((turn) => turn.sourceMessageId).sort(), ["m1", "m2"]);
    assert.deepEqual(replayable.map((turn) => turn.sourceMessageId), ["m3"]);
    // A normally-admitted pending turn is NOT pre-marked, so it stays replayable.
    assert.equal(turnAlreadyHandled("m3", processed), false);
    assert.equal(turnAlreadyHandled(undefined, processed), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
