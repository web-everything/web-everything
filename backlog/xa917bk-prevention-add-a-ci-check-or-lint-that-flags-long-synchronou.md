---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/__tests__/forge-key-structure-tracked.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a CI check or lint that flags long synchronous CPU loops in vitest files without a yield or a… (from web-everything/web-everything#7348 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/__tests__/forge-key-structure-tracked.test.mjs:11` — Add a CI check or lint that flags long synchronous CPU loops in vitest files without a yield or an explicit per-file duration budget. Alternatively, add a shard-duration budget report that names the slowest files.
2. `we:scripts/readiness/__tests__/forge-key-structure-tracked.test.mjs:10` — Add a deterministic acceptance-mapping gate requiring each behavioral guarantee to identify a named test and its observable assertion; this guard needs a future backlog item.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7348@8fabb72f2312e362dccb1f8a21382ff692c1d844

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
