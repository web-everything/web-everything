---
bornAs: x0alreb
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/health-smells/drain-merge-rate-drop.mjs", "we:scripts/conveyor/__tests__/health-watch*.test.mjs", "we:scripts/conveyor/health-smells/__tests__/drain-merge-rate-drop*.test.mjs", "we:scripts/conveyor/health-smells/__tests__/slice-3-daemon-smells.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "27c92dd17d893fe406953b1e0842a8627b64058f"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2915's independent review

Turn the three prevention debts recorded on approval into executable guards: corrupt drain-history handling, fixture tick isolation from host data, and agreement between merge-rate counts and their operator-facing explanation.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2915@26057325f18d0fdbda7d2c1bb7ae0efd94d67fa6

## Progress

- Original premise/scope: the approval cited the drain probe at `we:scripts/conveyor/health-watch.mjs:572`, requested either a corrupt-line fixture or tolerant parsing, requested zero reads outside the lock root, and requested a review lens for count/summary agreement. The scope named a dedicated smell test that does not exist.
- Corrected premise: the probe is now at `we:scripts/conveyor/health-watch.mjs:849`; its shared reader deliberately throws on malformed JSON at `we:scripts/operations/land-advance-io.mjs:49`. The tick captures probe failures at `we:scripts/conveyor/health-watch.mjs:974`. Preserve that strict unknown/error behavior and add the explicitly requested fixture guard; do not silently treat corrupt evidence as complete or change the shared reader.
- Corrected isolation scope: the existing fixture supplies sibling logs, locks, sync, and state directories, not one lock-root sandbox (`we:scripts/conveyor/health-smells/__tests__/slice-3-daemon-smells.test.mjs:307`). The contract is zero host-data reads during a fully configured fixture tick, allowing its explicitly supplied temporary roots. The existing no-history test only checks transitions (`we:scripts/conveyor/health-smells/__tests__/slice-3-daemon-smells.test.mjs:324`), so it cannot prove absence of reads. The drain-specific skip already exists at `we:scripts/conveyor/health-watch.mjs:1082`, but host-default calls remain for builder logs, shim lanes, untracked cards, App status, admission status, spend/cap/event inputs (`we:scripts/conveyor/health-watch.mjs:996`, `we:scripts/conveyor/health-watch.mjs:1021`, `we:scripts/conveyor/health-watch.mjs:1049`).
- Corrected metric scope: `waitingPasses` counts considered greater than merged, including partial merges (`we:scripts/conveyor/health-smells/drain-merge-rate-drop.mjs:26`), while its summary still says “landed none” (`we:scripts/conveyor/health-smells/drain-merge-rate-drop.mjs:59`). Preserve the predicate; correct the explanation and stale comments. Existing metric tests at `we:scripts/conveyor/health-smells/__tests__/slice-3-daemon-smells.test.mjs:247` lack partial-merge summary assertions. This remains undelivered.
- Scope now includes existing slice-3 coverage plus planned focused tests under the two narrow patterns in frontmatter. Every source has a matching test scope. Size **3 → 5**: the broader tick isolation audit/fix spans the default reads above, beyond the original three small guard assertions. No blocker change is proposed.

## Design

1. Pin corrupt-input behavior through the real drain reader: malformed history raises a probe error, the tick survives, and neither drain smell treats unavailable evidence as zero merges. Keep missing history distinct from corrupt history. This uses the approval's fixture-test option; tolerant parsing and shared-reader changes are outside this item.
2. Reuse the existing fixture-mode detection in `we:scripts/conveyor/health-watch.mjs:1006`. For host-data probes, honor explicit fixture inputs and otherwise skip host defaults in fixture mode. Preserve live-mode behavior. Apply this to reads reached through imported helpers as well as direct filesystem calls; avoid solving isolation by catching permission errors after attempting host reads. Existing skip representations and per-smell probe requirements determine unavailable values.
3. Add a runtime filesystem/child-process observation harness in planned `we:scripts/conveyor/__tests__/health-watch-fixture-isolation.test.mjs`. Import the module before starting observation, then record tick-time reads, metadata probes, directory scans and child launches. Allow only explicitly configured temporary fixture roots; module loading is outside the observation interval. Record forbidden attempts before throwing because tick error handling can swallow exceptions. Stub process/network/notification transports without masking filesystem reads. A default host command must not escape via a subprocess.
4. Correct the summary and comments in `we:scripts/conveyor/health-smells/drain-merge-rate-drop.mjs` to describe passes that considered more PRs than they merged. Add focused executable count-to-wording assertions in planned `we:scripts/conveyor/health-smells/__tests__/drain-merge-rate-drop.test.mjs`; use these cases as the concrete review lens. No thresholds or counting policy change.

## MVP

- Add corrupt middle-line and truncated final-line fixtures to `we:scripts/conveyor/health-smells/__tests__/slice-3-daemon-smells.test.mjs`, asserting direct probe failure and tick-level error reporting with no fabricated drain transitions.
- Add the focused isolation test, then repair default-host probe wiring only in `we:scripts/conveyor/health-watch.mjs`. Supply logs/state/locks/sync and explicit fixture files under one temporary parent, disable GitHub, diagnosis, investigation and filing, and intercept outbound notification. Exercise absent and explicit drain-history cases, plus a second tick with persisted state.
- Add metric/summary cases and update the misleading text. Keep the existing slice-3 tests and general health-watch coverage intact.

## Test plan

- Corruption: valid records on both sides of malformed JSON; a truncated final record; missing file; valid history. Assert error visibility, survival, and no false drain incident, not merely an empty transition list.
- Isolation: the observation ledger must contain no out-of-fixture data access or unapproved child launch, including attempted reads whose exceptions were caught. Include nonempty silence state with a fixture backlog directory so active-card lookup is exercised. Explicit history must still reach the real probe; omitted history must not reach the host default. Restore all mocks/environment in cleanup.
- Metric truth table: considered/merged pairs 0/0, 2/0, 2/1, 2/2, and 1/2; include numeric-string inputs already accepted by the predicate. Check waiting counts and interpolated summary, especially partial merges; retain baseline, quiet-hour and two-tick breach cases. Use default windows; configurable-window wording is separate.
- Run the focused new files, existing `we:scripts/conveyor/__tests__/health-watch.test.mjs`, `we:scripts/conveyor/__tests__/health-watch-heavy-run.test.mjs`, and `we:scripts/conveyor/health-smells/__tests__/slice-3-daemon-smells.test.mjs` through the host heavy-run queue. Run `npm run check:standards` through the same queue.

## Proof plan

- Before the fix, capture red isolation and partial-merge wording assertions; the corruption characterization may already pass because strict failure is intentional. Record the forbidden access ledger rather than infer isolation from lack of incidents.
- After the fix, capture queued test output showing all three guards pass. Temporarily restore the old summary and a host-default probe call separately: each corresponding guard must fail; revert these mutations before final verification.
- Queue commands via `we:scripts/readiness/heavy-admission.mjs`: invoke its `run --` with `npx vitest run` and the WE-relative test arguments named above, or with `npm run check:standards`. No live daemon, live drain-history mutation, host notification or GitHub request is needed.
- Preparation evidence is source inspection only; implementation tests and mutation proof are owed at delivery. The runner owns preparation checks and stamping.

## Follow-ups

- No new cards or blocker edges required. Broader JSONL recovery semantics would change shared evidence policy and are deliberately not part of this fixture guard.
- A generic review-lens system and configurable-window summary wording are outside this focused prevention debt; retain the concrete count/summary cases as reviewer evidence.

## Done when

All three debts have executable coverage, fixture ticks attempt no host-data reads, partial-merge summaries match the existing predicate, and queued regression/standards checks pass with red-before/green-after evidence for the two current defects.
