---
bornAs: xv8f2p4
kind: story
size: 2
parent: "5452"
status: open
scope: ["we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs", "we:docs/agent/reviewer-expectations.md"]
dateOpened: "2026-11-15"
tags: []
---

# Pin the advertised default runtime row and key retention boundaries

Prevention filed for PR #6889 review at head 7394c94691d07b2a2873fe0a9af946404f197a29, codex-correctness/coverage; also raised by the simplicity advisory at we:scripts/conveyor/pr-events-worker/core.mjs:66. Existing small injected bounds do not detect drift in the advertised defaults.

Latest advisory linkage: PR #6889, 2026-11-16T05:37:58Z, head ae079849826a461c809a93df310d133f759eb31c. A1–A3 carry correctness/test-coverage and security/coverage's default-bound requests, also raised as simplicity and codex-correctness card suggestions. A4 carries their general prevention obligations for numeric defaults, fail-closed guards and 'never X' comments, with #8367 and #8370 supplying the specific negative-path plans. Existing production SQLite expiry coverage does not replace the planned count-bound and independent-default assertions.

## Acceptance

- [A1] **Executable** — add 'default runtime row and key retention enforce advertised boundaries' in we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs with retention options omitted. Exercise runtime row counts 5,000 and 5,001, and key counts 20,000 and 20,001; assert the oldest entry is evicted at each overflow.
- [A2] With a deterministic clock, exercise just before, exactly at and just after the 30-day row and 60-day key cutoffs. Trigger pruning as production does; assert retained rows and replay/deduplication behavior independently so a row still present cannot mask key expiry.
- [A3] Demonstrate tests redden if any of the four defaults changes. Avoid wall-clock waits and implementation-constant imports that would let the expectation drift with the implementation. Keep fixture construction bounded; record the default-map cost if the existing implementation makes the suite too expensive.
- [A4] Add a review-lens checklist item to we:docs/agent/reviewer-expectations.md requiring new numeric defaults, fail-closed guards and 'never X' comments to reference named tests for their guarantees. Require literal default-value assertions, throwing-path assertions for each guard clause, and negative-path assertions for prohibitions. Flag defaults tested only through injected substitutes and prohibitions tested only on success. Cross-reference #8367 for bounds refusal and #8370 for client failure paths.

## Test plan

- A1–A3 — **Preservation (GREEN today)** for the configured policies: planned 'default runtime row and key retention enforce advertised boundaries' in we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs. Pin literal expectations for all four defaults, count overflow and age cutoff equality. Planned mutation proof: change each default independently. Full-capacity storage may expose the separate known #8365 defect; record that red honestly.
- A2 — **Preservation (GREEN today)**: planned 'default key expiry is observed by replay alone' in the same file, coordinated with #8365 A7. No intervening write may perform expiry on behalf of the replay. Existing 'replay alone expires the default key and row windows through the production appendRuntime method' in we:scripts/conveyor/pr-events-worker/__tests__/sql-adapter.test.mjs already covers replay-only expiry through the production adapter; this follow-up adds the independent default-bound assertions.
- A4 — **Capability (Red today)**: review the new checklist against numeric-default drift, injected-only bounds coverage, a fail-closed guard without a throwing-path test, and a 'never retries' comment with success-only tests; each must trigger a named-test request. These specific checklist requirements are the planned additions.

## Proof plan

Record deterministic named results and evidence that each default independently affects an assertion. Cite the checklist text and its counterexamples. Run full-capacity storage coverage with #8365's byte limit; do not conceal a row-size failure by reducing the advertised default capacity.

## Non-goals

- [N1] No default-policy changes or SQL row-size repair; storage restructuring is tracked separately.

## Edge cases this change must handle

1. **Untrusted text** — n/a: valid deterministic fixtures only.
2. **Truncated reads** — page through retained rows; do not mistake one page for the whole log.
3. **Shared state files** — n/a: isolated storage per test.
4. **Fail closed** — assert hard caps and the explicit oldest-first eviction fallback.
5. **Identity scoping** — use unique complete runtime keys to avoid accidental duplicates.
6. **State over time** — pin both age windows and replay after expiry independently of row retention.
7. **Who wrote it** — n/a: retention tests do not change authentication.
