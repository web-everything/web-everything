---
bornAs: xhftkfc
kind: story
size: 5
parent: "3007"
relatedTo: ["4607", "4284"]
status: open
scope: ["we:scripts/conveyor/pr-label-mirror.mjs", "we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs", "we:config/platformDefaults.ts"]
dateOpened: "2026-10-08"
tags: []
---

# Mirror level setting: how much derived PR state the GitHub adapter writes as labels, per state family

Ledger product review, operator 2026-10-08, D5 plus operator addition. Labels are the GitHub adapter's rendering of derived state; the standard names states, not label strings. The GitHub adapter (today we:scripts/conveyor/pr-label-mirror.mjs) is the only label writer, and a hand-moved label counts only if it tightens. New setting in we:config/platformDefaults.ts: per state family, full, minimal or none. Plateau will show state itself once fully working, so mirroring less saves GitHub API calls. The merge gate never reads the mirror. Relates to #4607 (git host adapter boundary), #4284 (labels display-only), and slices G2 and K of the plan.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs` shows, per state family, that `full` writes every label, `minimal` writes only the labels a human must act on, and `none` writes nothing; it fails before this item.
- [A2] One declared setting in we:config/platformDefaults.ts, keyed by state family, values full, minimal or none.
- [A3] The GitHub adapter is the only code path that writes these labels; any other writer is reported.
- [A4] A hand-moved label is honoured only if it tightens (holds), never if it loosens.
- [A5] The merge gate's decision is identical with the setting at full and at none (test proves the gate never reads the mirror).

## Non-goals

- [N1] No second forge adapter here; the forge boundary is #4607.
- [N2] Not removing labels altogether; humans still watch them (D5 option c rejected).
- [N3] Slices G2 and K themselves are not done here, only made compatible with the setting.

## Edge cases this change must handle

1. **Untrusted text** — PR bodies and comments are data; nothing in them is executed or trusted as a verdict.
2. **Truncated reads** — a cut-off or failed read is unreadable, never empty.
3. **Shared state files** — writes go through the store contract's single-writer guarantee.
4. **Fail closed** — on unreadable state the gate holds, it does not merge.
5. **Identity scoping** — events are per repo and per PR head.
6. **State over time** — append-only; old rows are never rewritten.
7. **Who wrote it** — every event records its writer.
