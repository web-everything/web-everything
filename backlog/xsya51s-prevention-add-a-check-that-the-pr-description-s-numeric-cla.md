---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:.github/workflows/ci.yml", "we:scripts/ci/__tests__/ci-shard-runner-switch.test.mjs", "we:scripts/ci/__tests__/rerun-failed-once.test.mjs", "we:scripts/ci/__tests__/quarantine-skip.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a check that the PR description's numeric claims (shard count, --expect) match values parsed… (from web-everything/web-everything#7142 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:.github/workflows/ci.yml:214` — Add a check that the PR description's numeric claims (shard count, `--expect`) match values parsed from we:.github/workflows/ci.yml. A backlog gate would be a test that derives the shard count and `--expect` from one constant.
2. `we:scripts/ci/__tests__/ci-shard-runner-switch.test.mjs:33` — Derive the expected shard count in the tests from a single exported constant that we:.github/workflows/ci.yml generation or a lint also reads.
3. `we:.github/workflows/ci.yml` — A lint that compares the Acceptance and title numerics (such as shard counts) against the matrix and `--expect` values in we:.github/workflows/ci.yml.
4. `we:scripts/ci/__tests__/rerun-failed-once.test.mjs` — Have the card validator require the Risks and Test plan headings for CI-workflow changes.
5. `we:scripts/ci/__tests__/quarantine-skip.test.mjs` — Add a `quarantine-skip exit 2` case to the runStep harness in we:ci-shard-steps.test.mjs, asserting a nonzero status and that npm is not invoked.
6. `we:.github/workflows/ci.yml:297` — Add a timing-artifact check in we:web-everything/scripts/ci/__tests__/ci-unit-shard-performance.test.mjs named 'meets shard duration and unit wall-time acceptance', asserting the agreed duration ceiling and comparable-run improvement against the recorded baseline.
7. `we:.github/workflows/ci.yml` — Add a named CI-results check asserting an explicit per-shard duration ceiling and comparing unit wall-time statistics against the stated baseline.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7142@c18283a6df732ed7aad3be3ca49486331d1a1eea

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
