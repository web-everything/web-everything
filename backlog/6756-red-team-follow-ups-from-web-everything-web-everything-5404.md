---
bornAs: xoxjz0d
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-red-recovery-watch.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5404 (head 552d9d28f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5404 (reviewed head `552d9d28f2a535e23891f36ae694f7f53b19a2a0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/ci-red-recovery-watch.mjs:1006` — (edge-case, degraded) A successfully read empty policy becomes unknown and schedules unnecessary CI recovery
   - Scenario: With no cache, return HTTP 200 rules:[] and HTTP 200 branch data {protected:true,protection:{enabled:true,required_status_checks:null}} for a branch protected only by reviews. Both reads succeed and establish an empty classic set. However, the detailed reader throws noRequiredChecks, getRequiredStatusChecks substitutes declared policy without classic metadata, and this wrapper returns null. A Node probe confirmed that an empty-rollup PR then becomes a missing-run candidate; passing the correct [] produces no candidates. Once overdue, it can receive unnecessary CI-trigger commits. Preserve the
   - Claude's re-check: With rules and classic both read and both empty, the reader throws 'noRequiredChecks', which the diff says selects the declared policy. The wrapper then maps 'declared' to null, where the old direct read gave '[]' for 'required_status_checks: null'. Null sends the pass to the narrower name-free fallback, so an empty-rollup PR can become a candidate. The null mapping is deliberate per the card, but it is a real behaviour change for a repo with no required checks.

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
