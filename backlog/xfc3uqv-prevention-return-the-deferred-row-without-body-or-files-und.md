---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-list-paged.mjs", "we:scripts/lib/heavy-cache.mjs", "we:scripts/lib/__tests__/pr-list-paged-delta.test.mjs", "we:scripts/lib/__tests__/pr-list-paged.test.mjs", "we:scripts/lib/__tests__/heavy-cache.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Return the deferred row without body or files (undefined), so any unguarded consumer fails loudly… (from web-everything/web-everything#7511 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-list-paged.mjs:405` — Return the deferred row without body or files (undefined), so any unguarded consumer fails loudly. Alternatively, add a deterministic check that every reader of pr.files or pr.body in we:merge-ai-prs.mjs also handles heavyReadError.
2. `we:scripts/lib/heavy-cache.mjs:105` — Add one assertion to P4 that saveHeavyStore throws on {...entry}. In general, require a test for each throw site in new gate modules.
3. `we:scripts/lib/__tests__/pr-list-paged-delta.test.mjs:143` — Keep the hermetic zero-reads test as the CI proxy. Block landing until the ET-timestamped live result is attached to the PR.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7511@2ca4275da246c16a9beab713f84b117f9ad15216

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
