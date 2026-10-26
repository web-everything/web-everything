---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/lib/daemon-rebuild/candidate.mjs", "we:scripts/__tests__/lane-pool.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/candidate.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Apply the env default only at the top-level call site, COMMANDS[cmd](resolveRepo(envDefaultedFlag… (from web-everything/web-everything#5947 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:355` — Apply the env default only at the top-level call site, `COMMANDS[cmd](resolveRepo(envDefaultedFlags))`, and add a test that `release --all-pools` or `--pool=other` with the env set still resolves the sibling pool's own origin.
2. `we:scripts/lane-pool.mjs:404` — Add a test to we:lane-pool-canonical-origin-env.test.mjs: a standalone clone under the fake pool named `x.candidate-1`, with WE_SMOKE_LIVE_CLONE set to itself, must produce the explicit-origin refusal. More generally, require each conjunct of a trust predicate to have a refusal test.
3. `we:scripts/lane-pool.mjs:403` — Add the named negative fixture and a deterministic mutation check that removes the linked-worktree inequality and requires that test to fail.
4. `we:scripts/lib/daemon-rebuild/candidate.mjs:151` — Add a deterministic candidateSmokeEnv regression test asserting that a relative configured origin becomes an absolute path rooted at the live clone.
5. `we:scripts/lane-pool.mjs:405` — Add a deterministic CLI refusal test using a standalone candidate-shaped repository inside the pool with its own path as WE_SMOKE_LIVE_CLONE.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5947@d98c5c947b58abfa7cd2ce879c0cb705af614c1f

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
