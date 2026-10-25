---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/red-team-withheld-publish.mjs", "we:scripts/conveyor/advisory-label-sweep.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5868 (head d81396f74)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5868 (reviewed head `d81396f747ff94444f68f3f13acdf3a64cb971aa`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/red-team-withheld-publish.mjs:81` — (failing-input, degraded) Recovery promotes confirmed degraded findings into blocking breaks
   - Scenario: Store summarizeRedTeam(r) for a finished result with comment='error' and one confirmed finding whose original impactIfUnfixed='degraded'. That compact representation omits impactIfUnfixed. Recovery restores the confirmation flag but renders impact?, which the gate classifies as broken. A probe using the real summarizer, publisher, renderer, parser and action planner changed the action from {sendBack:0,card:1} to {sendBack:1,card:0}. Recovery should retrieve/preserve the recorded impact so publication does not turn a follow-up card into a fixer bounce.
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/advisory-label-sweep.mjs:173` — (edge-case, degraded) One failed label write permanently strands recovery for an unlabeled PR
   - Scenario: Start with an open PR carrying no red-team label and a finished unpublished result. Let recovery post successfully and persist comment='posted', then make provider.setLabels throw once before applying the label. Subsequent sweeps exclude the PR: it has neither a red-team label nor an unpublished status. A three-sweep probe produced one label-write attempt, followed by two empty results; the label remained absent despite the provider recovering. Keep the PR eligible for reconciliation until its label write succeeds, independently of whether its comment has been published.
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
