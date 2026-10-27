---
bornAs: xk48erw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/candidate.mjs", "we:scripts/lane-pool.mjs", "we:scripts/lib/daemon-rebuild/__tests__/candidate.test.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Resolve a relative origin to an absolute path against root in candidateSmokeEnv, and add a test c… (from web-everything/web-everything#5941 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/candidate.mjs:148` — Resolve a relative origin to an absolute path against `root` in candidateSmokeEnv, and add a test case for a relative-path remote. Alternatively, a lint or test asserting that exported origins are absolute or URL-shaped.
2. `we:scripts/lane-pool.mjs:355` — Add a lane-pool test matrix that runs each command class (needsOrigin, gc, release with --pool) under the env. Alternatively, scope the env to `needsOrigin` commands only.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5941@3161dc0a49b64cb764bdf98b455d9941424a918f

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
