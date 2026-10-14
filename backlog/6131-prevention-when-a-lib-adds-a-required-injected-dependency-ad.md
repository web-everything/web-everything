---
bornAs: x6d078f
kind: story
size: 3
status: open
scope: ["we:scripts/lib/human-clearance-carry.mjs", "we:scripts/lib/__tests__/human-clearance-carry.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — When a lib adds a required injected dependency, add a test that the real call site (gateDecision)… (from web-everything/web-everything#5233 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#5233's review (reviewed head `a501eb225447990e8da15322ebbec53e13e0ca92`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/lib/human-clearance-carry.mjs:338` — When a lib adds a required injected dependency, add a test that the real call site (gateDecision) supplies it. A check:standards rule that a new required option has at least one non-test caller passing it would also work.
2. `we:scripts/lib/human-clearance-carry.mjs:217` — Add a deterministic test that every `proveHumanClearanceCarry` caller either re-checks later holds or is documented as exempt. A cheaper option is a check:standards rule that fails when a new carry tier is added without a `merge-gate-ci` test with a later-objection fixture. Failing that, gate the numbering tier behind an explicit `requireNoLaterHold` argument that defaults to refusing.
3. `we:scripts/lib/human-clearance-carry.mjs:347` — Add a deterministic parameterized regression test asserting that dry-run and real-run eligibility agree for objections, head changes, and unreadable reviews, while dry-run performs no writes.

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
