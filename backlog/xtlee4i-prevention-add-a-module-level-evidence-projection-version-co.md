---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/lib/daemon-jobs-runtime.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/conveyor/__tests__/review-referral-hold.test.mjs", "we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/smoke.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a module-level EVIDENCE_PROJECTION_VERSION constant that is bumped by hand, or fold PENDING_R… (from web-everything/web-everything#4798 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/review-referral-hold.mjs:72` — Add a module-level `EVIDENCE_PROJECTION_VERSION` constant that is bumped by hand, or fold `PENDING_REASON_TOKENS` and `sha` into the hash. Add a test that changes one of these inputs and asserts a re-parse. A check:standards rule requiring a version constant on any persisted derived cache would cover the whole class.
2. `we:scripts/conveyor/review-referral-hold.mjs:72` — Include the dependencies in the key, e.g. a manual PROJECTION_VERSION constant or a hash that also covers PENDING_REASON_TOKENS. Add a test that mutates a dependency and asserts a re-parse. Alternatively, key the cache on a hash of the module file's text.
3. `we:scripts/lib/daemon-jobs-runtime.mjs:96` — Classify by name instead: treat only files that do not match the `job-<kind>-*` id pattern as sidecars, and keep every `job-*` file that fails to parse as a record as corrupt. Add a test for a `job-*.json` holding `{}`.
4. `we:scripts/lib/daemon-jobs-runtime.mjs` — A strict PR template checklist or `check:scope` script requiring all changed files to map directly to the PR's primary goal.
5. `we:scripts/conveyor/review-referral-hold.mjs` — A `check:standards` lint rule banning `String(func)` for cache hashing in favor of explicit `CACHE_VERSION` integers.
6. `we:scripts/lib/daemon-rebuild/smoke.mjs` — A strict branch coverage gate requiring all new conditional paths (like the `a2.budgetSkipped` fallback) to be exercised by a named test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4798@0226eb4d5dae899fc37eb70142128b3f10138cb4

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
