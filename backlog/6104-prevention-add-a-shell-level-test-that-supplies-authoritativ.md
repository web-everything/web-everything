---
bornAs: xhpgurh
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/merge-queue-adaptive-batching.mjs", "we:scripts/lib/__tests__/merge-queue-adaptive-batching.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a shell-level test that supplies authoritative native membership and tip and asserts a cancel… (from web-everything/web-everything#5217 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/merge-queue-adaptive-batching.mjs:330` — Add a shell-level test that supplies authoritative native membership and tip and asserts a cancel POST under HEADGREEN. Alternatively, mark the cancel path explicitly inert in the PR text and settings comment, and gate the replay's HEADGREEN column on it. File a backlog item for a deterministic check that every named argument passed to an exported pure function is one it reads.
2. `we:scripts/lib/merge-queue-adaptive-batching.mjs:340` — Add a bounded-defer rule: after N consecutive lock-timeout defers for the same PR, or a lock older than a cap, fail open and log. Add a test with a never-released lock.
3. `we:scripts/lib/merge-queue-adaptive-batching.mjs:230` — Before counting a failure, check the queue entry or PR timeline for a removal reason, or the head SHA change. Add a test for a push-ejected PR that must not dequeue its peers.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5217@8e9aeec02b5098f4ede849946f69543bb81bf89e

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
