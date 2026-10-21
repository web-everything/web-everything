---
bornAs: xp9n2u7
kind: story
size: 2
status: open
scope: ["we:scripts/lib/merge-queue-enqueue.mjs", "we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5480 (head 621ad0f6e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5480 (reviewed head `621ad0f6eed1a9721d3e1b3f0d470de3cd958555`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/merge-queue-enqueue.mjs:281` — (security, degraded) A moving merge base invalidates the cached workflow-file surface
   - Scenario: Let B contain workflow W0, ancestor commit A change it to W1, and PR head H revert it to W0 while changing README. With main at B, preparation caches only README. Before cache expiry, main merges A without changing H, the PR body, labels, or base branch name. The merge base becomes A, so the PR now changes the workflow back to W0. Cached enqueue still reuses ['we:README.md']. An injected-exec probe returned workflow-edit/humanOnly with zero mutations through the ordinary path, but ok=true and one enqueue mutation with the prepared surface. Bind preparation to the base/merge-base commit and invali
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/enqueue-on-event.mjs:623` — (edge-case, degraded) An early successful check can consume and lose the final green wake
   - Scenario: For an eligible cached PR, an optional check succeeds while required test is pending. The new staged wake bypass starts a child immediately, which reads pending CI and declines enqueue. If test succeeds after that read but before the child exits, notePoll discards its success event because activeNums contains the PR (line 769). After the child exits, nothing remains to retry. A controlled-child probe reproduced one child start, zero enqueues, pending=[], and an empty subsequent tick despite green test. Retain events arriving during active drains and replay them afterward; otherwise enqueue wai
   - Claude's re-check: demonstrated break

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
