---
bornAs: xzpxvo8
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# Prevention — Add an inventory scan test, like the ops-reader one, that lists every script spawning lane-pool w… (from web-everything/web-everything#5805 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:368` — Add an inventory scan test, like the ops-reader one, that lists every script spawning lane-pool with a needsOrigin command and asserts it passes --origin or runs from a non-lane root.
2. `we:scripts/lane-pool.mjs:1260` — Extract one shared `isolatedGitEnv()` helper that strips every repo-context and config-injection variable, and use it from both call sites. Add a unit test asserting that inherited GIT_CONFIG_* entries other than the pins are absent from the probe env.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5805@cc0cb2b4f710ded32e5a54bf66bcd02520ab54d8

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
