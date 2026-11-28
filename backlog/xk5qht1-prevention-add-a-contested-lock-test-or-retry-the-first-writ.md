---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/rebuild.mjs", "we:scripts/lib/daemon-last-good.mjs", "we:scripts/lib/daemon-rebuild/__tests__/rebuild.test.mjs", "we:scripts/lib/__tests__/daemon-last-good.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a contested-lock test, or retry the first write on a short timer outside the write lock, sinc… (from web-everything/web-everything#7624 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/rebuild.mjs:504` — Add a contested-lock test, or retry the first write on a short timer outside the write lock, since the token comparison is cheap. A lint cannot catch this class, so a review-lens note on 'zero-wait lock on a hot path' is the cheapest guard.
2. `we:scripts/lib/daemon-last-good.mjs:66` — Add one env-raised boundary test for `heartbeatOwnerAlive`.
3. `we:scripts/lib/daemon-last-good.mjs:267` — Add a table-driven direct unit test for heartbeatOwnerAlive over foreign host, adoptOnly, jobMode false/undefined, pid 0/negative/string and an env-set window override. Longer term, a check:standards rule requiring each exported guard function to be called directly in a test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7624@dc34d5ad16e5b98ef5af65a45530a55d837914d5

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
