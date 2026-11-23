---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/plan.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7368 (head 25ca0771d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7368 (reviewed head `25ca0771d966f6098a2a38b9684ee6ae2f2f4830`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/plan.mjs:675` — (edge-case, degraded) Holding a containing top lets stack fallback reapply its unaudited base
   - Scenario: In default tops mode, repair a previously set-aside base without audit evidence and register a child containing it. The new guard skips the child, but leaves the base's stack-contained decision eligible for fallback. With no top applied, fallback applies the unaudited repaired base because holdUnauditedTip has no adopted merge parent for omitted content. Finalization then rejects the candidate as ready-audit-revoked. Repeated rebuilds cannot advance to newer main through this path until audit arrives. Both overlays should remain omitted while main and other eligible overlays can advance.
   - Class: correctness-in-normal-use (basis: The production planner probe returned applied-stack-fallback for the base and unaudited-tip-held for its child. Passing that applied set through the production revokedAppliedTips function returned lane/base, which triggers finalization's refusal. The fallback does not enforce the new durable omission audit check.)
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
