---
bornAs: xdq6hx5
kind: story
size: 5
parent: "3383"
status: closed
closedReason: duplicate
closedInto: "6202"
dateClosed: "2026-11-22"
scope: ["we:scripts/operations/wip-report.mjs", "we:scripts/operations/wip-report-io.mjs", "we:scripts/operations/__tests__/wip-report.test.mjs"]
dateOpened: "2026-09-20"
tags: []
---

# wip report: compact phone-first tables, and Attention findings become queued items

Operator (2026-09-20): /wip is read on a phone most of the time and the Attention section is an internal signal that should queue itself for resolution. (1) Work items and Done-since become compact tables: at most 3 short columns, about 35 characters a row, titles cut to about 18 characters, a short note under the table only when a row needs detail; the header and Needs you stay plain lines. (2) Every Attention finding becomes a queued item automatically. A finding with a live handler and a live runner is not shown in Attention and appears under Work items as queued. A finding with no handler is filed once as a backlog item (dedup by rule plus target) and /wip shows one line 'N gaps queued (#ids)'. A finding still unresolved past a deadline (about 2 h) shows one line naming the item. Needs you is unchanged. The report code (we:scripts/operations/wip-report.mjs) lives on lane/mechanical-dispatcher, not main, so this work commits there (epic #3383 prototype rule). Sequence: dispatch after wip-honest-remedy lands (same file; its auto vs no-handler decision selects the path). Full auto-resolution needs the conveyor runner live. (3) Once the unified planned-items intake exists (the `track` operation: tracker notes plus filed backlog items as the only two sources, operator 2026-09-20), /wip shows only the TOP planned items (about 5, ranked) as a compact table (id, short title, state) in place of the Next section, not the whole list; the FULL unified list is available on demand through a separate view (a `--planned` flag on the report, same compact table) and the operator wants it printed in full once, when the unified source first exists. Blocked on the `track` story, which is not filed yet. Related but distinct: #3603 (queue-report holds).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Superseded by plan step DZ-SHELL (PL-WIP-CLEANUP, 2026-11-22). Unfinished acceptance carried to DZ-SHELL and the FUI-10 data table: compact phone-first tables. The "Attention findings become queued items" half has no named owner in the plan; it should be carried by the Delivery plan step that lists attention findings.
