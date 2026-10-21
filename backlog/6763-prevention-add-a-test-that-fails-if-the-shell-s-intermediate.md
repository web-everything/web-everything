---
bornAs: xpr309s
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/merge-queue-adaptive-batching.mjs", "we:scripts/lib/__tests__/merge-queue-adaptive-batching.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a test that fails if the shell's intermediateRunsToCancel call is wired to a parameter name t… (from web-everything/web-everything#5217 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/merge-queue-adaptive-batching.mjs:368` — Add a test that fails if the shell's `intermediateRunsToCancel` call is wired to a parameter name the function ignores. `intermediateRunsToCancel` could also throw on unknown keys. A review lens for description-versus-code drift would also catch the prose half.
2. `we:scripts/lib/merge-queue-adaptive-batching.mjs:251` — Scope the dequeue effect to an explicit pendingDequeues list that is cleared on acknowledgement, or only re-derive for PRs whose recovery was never acknowledged. Add a test: PR in a failed group's recoveryRetired, re-added to the queue with no gate call, must not be dequeued. A lens note 'automated destructive mutations must be scoped to resources this process created' would also help.
3. `we:scripts/lib/merge-queue-adaptive-batching.mjs:280` — Pass timeout to execFileSync in ioOptions (e.g. 30s) so lock hold time is bounded. Optionally move GitHub IO outside the transaction, or fail open on ELOCKTIMEOUT in gate. Add a lint or standards rule that execFileSync calls to gh must set a timeout.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5217@cd633d5b9654ac5dec0b0efd6822c1659a4d2a29

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
