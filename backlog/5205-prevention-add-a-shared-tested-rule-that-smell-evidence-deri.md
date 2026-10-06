---
bornAs: xxewb6r
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-smells/build-session-looping.mjs", "we:scripts/conveyor/build-supervision.mjs", "we:scripts/conveyor/health-smells/__tests__/build-session-looping.test.mjs", "we:scripts/conveyor/__tests__/build-supervision.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a shared, tested rule that smell evidence derived from transcripts or commands goes through a… (from web-everything/web-everything#4081 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-smells/build-session-looping.mjs:25` — Add a shared, tested rule that smell evidence derived from transcripts or commands goes through a redaction helper (or is hashed/truncated to the executable name) before entering measure/summary. Enforce it with a check:standards lint, or a test that runs every smell's output through a canary secret.
2. `we:scripts/conveyor/build-supervision.mjs` — Require coverage thresholds or a rule that fails PRs adding exported functions without corresponding test coverage.
3. `we:scripts/conveyor/build-supervision.mjs` — Use a write-gate or review checklist reminding authors that every specific edge-case guarantee stated in prose must be backed by a test.
4. `we:scripts/conveyor/build-supervision.mjs` — Use a coverage tool or AI-assisted test generator to ensure all branches and limits (like array slices) in pure functions are exercised.
5. `we:scripts/conveyor/build-supervision.mjs` — A static analysis rule or linter for redundant array elements in simple loops.
6. `we:scripts/conveyor/build-supervision.mjs` — A test coverage gate or review checklist requiring branch coverage for all new exported probe functions, specifically testing their bounded behavior.
7. `we:scripts/conveyor/build-supervision.mjs` — A test suite standard requiring explicit boundary tests for functions that enforce collection limits or time windows.
8. `we:scripts/conveyor/build-supervision.mjs` — A lint rule or static analysis check forbidding unbounded synchronous filesystem operations (`statSync`, `readFileSync`) inside loops over full directory listings.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4081@805e236a0a7d91737a3ea4e8f56cc1ec239f1a97

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
