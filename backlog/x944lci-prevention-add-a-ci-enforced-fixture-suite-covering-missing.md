---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci/test-timings.json"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a CI-enforced fixture suite covering missing shards, the 90% boundary, stale-file removal, an… (from web-everything/web-everything#7404 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci/test-timings.json` — Add a CI-enforced fixture suite covering missing shards, the 90% boundary, stale-file removal, and exact preservation of the soak map, and reference its named cases in refresh validation evidence.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7404@07ff4fdfe1b0a104a9055bf36b91dc2161a80d07

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
