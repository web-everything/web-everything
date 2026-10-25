---
kind: story
size: 5
status: open
dateOpened: "2026-10-24"
tags: []
---

# Lane-pool PR 5859 review prevention and deferred coverage

Filed from the 2026-10-24 changes-requested review of PR #5859. These are the requested prevention checks and later-round card suggestions; this card does not authorize relaxing any preservation refusal.

## Work

1. Add a `check:standards` rule requiring tests that spawn lane-pool acquire or release to choose `LANE_POOL_NO_RECOVER` or `LANE_POOL_AUTO_RECOVER` explicitly, following shared fixture helpers as well as direct spawn sites. The four timing/refusal suites named in review are pinned in this repair.
2. Add backlog lint rejecting `TODO:` placeholders in Acceptance or Non-goals on open cards. Report file and section; do not silently rewrite cards.
3. Add a review-lens checklist requiring a CLI or wiring assertion for every prose guarantee in a doc comment. Use gap filling and ignored-entry logging as the positive examples from `lane-pool-cap-count.test.mjs`.
4. URL rewrite prevention is implemented in `lane-pool-salvage-push.mjs`: fail closed for effective `insteadOf` and `pushInsteadOf`, including included config. Keep both real-Git and transport-boundary regression coverage.
5. Keep the parameterized `selected pool recovery never uses the caller origin` integration gate covering gc, release and release --all-pools from a different caller with --pool and no explicit origin/reference. Explicit origin/reference and missing-primary refusals must remain covered.
6. Add a real backup regression proving successive recovery attempts never overwrite prior backup bytes. Exercise the actual `realRecoverIo.backup` path, not just an injected mkdir function.
7. Repair stash preservation completeness in `realRecoverIo`: `git stash show -p` alone omits some stash contents. Test staged/unstaged, untracked (`stash -u`), ignored (`stash -a`) and binary content with byte-for-byte restoration before permitting a reset; unreadable or incomplete backup must keep the lane.
8. The recovery-speed acceptance suggestion is specified on `xle1sxo-lane-pool-recovery-per-lane-slowness.md`, including the executable gate, planned named performance tests and risk mapping.

## Acceptance

- [A1] **Executable** — `npm run check:standards` must reject synthetic acquire/release fixtures missing an explicit recovery setting and open cards containing Acceptance/Non-goals placeholders. Add named rule tests `requires explicit recovery policy in lane-pool subprocess tests` and `rejects placeholders in open-card acceptance`.
- [A2] **Executable** — `npm run test:unit -- scripts/lib/__tests__/lane-pool-recover.test.mjs scripts/__tests__/lane-pool-recover-race.test.mjs` must include `successive recovery backups retain earlier bytes` and `stash backups restore every content kind`; test the failed-copy path retains the lane.
- [A3] Retain the canonical-origin and rewrite gates already added by PR #5859; document the review-lens checklist and map its prose guarantees to named wiring tests.

## Non-goals

- [N1] No performance implementation, force push, wider override, or suppression of current review findings.

## Risks and test plan

- Static analysis can miss helper-wrapped spawns or falsely flag unrelated commands: A1 tests direct, shared-helper, alias and opt-in/opt-out cases.
- Lint can mistake quoted examples for card requirements: A1 tests open/closed status and section boundaries.
- A backup can appear successful while losing bytes: A2 restores every stash content kind and injects incomplete writes and a second attempt.

## Edge cases this change must handle

1. **Untrusted text** — Treat fixture source and card text as data; argv, no shell interpolation. A1 includes quoted/newline inputs.
2. **Truncated reads** — Oversized/unreadable source or backup evidence reports an error; A1/A2 include read failures.
3. **Shared state files** — Concurrent backup attempts use distinct directories; A2 checks earlier bytes survive.
4. **Fail closed** — Incomplete preservation never permits reset; A2 injects incomplete writes.
5. **Identity scoping** — Same lane number in different pools cannot share proof; retain the canonical-origin integration gate.
6. **State over time** — Repeated attempts retain older backups and recheck leases before reset; A2 covers retries.
7. **Who wrote it** — Lane config and content are untrusted; canonical primary and verified backup are the authority.
