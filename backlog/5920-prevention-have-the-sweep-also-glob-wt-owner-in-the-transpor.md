---
bornAs: xn5to2l
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/git-transport-branch.mjs", "we:scripts/lib/__tests__/git-transport-branch.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Have the sweep also glob wt-*.owner in the transport root and delete the ones that are stale and… (from web-everything/web-everything#4966 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/git-transport-branch.mjs:268` — Have the sweep also glob `wt-*.owner` in the transport root and delete the ones that are stale and whose pid is dead and which have no registered worktree. Add a test for this case.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4966@031bf64301b863113c74e34fa43a456037401a34

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
