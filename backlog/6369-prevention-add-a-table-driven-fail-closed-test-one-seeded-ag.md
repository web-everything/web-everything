---
bornAs: x7mbffg
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-sweep.mjs", "we:scripts/conveyor/__tests__/pr-sweep.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a table-driven fail-closed test: one seeded aged episode, with each read (owners, queue, PRs,… (from web-everything/web-everything#5323 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pr-sweep.mjs:120` — Add a table-driven fail-closed test: one seeded aged episode, with each read (owners, queue, PRs, send) failed in turn. Assert that alerts are empty and that `episodes`/`needsYou` are preserved.
2. `we:scripts/conveyor/pr-sweep.mjs:96` — Filter daemon evidence to progress-type log lines and exclude refusals. Add a test with a refusal-only history and a stale head, expecting `state: 'none'` and an alert after the delay.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5323@18671c94a537bf79bfc7cae99eed116ff84b1b8b

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
