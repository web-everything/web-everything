---
bornAs: xbamp05
kind: story
size: 5
parent: "6469"
status: open
scope: ["we:scripts/backlog.mjs", "we:scripts/conveyor/", "we:scripts/settings/"]
dateOpened: "2026-10-19"
tags: []
---

# Every card carries a delivery mode, proposed per card before build

Every card carries a deliveryMode frontmatter field (debug | prototype | edge | shadow | ab | pr). It is required before a card can be dispatched for build; the conveyor holds the card as mode-missing otherwise. At prepare or dispatch time the orchestrator proposes a mode with a one-line reason, and the operator can override it. Each mode maps to a preset of settings: testing depth, audit scope, load path, rollback, and TTL. The guard floor is identical in every mode and is not overridable. The choice, the reason and any override are recorded, so landing speed and breakage can be compared per mode later. Source: the presets discussion (2026-10-19). Evidence 2026-10-19: about 25 debug-mode hotfixes landed live in one day, while batch-4 prototype rounds took hours. Scope: we:scripts/backlog.mjs, we:scripts/conveyor/, we:scripts/settings/. Parent: delivery-modes epic #6469.

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
