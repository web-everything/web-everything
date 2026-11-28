---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/wrong-branch-heal.mjs", "we:scripts/lib/daemon-rebuild/__tests__/wrong-branch-heal.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — A characterisation test asserting the stash create argv or message for the allowlisted-branch hea… (from web-everything/web-everything#7620 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/wrong-branch-heal.mjs:135` — A characterisation test asserting the `stash create` argv or message for the allowlisted-branch heal path, so unrelated audit metadata can't change silently.
2. `we:scripts/lib/daemon-rebuild/wrong-branch-heal.mjs:20` — In the heal fixture, wrap the injected `git` so any `fetch`, `ls-remote` or `push` call fails the test. In prepare tests, have the `holdsCloneWriteLock` mock return false and assert the healer is not invoked.
3. `we:scripts/lib/daemon-rebuild/wrong-branch-heal.mjs:20` — Add a named test, 'detached healing never fetches', in we:scripts/lib/__tests__/daemon-rebuild-wrong-branch-heal.test.mjs that asserts the recorded helper commands contain no fetch on successful and refused healing paths.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7620@4956daab1c67aec43909d40b5e9cbbf55c6fd3ce

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
