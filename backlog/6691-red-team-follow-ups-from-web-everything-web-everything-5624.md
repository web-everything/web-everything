---
bornAs: x3nwbes
kind: story
size: 2
status: open
scope: ["we:scripts/lib/lane-transcript-backfill.mjs", "we:scripts/lane-pool.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5624 (head 0ebfc169a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5624 (reviewed head `0ebfc169af73682de649a6d805680c9d3b32b187`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/lane-transcript-backfill.mjs:29` — (failing-input, degraded) A truncated transcript record permanently caches empty attribution
   - Scenario: Run explicit backfill while the only matching Edit record is partially appended: it contains we:/pool/lane-1/a.md but lacks its closing JSON delimiters. The strict scanner silently drops the malformed matching line, and backfill permanently caches touches=[]. Completing the record and invoking backfill again still returns []; it never rescans. Reproduced with the actual scanner and backfill using in-memory filesystem stubs: scans=1, whereas a fresh scan of the completed record finds the owner. Incomplete matching records should refuse cache publication and permit retry.
   - Claude's re-check: demonstrated break
2. `we:scripts/lane-pool.mjs:4438` — (edge-case, degraded) Sibling clones lose automatic GC without receiving scheduled GC
   - Scenario: Provision or refresh a WE pool containing lane-1, frontierui and plateau-app, then run gc or gc --watch. ensureOneSibling sets gc.auto=0 on both sibling repositories, but cmdGc enumerates only lane-N directories. Executing the actual extracted functions confirmed both sibling configuration writes while GC targets contained only /pool/web-everything/lane-1. Repeated maintenance passes never collect the siblings. Scheduled maintenance should cover every clone whose automatic GC this change disables.
   - Claude's re-check: demonstrated break
3. `we:scripts/lane-pool.mjs:4439` — (edge-case, degraded) Overload-deferred GC exits successfully instead of returning 75
   - Scenario: Invoke noninteractive we:scripts/lane-pool.mjs gc with a due lane while load/core exceeds the threshold. scheduledLaneGc refuses all Git work, but cmdGc only logs the result and returns normally, leaving exit status 0. Reproduced using the actual admission/GC functions and extracted command wiring with filesystem writes stubbed in memory. A scheduler cannot distinguish this deferral from successful completion. The command should propagate the advertised temporary-deferral status 75.
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
