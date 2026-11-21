---
kind: task
status: open
scope: ["we:scripts/operations/review-set-label.mjs", "we:scripts/__tests__/review-set-label.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# review-set-label needs a way to drop a stale status:needs-you on an accepted PR

#7230 is accepted but carries a stale status:needs-you. review-set-label can only clear it as a human; add a non-clear-human path to drop it. Source: build-queue 22:11 ET 2026-11-20.

## Acceptance

- [A1] **Executable** — Planned `drops stale needs-you after non-clear-human acceptance` in `we:scripts/__tests__/review-set-label.test.mjs`: Accept a PR through the non-clear-human path; assert stale status:needs-you is removed.
- [A2] **Executable** — Planned `preserves outstanding human hold` in `we:scripts/__tests__/review-set-label.test.mjs`: Accept with a genuine outstanding human hold; assert status:needs-you remains and the hold is unchanged.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No blanket removal of human holds.

## Edge cases this change must handle

1. **Untrusted text** — Label and acceptance text remain data.
2. **Truncated reads** — Incomplete acceptance evidence cannot clear the label.
3. **Shared state files** — Reconcile current labels before changing them.
4. **Fail closed** — Uncertain acceptance retains the hold with a visible reason.
5. **Identity scoping** — Clear only the matching accepted PR label.
6. **State over time** — Cover acceptance followed by a new human hold.
7. **Who wrote it** — Only verified acceptance authorizes stale-label removal.

## Duplicate admission

new card from build-queue CARD line
