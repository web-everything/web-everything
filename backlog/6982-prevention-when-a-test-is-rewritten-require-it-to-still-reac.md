---
bornAs: x23kb5c
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/prepare-pr.test.mjs", "we:scripts/operations/open-pr-io.mjs", "we:scripts/operations/__tests__/open-pr-io.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — When a test is rewritten, require it to still reach the original production entry point (createPr… (from web-everything/web-everything#5853 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/__tests__/prepare-pr.test.mjs:139` — When a test is rewritten, require it to still reach the original production entry point (`createPrLandRunner` default `git`); a review-lens note is enough.
2. `we:scripts/operations/open-pr-io.mjs:126` — Keep strict decoding scoped to the size reader's own reads, or add a test that the default `git` still tolerates non-UTF-8 content on the prepare path.
3. `we:scripts/operations/open-pr-io.mjs:182` — Add a test fixture with a stale `origin/main`, or make the refusal detail mention fetching `origin/<base>` before splitting.
4. `we:scripts/operations/open-pr-io.mjs:206` — Add a test that builds `createPrLandRunner` with no `diffStat` or `spawn` override against a temp git repo and asserts an oversized diff is refused. Alternatively, make the stub explicit, for example by requiring `diffStat: null` to disable the reader, so a default can never be the fail-open value.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5853@cecc80ff738fa628ee961bfdded7e9fe13cf005b

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
