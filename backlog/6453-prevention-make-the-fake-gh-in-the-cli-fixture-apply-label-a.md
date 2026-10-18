---
bornAs: xjdbm8m
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/__tests__/drain-prestage.test.mjs", "we:scripts/__tests__/merge-ai-prs-prestage.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Make the fake gh in the CLI fixture apply label add/remove edits to the PR fixture. Better, build… (from web-everything/web-everything#5480 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:6474` — Make the fake gh in the CLI fixture apply label add/remove edits to the PR fixture. Better, build the cache signature from a post-reconcile live label read (as `mergeStrategy.prestage` already does) rather than from the listing row.
2. `we:scripts/lib/__tests__/drain-prestage.test.mjs:1` — Add a CLI case with the setting off that asserts no `drain-prestage` directory and no 'prepared while CI pending' line. Add an `enqueue-on-event` case where the setting is false and a green mark keeps the debounce and catch-up listing. A grep-based test that every `prestageWhileCiRuns` reader is covered would also work.
3. `we:scripts/__tests__/merge-ai-prs-prestage.test.mjs:60` — Add a CLI test for the red-main hold on `--from-green-event`. Longer term, a lint or table-driven test that every pass-level guard the full drain honors is exercised on the shortcut path.
4. `we:scripts/lib/__tests__/drain-prestage.test.mjs` — Add an isolated disablement regression using fresh, eligible, green preparation, paired with an enabled control; gate it in the test suite.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5480@72e0efe919116501aef66a2f1c1eeff9b92aa717

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
