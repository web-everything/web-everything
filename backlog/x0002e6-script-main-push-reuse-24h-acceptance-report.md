---
kind: story
size: 3
status: open
scope: ["we:scripts/ci/main-push-reuse-24h.mjs", "we:scripts/ci/__tests__/main-push-reuse-24h.test.mjs", "we:docs/agent/testing.md"]
dateOpened: "2026-11-21"
tags: [ci, prevention]
---

# Script the main push reuse 24-hour acceptance report

PR #7224's Tier 2 targets currently depend on a manual report. Implement the
`main-push-reuse-24h` checker specified in `we:docs/agent/testing.md`, taking recorded
run IDs and measurements as input and emitting pass, pending or fail with evidence.
This tracks the coverage prevention owed by the 2026-11-21 advisory review.

## Design

Use a pure reducer and a bounded JSON-input CLI. Include UTC windows, immutable run
IDs and attempts, exact-SHA eligibility at decision time, execution receipts,
runner-minutes and independently established break/detection times. Preserve each
calculation's supporting run IDs. Do not infer production acceptance from Tier 1.

## MVP

Evaluate a complete post-merge day and preceding baseline from recorded evidence.
Report zero eligible-SHA full retests, 24 hourly full backstops, nearest-rank red-main
detection p90 at most 80 minutes and at least 30% runner-minute savings.

## Acceptance

- [A1] Planned `we:scripts/ci/__tests__/main-push-reuse-24h.test.mjs`, case `complete eligible window passes`: all four metrics and their immutable evidence IDs are emitted.
- [A2] Planned same file, case `violated target fails`: a full retest, cancelled backstop, p90 above 80 or savings below 30% each yields fail.
- [A3] Planned same file, case `incomplete window stays pending`: truncated inventory, missing hourly receipts, no break sample, missing or zero baseline never yields pass.
- [A4] Planned same file, case `CLI preserves evidence identity`: run the CLI on fixtures; malformed, duplicate or mismatched SHA/attempt inputs are refused with a bounded diagnostic.

## Non-goals

Changing reuse eligibility, CI scheduling, review labels or automatically injecting
production incidents. A no-break window needs a separately approved drill.

## Edge cases

Treat labels and logs as data; bound input bytes and rows. Reject incomplete reads,
duplicate IDs/attempts and unknown receipt provenance. Distinguish decision-time
eligibility from later reruns and compare workloads with merge counts. This is a
read-only report, so shared-state writes, locks and rollback are not applicable.

## Test plan

Run the targeted unit-test command for
`we:scripts/ci/__tests__/main-push-reuse-24h.test.mjs` with passing, failing and
pending fixture windows, including exact threshold boundaries.

## Proof plan

Publish fixture output first, then a real complete production window and baseline
with UTC boundaries and immutable IDs. Missing measurements remain pending.
