---
kind: story
size: 5
status: open
dateOpened: "2026-11-13"
tags: []
---

# Split lane acquireMs into claim vs provision, then cut provision time under load

After the scan-lock hand-off fix, review jobs no longer defer for no lane, but acquireMs is 13.8-108s under load 32-38. Split acquireMs into claim time and provision time (fetch/reset/deps) in the job log, then cut provision under load, e.g. pre-provision free lanes off the critical path. Acceptance: a review job logs acquireMs under 10s under normal load.

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

x2zwve7 was the reset fail-open (fixed here); this is acquire latency: claim time vs fetch/reset/deps provision, live 2026-11-13 post-adoption acquireMs 13.8-108s at load 32-38
