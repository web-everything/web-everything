---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Test selection rollout (R146/R147)

MED priority hint. ## (held 2026-10-26 18:24 ET) Test selection rollout (R146/R147) The measure shadow went live at 22:23Z. Children: (1) an always-run safety set that tags tests which spawn scripts, scan the tree or read baselines (5); (2) selection for PR/fix-round CI behind a flag, default off (5); (3) a main/nightly selection miss auto-files a dependency-map fix card and adds the test to the safety set (5); (4) a content-keyed per-test result cache in CI, rescoping 4593 (8); (5) classify flaky vs real failures in the measure log (3); (6) publish the false-green summary per PR (3). Reuse: 2681, 5733, 4541, 4593, 5736. Replay data: 10 of 14 PRs missed with import-graph-only selection.

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
