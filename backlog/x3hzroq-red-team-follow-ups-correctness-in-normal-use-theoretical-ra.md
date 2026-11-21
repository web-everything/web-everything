---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, theoretical-race] from web-everything/web-everything#7220 (head 86d0c3739)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7220 (reviewed head `86d0c3739e66371b67f6eba90a71b0c08952bc24`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:2875` — (edge-case, degraded) Shared scan-cache candidates bypass the new eligibility check and still block growth
   - Scenario: Warm the shared cache using list --acquirable while lane-1 is clean and unleased, then create an unpushed commit there. Within the default 8000ms contention-grace window, run acquire --no-free-list --wait-ms=0 --hard-max=2 --growth-max-new=1 against a reachable origin. readListCache returns lane-1 despite its changed fingerprint. Because usingFreeList and retryingCandidates are both false, the new eligibility check is skipped. Acquire claims and fetches lane-1, then the reset guard refuses its unpushed commit. This sets sawProvisionFailure, suppresses growth, and fails acquire. It should skip
   - Class: correctness-in-normal-use (basis: Executed the production cmdAcquire, readListCache, cached-list wrappers, and provisionClaimedLane in a read-only VM with private I/O representing this sequence. Observed one claim, one fetch, zero eligibility checks, zero growth calls, and the final claimed-but-failed-to-provision error. No concurrent timing race is required; sequential operations inside the configured cache-grace window suffice.)
   - Also class: theoretical-race
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
