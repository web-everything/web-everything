---
bornAs: x7fp745
kind: task
status: open
scope: ["we:scripts/conveyor/soak", "we:.github/workflows/ci.yml"]
scopeRationale: "The review-job and review-dispatch modules named in acceptance are unchanged selection inputs. Deliverables are the soak dependency selection, workflow and aggregator coverage within the declared scope."
dateOpened: "2026-11-25"
tags: [testing, prevention]
---

# Run affected review soak breaks on PRs through the import closure

Prevention owed by PR #7450: job-option validation and a new head checkpoint broke
two existing soak fixtures, but the PR aggregate passed without running shards.
The source closure already includes review-job and review-dispatch. R1068 explicitly
defers shards to the merge queue; change that policy deliberately, preserving the
full merge-group gate while adding affected-break PR coverage.

## Acceptance

- A change to `we:scripts/operations/review-job.mjs` selects and executes
  `we:scripts/conveyor/soak/breaks/review-hold-red-draft-deadlock.soak.test.mjs` on a pull request.
- A change to `we:scripts/operations/review-dispatch.mjs` selects and executes
  `we:scripts/conveyor/soak/breaks/review-dispatch-without-expected-head.soak.test.mjs` on a pull request.
- Follow static imports and literal subprocess module paths. Missing, unreadable,
  ambiguous or oversized dependency evidence runs the full soak or blocks; it cannot skip green.
- Test the workflow producer and aggregator together, including failed scope computation.

## Non-goals

No blanket timeout relaxation or weakening of the merge-group soak.
