---
bornAs: xa4t53u
kind: task
status: open
scope: ["we:designs/pr7196-test-removal-ruling-2026-11-21.md", "we:scripts/conveyor/__tests__/pr-ready-stuck.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Pin ready-pin-stale detail.reason and restore is-ancestor for the moved-tip row

From the #7196 ruling (we:designs/pr7196-test-removal-ruling-2026-11-21.md): the ready test should pin the detail reason ready-pin-stale and restore the is-ancestor check for the moved-tip row. Source: build-queue 00:33 ET 2026-11-21.

## Acceptance

- [A1] **Executable** — Planned `reports ready-pin-stale for moved tip` in `we:scripts/conveyor/__tests__/pr-ready-stuck.test.mjs`: Move a real fixture branch tip; assert detail.reason equals ready-pin-stale and the is-ancestor assertion rejects the stale relationship.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No change to ready-pin policy.

## Edge cases this change must handle

1. **Untrusted text** — Ref names remain data.
2. **Truncated reads** — Incomplete ancestry evidence cannot establish readiness.
3. **Shared state files** — Keep moved-tip fixtures isolated.
4. **Fail closed** — An ancestry error cannot become a ready result.
5. **Identity scoping** — Compare the exact pinned and moved heads.
6. **State over time** — Exercise the tip move explicitly.
7. **Who wrote it** — Assertions use observed reason and ancestry results.

## Duplicate admission

nd
