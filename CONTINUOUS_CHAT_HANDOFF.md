# WhatsApp Bridge — Continuous Chat Handoff

Date: 2026-07-10

This handoff covers **only** `/Users/markausten/Documents/whatsapp-claude-bridge`.
Do not inspect, modify, deploy, or revert any other project.

## Current state

The bridge has an uncommitted continuous-conversation implementation. The previously installed `/Applications/WhatsApp Bridge.app` is still the old installed build; the new work has **not** been rebuilt into the app or installed/deployed.

Verification currently passing:

- `npm run build`
- `npm test` — 68 tests passed (32 originally; 48/56/63 after rounds one/two/three)
- `app/src-tauri`: `cargo test` — 9 tests passed
- `git diff --check`

Existing bridge commits before this work: `b1df805`, `a014526`, `76531ac`.

## Review fixes applied (2026-07-10)

A verified code review of the continuous-chat diff found ten defects plus quick wins; all are now fixed in the working tree:

- **F1 — recovery re-validates live config.** Replayed journal turns re-check the LIVE monitoredGroups map / allowlist (group turns) and live `mentionEnabled` + routed call sign (mention turns); revoked config drops the turn (journal row finished, warn logged). Live groupCfg/route is used for the replay; the persisted copy is only a log label. `monitoredGroups` is seeded from persisted `groups.json` pins before recovery so validation works at boot. Recovered turns stay exempt from `allowTaskAttempt` (they passed admission pre-crash); a recovered mention turn always replays on the mention path even if its chat became a monitored group. Policy lives in `src/recovery.ts` (unit-tested).
- **F2 — burst-breaker thresholds split correctly.** Dedicated-group messages (plain AND call-sign-routed) and explicit mentions use the strict 3 hits/30 s guard (the CLAUDE.md hard-rule barrier, restored); only sticky-conversation follow-ups use the 8/30 s guard. The group-plain path no longer routes to the loose guard.
- **F3 — control verbs throttled.** In ordinary-chat/mention handling, control verbs (/new, /stop, /chat, /status, /cd, /use) and bare-call-sign activation count as attempts against the strict guard BEFORE they are handled; a tripped guard sends its notice once per pause window and ignores further messages. One message never double-counts (control + task).
- **F4 — loop trips no longer destroy accepted work.** A trip ends sticky mode and cancels WAITING turns via a dedicated helper (`haltConversationOnLoopTrip` / `applyLoopTripHalt`) WITHOUT bumping `chat.generation` — the running turn's reply and outbox still deliver, and the notice says so. Generation bumps are reserved for user resets (/new, /stop, /cd, /use). `/stop` keeps full semantics.
- **F5 — cancelled turns never replay.** The chat generation at admission is journaled; recovery drops rows whose generation mismatches the loaded chat (a missing chat counts as generation 0, matching `isGuardValid`, so a first-task reply in a never-persisted chat isn't dropped as cancelled). Generation bumps persist chats.json SYNCHRONOUSLY (`persistChatsNow` → `saveChats.flushNow`). `cancelWaitingTurns`' durable cancel retries once and logs at error level instead of swallowing.
- **F6 — journal I/O async, compact, bounded.** `TurnJournal` writes compact JSON via async fs behind a serialized promise lock (writes never interleave); add/claim/finish/cancelPending are awaited by callers, preserving the admission barrier (row durable before queue admission/ack). A synchronous `flushSync` exists only for the process-exit flush. The durable payload is slimmed: `allowedIdsAtCutoff` (+ reply ordinal + acceptedTs + generation) replaces the full `historySnapshot`. The raw WAMessage stays (attachment durability remains a separate item, see below).
- **F7 — transcript integrity.** (a) `safeSend` returns the delivered chunk ids; `recordAgentReply` stores them and no longer pushes an id-less copy into the live buffer — the persisted store is the single transcript source for agent replies, and the completed-replies injection dedupes by id. (b) `formatHistory` unions the recorded agent-reply ids into the same-second cutoff allowlist so a stored reply landing in the same second as the next user message survives. (c) Journal-recovered turns rebuild history from the persisted store with cutoff = replay time (trigger message excluded by id), so replayed turn N+1 sees turn N's stored reply.
- **F8 — command handling unified.** Sticky chats recognize `/cd <path>` and `/use <provider>` (group semantics: reset + confirm) so they never ship to the agent; unknown `/`-leading conversational text still does. Group `/stop` and `/chat` get helpful notices instead of "Unknown command". Command-shaped group messages (leading `/`, known or unknown) never run as tasks even with an attachment (`parseGroupCommand` closed the attachment and mention-selector bypasses; a dropped attachment is called out). The `/new` group-vs-sticky difference is documented in README/CLAUDE.md and in the confirmations and `/status` text.
- **F9 — attachments on activation not swallowed.** A media message captioned exactly `@codex` (or `@codex /chat`) in self-chat activates sticky mode AND runs the attachment as a captionless turn — the ack and the turn both happen.
- **F10 — journal load error handling.** `loadJsonSafe` is exported from `src/store.ts` (now reviver-aware) and reused by the journal: transient read errors (EACCES/EIO) warn, keep the file in place, and start empty for this boot; parse corruption renames to `.corrupt-*` with an error log. The caught error is always logged.
- **Quick wins.** Blank `CONVERSATION_MODE_MINUTES` (settings UI saves '') defaults to 120 — explicit `0` still disables; invalid values warn (`parseConversationMinutes`, tested). Queue-full rejections name WHICH limit was hit (per-chat vs global) and the message string is extracted. `rememberProcessed` early-returns on known ids (skips the redundant file rewrite). `completedAgentReplies`/`replyOrdinals` use the same 300-chat oldest-eviction as chatHistory. `readHistory` reads only the last ~256 KB of a chat's JSONL (dropping the partial first line) instead of the whole file.

### Second-round fixes (adversarial re-review, same day)

- **R1 — dead group pins re-resolve.** The recovery seed is bootstrap-only: seeded entries are tracked in `seededGroupJids`, never count as resolved (`verifiedResolvedConfigs`), and `ensureGroups` still verifies every pinned jid against the live `groupFetchAllParticipating` result — a WhatsApp group deleted while the bridge was down falls through to subject match / re-creation exactly as at HEAD (the stale seeded entry is removed before re-resolution). All "fully resolved" predicates (on-open, retry timer, backoff reset) count only VERIFIED entries via `groupsFullyResolved()`.
- **R2 — seed gated on CREATE_GROUP.** `seedRecoveryGroupPins` returns nothing when the feature is off; recovered group turns then drop via live-config validation.
- **R3 — trip-path replay window closed.** Admission no longer pre-marks source ids as processed (in processedIds a journaled row's id now strictly means "handled — never replay"); cancellation (`cancelWaitingTurns` and the trip path) synchronously marks every pending row's source id BEFORE the async journal cancel; recovery skips + finishes any row whose source id is already processed (this also silently clears completed-but-unfinished rows instead of sending a bogus "interrupted" notice); the trip path awaits the durable cancel (`haltConversationOnLoopTrip` is async; the notice follows the cancel). Redelivery dedupe for in-flight turns rests on `turnJournal.hasSourceMessage` + `inflightIncomingIds`, which cover the whole row lifetime.
- **R4 — offline-queued replies keep transcript coverage.** `safeSend` now also reports `sentIds` (chunks delivered live); a reply whose chunks ALL queued to pending-sends is buffered id-less as a fallback (the pre-F7a coverage, scoped to only this case). After the flush creates the id-bearing store rows, `buildConversationTranscript` drops an id-less entry whenever an id-bearing entry with the same label and normalized text exists (normalization strips the "(delayed)" marker and collapses whitespace), and `formatHistory` now parses labels through the "(delayed) Label:" form.
- **R5 — no partial chunk subsets for injected replies.** `agentRepliesAfter` carries each reply's chunk ids; `formatHistory` excludes those chunk rows from the stored set (`injectedChunkIds`) so the injected FULL text wins; non-injected replies keep their stored chunk rows.
- **R6 — legacy-journal command bypass + unfinishable rows.** Recovered group turns with a command-shaped body (pre-hardening journal rows) are DROPPED, never executed; a recovered turn with an unresolvable provider — and every other pre-enqueue refusal path (broadcast, non-fromMe, empty content/body) — finishes its journal row instead of replaying every boot; the reject-path `turnJournal.finish` failure is logged at error level.
- **R7 — sticky verbs tolerate trailing text.** `parseConversationControl` accepts "/stop now", "/new please", "/status?" (args ignored, like the group path); `/chat` keeps its `<rest>` semantics; `\b` keeps "/stopped"//"/chats"//"/newsletter" conversational. Docs updated to match.

### Round 3 — per-agent lanes (design change, requested by Mark 2026-07-10 22:07 after live-testing the old installed build)

Mark wants multiple AIs in one chat to behave like independent terminals: `@computer` and `@codex` run CONCURRENTLY, with no queue-position ceremony.

- **D1 — per-lane queue keys.** The turn queue (and the journal's `queueKey`) is now `chatKey + laneId` (`src/lanes.ts`): mention turns use the call-sign session key (`mentionSessionKey(route)`), group turns the resolved provider name. Same-lane turns stay strictly FIFO (session continuity unchanged, now scoped per lane); different lanes in one chat run concurrently. The lane derives from data already persisted (route / providerName), so recovery lands each replayed row in the identical lane, in per-lane FIFO (seq) order. Legacy chat-keyed journal rows still match chat-wide cancels (`laneMatchesChat`). The F5 generation lookup now derives the chat key from `remoteJid` (never from the lane-valued `queueKey`).
- **D2 — per-lane strict guard.** The explicit 3/30s breaker is keyed per lane (chat + call sign, or chat + provider in groups) so parallel agents keep independent budgets; total burst per chat is bounded at 3 x configured call signs per window (documented in CLAUDE.md/README). The sticky conversation guard (8/30s) stays per chat. A trip pauses only the tripped lane but still clears EVERY lane's waiting turns in the chat (loop = emergency; documented) and ends sticky mode.
- **D3 — silent queueing.** The '⏳ Queued for X — N turns ahead' notice is gone. Queue-full rejections (per-lane limit wording + global cap) and the loop-trip notice remain.
- **D4 — /status per lane.** Sticky /status lists every configured call sign ('Computer: running, 1 queued · Codex: idle'); group /status lists provider lanes with activity plus the chat default. `/api` `activeTurns`/`queuedTurns` keep their names/types and aggregate across lanes (tray restart-safety unchanged, D6).
- **D5 — cross-agent context + per-chat bookkeeping verified.** `completedAgentReplies`/ordinals stay per chat: both agents' replies appear in each other's transcripts as labelled lines (desired shared context). `busyCwds` is a per-cwd COUNT (concurrency-safe); `chat.busy` is now advisory/write-only; `chat.generation` stays per chat — /new, /stop, /cd, /use invalidate ALL lanes' running turns in that chat (accepted user-reset semantics; waiting turns adopt the new generation at their lane head). Chat-wide cancels (`/stop`, trips, group `/new`, `/cd`, `/use`) clear every lane; a sticky `/new` now clears only that call sign's waiting lane (cheap with lanes — `cancelWaitingTurnsInLane`), while its generation bump still suppresses all running turns.
- **Journal/queue API changes.** `TurnJournal.cancelPending` and `pendingSourceIds` are predicate-based (chat-wide vs lane-scoped selection); `KeyedTurnQueue.cancelWaitingMatching` added. Per-lane queue caps: each lane gets `CONVERSATION_QUEUE_LIMIT` waiting turns; the global 100-turn cap still bounds the whole bridge.

### Round 4 — per-lane generations + lane polish (lane-verifier findings)

- **G1 — per-lane generations.** `ChatState`/`PersistedChat` gain `laneGenerations: Record<laneId, number>` (persisted; PN/LID alias merge takes the max per lane — `mergeLaneGenerations`). `SendGuard` gains optional `laneId`/`laneGeneration`; validity is `guardMatchesState` (chat generation matches AND, for lane-scoped guards, the lane generation matches; missing chat/lane = 0). Run closures capture both epochs at dispatch and every post-await check uses one `stale()` predicate built on the same function. A sticky `/new` now bumps ONLY its lane's generation (+ `persistChatsNow` + lane-scoped waiting-cancel + `discardInvalidPending`): its own running turn is invalidated, the OTHER agent's running reply still delivers, its session writeback survives, and after a crash its queued journal rows still replay (the journal payload stores `laneGeneration`; recovery validates chat + lane epochs, legacy rows pass). `/stop`, sticky `/cd`//`/use`, and group `/new`//`/cd`//`/use` keep the chat-wide bump (documented chat-level semantics).
- **G2 — cwd-fallback race closed.** `ensureCwdValid`'s vanished-cwd fallback (sessions wiped) now bumps `chat.generation` + `persistChatsNow` — a concurrently running lane can no longer write its stale session id into the fresh map. Both run closures call it BEFORE capturing their epoch snapshot so the current turn adopts the new epoch instead of killing itself (its failure notice is deliberately unguarded). The boot-time cwd fallback intentionally does NOT bump (no turns are running at boot, and a bump would wrongly drop that chat's recovered turns).
- **G3 — trip notice names the paused lane.** "🛑 Loop protection: paused Codex requests in this chat for 2 minutes; other agents are unaffected. Cleared N queued turns; a running task will still deliver." Label only — never a live trigger token (hard rule); the chat-scoped sticky-guard trip keeps the generic wording.
- **G4 — `chat.busy` removed** (field, writes, alias merge, comments — it was write-only and wrong under concurrent lanes). `/status` now unions configured lanes with any lane showing activity, so a running-but-deconfigured call sign/provider stays visible (labelled via `laneLabelFromId` — never a raw trigger).

### Accepted residual risks

1. **flushNow stale-rename crash window.** A debounced async chats.json write already in flight when `persistChatsNow()` runs could rename slightly older data over the sync flush; a chained confirming write rewrites the latest snapshot right after, so only a crash landing exactly between the stale rename and the confirming write can leave a pre-bump generation on disk. Accepted (double-fault window; consequences bounded by the R3 processed-id pre-mark).
2. **300-chat eviction of an in-use ordinal.** `completedAgentReplies`//`replyOrdinals` evict the oldest chat at the 300-chat cap; a turn queued in that chat at that exact moment could see its reply-ordinal watermark reset and over- or under-inject completed replies in ONE transcript (id-dedupe bounds the damage to duplicates/omissions of catch-up context, never task re-execution). Accepted as theoretical.

New/updated tests: recovery validation verdicts; loop-trip semantics (no generation bump, waiting cleared, running delivers, threshold split); journal load error paths, concurrent-write serialization, and flushSync; transcript single-copy and same-second reply survival; sticky `/cd`/`/use` and group-command parsing; blank `CONVERSATION_MODE_MINUTES`; chunk-id reporting from `safeSend`; second round adds dead-pin re-resolution + CREATE_GROUP seed gating, processed-id recovery skip, offline-reply fallback + post-flush dedupe, injected-reply chunk exclusion, recovered command-shaped drop detection, and sticky verbs with trailing text; round three adds lane-key derivation/matching, two-call-signs-concurrent + same-lane FIFO, chat-wide vs lane-scoped cancels, per-lane guard budgets, recovered per-lane FIFO replay, the silent-queueing tripwire, and /status lane formatting (`tests/lanes.test.ts`); round four adds guard-state lane semantics (B's /new spares A's running reply at the socket, kills its own), lane-generation recovery survival, laneGenerations alias merge, and label-never-trigger lane labels. Tests that exercise real store/outbound/journal paths point `WA_BRIDGE_HOME` at a temp dir (`tests/helpers/test-home.ts`) so they never touch the live `data/`.

## Implemented behavior

- Self-chat automatically becomes sticky after a leading `@computer` or `@codex` task.
- While sticky, follow-ups can be ordinary messages without a call sign.
- Bare `@computer` / `@codex` in self-chat activates and acknowledges conversation mode without spending an agent turn.
- Other chats remain one-shot unless explicitly enabled with `@call-sign /chat`.
- `/new` resets provider sessions and clears waiting turns while keeping conversation mode active.
- `/stop` disables sticky mode and clears waiting turns.
- `/status` reports provider/session/conversation state plus per-lane agent activity ('Computer: running, 1 queued · Codex: idle').
- Conversation expiry is sliding and configurable; `0` disables sticky mode.
- Per-agent LANE queues (round 3): each call sign/provider in a chat is an independent FIFO lane — `@computer` and `@codex` in one chat run concurrently, same-agent turns stay ordered, queue limits are bounded per lane plus a global cap, and queueing is silent.
- Claude/Codex resumable sessions are resolved when a queued turn reaches the queue head, so a later turn sees the prior turn's new session id.
- Stateless providers receive bounded recent WhatsApp transcript context.
- PN/LID self-chat aliases share state, history, queue, and loop protection.
- Replies have visible provider/call-sign prefixes and wire markers; known bot prefixes and markers are filtered to prevent echo loops.
- Loop breakers: dedicated-group messages, explicit call-sign mentions, and control verbs use the strict 3/30s guard; sticky conversation follow-ups use 8/30s. A trip clears waiting turns and ends sticky mode but lets the running task deliver.
- Guarded task replies are invalidated by `/stop`, `/new`, `/cd`, `/use` (explicit user resets only — loop trips no longer invalidate the running reply). Invalidated replies are dropped before socket delivery and from the pending outbound queue.
- Same-second history cutoff uses WhatsApp message ids, preventing a later human message in the same second from leaking into an earlier queued prompt; recorded agent-reply ids are allowlisted so a same-second reply survives.
- Stored attachment paths are included in transcript context, including captioned attachments.
- An awaited-before-admission `data/pending-turns.json` journal records accepted turns before queue admission (async serialized writes; sync flush only at exit). Pending turns replay after restart with live-config and generation re-validation; turns marked running are reported as interrupted and are not replayed.
- Redelivery dedupe considers processed ids, in-flight ids, and journal source-message ids.
- Tray activity includes active and queued turns; the Rust tray has route/provider/model controls and refuses restarts when task activity is running or unverifiable.

## Main files added

- `src/conversation-mode.ts` — sticky-mode parsing, activation, expiry, controls, stop-vs-trip transitions, group-command parsing.
- `src/conversation-history.ts` — bounded transcript merge, id cutoff, dedupe, attachment references.
- `src/turn-queue.ts` — keyed FIFO with active/waiting counters, limit-aware rejections, matching-key cancels, and recovery bypass.
- `src/lanes.ts` — per-agent lane keys, chat matching, /status lane formatting (round 3).
- `src/turn-journal.ts` — durable pending/running turn journal (async serialized writes, sync exit flush).
- `src/recovery.ts` — pure replay-admission policy (live config + generation re-validation).
- Tests: `tests/conversation-mode.test.ts`, `tests/conversation-history.test.ts`, `tests/turn-queue.test.ts`, `tests/turn-journal.test.ts`, `tests/recovery.test.ts`, `tests/loop-trip.test.ts`, `tests/config.test.ts`, `tests/helpers/test-home.ts`.

## Important modified areas

- `src/index.ts` — routing, sticky mode, durable admission/recovery, task guards, history, group and ordinary-chat runners.
- `src/outbound.ts` — guarded resilient sends and stale pending-send removal.
- `src/media.ts` — guarded outbox file delivery.
- `src/store.ts` — persisted chat generation and message ids.
- `src/api.ts` — status counters and restart endpoint.
- `src/config.ts`, `src/settings.ts`, `.env.example` — conversation settings/limits.
- `src/ui.ts`, `app/src-tauri/src/lib.rs` — dashboard/tray activity and provider/call-sign/model controls.
- `README.md`, `CLAUDE.md` — bridge documentation.

## Remaining release work

1. **Do not install yet.** The 2026-07-10 review fixes above are applied but uncommitted; rebuild the sidecar and app only after a final review pass is satisfied.
2. Make `POST /restart` perform an atomic daemon-side drain check and `flushAllNow()` before exit. The tray polling policy is safer, but a direct API restart still has a small check/kill race and currently calls `process.exit` after 150 ms.
3. Finish attachment durability for journal recovery. The journal currently serializes the accepted payload/WAMessage; a robust next step is to stage incoming media to a bridge-owned path before durable admission and journal `{kind, filename, path}` rather than depending on the original Baileys message object after restart.
4. Review transcript/session overlap for RESUMED Claude/Codex sessions: the resumed provider session may already contain content the bounded transcript repeats. (The reply-duplication half of this item — agent replies recorded twice with uncollidable dedupe keys — was fixed by F7; the resumed-session overlap remains a design question.)
5. Decide how to handle unknown linked-device automation during sticky mode. Marker/prefix guards and the 8/30s sticky breaker (3/30s everywhere else) are present, but no WhatsApp-level sender identity can perfectly distinguish every linked automation from a human `fromMe` message.
6. Add an integration test for journal crash windows: journaled-before-queue, running-before-provider, cancellation during preflight, source-id redelivery, and recovered FIFO ordering. (Unit-level coverage for load errors, concurrent writes, generation/config re-validation, and trip semantics was added with the review fixes; the full crash-window integration harness is still open.)
7. Rebuild/install the app, then verify live with `/status`, `/new`, `/stop`, two rapid same-chat messages, two different chats, a reconnect, and a captioned attachment. Add to the live checklist: a command with an attachment in the group (file must NOT run), `/cd`+`/use` inside a sticky self-chat, and a bare `@codex` caption on a media message (ack + attachment turn).

## Useful commands

```bash
cd /Users/markausten/Documents/whatsapp-claude-bridge
npm run build
npm test
cargo test --manifest-path app/src-tauri/Cargo.toml
git diff --check
git status --short
```

Runtime data is under the configured WhatsApp bridge auth directory, especially:

- `data/pending-turns.json`
- `data/pending-sends.jsonl`
- `data/chats.json`
- `data/messages/`
- `data/media/`

No deployment, app replacement, or live WhatsApp test has been performed for this uncommitted version.
