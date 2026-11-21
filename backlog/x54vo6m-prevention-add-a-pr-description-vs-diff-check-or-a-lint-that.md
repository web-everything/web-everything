---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:.github/workflows/ci.yml", "we:scripts/ci/rerun-failed-once.mjs", "we:scripts/ci/__tests__/rerun-failed-once.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a PR-description-vs-diff check, or a lint that fails when a titled numeric claim (e.g. 'N sha… (from web-everything/web-everything#7142 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:.github/workflows/ci.yml:214` — Add a PR-description-vs-diff check, or a lint that fails when a titled numeric claim (e.g. 'N shards') has no matching change to the pinned constant. At minimum, require the Acceptance bullets to name a test.
2. `we:scripts/ci/rerun-failed-once.mjs:112` — Add a wiring test that fixes which directory the coverage upload reads after a covered retry, and a note in the script header saying which run's coverage counts.
3. `we:.github/workflows/ci.yml:297` — Add an automated acceptance gate that checks completed CI duration data against explicit shard and aggregate latency budgets.
4. `we:.github/workflows/ci.yml` — Add a named CI timing check that reads completed-run measurements, asserts an explicit maximum shard duration, and compares aggregate unit wall-time percentiles with the recorded baseline.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7142@2bb6f6e14096f00c16d3cf66693e608c9382b37f

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
