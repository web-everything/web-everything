---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/scheduled-sweep.mjs", "we:scripts/operations/agy-usage-reader.mjs", "we:docs/agent/architecture.md", "we:scripts/operations/__tests__/scheduled-sweep.test.mjs", "we:scripts/operations/__tests__/agy-usage-reader.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a test that derives the plist's MIN_INTERVAL from StartInterval and requires it to be strictl… (from web-everything/web-everything#7331 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/scheduled-sweep.mjs:175` — Add a test that derives the plist's MIN_INTERVAL from StartInterval and requires it to be strictly smaller, for example 25 minutes against 1800s. Alternatively, a reader test with `at = now - (interval - 5s)` should expect a collection. A check:standards rule on the plist builder would be heavier than this needs.
2. `we:scripts/operations/agy-usage-reader.mjs:174` — Move the result-to-message mapping into an exported function such as `reportResult(result, log)`. Unit-test it, or add a spawn-based smoke test with a signed-out fixture. Treat any acceptance string as needing a named test.
3. `we:scripts/operations/agy-usage-reader.mjs:176` — Add a deterministic CLI output regression test to the required suite.
4. `we:docs/agent/architecture.md:90` — Add a required table-driven test comparing populated capacity results with and without stale, future, other-status and unreadable status evidence.
5. `we:scripts/operations/scheduled-sweep.mjs:184` — Add a deterministic fake-clock regression exercising consecutive scheduled launches with nonzero collection latency; keep the freshness threshold below the scheduling interval.
6. `we:scripts/operations/agy-usage-reader.mjs:176` — Add a deterministic CLI-entrypoint regression that supplies a signed-out result and asserts the exact diagnostic and successful exit status.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7331@791120edcac2d97d0717437031ed4c178ad11ea6

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
