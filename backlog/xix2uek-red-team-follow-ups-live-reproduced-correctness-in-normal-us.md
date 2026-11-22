---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/resource-pool-io.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7181 (head d84eedab4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7181 (reviewed head `d84eedab4bd1df0126d36a813dbdd2009251c63e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/resource-pool-io.mjs:186` — (failing-input, degraded) Frontier UI review companion files invalidate the entire inventory
   - Scenario: A normal Frontier UI review writes we:review-fui-49.loop.json containing its loop payload without a PID. The companion-file exclusion only matches review-&lt;digits&gt; filenames, so this file produces 'invalid review claim'. The reviews source becomes unknown, which makes every pool decision unknown. Companion files for all supported repository slugs should be excluded while validating actual claim records.
   - Class: live-reproduced (basis: Executed the unmodified adapter in a Node VM with an in-memory filesystem fixture and observed the source become unknown. The canonical slug function returns review-fui-49, and we:review-job.mjs writes the corresponding loop companion.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/resource-pool-io.mjs:297` — (failing-input, degraded) Committed legacy policies produce unknown comparison rows
   - Scenario: With committed settings and otherwise complete source evidence, blocker, redTeam and build rows all report legacyDecision='unknown'. The blocker lookup returns the boolean pastFixCap; redTeam reads redTeamQueue.minConcurrent although the setting is redTeam.queue.minConcurrent; build reads a nonexistent top-level maxConcurrentBuilds instead of the build dispatch policy. These known policies should be resolved through their canonical readers so the shadow ledger can compare actual legacy decisions.
   - Class: live-reproduced (basis: Read the committed settings with the real settings reader, then executed the collector in a Node VM with complete injected source evidence. All three rows were unknown despite report.unknown being false.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
3. `we:scripts/lib/resource-pool-io.mjs:324` — (edge-case, degraded) Overlapping review observations falsely fill the legacy cap
   - Scenario: Run four review jobs with the normal eight-round cap. Each job appears in both the review claim source and the deduplicated live-round process source. The collector counts eight review holders and emits legacyDecision='hold', although the canonical live-round budget has live=4, max=8 and left=4. Conservative overlap counting may serve the pool estimate, but the legacy comparison must use the legacy gate's own population.
   - Class: live-reproduced (basis: Executed the unmodified collector with four review claims and their four corresponding process observations. Its review row reported 'observed 8, legacy cap 8' and hold; the canonical process-budget implementation counts each job once.)
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
