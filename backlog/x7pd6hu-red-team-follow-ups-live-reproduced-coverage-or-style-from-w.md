---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/adopt.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7171 (head 477cda07f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7171 (reviewed head `477cda07f0053607ceeff231521acb582cffda87`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/adopt.mjs:230` — (edge-case, degraded) Historical in-main removals cannot pass the new tip check
   - Scenario: A candidate passes smoke carrying lane/a at tip A, but adoption waits. An earlier rebuild tick has removed lane/a as in-main. we:prepare.mjs emits that auto-dropped event without a tip: it populates removal proof only for pr-merged. On the next tick, lane/a is absent and plan.decisions contains no removal. Even with a valid earlier added event and inMain(A) returning true, classification returns unknown and matching rejects the candidate as overlay-no-longer-wanted. Recording tip A on the removal event makes the same input adopt successfully. The in-main writer must persist the exact tip so benig
   - Class: live-reproduced (basis: A read-only probe executed the production classifier and matcher with other gates passing. The event shape emitted by we:prepare.mjs produced unknown and rejection; adding only the missing tip produced adoption. This was an isolated function probe, not a full daemon run.)
   - Also class: coverage-or-style
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
