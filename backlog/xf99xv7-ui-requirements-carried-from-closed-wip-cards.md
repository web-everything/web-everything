---
kind: story
size: 8
parent: "6202"
status: open
blockedBy: ["4006", "4056", "4051", "4198", "4894", "4900"]
scope: ["plateau:src/wip/"]
dateOpened: "2026-11-22"
tags: []
---

# UI requirements carried from closed /wip cards

Requirements the closed /wip cards held that #6202 does not carry; each is an acceptance item on /delivery or its /wip-family surface. The full source text of each closed card is embedded verbatim at the end of this card. (#4007) live plan steps per card from the step status record. (#4057) Fleet panel: every open PR with phase, owner, sessions, lane, time in phase; flagged rows first and in Needs you; explain non-dispatch from admission and reconcile evidence; show each daemon's revision and distance behind origin/main. (#4199) per-card activity rows: each session/job with role, state, times, outcome, openable transcript link or copyable path. (#4202) durable not-delivered-by-N dismissal for a merged PR that delivered only a slice or note; card stays open, other evidence kept. (#3736) phone-first compact tables: at most 3 short columns, about 35 characters a row, titles cut to about 18 characters; Attention findings queue themselves. (#4901) phone Flow view: every PR wait group with counts and full descriptions, reachable chain details, honest paging coverage, human prerequisites and disclosure focus preserved across updates and reconnects, title/reason/links/paths treated as untrusted text with safe links only, each repo/number counted once. (#4984) no horizontal elastic scroll on mobile, checked at 366x747, vertical scroll unchanged. (#4997) no pinch or double-tap zoom on /wip phone pages (viewport maximum-scale and touch-action manipulation), scope /wip only. (#5377) compact touch-friendly nav between /wip, glance and /sessions with the current page highlighted and no horizontal scroll. (#4996) Discard action per request with a phone-suited confirm step; soft state change that keeps the request tagged discarded. (#5358) deep links: ?card=N scrolls, highlights and focuses the card; ?agent=session opens its panel; unknown identity shows an inline notice; exact-identity resolution, unauthorized-session refusal, incomplete-feed handling and hostile-query handling; no new write endpoint. (#5593) apply ?card= and ?agent= only to the real snapshot, never the fallback sample; scroll-once; 128-character cap on the link value, longer values ignored not truncated.

Safeguards carried from #4202 (dismissal): persist successfully before showing a saved dismissal; a missing, malformed, unavailable or quota-denied store shows a visible recoverable error and leaves the evidence visible, and never reports persistence after a failed write; the record key is card id plus normalized repository identity plus PR number, never the PR number alone, with identity validation; a Restore action (accessible, also persisted before the display changes) re-exposes only the selected match; the received snapshot stays immutable; regression tests at the renderer and mount seams (round-trip through a fresh store, isolation, duplicate save, restore, malformed data, thrown reads and writes) plus a running-browser proof with a controlled snapshot (dismiss PR N, refresh, pushed snapshot, reload, reopen the profile: N stays saved and the other match stays actionable).

Safeguards carried from #4901 (phone Flow view): reject cross-snapshot unions (replayed old snapshots or pages are rejected, rows age honestly, the unreachable remainder is marked); instrumented proof over two 120-second publish cycles plus a second tab shows zero extra collection or GitHub calls attributable to the page asks or the extra tab; a publisher to relay to same-origin browser run compares the rendered union and counts to the repo/number manifest across all three repos.

## Acceptance

- [A1] **Executable** — `CarriedSourceFidelity.test_carried_bodies_equal_pinned_sources` below compares all 12 carried titles and complete bodies against source cards pinned at WE commit `17a4e1f94889cdf4f4760765b10228e7aaa9600c`. Only blank separator lines at block boundaries are ignored. Changed or deleted requirements, missing blocks, unavailable pinned sources and incomplete fences must fail validation; do not refresh the pin to bypass a mismatch. If the pinned objects are unavailable, restore that local history before claiming preservation.

Save the following Python block as `$TMPDIR/xf99xv7-carried-source-test.py` and run `queue=we:scripts/readiness/heavy-admission.mjs; node "${queue#we:}" run --wait-ms=60000 -- python3 "$TMPDIR/xf99xv7-carried-source-test.py"` from the WE repository root. The named negative tests exercise content mutations and missing evidence without changing the card or source files.

```python
import os
import re
import subprocess
import unittest
from pathlib import Path

PIN = "17a4e1f94889cdf4f4760765b10228e7aaa9600c"
CARD = "we:backlog/xf99xv7-ui-requirements-carried-from-closed-wip-cards.md"
SOURCES = [
    ('4007', 'we:backlog/4007-plateau-wip-dashboard-shows-live-plan-steps-per-card.md'),
    ('4057', 'we:backlog/4057-wip-fleet-panel-pr-ownership-rows-and-a-why-is-nothing-dispa.md'),
    ('4199', 'we:backlog/4199-wip-page-per-card-activity-panel-listing-sessions-and-jobs-r.md'),
    ('4202', 'we:backlog/4202-wip-page-a-durable-not-delivered-by-n-dismissal-for-a-strand.md'),
    ('3736', 'we:backlog/3736-wip-report-compact-phone-first-tables-and-attention-findings.md'),
    ('4901', 'we:backlog/4901-render-all-plateau-pr-waits-and-cached-pages-in-the-phone-fl.md'),
    ('4984', 'we:backlog/4984-prevent-horizontal-elastic-scroll-on-mobile-in-the-wip-page.md'),
    ('4997', 'we:backlog/4997-prevent-pinch-and-double-tap-zoom-on-mobile-for-the-wip-page.md'),
    ('5377', 'we:backlog/5377-add-mobile-friendly-navigation-menu-to-wip-and-related-pages.md'),
    ('4996', 'we:backlog/4996-add-a-discard-action-for-requests-on-the-wip-page.md'),
    ('5358', 'we:backlog/5358-wip-deep-links-card-n-highlights-a-card-agent-session-opens.md'),
    ('5593', 'we:backlog/5593-wip-deep-links-apply-card-and-agent-only-to-the-real-snapsho.md'),
]


def source_body(revision, qualified_path):
    raw = subprocess.run(
        ["git", "--no-replace-objects", "show",
         revision + ":" + qualified_path.removeprefix("we:")],
        check=True, capture_output=True, text=True,
        timeout=10, env={**os.environ, "GIT_NO_LAZY_FETCH": "1"},
    ).stdout
    _, separator, content = raw.partition("\n# ")
    if not separator:
        raise ValueError("Pinned source lacks its title")
    title, separator, body = content.partition("\n")
    if not separator:
        raise ValueError("Pinned source lacks its body")
    return title, body.strip("\n")


def carried_blocks(text):
    _, separator, quoted = text.partition("\n~~~~text\n")
    if not separator or not quoted.endswith("\n~~~~\n"):
        raise ValueError("Missing or incomplete verbatim source fence")
    quoted = quoted[:-len("\n~~~~\n")]
    parts = re.split(r"^### Carried from #(\d+): ([^\n]+)\n", quoted,
                     flags=re.MULTILINE)
    if parts[0].strip() or (len(parts) - 1) % 3:
        raise ValueError("Unexpected carried source structure")
    return [(parts[i], parts[i + 1], parts[i + 2].strip("\n"))
            for i in range(1, len(parts), 3)]


class CarriedSourceFidelity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.expected = [(number, *source_body(PIN, path))
                        for number, path in SOURCES]
        cls.text = Path(CARD.removeprefix("we:")).read_text()

    def verify(self, text):
        self.assertEqual(carried_blocks(text), self.expected)

    def test_carried_bodies_equal_pinned_sources(self):
        self.verify(self.text)

    def test_changed_requirement_is_rejected(self):
        original = self.expected[0][2]
        self.assertIn(original, self.text)
        with self.assertRaises(AssertionError):
            self.verify(self.text.replace(original, original + " altered", 1))

    def test_deleted_requirement_is_rejected(self):
        original = self.expected[0][2]
        requirement = original.splitlines()[0]
        self.assertTrue(requirement)
        with self.assertRaises(AssertionError):
            self.verify(self.text.replace(requirement, "", 1))

    def test_missing_block_is_rejected(self):
        marker = "### Carried from #4007: "
        start = self.text.index(marker, self.text.index("\n~~~~text\n"))
        end = self.text.index("### Carried from #4057: ", start)
        with self.assertRaises(AssertionError):
            self.verify(self.text[:start] + self.text[end:])

    def test_unavailable_pinned_source_is_rejected(self):
        with self.assertRaises(subprocess.CalledProcessError):
            source_body("0" * 40, SOURCES[0][1])

    def test_incomplete_source_fence_is_rejected(self):
        with self.assertRaises(ValueError):
            self.verify(self.text.removesuffix("~~~~\n"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
```

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.

## Duplicate admission

carries requirements of 13 cards closed into #6202; no existing card holds them

## Carried source text (verbatim)

~~~~text

### Carried from #4007: Plateau WIP dashboard shows live plan steps per card


Child 7b (Plateau side) of #3922. The Plateau WIP dashboard reads the step status record and shows each card live steps and their state. Locus plateau-app.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

### Carried from #4057: /wip Fleet panel: PR ownership rows and a why-is-nothing-dispatching answer, fed by the pr-ownership read and dispatch-eligibility


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

### Carried from #4199: /wip page: per-card activity panel listing sessions and jobs (review/fix/ci-heal/build) with transcript links


Add a snapshot-driven activity panel inside each Doing/Needs-you card's existing disclosure: list each matching session/job separately, with role, state, started/last-event time, outcome, and an openable transcript link or copyable path. Preserve #4198 as the producer dependency and #3931 as the parent; this is the non-live slice, not the fuller L2/L3 timeline.

## Progress

Preparation checked the current WE lane and Plateau checkout (Plateau HEAD `1debc8990f730b45bdfc0eab430f9a567f6de2c9`). Paths below use `we:../plateau-app/` to identify the sibling product; the machine-readable scope retains its canonical Plateau repo qualifier so dispatch does not mistake this for WE implementation.

- **Old premise:** cards only show claims/PRs and detached review jobs are invisible. **Corrected:** card details still lack activity rows (we:../plateau-app/src/wip/wip-view.ts:223–266), but the global Running now panel already shows state/times and copyable transcript paths (we:../plateau-app/src/wip/wip-view.ts:453–462). WE already includes review jobs through `listAgentsWithReviewJobs` and assigns their own logs as transcript pointers (we:scripts/operations/agent-activity-io.mjs:37,270–281). Do not recreate that collector or repeat “merged today.”
- **Old premise:** the reader only supplies the daemon-level shelling pattern. **Corrected:** it shares one `live-state` read between health and Running now, independently validates rows, and projects card/PR identity and transcript paths (we:../plateau-app/src/wip/wip-read.ts:278–315,386–415). `WipRunningRow` lacks an outcome field (we:../plateau-app/src/wip/types.ts:165–182). Global activity is therefore useful existing infrastructure, not proof this card's full goal shipped.
- **Dependency remains:** #4198 specifies the targeted query and outcomes (we:backlog/4198-add-review-job-records-as-an-agent-activity-source-join-sess.md:15). The current operation registry imports agent activity (we:scripts/operations/run.mjs:122–123); a repository search found no item-activity implementation, only forward references (we:scripts/operations/agent-activity.mjs:41,241). Treat #4198's exact envelope/flags as a producer contract to verify when it lands, not an existing API.
- **Old scope:** six reader/type/view files and tests. **Corrected:** include product documentation, relay validation and transport/hostile-input tests. The relay validates rendered items and uses closed source vocabularies (we:../plateau-app/wip-relay.js:26,292–321); a reader-only change is insufficient. Existing snapshot freshness is 120-second publication and a 600-second stale threshold (we:../plateau-app/src/wip/wip-source.ts:27–28), not a new live subscription.

## Design

1. Document the optional per-card activity projection in we:../plateau-app/docs/wip-page.md before implementation. Add an optional activity value to `WipItem`: observation time, completeness/availability, rows and a plain failure reason. Each row preserves producer identity, role, state, nullable start/last-event times, nullable outcome and transcript pointer. Unknown outcome/time stays explicitly unknown; never derive success from a dead PID or an absent session. Missing activity in an older snapshot means unknown, not empty. Existing item identity/PR fields are at we:../plateau-app/src/wip/types.ts:49–81.
2. In the reader, build the existing snapshot first, then enrich only Doing/Needs-you items with #4198's declared operation. Query by card identity so a pre-PR build and PR-associated jobs can both appear; use a repository-qualified PR query when that is the only available identity. Verify producer mapping supports both paths before integration. Deduplicate identical requests within a refresh, bound concurrency (two calls at once), and use argument arrays, timeouts and output limits following the existing operation call at we:../plateau-app/src/wip/wip-read.ts:161. No shell interpolation, per-render subprocess, separate polling loop or duplicated process scanner. The snapshot is assembled at we:../plateau-app/src/wip/wip-read.ts:463–479; enrichment after assembly avoids changing grouping and counts.
3. Validate the new optional payload at the reader and relay boundary with the same bounded validator. An unsupported operation, timeout, malformed payload or incomplete source affects that card's activity only. Preserve the rest of the snapshot. Render `No agent found` only for a fresh, complete, successful empty result; stale, partial, missing or failed evidence renders `?` with a reason, retaining any known rows as dated evidence. Page-level stale status also suppresses an empty-result assertion. This extends the existing independent-source validation pattern (we:../plateau-app/src/wip/wip-read.ts:313–315,411–415).
4. Render inside the existing native details element, preserving expansion over refresh (we:../plateau-app/src/wip/wip-view.ts:256–266). Keep distinct run identities even when role/PR match; do not collapse a review and fixer into one row. Use semantic list/labels, readable wrapping and text state labels; escape every producer string, including paths. Do not change card grouping or the global Running now list.
5. Use selectable, copyable path text for filesystem transcript pointers, including outside readable roots, matching the existing product behavior (we:../plateau-app/src/wip/wip-view.ts:454–456). Do not manufacture a file URL, browser link or filesystem-serving route. If the producer supplies an actually supported web transcript URL, validate it with the existing URL policy before rendering an anchor; otherwise retain the path fallback. Live proof must check the underlying file, not merely that text rendered. This preserves the original phone fallback goal without assuming a transcript server exists.

**Per-repo delivery split (#4289):** #4198 is the WE producer predecessor; #4199 is the Plateau reader/relay/view successor, with separate repo gates and PRs. The general per-repo profile rule is we:docs/agent/platform-decisions.md:5511 (`#conveyor-multi-repo-model`); the explicit split ruling is we:backlog/4289-design-multi-repo-couple-locus-delivery-e-g-we-plateau-app-2.md:18–20. No WE implementation files belong in this scope. Before building, verify #4198 exports the query, completeness, outcome and pointer data above. If an additional shared contract or operation registration is needed, propose a WE-only predecessor amendment with its own tests; do not quietly add WE writes to this Plateau card. Coupled delivery remains a future supported capability, not a prohibition on cross-repo features.

## MVP

Ship the optional documented activity payload, bounded reader integration, shared relay validation and per-card presentation together. Support build, fix, ci-heal and review rows; display additional producer roles faithfully. Preserve schema-1/schema-2 snapshots without the optional field as unknown, and pass the field through publication and fetch. The current fetch accepts both schemas (we:../plateau-app/src/wip/wip-source.ts:44–55), and the relay has separate schema-2 handling (we:../plateau-app/wip-relay.js:297–305); cover both validation paths.

Excluded: live interest/watch transport, token/tool timelines, remote transcript-file serving, session control, new activity discovery, outcome inference and changes to card priority/counts. #4198 must land before the consumer build is declared complete.

## Test plan

- **Capability (Red today):** extend we:../plateau-app/src/wip/wip-read.test.ts: review plus fixer on one card produces two rows; a pre-PR build matches by card; same PR number in another repository cannot leak in; duplicate query keys issue one call per refresh; concurrency stays bounded; timeouts, unsupported operation, malformed rows and partial results yield unknown without breaking healthy cards. Verify explicit outcomes survive projection and unknowns are not invented.
- **Capability (Red today):** extend we:../plateau-app/src/wip/wip-view.test.ts and we:../plateau-app/src/wip/wip-view.hostile.test.ts: every row field, empty/failure/stale distinctions, absent legacy data, multiple same-role jobs, escaped hostile values, long paths, and copyable outside-root pointers with no dead anchor. Include completed/failed/unknown outcomes and missing timestamps. Existing path-escaping coverage starts at we:../plateau-app/src/wip/wip-view.test.ts:235.
- **Capability (Red today):** extend we:../plateau-app/src/wip/wip-relay-contract.test.ts, we:../plateau-app/scripts/wip-relay.test.mjs and we:../plateau-app/src/wip/wip-source.test.ts: publisher→relay→fetch round trip, schemas 1 and 2, legacy absent fields, null/error versus successful empty, invalid dates, oversized strings/arrays, and scope-less schema-2 validation. New fields must survive transport and be validated wherever rendered.
- **Preservation (GREEN today):** run the full Plateau WIP Vitest directory plus the relay script suite using Plateau's configured test runner; run the Plateau repo gate. Browser-check keyboard disclosure, expansion preservation through refresh, narrow phone layout, visible focus, accessible labels and states distinguishable without colour. Mutation proof: make snapshot refresh discard the open-card set, or remove the existing path escaping; the corresponding preservation assertions must fail. “GREEN today” classifies existing behavior to preserve, not a test run performed in this preparation. Preparation itself does not execute or claim these future implementation tests.

## Proof plan

1. After #4198 lands, capture its real targeted output for an in-flight card/PR with both a review job and fixer. Record repository, card, PR, run identities, timestamps and producer revision. Confirm each transcript/log pointer resolves to a real non-empty file; do not equate a fixture or filename with this observation.
2. Open the dev or deployed /wip route against that snapshot and expand the matching Doing/Needs-you card. Capture both separate rows with role, state, times, outcome (or explicitly unknown), and transcript link/path. Verify a supplied web link opens readable content; for filesystem paths, copy/select the displayed path and verify the file on the host.
3. Observe a subsequent refresh update the activity while preserving expansion. Exercise a successful empty query, then a failed/partial source and a stale snapshot: only the first may say `No agent found`; the others show `?`. Confirm another healthy card remains usable and no additional live subscription was introduced.
4. Capture passing Plateau tests/gate and browser evidence with exact revisions. Deployed proof must include a publisher→relay→phone read; a reader unit test alone cannot establish that the panel reached the phone.

## Follow-ups

- Recheck #4198's delivered contract at implementation time; the current card describes required consumer behavior, not a fabricated producer envelope. Any missing producer capability belongs in its WE predecessor with contract/operation tests before dispatching the consumer.
- Keep live L2/L3 disclosure under #3931's broader work; transcript streaming or a guarded file-serving endpoint requires its own design and scope.
- Testing lesson: local view fixtures cannot prove relay compatibility, source freshness or transcript existence. Keep the live two-run proof and old-snapshot cases on this card; do not append shared agent documentation.

## Done when

The scoped Plateau tests and repo gate pass; a real card displays its review job and fixer separately with all required fields and verified transcript access/path fallback; healthy-empty, unknown and stale evidence remain distinguishable; publisher/relay compatibility and keyboard/phone use are observed. This preparation changes only the card and does not implement or claim that proof.

### Carried from #4202: WIP page: a durable 'not delivered by #N' dismissal for a stranded row that's only a slice or a note


Follow-up from #4201. Let the operator record that a particular merged PR delivered only a slice or a note, and stop repeating that delivery question in the WIP page. Keep the card open and preserve other evidence. This is a Plateau presentation feature, not a backlog resolution or health-watch silence.

## Progress

Prepared against WE HEAD `026425e9e4a9c067851692c796ec0620879dabcb` and Plateau HEAD `1debc8990f730b45bdfc0eab430f9a567f6de2c9` by reading the current paths below. Plateau citations use the WE-relative sibling locator `we:../plateau-app/`; frontmatter retains the machine's canonical `plateau:` scope qualifier so dispatch selects the correct repository.

- **Old premise:** merged evidence repeatedly asks a Needs-you question every 10 seconds. **Corrected:** the current model puts merged bookkeeping into **doing**, with unknown liveness and no resolve action (we:../plateau-app/src/wip/wip-model.ts:235–242). The view still shows a warning asking for confirmation and links to check each merge (we:../plateau-app/src/wip/wip-view.ts:190, :250–254). Polling is 15 seconds (we:../plateau-app/src/wip/wip-view.ts:555); websocket snapshots also repaint the page (same file:589–608). The goal is therefore still outstanding, but restoring the old Needs-you/resolve behavior would be wrong.
- **Matcher premise confirmed:** Plateau loads the WE sweep (we:../plateau-app/src/wip/stranded-read.ts:64–66) and maps its hits to PR URLs (same file:154–169); stale-claim uses the same sweep (we:scripts/conveyor/health-smells/stale-claim.mjs:40, :130). The sweep does not read a dismissal annotation: it matches open/active non-epic cards and caps the returned hits (we:scripts/backlog-stranded-sweep.mjs:155–175). “dismissedPrs-style” was an analogy, not an existing integration seam.
- **Silence qualification:** health-watch has independent persisted silences (we:scripts/conveyor/health-watch.mjs:861–869), with expiry/re-raising (we:scripts/conveyor/health-watch-core.mjs:407–417). They are not a permanent per-card/PR dismissal consumed by the WIP page.
- **Old scope:** three Plateau model/reader files, without UI or tests. **Corrected scope:** the page renderer/mount, a proposed browser-local dismissal helper and its tests, existing renderer/mount tests, and the product page specification. The existing pure renderer and repaint seam are we:../plateau-app/src/wip/wip-view.ts:380 and :582–587; mounted-source tests already exist at we:../plateau-app/src/wip/wip-mount.test.ts:19–29. No source reader or shared matcher edit is needed for the page-local option explicitly allowed by the original card.

## Design

Use a versioned browser-local store for the WIP page. “Durable” here means surviving polls, pushed snapshots, navigation, reload and browser restart in the same origin/profile; it does not promise cross-device synchronization or survival after browser storage is cleared. State that boundary next to the dismissal control. This selects the original card's WIP-page-local note-store option.

Before implementation, update we:../plateau-app/docs/wip-page.md:15–31 to describe current Flow bookkeeping and this dismissal state. Those lines still describe the older Needs-you/resolve behavior; current implementation evidence above takes precedence over that stale narrative.

For each matched PR provide **“Not delivered by #N — only a slice/note”** and an accessible restore action. Key records by card identifier plus normalized repository identity and PR number, extracted from the matched PR URL already supplied by we:../plateau-app/src/wip/stranded-read.ts:162–165. Do not key by PR number alone, epic, title, or row index. Reject malformed identities rather than risk dismissing another repository's PR.

Keep the received snapshot immutable. Pass local dismissal state into the pure renderer; project only the delivery evidence at render time. Suppress the dismissed match's warning, check prompt and repeated delivery implication, while keeping an unobtrusive saved note with Restore. If another matched PR remains, show that PR's evidence and question. If every match is dismissed, replace the merge-only explanation with “Delivery matches dismissed on this browser; card remains open/active.” Keep the card, its group, liveness, totals and progress unchanged: the page does not have the raw inputs needed to safely reclassify it. Do not replace an independent already-done stall explanation with a dismissal note; that reason precedes merged evidence in we:../plateau-app/src/wip/wip-model.ts:231–238.

Persist successfully before showing a saved dismissal. Missing storage means no saved notes; malformed data or unavailable/quota-denied storage produces a visible recoverable error and leaves evidence visible. Restore is also persisted before changing the display. Mount and unmount must load/clean up their local state and subscriptions; test through both poll and pushed-snapshot paint paths. Compose existing disclosure behavior if a saved-note disclosure is needed; the page already uses `nav:section` (we:../plateau-app/src/wip/wip-view.ts:539).

## MVP

1. Document the behavior and storage boundary in the Plateau page specification.
2. Add we:../plateau-app/src/wip/stranding-dismissals.ts (proposed): identity validation, versioned storage decoding, idempotent save/restore, and injectable storage for tests.
3. Integrate dismissal and Restore into we:../plateau-app/src/wip/wip-view.ts:190, :233, :252 and :569. Preserve focus across repaint and expose save failures to assistive technology. Keep saved notes inspectable without recreating an action-demanding warning.
4. Add helper tests and extend existing view/mount tests listed in scope. No backlog annotation, health-watch mutation, matcher change, publisher/relay protocol change or remote command is part of this MVP.

**Repository delivery:** implementation and tests are Plateau-only. This WE card is the planning carrier. Under the #4289 ruling (we:backlog/4289-design-multi-repo-couple-locus-delivery-e-g-we-plateau-app-2.md:18), a future shared annotation design would require a separately useful WE predecessor (annotation contract, sweep semantics and tests), followed by a Plateau consumer/UI successor blocked on it. Do not add that mixed implementation scope to this card or silently omit WE files to bypass admission. No split is needed for the selected browser-local MVP, and no additional cards are created in this preparation.

## Test plan

- Proposed we:../plateau-app/src/wip/stranding-dismissals.test.ts: round-trip through a fresh store instance; card/repository/PR isolation; duplicate save; restore; malformed JSON/version/identity; missing storage; thrown reads/writes and quota errors. Never report persistence after a failed write.
- Extend we:../plateau-app/src/wip/wip-view.test.ts at the renderer seam (we:../plateau-app/src/wip/wip-view.ts:380): two matches, one dismissal, all dismissed, a new PR, saved-note restore control, escaped hostile text, and unchanged group/count/progress. Assert independent stall/review/CI/degraded evidence remains visible; current grouping precedence is we:../plateau-app/src/wip/wip-model.ts:220–242.
- Extend we:../plateau-app/src/wip/wip-mount.test.ts:19–29: click → successful persistence → next poll → pushed snapshot → unmount/remount preserves the dismissal; Restore re-exposes only the selected match. Verify failure messages, keyboard access and retained focus through repaint. Use injected sources/storage; no live backlog or GitHub writes.
- Run in the Plateau implementation checkout (the helper suite is proposed, not present or passing during preparation):

```bash
npx vitest run src/wip/stranding-dismissals.test.ts src/wip/wip-view.test.ts src/wip/wip-mount.test.ts src/wip/wip-model.test.ts src/wip/wip-read.test.ts
```

## Proof plan

Implementation acceptance requires a running browser with a controlled snapshot containing an open card and two merged matches. Record the initial warning, dismiss PR #N, wait through a refresh, deliver a pushed snapshot, reload, and reopen the browser profile: #N must remain saved while the other match remains actionable. Introduce a different PR and verify its question appears. Restore #N and verify its evidence returns. Repeat with storage writes rejected: no success message or hidden evidence is allowed.

Capture the card remaining open, unchanged counts and unrelated warnings, the visible same-browser limitation, keyboard focus/accessible control names, and the fixture identity alongside screenshots and test output. No production card should be resolved for this proof. These are future implementation acceptance steps, not claims that the dismissal has been built or browser-tested in this preparation.

## Done when

1. The focused Plateau command in Test plan passes with new persistence/poll/remount regression cases that fail against the old implementation.
2. The running-browser Proof plan demonstrates per-card/per-PR dismissal and restoration without concealing other evidence or claiming cross-device durability.
3. Only Plateau implementation/specification/test files listed in scope are needed; existing WE sweep and health-watch behavior remain intact.

## Follow-ups

- Cross-device/shared operator dismissals are a possible later feature, not delivered or separately filed here. If requested, define persistence ownership and consumer semantics first, then apply the per-repo dependency split above.
- The sweep limits displayed PR hits (we:scripts/backlog-stranded-sweep.mjs:171; we:../plateau-app/src/wip/types.ts:93–94). This page-local feature must not claim that dismissing the returned matches proves there are no other merges; broadening or paginating evidence is separate work.
- Testing lesson for implementation: exercise fresh storage instances and both snapshot arrival paths. A renderer-only test cannot prove persistence across reload, and a successful storage write alone cannot prove the page stops repeating the question.

### Carried from #3736: wip report: compact phone-first tables, and Attention findings become queued items


Operator (2026-09-20): /wip is read on a phone most of the time and the Attention section is an internal signal that should queue itself for resolution. (1) Work items and Done-since become compact tables: at most 3 short columns, about 35 characters a row, titles cut to about 18 characters, a short note under the table only when a row needs detail; the header and Needs you stay plain lines. (2) Every Attention finding becomes a queued item automatically. A finding with a live handler and a live runner is not shown in Attention and appears under Work items as queued. A finding with no handler is filed once as a backlog item (dedup by rule plus target) and /wip shows one line 'N gaps queued (#ids)'. A finding still unresolved past a deadline (about 2 h) shows one line naming the item. Needs you is unchanged. The report code (we:scripts/operations/wip-report.mjs) lives on lane/mechanical-dispatcher, not main, so this work commits there (epic #3383 prototype rule). Sequence: dispatch after wip-honest-remedy lands (same file; its auto vs no-handler decision selects the path). Full auto-resolution needs the conveyor runner live. (3) Once the unified planned-items intake exists (the `track` operation: tracker notes plus filed backlog items as the only two sources, operator 2026-09-20), /wip shows only the TOP planned items (about 5, ranked) as a compact table (id, short title, state) in place of the Next section, not the whole list; the FULL unified list is available on demand through a separate view (a `--planned` flag on the report, same compact table) and the operator wants it printed in full once, when the unified source first exists. Blocked on the `track` story, which is not filed yet. Related but distinct: #3603 (queue-report holds).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

### Carried from #4901: Render all Plateau PR waits and cached pages in the phone Flow view


Show every observed PR in counted wait groups with full descriptions, reachable waiting-chain details and honest paging coverage. Preserve human prerequisites, existing decision links and disclosure focus across mobile updates and reconnects.

## Design

Render all primary groups, counts and disclosure, including empty groups, with one fully wrapped description per PR and reachable chain details. Reuse native disclosure already used by the WIP view (we:../plateau-app/src/wip/wip-view.ts:250); no custom disclosure listeners. Preserve disclosure/focus/scroll on updates. Treat title, raw reason, links and paths as untrusted text; permit safe links only and never publish absolute host paths/transcripts. CSS currently clamps descriptions (we:../plateau-app/src/wip/wip-view.css:146); remove clipping on the new flow path. No new approval/merge/stop control.

Consume both predecessor outputs, show every primary group including empty ones, and count each repo/number exactly once across loaded pages. Group totals describe the accepted collection, not only visible pages; show pending versus actionable human counts and preserve system prerequisites. Author/card/epic filters never change global totals. Every row exposes current wait, owner/reason/age, queue/blocker/shared-file evidence, holder/since, conditional next steps and ETA or its specific unknown reason. Missing/truncated repo observations cannot claim all-PR completeness. Do not add approval/merge/stop controls.

## Observed seam and scope

we:../plateau-app/src/wip/wip-view.ts:343 renders the schema-2 summary/actions; :569 mounts snapshot/live updates. Extend that existing surface and recheck #4057 for Fleet overlap before build. Native disclosure is present at :250; reuse it, preserving focus/scroll/open state. The current wrapping rule at we:../plateau-app/src/wip/wip-view.css:197 supersedes the old preparation's blanket clamp diagnosis: test the new Flow path rather than assuming it needs global CSS removal. Existing renderer/hostile tests anchor the new cases. Proposed we:../plateau-app/tests/wip-progress.spec.ts uses the owning browser harness.

Budget: **5 implementation/test paths, 2 areas** (we:../plateau-app/src/wip/ and we:../plateau-app/tests/), plus card close-out. Only the browser spec is a new file. Exact touch set is frontmatter scope.

## Test plan / Done when

- **Capability — Red today expected (not executed during this backlog split):** View/hostile tests prove full descriptions, safe links/text, all groups/rows reachable, truthful partial/offline coverage and global totals invariant under filtering. Keep decision links, human prerequisites and human action counts; pending review/fix stays Flow without explicit human disposition.
- **Capability — Red today expected (not executed during this backlog split):** Drive 320/390px browser screenshots, keyboard traversal and axe. Check visible focus, accessible names, landmarks, one h1/ordered headings, no clipping or horizontal overflow, restrained live announcements and retained disclosure/focus/scroll after updates.
- **Capability — Red today expected (not executed during this backlog split):** Save sanitized snapshots for all three repos with producer timestamps and a repo/number manifest. Run publisher → relay → same-origin browser, load all pages and compare exact rendered union/counts to that manifest. Repeat with missing/truncated repo observations.
- **Capability — Red today expected (not executed during this backlog split):** Capture contemporaneous refusal/claim/run evidence, compare blocker/shared file/holder/start, then observe a later pass changing the wait. Show controlled known ETA and insufficient-history unknown; record unsupported producer fields rather than inventing them.
- **Capability — Red today expected (not executed during this backlog split):** Observe two 120-second publish cycles plus a second tab with process/network instrumentation and GitHub ledger attribution. Require zero calls attributable to collection/page asks/extra tab, accounting separately for unrelated legacy history activity.
- **Capability — Red today expected (not executed during this backlog split):** Disconnect/reconnect publisher and replay old snapshots/pages; preserve rows and age honestly, mark unreachable remainder and reject cross-snapshot unions. Run focused WIP suites and affected relay suites plus the owning gate. Record proof commands, source identities, results and limitations here and on the epic.

## Follow-ups

#4624 owns broader standalone running/held-work discovery. Consume its evidence if available; it is not a hidden prerequisite. Preserve the umbrella's producer-enrichment/history follow-ups without expanding this UI story.

## Delivery boundary

This is one story under #4623; its prepared Design, MVP and Proof plan remain the umbrella acceptance. No implementation was performed while splitting. Reconcile predecessor interfaces before build and capture expected failing capabilities before changing code. All tests use sanitized fixtures, injected clock/IO and network/process spies, never live claims. A missing source means unknown with a reason. No new GitHub polling, approval, dispatch or merge behavior is authorized.

Build only the listed scope. Re-probe the touch set if upstream interfaces move; split again before exceeding 20 paths or 4 areas. Run the affected suites and the owning repository gate, recording commands, source identities and limitations on this card. Keep testing lessons in Follow-ups rather than shared agent docs.

### Carried from #4984: Prevent horizontal elastic scroll on mobile in the WIP page


Filed from owner request R-H2JH3 (story). On mobile, the /wip page can be dragged sideways and shows elastic overscroll past its left and right edges. Done means the page stays fixed in width on narrow screens (checked at 366x747 in the lane/wip-quickview build) and vertical scrolling is unchanged. The likely fix is overflow-x control on the page root and the wip layout, plus checking any wide child such as the focus picker or board rows. Scope assumes the whole page, not one section.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

### Carried from #4997: Prevent pinch and double-tap zoom on mobile for the WIP page


Filed from owner request R-V2G2G (story). Operator reports the /wip page zooms on mobile (pinch and double-tap), which breaks the phone layout. Done when pinch-zoom and double-tap zoom no longer occur on /wip pages on a phone, via the viewport meta (maximum-scale=1, user-scalable=no) and touch-action: manipulation on the page root. Assumption: scope is the /wip pages only, not the rest of the app; input focus zoom on iOS is also prevented by keeping form control font size at 16px or larger.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

### Carried from #5377: Add mobile-friendly navigation menu to /wip and related pages


Filed from owner request R-LQDDN (story). On a phone (366px wide) there is no easy way to move between /wip and its related pages (e.g. /sessions, glance). Add a compact, touch-friendly menu (hamburger or bottom bar) that lists those pages, highlights the current one, and works at mobile widths without horizontal scroll. Assumption: 'related pages' means the existing WIP-family pages (/wip, /wip glance, /sessions); desktop layout stays as is or reuses the same nav. Done when the menu appears on all those pages, every link navigates correctly, and it is usable at 366x791.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.

### Carried from #4996: Add a Discard action for requests on the /wip page


Filed from owner request R-482Z9 (story). The operator can file requests from the /wip page but has no way to drop one that was sent by mistake or is no longer wanted. Add a Discard control on each request that, after a confirm step suited to a phone screen, marks it discarded and removes it from the active request list. Assumption: discard is a soft state change (the request is kept, tagged discarded, and any linked card is left untouched), not a hard delete. Done when a request can be discarded from a 366px-wide view and no longer appears among open requests.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

### Carried from #5358: /wip deep links: ?card=N highlights a card, ?agent=<session> opens its agent panel (P3 of 128)


Requested behavior: /wip?card=N scrolls to, highlights and focuses the card; /wip?agent=<session> opens the matching agent panel. Unknown identities show an inline notice. The original scope points outside WE; no matching WIP mount or mount test was found in this checkout. Scope is omitted pending an ownership ruling.

## Done when

- [A1] Executable criterion blocked: there is no verified WE mount test path for this surface. After the ownership question is answered, name the real owning-repo test and queue command; it must cover known card focus/highlight, known session panel, and unknown card/session notice. Inventing a we:-prefixed implementation/test path would misrepresent the checkout.

## Non-goals

- [N1] No implementation in the abandoned prototype, new session-control action, or feed mutation. Links select existing UI state; no new write endpoint, so body/rate/CSRF controls are inapplicable.

## Edge cases this change must handle

1. **Untrusted text** — Parse query values as opaque IDs; render unknown-ID notices as text, never HTML or raw selectors.
2. **Truncated reads** — If the card/session feed is incomplete, show loading/unavailable rather than declaring a missing identity.
3. **Shared state files** — n/a: navigation should not write shared card/session state.
4. **Fail closed** — A missing or unauthorized session must not open another panel or trigger a control action.
5. **Identity scoping** — Resolve the exact card/session within the loaded authorized surface, not a substring match.
6. **State over time** — Wait for async mount/data before resolving; clear obsolete highlights when query/navigation changes.
7. **Who wrote it** — A URL selects a target; it does not prove the linker owns the session or authorize session actions.

## Grounding

`we:vite.config.mts:12` imports the sibling product’s dev panel, not a WE WIP mount. `we:backlog/128-background-task-status-bar-block.md:13` concerns a background-task block, not the claimed P3 parent. File enumeration found no WIP/glance mount or associated test in WE.

## Open questions

Which live product repo and existing mount/test own this feature, and what is the actual parent card? The original non-WE scope conflicts with the requested we:-only scope. This blocks a truthful executable acceptance test and implementation estimate; size 1 is retained provisionally.

### Carried from #5593: /wip deep links: apply ?card= and ?agent= only to the real snapshot, never the fallback sample


Follow-up from plateau-app #217 (card 5358, P3 of 128; operator approved with follow-up 2026-10-09). The deep-link once-flags (scroll-once, open-agent-once) are spent on the fallback sample rendered before the real snapshot arrives, so the link never applies to real data. Apply deep links only to the real snapshot; add tests for scroll-once and the 128-char cap on the link value. Scope is the #217 glance files; confirm against the card at pickup.

## Acceptance

- [A1] **Executable** — a glance deep-link test fails on the #217 head and passes after: with the fallback sample rendered first and the real snapshot arriving later, `?card=` scrolls and highlights on the real snapshot, and `?agent=` opens the panel there.
- [A2] The once-flags are spent only on the real snapshot, never on the fallback sample.
- [A3] Tests cover scroll-once (a later snapshot refresh does not scroll again) and the 128-char cap on the link value (a longer value is ignored, not truncated into a match).

## Non-goals

- [N1] New deep-link parameters.
- [N2] Changing the fallback sample itself.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the query value is capped at 128 chars and matched as text, never injected as HTML or a selector.
2. **Truncated reads** — n/a: this follow-up opens no new case of this class.
3. **Shared state files** — n/a: this follow-up opens no new case of this class.
4. **Fail closed** — n/a: this follow-up opens no new case of this class.
5. **Identity scoping** — n/a: this follow-up opens no new case of this class.
6. **State over time** — scroll and open happen once per page load, not per snapshot refresh.
7. **Who wrote it** — n/a: this follow-up opens no new case of this class.

~~~~
