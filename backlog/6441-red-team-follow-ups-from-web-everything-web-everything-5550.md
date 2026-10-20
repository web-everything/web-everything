---
bornAs: xeqn1a2
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-label-mirror.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5550 (head a3fcf68c5)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5550 (reviewed head `a3fcf68c53004d21b9c514a25030ea6b32d87007`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-label-mirror.mjs:267` — (failing-input, degraded) A valid comment-only referral loses its existing advisory label.
   - Scenario: An open PR has review:human and advisory:ruling-needed, a trusted current-head attempted referral still awaiting a ruling, readable facts, and an empty readable ledger. This can occur for older PRs or a missed referral append. A probe using the real derivation and fixture showed runMirrorApply removing advisory:ruling-needed with failures=[], while the thread-based planner still returned add afterward. Preserve the signal until comment-only referrals have been imported or reconcile through a migration fallback.
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/pr-label-mirror.mjs:198` — (edge-case, degraded) The replacement writer cannot create a missing repository label.
   - Scenario: A repository lacks advisory:ruling-needed and receives its first unruled referral. The old sweep ensured the label existed before adding it; the replacement issues only gh pr edit --add-label. GitHub rejects an unknown label, so every retry fails and the advisory never appears. An adapter probe confirmed that no label-create command precedes the edit. Restore ensureLabel before adding this family.
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
