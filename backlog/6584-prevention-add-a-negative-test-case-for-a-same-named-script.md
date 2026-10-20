---
bornAs: x5i94cy
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Add a negative test case for a same-named script in a different directory, and compare the normal… (from web-everything/web-everything#5455 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/guard-bash.mjs:470` — Add a negative test case for a same-named script in a different directory, and compare the normalized path suffix instead of the basename. Review lens only; not script-decidable.
2. `we:scripts/guard-bash.mjs:4501` — Wrap the loader in its own try/catch that falls back to `{}` (orchestrator off). Add a hook-stdin test where the settings load throws and a known-denied command is still denied.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5455@c0203a4629cb35877b8088b34e65d1e744616fd9

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
