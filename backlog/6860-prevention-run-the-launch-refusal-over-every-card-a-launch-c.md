---
bornAs: xuj4nnm
kind: story
size: 3
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/soak/breaks/prepare-guard-recovery-and-capacity.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/prepare-guard-recovery-and-capacity.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Run the launch refusal over every card a launch claims (lead and members) through one shared admi… (from web-everything/web-everything#5366 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#5366's review (reviewed head `a60d43447d35f4f95c342758ae17a58a37214cd4`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:1210` — Run the launch refusal over every card a launch claims (lead and members) through one shared admission helper. Add a daemon test where a not-yet-refused member has an open PR from listPreparePrs.
2. `we:skills-src/conveyor/build-dispatch-daemon.mjs:2018` — Add a reader test that models a realistic PR volume and asserts a bound on `gh` calls per tick. Not a script-decidable defect, so a review lens is enough.
3. `we:scripts/conveyor/soak/breaks/prepare-guard-recovery-and-capacity.mjs:18` — Extend soak breaks-shape validation to reject a non-hex fixedBy.sha and to check that each sha resolves in git.

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
