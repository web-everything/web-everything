---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:.github/workflows/ci.yml", "we:scripts/ci/__tests__/secret-scan.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Derive the base from the checked-out merge commit's first parent, or fetch base.sha explicitly. A… (from web-everything/web-everything#7398 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:.github/workflows/ci.yml:96` — Derive the base from the checked-out merge commit's first parent, or fetch base.sha explicitly. Add a workflow test where BASE_SHA is not a parent of HEAD and assert the outcome.
2. `we:.github/workflows/ci.yml:98` — Remove the fallback in a follow-up once the scanner is on main, so a missing base scanner fails the job. Also add a check:standards rule or test asserting we:scripts/ci/secret-scan.mjs, the allowlist and the shared readiness modules exist on main.
3. `we:scripts/ci/__tests__/secret-scan.test.mjs` — Add a named rollout gate that checks the effective ruleset and requires evidence of five successful runs before making secret-scan required.
4. `we:scripts/ci/__tests__/secret-scan.test.mjs` — Add a deterministic rollout configuration check asserting that secret-scan is absent from required status checks until rollout approval.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7398@1bdc26b9ae7cb47a6156c4e9822552527fbfb0c0

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
