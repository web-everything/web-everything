---
bornAs: x48hcbk
kind: story
size: 3
status: open
dateOpened: "2026-11-13"
tags: []
---

# Overlay graduation: diagnostic failure events ignored up to readyAt may hide an unresolved main-red

Residual accepted under R903+R907 for lane/fix-daemon-dispatch-6745 d6ce8fc6fe: overlayGraduated ignores overlay-main-red/merge-conflict/needs-you events dated at or before the ready candidate's readyAt, because the ready smoke ran after them. Auditor: smoke can reuse prior results (we:scripts/lib/daemon-rebuild/smoke.mjs:465-482) and passedAt is recorded after, so the timestamp proves neither resolution nor re-execution. Reinforce: ignore only a diagnostic whose failing check the smoke re-ran green.

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
