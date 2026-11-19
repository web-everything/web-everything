---
bornAs: x6ehv0b
kind: story
size: 2
status: open
scope: ["we:perf-2026-11-01/PLAN.md", "we:PLAN.md"]
dateOpened: "2026-11-02"
tags: []
---

# PERF PLAN R320 — 12 ranked fixes in we:perf-2026-11-01/PLAN.md (gh wrapper process chain

MED priority hint. - (2026-11-01 09:14 EST) PERF PLAN R320 — 12 ranked fixes in we:perf-2026-11-01/PLAN.md (gh wrapper process chain; missing commit bf857f4 / lane-whois; lane status sweep cache; fetch freshness + refspec; job store full read; drain label memo; build-dispatch bulk search; review extra-seat full checkouts (XProtect); smoke reuse; Forge bun-trial + remote-full; red-team-gate-apply dirty lanes; Sonnet worker types). File each as a card from we:PLAN.md.

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
