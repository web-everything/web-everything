---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/adopt.mjs", "we:scripts/lib/daemon-rebuild/__tests__/adopt.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a fallback-kind case to we:adopt-then-add.test.mjs (benign adopts with rebuildAfter, unsafe o… (from web-everything/web-everything#7171 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/adopt.mjs:106` — Add a fallback-kind case to we:adopt-then-add.test.mjs (benign adopts with rebuildAfter, unsafe or unknown discards). A coverage rule that every branch calling a shared helper has a fixture would catch this class.
2. `we:scripts/lib/daemon-rebuild/adopt.mjs:106` — Add a branch-coverage or mutation check on we:scripts/lib/daemon-rebuild/adopt.mjs that fails when a changed `matchReadyCandidate` branch has no test reaching it. Alternatively add one table-driven test that runs every `ready.kind` against every removalSafety outcome.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7171@ad36a450ce05f477c73d4da7081c8c8e6d332adc

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
