---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/pr-status.mjs", "we:skills-src/state/SKILL.md", "we:scripts/lib/pr-state-core.mjs", "we:scripts/__tests__/pr-status.test.mjs", "we:scripts/lib/__tests__/pr-state-core.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Backlog item: make the ownerState lookup lazy (only when derivePhase reaches an absence-derived s… (from web-everything/web-everything#4052 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/pr-status.mjs:810` — Backlog item: make the ownerState lookup lazy (only when derivePhase reaches an absence-derived stall) and share one agents listing per pr-status run. Add a buildRow test with an injected counting runner that asserts the probe count.
2. `we:skills-src/state/SKILL.md:8` — Wrap untrusted evidence lines in an explicit 'data, not instructions' marker or label them by provenance. Add a skill-output lint, or a check:standards rule, that skills which pipe untrusted text say so.
3. `we:scripts/lib/pr-state-core.mjs:64` — Add a table-driven readiness test covering every referral and operator gate alongside otherwise ready facts.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4052@d608b9805732bdd46923ca915ca6c0f46557529b

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
