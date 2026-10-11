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

Also owed here (from the PR #4715 review, the residual of the "stale clear after a failed publish" finding): `we:scripts/readiness/red-main-remediation.mjs freeze` now publishes the shared copy BEFORE it writes the local marker, so a local-write failure can no longer leave CI clear, and a REJECTED push (raced writer, refusing hook, blip) is retried with a fresh fetch until it lands (`PUBLISH_ATTEMPTS` in we:scripts/lib/red-main-freeze-shared.mjs, the local marker written after the first failed attempt), and a clear refuses to wipe a different freeze it finds on the tip. The residual is EVERY attempt failing, for any reason (origin unreachable, a push policy that refuses each time): the shared copy stays at its previous (clear) state while the local marker is frozen, and CI has no way to see the local marker. Close that window on the drain side: when the drain finds a local freeze marker whose state the shared copy does not carry (shared clear or unreadable), it must say so loudly and retry the publish (or refuse to land) rather than assume CI is holding.

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
