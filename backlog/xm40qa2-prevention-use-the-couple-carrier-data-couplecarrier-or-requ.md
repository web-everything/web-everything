---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-skip-reasons.mjs", "we:scripts/lib/__tests__/drain-skip-reasons.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Use the couple carrier data (coupleCarrier) or require different repos and Number.isFinite(item).… (from web-everything/web-everything#4397 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-skip-reasons.mjs:86` — Use the couple carrier data (`coupleCarrier`) or require different repos and `Number.isFinite(item)`. Add a test for same-item, same-repo PRs.
2. `we:scripts/lib/__tests__/drain-skip-reasons.test.mjs:46` — Add a table-driven test mapping each representative reason to its exact expected kind, enforced by the normal test gate; include reason-based escalation separately from the escalated flag.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4397@8a554840648464b10e7db03feedd9c41e6da986d

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
