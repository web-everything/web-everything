---
kind: story
size: 5
priority: high
status: resolved
blockedBy: ["xe2s04u", "5726"]
scope: ["we:scripts/operations/review-job.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/lib/review-speculative-red-team.mjs", "we:scripts/settings/review.json"]
dateOpened: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Start the post-accept red team speculatively alongside the juror seats

Today the post-accept red team (comment marker we:red-team-advisory, we:scripts/operations/review-job.mjs) starts only after the review panel reduces to accept, adding ~3-5 min to every accepted review. Start it concurrently with the juror seats on the same read (head + net diff); on accept use its result exactly as today (including the red-team gate routing of PR #4762), on changes/needs-human discard it (no comment, no routing) and record the discarded spend. Setting review.speculativeRedTeam under the policy cascade (default on; off = the sequential order). Stacks on PR #4763 and PR #4762.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/operations/__tests__/review-job-speculative-red-team.test.mjs we:scripts/lib/__tests__/review-speculative-red-team.test.mjs` passes (fails before: the speculative entry points do not exist).
- [A2] Must: on ACCEPT the speculative pass is finished and records exactly what the sequential pass records (seat row, folded verdict, comment, then the red-team gate of PR #4762) — and only when it judged the review's very read (head + net diff + title/body + file list); a different read falls back to the sequential pass.
- [A3] Must: on changes / needs-human / no finished review, the pass is called off (its seat CLI killed if still running), nothing is posted or routed, and the spend is recorded as a `review-seat-speculative-discard` row.
- [A4] Must (refuse on error): a speculative pass that crashed, errored or ran out its wall yields the same `error` red-team result as today (fail-closed: an unrun red team never folds to accept); a speculative pass never resumes or posts a prior row's effects before the verdict.
- [A5] Setting `review.speculativeRedTeam` resolves env → tool (`we:scripts/settings/review.json`) → platform (`we:scripts/lib/delivery-platform-preferences.json` `review.speculativeRedTeam`) → standard default on; the job logs the layer; off = today's sequential order.
- [A6] Live proof on the review daemon: the red team's run overlaps the juror seats, total ≈ max(seat, red team).
