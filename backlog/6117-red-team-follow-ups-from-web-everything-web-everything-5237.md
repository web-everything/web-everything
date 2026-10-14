---
bornAs: xg2fks3
kind: story
size: 2
status: open
scope: ["we:scripts/lib/review-clearance-guard.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5237 (head 12298206f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5237 (reviewed head `12298206f89447554273ed4d7d09ceb7387d4807`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/review-clearance-guard.mjs:314` — (edge-case, degraded) A failed stale-gate rerun request bypasses the no-failing-CI launch guard
   - Scenario: Use an accepted current head whose sole failing check is a stale merge-gate with a readable, head-bound verdict containing only a review-acceptance hold. Enable all settings and let every read succeed. Make POST actions/jobs/&lt;id&gt;/rerun throw HTTP 403. With a successful POST, beforeCiHeal returns launch:false and excludes merge-gate as review-hold. With the 403, it returns launch:true with 'guard error', because apply throws before failingCiChecks executes. ci-heal-pr-dispatch consequently permits an unnecessary repair launch despite having proven no CI break. A rerun write failure should be re
   - Claude's re-check: In apply, the rerun mutate(POST) is unguarded. A 403 throws out of apply into beforeCiHeal's catch, which returns launch:true ('guard error') before failingCiChecks runs. The fail-open is intentional for read and deferred-write errors, but here the no-CI-break proof is available. A failed rerun write still lets an unneeded heal launch.

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
