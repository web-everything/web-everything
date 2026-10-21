---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/gh-throttle-holders.mjs", "we:scripts/lib/gh-throttle.mjs", "we:scripts/lib/__tests__/gh-throttle-holders.test.mjs", "we:scripts/lib/__tests__/gh-throttle.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a test that combines perCallerMax with over-age holds. Consider reaping on any poll where a h… (from web-everything/web-everything#5326 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/gh-throttle-holders.mjs:72` — Add a test that combines perCallerMax with over-age holds. Consider reaping on any poll where a holder is over-age, not only when the pool is full.
2. `we:scripts/lib/gh-throttle.mjs:1043` — Put the holder fields under a `holder` key in the row, and use a bounded label such as the first args token for the metric.
3. `we:scripts/lib/gh-throttle.mjs:1950` — Log the row only when `r.error.code === 'ETIMEDOUT'`, or set `points: 0` for errors where gh did not run. Add a test for the ENOENT case.
4. `we:scripts/lib/gh-throttle-holders.mjs:22` — Persist only an allowlisted op label (subcommand plus method/endpoint, with no free-text flag values). Add a test that asserts values after `--body`, `-b`, `--body-file` and `-f key=` never appear in the persisted `op`.
5. `we:scripts/lib/gh-throttle-holders.mjs:38` — Restrict watch exemption to `run watch` and to a `--watch` flag on known subcommands (`pr checks`, `run view`). Add a negative test where `--watch` is a flag value.
6. `we:scripts/lib/gh-throttle-holders.mjs:75` — Add a deterministic admission regression test combining a partially occupied pool, a reached caller cap, and over-age holders.
7. `we:scripts/lib/gh-throttle-holders.mjs:74` — Add a deterministic concurrent-admission test with a barrier between holder snapshots and reservations, gating changes to caller admission.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5326@a4b18b2a03b10aa7cdd19dd5bc8d6620d484bf07

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
