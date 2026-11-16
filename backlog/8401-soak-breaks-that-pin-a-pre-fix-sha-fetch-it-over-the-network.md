---
bornAs: xmioa4i
kind: story
size: 2
status: active
scaffoldedBy: "cards-batch-21"
dateScaffolded: "2026-11-16"
scope: ["we:scripts/conveyor/soak/"]
dateOpened: "2026-11-16"
tags: []
---

# Soak breaks that pin a pre-fix sha fetch it over the network at test time

Soak breaks that pin a pre-fix sha fetch it over the network at test time (git archive <sha>). One network blip turned main red (2026-11-16 01:30Z); quarantined 24h (R157). Retry the fetch, or bundle pinned shas into the runner cache.

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
