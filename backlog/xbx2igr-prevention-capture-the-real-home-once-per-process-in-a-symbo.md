---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/hermetic-tests-vitest.mjs", "we:scripts/lib/hermetic-tests.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:.github/workflows/live-tests.yml", "we:scripts/lib/__tests__/hermetic-tests-vitest.test.mjs", "we:scripts/lib/__tests__/hermetic-tests.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Capture the real home once per process in a Symbol.for-keyed global, for example by storing it ne… (from web-everything/web-everything#4547 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/hermetic-tests-vitest.mjs:78` — Capture the real home once per process in a Symbol.for-keyed global, for example by storing it next to HOME_KEY at install time. Also restore HOME in cleanupFileTmp. Add a unit test that calls setupHermeticTestFile twice with HOME left changed between calls.
2. `we:scripts/lib/hermetic-tests.mjs:253` — Add parity cases to GIT_CASES for `fetch --depth 1 origin` and `push -o x origin`, and teach both implementations the value-taking options.
3. `we:scripts/__tests__/review-set-label.test.mjs:3074` — When a harness redirects HOME or other ambient roots, a review lens or note should require security-refusal tests to keep probing the real ambient location. `realHomedir()` already exists for this.
4. `we:.github/workflows/live-tests.yml:61` — A workflow lint or check:standards rule: any step that posts captured logs to an issue or PR must pipe them through a redaction filter such as sed on `$GH_TOKEN`.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4547@028cf08342fd35c1aa9217ad63ab97ca7a38e25f

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
