---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/daemon-rebuild/audited-tip.mjs"]
dateOpened: "2026-11-12"
tags: []
---

# Reinforce the audited-tip overlay gate: close the cases where it does not apply

we:scripts/lib/daemon-rebuild/plan.mjs and we:scripts/lib/daemon-rebuild/audited-tip.mjs (lane/overlay-pin-audited-sha 786f62037e) gate overlay tips on a fix-ready + audit record, but R895+R903 accepted these residuals: (1) a graduated adopted head leaves adoptedTips so a newer unaudited tip is not gated; (2) an unreadable history read finds no adopted head and skips the gate; (3) stacked or set-aside bases bypass the gate; (4) fingerprint-carry evidence is not honoured, so a legitimate rebase waits for fresh evidence; (5) WEAKENED records are checked for R-number and findings but not against the ruledWeakened allowlist; (6) squash-equivalence retirement runs after the substitution. Close them.

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
