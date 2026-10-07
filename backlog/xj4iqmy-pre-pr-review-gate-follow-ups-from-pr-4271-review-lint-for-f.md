---
kind: task
status: active
scaffoldedBy: "fix-4271"
dateScaffolded: "2026-10-07"
dateOpened: "2026-10-07"
tags: []
---

# Pre-PR review gate: follow-ups from PR #4271 review (lint for fail-open catch, binary-file size, flag-parse parity, trust boundary)

Follow-ups left out of PR #4271 repair: (1) a standards lint against catch blocks returning a pass action inside gate code; (2) binary files count 0 lines in the risk size rule; (3) open-pr-io arg() reads the first --base/--ref while pr-land reads the last; (4) pr-land rev-parses SRC without ^{commit}; (5) bypass audit log keeps raw text while the PR body shows the normalized span; (6) a lane can edit its own copy of the settings file or receipt if open-pr runs from the lane's scripts — decide the trust boundary; (7) the gate lives only in the `open-pr` wrapper, but the pr/finish/batch-backlog-items/harvest-learnings skills tell agents to run `we:scripts/pr-land.mjs` directly, which skips it — move the receipt check into pr-land behind the same settings file, or add a check:standards rule against skill text that opens a PR via pr-land when `open-pr` exists; (8) the worker/operator split rests on the unverified `WE_CONVEYOR_WORKER` marker and a self-supplied `--actor` — a worker that unsets the marker can still bypass; needs a marker the agent cannot write (an operator-held token or a dispatcher-set read-only signal).

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/pre-pr-review.test.mjs` fails before this item lands and passes after, with one test per follow-up above (the lint in (1) as a `check:standards` rule fixture).
2. **Must (error path)** — a gate check that errors in `enforce` mode refuses; no follow-up may add a `catch` that returns a pass action.
3. **Must (input kinds)** — binary files, renames, and non-source files (docs, config, data) are all counted by the risk rule, never skipped.
