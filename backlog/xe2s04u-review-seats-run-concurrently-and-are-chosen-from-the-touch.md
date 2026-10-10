---
kind: story
size: 5
status: resolved
priority: high
scope: ["we:scripts/operations/parallel-judges.mjs", "we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/record-verdict-io.mjs", "we:scripts/operations/run.mjs", "we:scripts/lib/review-seat-settings.mjs", "we:scripts/settings/review.json"]
dateOpened: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Review seats run concurrently and are chosen from the touch-set

The review operation ran its juror seats one after another (each 2-5 min), so a review round cost the sum of its seats. Run every independent seat at once with the same verdict, give a second tool-bearing seat its own lane, and choose the seat list from the PR touch-set before the run (an all-prose PR does not seat the security juror). Settings review.parallelSeats and review.seatsByTouchSet, default on.

Before (review daemon run record `review-pr-c197c39b…`, PR #4689, 2026-10-10 08:59 ET): five seats strictly in a row —
judge 97 s, judgeSecurity 90 s, judgeAdvisory 32 s, judgeCorrectnessAdvisory 74 s, judgeAgyCorrectness 42 s — 335 s of
seat wall time where the slowest seat was 97 s.

## Acceptance

- [A1] **Executable** — the unit suite `we:scripts/operations/__tests__/parallel-judges.test.mjs` passes (via
  `npm run test:unit`): seats overlap in time, the record (findings, verdict, telemetry, effects) equals the sequential
  drive's, one failing seat stops the run where the sequential drive stops, a failed run resumes with `--resume`, a
  second tool-bearing seat gets its own lane (or waits for the primary one), and an all-prose PR seats no security juror.
- [A2] **Live** — a review on the review daemon shows overlapping seat start/end timestamps in its run record and a
  seat wall time close to the slowest seat.

## Non-goals

- [N1] No new step kind and no engine change (#3031): the engine still steps one record one step at a time; the
  look-ahead and the seat choice live in the callers.
- [N2] The mandatory pair (correctness + security) is unchanged for code PRs; only an all-prose touch-set drops security.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new text reaches a prompt; seat requests are the ones the declaration already builds.
2. **Truncated reads** — a touch-set of 100+ files (GitHub's cap) or an unreadable one keeps the full roster.
3. **Shared state files** — each further tool-bearing seat runs in its own leased lane; with none free it waits for the primary lane, never shares it concurrently.
4. **Fail closed** — setting off, no `--pr`, unreadable files, or a non-mandatory caller lens all keep the security seat; a changed request discards the early answer and respawns.
5. **Identity scoping** — each seat keeps its own derived session id (`runId` + lens), unchanged.
6. **State over time** — a resume reads the roster off the saved run (`securitySeatFromRun`); a parked run is never resumed under a different roster.
7. **Who wrote it** — n/a: no authorship decision changes.
