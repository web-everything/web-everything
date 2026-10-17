---
kind: story
size: 5
parent: "xrlwbd7"
status: open
blockedBy: ["xdstsoh"]
dateOpened: "2026-10-17"
tags: []
---

# we: review stringency slice 2 — settings table used by the ruling step

Add the review-stringency settings table (class by level to block, expedite, debt or advisory), every cell a cascade setting with its source logged, and make the ruling step read it. Fail closed on gaps. Current level internal delivery.

## Acceptance

- [A1] **Executable** — a validator over `we:scripts/settings/review-stringency.json` fails on an unknown class, a missing level cell, or a debt cell without a must-pay-before level, passes on the ratified amended table, and a ruling-step test shows a table gap resolves to block.
- [A2] **Executable** — ruling-step test `override-precedence` supplies a reviewer tag that conflicts with a matching path rule, then with a matching pattern rule; each rule wins and the outcome comes from the overridden class at the current level. With no matching rule, the reviewer tag supplies the class.
- [A3] **Executable** — ruling-step test `confidence-cap` covers each non-always-block outcome (block, expedite, debt, advisory): low reviewer confidence yields advisory. An always-block class at low confidence triggers a second check and stays block pending it, including when a path or pattern override selects that class; an unknown class or table gap still blocks.
- [A4] **Executable** — settings-write test `settings-edit-authority` rejects agent attempts to change any table cell, an invariant row, or the current level, leaving the effective settings unchanged; the corresponding operator edits succeed and log the setting source and operator identity.
- [A5] **Executable** — ruling-step test `careless-debt-block` rejects reckless or inadvertent debt as block regardless of the configured cell or low reviewer confidence; prudent-deliberate debt follows the class/level outcome and confidence rules.

Ruling and amended table: [we:backlog/xugqjw1](/backlog/xugqjw1-decision-review-stringency-classified-findings-per-level-out/) and the statute `we:docs/agent/platform-decisions.md#review-stringency-classified-outcomes`.

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
