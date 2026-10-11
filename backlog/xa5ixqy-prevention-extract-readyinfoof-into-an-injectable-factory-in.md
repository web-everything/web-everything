---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Extract readyInfoOf into an injectable factory in a lib module, with exec and the open-PR lister… (from web-everything/web-everything#4879 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:5890` — Extract `readyInfoOf` into an injectable factory in a lib module, with `exec` and the open-PR lister as parameters. Add a test that asserts stackedDependents, changesCode and override from fixture rows. A lint that flags untested closures inside runCli is not practical.
2. `we:scripts/merge-ai-prs.mjs:2543` — Add a test with a throwing or counting `infoOf` under `order: 'card-number'` to assert the rollback mode does no forge reads.
3. `we:scripts/merge-ai-prs.mjs:5870` — Add a review-lens rule that any trust or authorship decision must live in an exported pure function with a negative-case test. A deterministic gate is hard here, but a `check:standards` rule could flag `isOperatorAuthored` calls that sit inside `runCli` closures.
4. `we:scripts/merge-ai-prs.mjs:5892` — Before `drain.priorityMode` is flipped to `enforce`, restrict dependents to AI-authored or same-repo PRs. Reuse `isAiGeneratedPr`, and add a unit test with a foreign-authored dependent PR.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4879@e2edfc24763ca3ef0021ea07ba9848e435ee5bf0

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
