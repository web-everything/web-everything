---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/plan.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, attacker-same-user] from web-everything/web-everything#7368 (head 3854e5d4e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7368 (reviewed head `3854e5d4e898a51d6cb3b729733d48788af8be72`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/plan.mjs:711` — (failing-input, degraded) Prototype property names are mistaken for recorded omissions
   - Scenario: In audited mode with known-empty omission history, register a new, conflict-free branch named constructor or __proto__ without an audit record. setAside?.[ref] resolves an inherited Object.prototype property, so the planner incorrectly skips the overlay as unaudited-tip-held on every tick. These valid branches should receive the same first-adoption treatment as other new registrations. Omission membership must check own properties.
   - Class: correctness-in-normal-use (basis: A read-only production-planner probe with identical synthetic Git responses applied lane/new but skipped constructor and __proto__. Git check-ref-format accepted both names, and the repository branch validator also permits them.)
   - Also class: attacker-same-user
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
