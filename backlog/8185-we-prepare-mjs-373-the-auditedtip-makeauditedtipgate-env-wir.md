---
bornAs: xcjh1fm
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/prepare.mjs"]
dateOpened: "2026-11-12"
tags: []
---

# we:prepare.mjs:373 The `auditedTip: makeAuditedTipGate(env)` wiring in we:prepare.mjs, we:preview.mjs (3 sites) and (web-everything#6732)

1. `we:scripts/lib/daemon-rebuild/prepare.mjs:373` — The `auditedTip: makeAuditedTipGate(env)` wiring in we:prepare.mjs, we:preview.mjs (3 sites) and we:smoke.mjs (2 fallback plans) has no test; the audited-tip tests call planRebuild directly with a hand-built gate.

Operator card follow-up for web-everything/web-everything#6732 (head 8e70d6ecb0a34e1865fba3bad26bc5b341293f08).

Not worse than main (R903): coverage-only gap: the wiring has no test on main either (the audited-tip tests call planRebuild with a hand-built gate); the PR adds the gate, so it is not worse than main

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
