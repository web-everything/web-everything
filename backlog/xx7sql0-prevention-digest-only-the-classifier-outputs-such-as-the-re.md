---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/seat-assessment.mjs", "we:scripts/lib/review-core.mjs", "we:scripts/lib/__tests__/seat-assessment.test.mjs", "we:scripts/lib/__tests__/review-core.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Digest only the classifier outputs, such as the resolved pattern lists, prefixes and basenames th… (from web-everything/web-everything#7363 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/seat-assessment.mjs:405` — Digest only the classifier outputs, such as the resolved pattern lists, prefixes and basenames that are already embedded, or a classification vector over a fixed path corpus. Drop the whole-file digests, or move the repin into a script that the drift test's failure message names.
2. `we:scripts/lib/review-core.mjs:1` — Add a check:standards rule that fails when a non-test scripts/** module imports a package listed only in devDependencies, or move `ajv` and `ajv-formats` to dependencies.
3. `we:scripts/lib/__tests__/seat-assessment.test.mjs:1` — Require each pre-mortem mitigation in a PR description to carry a named test or a filed card id, and check for that during the prep-to-PR audit.
4. `we:scripts/lib/seat-assessment.mjs` — Add a deterministic adapter regression requiring unresolved repro references to return not-pass, covering both compact answers and full Statements.
5. `we:scripts/lib/seat-assessment.mjs` — Add a deterministic citation-boundary test covering empty files, terminal newlines, and files without terminal newlines, asserting not-pass for nonexistent lines.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7363@c69fec0d84e634c85286dc5cf09bc5f350e3e312

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
