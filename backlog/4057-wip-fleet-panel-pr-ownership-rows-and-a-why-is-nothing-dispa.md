---
bornAs: xqjl5lf
kind: story
size: 3
parent: "3383"
status: closed
closedReason: duplicate
closedInto: "6202"
dateClosed: "2026-11-22"
locus: plateau-app
blockedBy: ["4056", "4051"]
scope: ["plateau:src/wip/types.ts", "plateau:src/wip/wip-model.ts", "plateau:src/wip/wip-model.test.ts", "plateau:src/wip/wip-view.ts", "plateau:src/wip/wip-view.css", "plateau:src/wip/wip-view.test.ts", "plateau:src/wip/wip-view.hostile.test.ts", "plateau:src/wip/wip-read.ts", "plateau:src/wip/wip-read.test.ts", "plateau:src/wip/fleet-read.ts", "plateau:src/wip/fleet-read.test.ts", "plateau:src/wip/wip-source.test.ts", "plateau:src/wip/wip-publish.test.ts", "plateau:src/wip/wip-live.test.ts", "plateau:src/wip/wip-relay-contract.test.ts", "plateau:wip-relay.js", "plateau:scripts/wip-relay.test.mjs", "plateau:tools/drain-daemon/daemon.mjs", "plateau:tools/drain-daemon/cli.mjs", "plateau:tools/drain-daemon/lib.mjs", "plateau:tools/drain-daemon/lib.test.mjs"]
dateOpened: "2026-09-24"
preparedDate: "2026-10-01"
preparedAgainstSha: "79a29b92f47ec8019f538665ba3d095fb98d7050"
tags: []
---

# /wip Fleet panel: PR ownership rows and a why-is-nothing-dispatching answer, fed by the pr-ownership read and dispatch-eligibility

Add a Fleet panel to Plateau's /wip page: every open PR, its phase, owner, bound sessions and transcript ages, lane and time in phase; flagged rows first and surfaced in Needs you. Explain sustained non-dispatch from the build admission and PR reconcile evidence. Show each daemon's running revision and distance behind its own origin/main. This remains a product implementation, dependent on #4056 and #4051.

## Progress

Preparation inspected WE `79a29b92f47ec8019f538665ba3d095fb98d7050` and Plateau `2a38182a53a32e12633c135dc4daecff5e5b101d`. These are source observations, not a live fleet audit.

| Original premise / scope | Corrected premise and evidence |
| --- | --- |
| Four UI files suffice. | The snapshot crosses a validator that requires exactly four runners and a closed name enum (plateau:wip-relay.js:204–215). Include relay validation, transport tests, styling, and the proposed plateau:src/wip/fleet-read.ts helper/test. The publisher serializes the full snapshot (plateau:src/wip/wip-publish.ts:41–58), so no new publish endpoint is needed. |
| Ownership read is future work. | The read exists: its verdict contains `prs`, `gaps`, thresholds and the shared PR→card map (we:scripts/operations/pr-ownership.mjs:173–187). Plateau's current reader assembles runner, drain, single-repo PR, health and dispatch reads without it (plateau:src/wip/wip-read.ts:391–419). This feature is not already delivered. |
| Per-card agents are only planned. | Running now already renders sessions independently of card groups (plateau:src/wip/wip-view.ts:436–447). Reuse source ownership/card identifiers; do not introduce another binding algorithm. Ownership rows include sessions, lane, phase timing and reconcile verdict (we:scripts/operations/pr-ownership.mjs:155–165). |
| Revision chips can be fed immediately by #4051. | Current WE readers enumerate three daemons and return liveness without revision fields (we:scripts/operations/runner-activity-io.mjs:54–58, :150–166). Plateau restricts runner names to those three plus drain (plateau:src/wip/types.ts:104–107), and the view loops over that constant (plateau:src/wip/wip-view.ts:414–420). #4051 remains a required producer prerequisite. |
| Every chip can compare directly with runner-activity. | Drain is a separate local status read (plateau:src/wip/wip-read.ts:211); ownership explicitly reports its liveness as unknown (we:scripts/operations/pr-ownership-io.mjs:121–124). Include local drain revision reporting in the Plateau scope: its resident heartbeat and acquisition sites are plateau:tools/drain-daemon/daemon.mjs:350 and :417. Compare this chip to its local status, not a nonexistent WE drain row. |
| “Time in state” and N ticks are exact observed transition history. | Ownership estimates phase age from the latest label/commit event and reports that limitation (we:scripts/operations/pr-ownership-io.mjs:121–123); its `ticksInPhase` is elapsed time divided by the configured interval (we:scripts/operations/pr-ownership.mjs:126–129). Build eligibility returns per-item reasons and observation times, not a fleet-wide no-dispatch counter (we:scripts/operations/dispatch-eligibility.mjs:73–91). Keep those meanings distinct. |

The original incident examples (#3951, #4030, #4038) remain motivation, not claims that these failures are present now. Existing PR ownership computes the flags and owner mapping; this consumer must not substitute UI-derived policy for them (we:scripts/operations/pr-ownership.mjs:119–151).

## Design

1. **Read and normalize once per snapshot cycle.** Add the proposed fleet helper behind the existing injected executor/failure boundary in plateau:src/wip/wip-read.ts:391. Read `pr-ownership` and whole-queue `dispatch-eligibility` through the declared operation runner; unwrap their verdicts, validate shapes and retain source observation times. Reuse the ownership operation's embedded reconcile verdict, rather than executing another reconcile pass. Fleet is constellation-wide, even though existing backlog groups are epic-scoped. Key rows by `(repo, number)`; retain unmapped PRs and every bound session. Preserve `gaps`; null/failed/partial reads never become an empty, healthy fleet. Bound child-process time and output, and let unrelated snapshot sections survive a fleet failure. Keep the existing publication cadence (plateau:src/wip/wip-source.ts:27–28).
2. **One ownership truth, two presentations.** Introduce an optional fleet snapshot section carrying rows, source timestamps/completeness and build explanations. Stable ordering: flagged first, then repo and PR number. Fleet retains every row; Needs you gets a distinct PR-attention subsection referencing flagged rows, without fabricating backlog cards or incrementing card counts. Include all flag explanations as text. This preserves the card's attention goal without confusing automatic repair needs with the existing schema-2 “Human review in Flow” section (plateau:src/wip/wip-view.ts:303). Link only validated PR identities; escape every source string. Show unknown lane/session age/revision explicitly and label phase duration as an estimate.
3. **Explain non-dispatch from evidence.** Proposed display threshold: five consecutive *observed* dispatcher ticks with queued work and no dispatch, configured in one Plateau helper. Track distinct tick numbers/timestamps from runner-activity (we:scripts/operations/runner-activity-io.mjs:214), paired with the existing dispatch-tail evidence (plateau:src/wip/wip-read.ts:118–125). Require complete dispatch-log coverage of each interval; duplicate refreshes never advance the counter. Reset on dispatch, empty queue, dispatcher restart/tick regression or a missing interval; startup or incomplete history says observation pending/unknown. Do not infer five ticks merely from clock age or ownership's estimated ticks. Render one compact answer with separately labelled Build and PR clauses: use `firstBlockingGate`/`reason` for held build items, and `reconcile.why` for PR refusals. Multiple holds remain distinguishable by item/PR; no invented single global cause. Eligible-without-dispatch says that no blocking gate was reported. No PR refusal is not proof of build eligibility. Preserve each source's as-of time; stale evidence cannot assert a current hold.
4. **Revision evidence for the full fleet.** Consume #4051's landed output shape, including boot inputs/overlays, behind-main count and rejected revision where available. Replace the fixed runner list with validated unique producer names plus the local drain; retain dispatcher-specific grouping. For drain, capture the actual process boot inputs in a process-owned record and expose them through its existing local status command. Compare each boot main SHA to that repository's locally observed origin/main; never substitute current checkout HEAD for running code. Record reference freshness, and report unknown for unavailable history or an untrustworthy comparison. Label drain wrapper versus WE sweep input separately where they differ. New drain metadata must not change lease ownership, scheduling, or merge authority. Missing revisions during rollout show unknown, never zero behind.
5. **Transport compatibility.** Extend Plateau's validator for optional fleet data and revision fields, bounded strings/arrays/numbers, unique repo+PR and runner keys, and permitted statuses. Accept old schema-1 and schema-2 snapshots without Fleet; absent data displays unavailable. Keep the shared progress contract unchanged: Fleet is a product extension, not a new progress semantic. Validate present extensions on both schema branches, including the scope-less schema-2 early return (plateau:wip-relay.js:292–305). Deploy accepting relay/client before the new publisher. Regression-test old four-runner payloads and newly enumerated daemons.

### Repository split and admission (#4289)

Placement follows we:docs/agent/platform-decisions.md:143 (`#constellation-placement`); scope identity and per-repo gates follow we:docs/agent/platform-decisions.md:5511 (`#conveyor-multi-repo-model`). #4289's operator ruling is recorded at we:backlog/4289-design-multi-repo-couple-locus-delivery-e-g-we-plateau-app-2.md:18; resolve by number if renamed. It preserves coupled delivery as future capability and approves a useful predecessor/consumer split rather than hiding mixed scope.

This feature crosses producer and consumer repositories, but #4057's implementation scope is Plateau-only. Proposed delivery split:

- **WE producer predecessor — existing #4051**, alongside already-built #4056: finish full daemon revision/overlay/behind-main evidence and producer fixtures. Relevant current seams are we:scripts/operations/runner-activity-io.mjs:54 and :150; include producer tests when preparing #4051. Its independent acceptance is correct CLI output without any Plateau UI. Do not silently implement that producer inside #4057 or remove the blocker.
- **Plateau consumer — this card:** the complete scope above includes local drain metadata, fleet reading/model/rendering, relay compatibility and tests. Its independent acceptance is a fixture-driven panel and a source-matched published snapshot after the producer lands. No WE runtime or contract edits are planned here. Backlog bookkeeping does not turn the product implementation into a mixed-scope build.

If #4051 lands with incompatible semantics or requires a shared contract change, re-prepare this card and name the independently validated WE predecessor before dispatch. Do not drop a real scope entry or weaken the wrapper refusal to force admission. This preparation creates no child cards and changes no prerequisite metadata.

## MVP

- A read-only, mobile-readable Fleet section with one row per PR, all requested evidence, flagged-first ordering and PR attention in Needs you, including PRs with no card mapping.
- One evidence-backed non-dispatch summary after the configured observation window; unknown/partial/stale states are visible.
- Revision and behind-main evidence on all producer daemon chips and local drain, with an explicit unknown fallback and source freshness.
- Old snapshots continue rendering. No new operator action, dispatch mutation, session rebinding, alert delivery or scheduling policy.

## Test plan

These are planned tests; no Plateau test result is claimed by this preparation. All paths in scope are implementation targets; plateau:src/wip/fleet-read.ts and plateau:src/wip/fleet-read.test.ts are proposed new files. Other scoped test files already exist.

- **Capability (Red today; required new assertions, not a claim of a run):** Reader/helper fixtures: valid operation envelopes; normal ownership plus each flag; multiple repos with equal PR numbers; no card mapping; multiple sessions; partial repo gaps; malformed output, timeout and failed revision read. Assert one ownership read and one eligibility read per cycle, no second reconcile and no mutation command. Test five distinct covered ticks, duplicate refresh, tick gap/reset, dispatch reset, empty queue, cold start and stale history.
- **Capability (Red today; required new assertions, not a claim of a run):** Model/view fixtures in plateau:src/wip/wip-model.test.ts and plateau:src/wip/wip-view.test.ts: flagged-first stable ordering, all sessions, separate PR attention without card-count changes, estimated age labels, distinct build/PR holds, unknown versus confirmed-empty, revision zero/nine/unknown, new daemon names and dispatcher-only grouping. Extend plateau:src/wip/wip-view.hostile.test.ts for hostile reasons/session/daemon strings and unsafe link identities.
- **Capability (Red today; required new assertions, not a claim of a run):** Relay/transport fixtures in plateau:src/wip/wip-relay-contract.test.ts, plateau:src/wip/wip-source.test.ts, plateau:src/wip/wip-live.test.ts, plateau:src/wip/wip-publish.test.ts and plateau:scripts/wip-relay.test.mjs: old and new payload round trips, scope-less schema 2, bad types/oversized fields, duplicate keys and stale/reconnect behavior. Exercise the real validator, not a mock that accepts every payload.
- **Capability (Red today; required new assertions, not a claim of a run):** Drain fixtures in plateau:tools/drain-daemon/lib.test.mjs: boot revision remains fixed when checkout advances; comparison zero/nine/unknown; missing/divergent history; metadata tied to the owning process and cleared or superseded on restart. Verify metadata changes do not alter lease acquisition/heartbeat/release decisions.
- **Preservation (expected GREEN today; baseline execution required at implementation pickup):** retain existing four-runner validation and dispatcher-only grouping cases. Mutation proof: remove runner-name uniqueness validation or let review-daemon downtime block queued cards; the retained tests must fail. The new capability fixtures above separately cover the widened payload.

Implementation commands, run from Plateau: `npx vitest run` with the scoped WIP and drain test paths, plus the repository's relay script test command and its required verification gate. Run WE producer tests in #4051's own lane. Passing WE checks alone is not Plateau acceptance.

## Proof plan

After implementation and producer delivery, retain timestamped operation JSON, local drain status, the actual published/received snapshot and phone-width rendered evidence for the same collection cycle. Compare repo+PR identities to the ownership read and its reconcile source; account for concurrent PR changes and every reported gap instead of claiming unconditional completeness. Compare daemon boot inputs/behind counts to their respective producer status. No drain comparison to a nonexistent runner-activity row.

Use deterministic fixtures to prove all three flags and the five-tick hold without manufacturing a real stuck session or stopping a daemon. Then observe one normal laptop publication through the real relay to /wip, including the section's row content and revision chips. Inspect phone overflow, keyboard focus, names, heading order and textual flag cues. Disconnect publication and confirm that retained evidence becomes stale rather than current. Record cycle duration/output size to establish that the extra reads fit the existing cadence and timeout budget. These are implementation proof requirements; this preparation has not run the live scenario.

## Done when

The scoped tests pass, the real publisher→relay→phone proof matches its source evidence, and all three original goals are met, including local drain revision evidence. The current preparation changes only this card; it does not claim the feature works or clear #4051.

## Follow-ups

- At implementation pickup, verify #4051's actual field names and all-daemon coverage, then pin the producer revision in proof. Revisit the size estimate with the reviewer: the original size 3 omitted relay and drain work; preparation preserves frontmatter other than allowed scope/stamps.
- If the full ownership read exceeds the publication budget, prepare a separately scoped producer performance change; do not silently omit repos or speed up polling. Cache age and collection gaps must remain visible.
- Testing lesson: relay validation can reject a correct-looking UI model (the four-runner invariant); include the real transport and scope-less schema branch in regression fixtures. Keep this lesson here, not in shared agent documents.
