---
bornAs: xk420sz
kind: story
size: 2
status: active
scaffoldedBy: "fix-5366"
dateScaffolded: "2026-10-15"
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/prepare-pr-match.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prepare launch guard: failure-record timestamps can override the real dispatch time and bypass the merged-PR guard

Card suggestion from PR #5366 round-4 review (codex-correctness, advisory): in we:skills-src/conveyor/build-dispatch-daemon.mjs (~line 1193) lastDispatchAt takes the newest of ledger failure recordedAt, claim claimedAt, settled startedAt and live row startedAt. A failure recorded after a merged prepare PR was created moves lastDispatchAt past the PR createdAt, so preparePrGuard no longer counts the merged PR and the merged-PR guard is bypassed. Use dispatch times (claims/run starts) only, or the attempt start of the failure, not its recordedAt.

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
