---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/lib/fix-slot-borrow.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, live-reproduced] from web-everything/web-everything#7384 (head 82eb671e1)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7384 (reviewed head `82eb671e10dc2d86d33915eaf8480c6b008b5828`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1324` — (failing-input, degraded) The live daemon bypasses the new criticalGlobs setting
   - Scenario: Set fixExecutor.criticalGlobs to ['src/payments/**'] and dispatch scope ['we:src/payments/transfer.ts']. The daemon supplies its own criticalFor callback at we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1316, bypassing this new default. Its legacy verdict returns false, so the decision records requiresReview=false despite matching the configured critical scope. The live route should honor criticalGlobs.
   - Class: correctness-in-normal-use (basis: A read-only Node probe resolved the configured globs and executed the daemon's exact critical-work predicate through chooseFixExecutor; the resulting requiresReview was false. Full daemon execution was unavailable because gray-matter is missing.)
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/fix-slot-borrow.mjs:123` — (failing-input, degraded) Wrapped CI-heal ignores the selected executor and model
   - Scenario: Configure CI-heal executionModeByRole as wrapped, with two unproductive runs selecting codex-alt. This condition sends execution through the existing sink without forwarding the selected Codex route or adding supervision instructions. The unchanged repair prompt reaches the old provider, while claim metadata records Codex and gpt-6-astra. Wrapped CI-heal should instruct its supervisor to invoke the selected executor and model, as dispatchFix does.
   - Class: live-reproduced (basis: A read-only Node probe executed the actual chooseFixExecutor and createRoutedCiHealDispatch functions with an inert sink. It observed no provider override, an unchanged prompt, no Codex launch, and claim metadata naming codex-alt.)
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
