---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/plan.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7368 (head 5008972e9)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7368 (reviewed head `5008972e9a58f98fbe09752d969fba9a2acef6cd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/smoke.mjs:683` — (edge-case, degraded) Inline fallback loses the original plan’s permitted mechanism skip
   - Scenario: Run an inline rebuild with asJob:false, a newcomer mechanism overlay legitimately marked pinned-overlay-conflict-skipped, and an applied non-pinned overlay. When candidate smoke fails but plain-main fallback passes completely, adoptionDecisions discards the mechanism-skip decision. finalizeRebuild receives the reduced plan without pinPlan, rejects the omitted mechanism overlay, and leaves HEAD and registrations unchanged. It should adopt the passing fallback and remove the failing overlay immediately; recovery currently requires a later ready-adoption pass.
   - Class: correctness-in-normal-use (basis: Reproduced using production planner and finalizer code with synthetic Git and in-memory I/O. The fallback was refused with established-overlay-conflict; supplying the original plan as pinPlan made the same candidate adopt successfully.)
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/daemon-rebuild/plan.mjs:711` — (failing-input, degraded) Inherited object properties incorrectly mark valid branch names as previously omitted
   - Scenario: With known-empty omission history, register a clean new overlay named constructor or toString in audited mode without an audit record. setAside is an ordinary empty object, so setAside?.[ref] resolves an inherited Object.prototype property. The planner incorrectly skips the overlay as unaudited-tip-held, potentially indefinitely. These branches should receive the same first-adoption treatment as other new overlays; omission checks must require an own property.
   - Class: correctness-in-normal-use (basis: Confirmed constructor is a valid Git branch name. An isolated production-planner probe applied lane/new but skipped constructor and toString with identical synthetic Git history, empty omission history, and audit results.)
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
