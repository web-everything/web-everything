---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7381 (head 7731a96e5)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7381 (reviewed head `7731a96e5ee82b51a2b329cbfb8fdc81aee87397`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:752` — (edge-case, degraded) The timing allowlist drops existing fast-drain listing phases
   - Scenario: A child emits 'merge-ai-prs · pass timings: gate.defaultBranch=200ms listing.target=2500ms listing.snapshot=300ms listing.pages=1000ms total=4000ms'. The new extractor publishes only 'gate.defaultBranch=200 total=4000', hiding all listing costs. These are real phase names emitted by we:merge-ai-prs.mjs at lines 6038, 6047 and 6070. PASS_STEP_ORDER defines display order rather than an exhaustive phase vocabulary. The safe allowlist should include these existing phases so catch-up diagnostics retain their timing breakdown.
   - Class: live-reproduced (basis: Executed the current formatTimingsSummary and extractPassTimings implementation with the production phase names and observed the listing tokens disappear.)
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
