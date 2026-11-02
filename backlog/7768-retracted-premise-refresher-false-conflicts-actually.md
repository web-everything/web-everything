---
bornAs: xedrd1v
kind: story
size: 2
status: open
scope: ["we:daemon-overlay.test.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# [RETRACTED premise] refresher false conflicts — actually

MED priority hint. - (2026-11-01 11:34 ET, CORRECTED 12:44) [RETRACTED premise] refresher false conflicts — actually: 1101a/1101b-m1 failed at step "tests" (we:daemon-overlay.test.mjs asserts empty stderr; Node DEP0040 punycode warning leaks; fixed by #6175). proto-daemon-resources is a GENUINE 40-file conflict. Remaining product gap: the alert should name the failing step in plain words (tests vs merge). A manual `git merge origin/main` into the same tops (review/health-watch 1101a) was clean. Fix: reproduce the refresher merge (checkout state, base, merge strategy, dirty tree) and make it match a plain merge; emit a conflict only when a clean worktree merge really conflicts, with the file list.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

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
