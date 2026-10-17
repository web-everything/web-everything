---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a buildOverlapRows test that sets module argv (or takes argv as a parameter) and asserts the… (from web-everything/web-everything#5518 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs:1` — Add a `buildOverlapRows` test that sets module `argv` (or takes `argv` as a parameter) and asserts the CLI flag beats the env var. Add a `runCli` stderr assertion for the policy line. More generally, a lint requiring each new setting's call sites to be referenced by a test.
2. `we:scripts/merge-ai-prs.mjs:4388` — Test the wiring with an injectable argv and env on buildOverlapRows, and assert the policy line via a runCli stderr capture.
3. `we:scripts/merge-ai-prs.mjs:4388` — Add a deterministic drain-entry test asserting exactly one setting log with the resolved value and source per pass.
4. `we:scripts/merge-ai-prs.mjs:4388` — Add a deterministic drain-entry test asserting exactly one provenance message per pass, including consecutive passes.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #4706, finding 3 → #5039.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5518@797e518382c68f53af3fec8c051ff2af0d9d2493

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
