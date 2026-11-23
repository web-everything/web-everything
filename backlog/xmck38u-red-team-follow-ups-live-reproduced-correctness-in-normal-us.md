---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/resource-pool-io.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7353 (head d34cc966f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7353 (reviewed head `d34cc966ff59636638910057a38c2b65216742f7`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/resource-pool-io.mjs:204` — (edge-case, degraded) Unreadable lane leases become known-zero usage and permit shadow grants.
   - Scenario: Supply lane status containing path '/pool/lane-1', leased:false, lease:null and readError:'EACCES: unreadable lease', with other sources healthy. The collector ignores readError, reports unknown:false and C3=0, and grants all three hypothetical starts. It should mark worker evidence unknown and hold those starts.
   - Class: live-reproduced (basis: An in-memory probe executing the checked-out reader and collector bodies reproduced the zero digest and grants. laneStatus emits this shape when reading a lease fails. Dependencies were injected because full-module imports encountered missing packages.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/resource-pool-io.mjs:272` — (edge-case, degraded) Session deduplication collapses distinct leased workers.
   - Scenario: Supply two leased lanes, '/pool/lane-1' and '/pool/lane-2', each with session:'fix-42' and purpose:'conveyor-fix'. The worker reader observes both, but collection drops the second solely because jobId matches, reporting one holder and 2u instead of two holders and 4u. Distinct worker observations should remain counted, or ambiguous duplication should make evidence unknown; deduplication should reconcile overlapping sources.
   - Class: live-reproduced (basis: The in-memory source-body probe returned unknown:false and C3=2 for these two distinct lane records. The failure requires matching session names, without concurrency during collection or an attacker.)
   - Also class: correctness-in-normal-use
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
