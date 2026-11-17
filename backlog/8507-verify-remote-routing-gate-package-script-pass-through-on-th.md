---
bornAs: xoiqc10
kind: story
size: 3
status: active
scaffoldedBy: "fix-6769"
dateScaffolded: "2026-11-13"
scope: ["we:scripts/lib/verify-remote-routing.mjs", "we:scripts/verify-lane.mjs"]
dateOpened: "2026-11-13"
tags: []
related: ["6769"]
---

# verify remote routing: gate package-script pass-through on the target script being self-wrapped

phaseAdmissionPlan passes npm run test:unit|check:standards through as remote-eligible on the assumption the target's script wraps itself in heavy-admission. frontierui's scripts are unwrapped (vitest run / its own check-standards script), so a remote decision there runs the heavy phase with no local slot and no remote run. Gate the pass-through on the script actually being self-wrapped (or the wrapper file existing), and reuse one admission plan per phase in verify-lane so the decision probe and the run plan cannot disagree.

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

## Duplicate admission

same defect class (routing assumes WE's admission wrapper in the target checkout); PR 6769 fixed only the vitest rewrites
