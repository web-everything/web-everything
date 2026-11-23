---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/advisory-merge.mjs", "we:scripts/lib/settings-registry.mjs", "we:scripts/lib/daemon-rebuild/__tests__/advisory-merge.test.mjs", "we:scripts/lib/__tests__/settings-registry.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a table-driven readMerge test over stage-presence combinations (base, ours, theirs) with the… (from web-everything/web-everything#7360 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/advisory-merge.mjs:160` — Add a table-driven readMerge test over stage-presence combinations (base, ours, theirs) with the expected result for each. A coverage gate on new branches in we:scripts/lib/daemon-rebuild/advisory-merge.mjs would catch this class.
2. `we:scripts/lib/settings-registry.mjs:221` — Optionally render once in a child process and compare it with the parent's render, or document the within-process limit next to the check. This is a low-value gate and can be filed as a card.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7360@b50ba37906dc482e2ffe705ce7198e81f25ea0b9

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
