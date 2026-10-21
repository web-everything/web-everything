---
bornAs: xetrmif
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/__tests__/review-extra-seats.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — When the route is non-Claude and reads are on, fall back to a tool-free re-check and log a loud w… (from web-everything/web-everything#5452 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-extra-seats.mjs:1537` — When the route is non-Claude and reads are on, fall back to a tool-free re-check and log a loud warning. Alternatively, add a startup or check:standards assertion that the resolved `review-recheck` provider supports `allowedTools`.
2. `we:scripts/operations/review-extra-seats.mjs:1597` — Add a spawn-time confinement gate: refuse a tool-bearing juror unless the harness enforces a path allow-list or sandbox (for example a deny-rule for paths outside cwd) and pass a scrubbed env. Add a test that asserts the argv contains the path restriction. File this as a backlog item for filesystem read confinement.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5452@3bfab0b6836e6765cf3094e630150aa8b2d3bcbe

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
