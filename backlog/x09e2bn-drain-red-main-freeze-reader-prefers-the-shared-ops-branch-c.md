---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/readiness/red-main-remediation.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# drain: red-main freeze reader prefers the shared ops branch copy

Follow-up to xyd06qo. The freeze is now published to the shared ops/red-main-freeze branch (mergeDelivery.redMainFreezeBranch) by we:scripts/readiness/red-main-remediation.mjs freeze/unfreeze, and CI's merge-gate reads it; the drain's own reader (isDispatchFrozen/readFreeze in we:scripts/merge-ai-prs.mjs) still reads only the local marker. Make the drain prefer the shared copy (readSharedFreeze in we:scripts/lib/red-main-freeze-shared.mjs), falling back to the local marker, and treat frozen-in-either as frozen (never fail open). Blocked on PR #4624 (card xx7ckd6), which holds both files and moves the local marker to the coordination root. (No `blockedBy:` edge yet: card xx7ckd6 exists only on #4624's branch, and an edge to a card not on main fails the gate — add `blockedBy: ["xx7ckd6"]` once #4624 lands, or simply start after it.)

Also owed here (from the PR #4715 review, the residual of the "stale clear after a failed publish" finding): per the operator ruling of 2026-10-11, CI's merge-gate now reads main's OWN CI status from GitHub (`readMainCiFact` in we:scripts/merge-gate-check.mjs; unreadable ⇒ hold), so a red main can never hide behind a failing publisher, and the shared copy carries MANUAL freezes only. `freeze` writes the local marker first and then publishes (retried with a fresh fetch, every git call timed); a clear refuses to wipe a different freeze it finds on the tip. The residual is a MANUAL freeze whose every publish attempt fails (origin unreachable, a push policy that refuses each time): the shared copy stays at its previous (clear) state while the local marker is frozen, and CI has no way to see the local marker. Close that window on the drain side: when the drain finds a local freeze marker whose state the shared copy does not carry (shared clear or unreadable), it must say so loudly and retry the publish (or refuse to land) rather than assume CI is holding.

Also owed here (PR #4715 round-3 self-review, the same auto/manual class one file over): the drain's own red-main hold in we:scripts/merge-ai-prs.mjs passes ANY local marker to `redMainSignal` as `manualFreeze`, ignoring `kind`. So a local AUTOMATIC freeze (`decide --apply`, or a kind-less legacy marker whose reason is `decide --apply`) still holds the main-fix PR in the drain, which CI's merge-gate no longer does. Classify the local marker with `freezeKindOf` (we:scripts/lib/red-main-freeze-shared.mjs), the same rule the CLI and the writer use, and let only a MANUAL marker hold the main-fix PR.

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
