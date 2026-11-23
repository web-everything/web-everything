---
kind: story
size: 3
status: open
scope: ["we:backlog/xho1snv-2811-oracle-failing-check-first.md"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Represent split-card completion phases explicitly and add a deterministic gate rejecting green-pr… (from web-everything/web-everything#7390 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#7390's review (reviewed head `6d3899217beca620cdfcd95f66855a33742bbbd5`) to prevention-outstanding by naming a guard neither captured nor filed:
1. `we:backlog/xho1snv-2811-oracle-failing-check-first.md:20` — Represent split-card completion phases explicitly and add a deterministic gate rejecting green-proof completion requirements on red-only oracle prerequisites.
2. `we:backlog/xho1snv-2811-oracle-failing-check-first.md:18` — Gate prepared cards on acceptance-to-test mappings, including separate named checks for rendering behavior and backlog workflow guarantees.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #5473, finding 3 → #5473.

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
