---
bornAs: xe4yop4
kind: story
size: 2
status: open
scope: ["we:scripts/lib/merge-queue-adaptive-batching.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5217 (head 8e9aeec02)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5217 (reviewed head `8e9aeec02b5098f4ede849946f69543bb81bf89e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/merge-queue-adaptive-batching.mjs:485` — (failing-input, degraded) Replay treats timed-out CI as a successful merge
   - Scenario: Confirmed by calling replayBatching with enabled:true, ciMinutes:1, and one run having headBranch='gh-readonly-queue/main/pr-1-abc', status='completed', conclusion='timed_out', createdAt='2026-10-12T00:00:00Z', updatedAt='2026-10-12T00:01:00Z'. The baseline reports zero merged PRs, but the projection reports one merged PR and zero failures. Only the literal conclusion 'failure' creates a failing arrival; a timed-out required check is simulated as passing. Model unsuccessful terminal conclusions as nonpassing rather than manufacturing successful merges and understating recovery costs.
   - Claude's re-check: The baseline counts only conclusion==='success' as merged, but the arrival builder treats only 'failure' as a culprit. A completed 'timed_out' run becomes a normal arrival that merges when its simulated job ends. The projection therefore reports 1 merged PR and 0 failures where the baseline reports 0 merged.

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
