---
bornAs: xt0drs2
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/sim/world-env.mjs", "we:scripts/operations/file-item-io.mjs", "we:scripts/operations/__tests__/file-item-io.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — A dead-export check (an unused-export lint) over scripts/conveyor/__tests__/sim/ would flag a hel… (from web-everything/web-everything#5242 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/sim/world-env.mjs:4` — A dead-export check (an unused-export lint) over scripts/conveyor/__tests__/sim/ would flag a helper that only its own test imports.
2. `we:scripts/operations/file-item-io.mjs:39` — A check:standards rule that flags a hard-coded IANA zone outside we:local-date.mjs, plus a test that an ordinary file-item run still uses localToday.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5242@d804ef21283d80d698ad2dc420349b35167eddb8

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
