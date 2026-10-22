---
bornAs: xwkp23k
kind: story
size: 3
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention: reject open backlog cards with TODO acceptance placeholders

PR #5729 advisory found daemon follow-up cards without executable acceptance. Add a check:standards backlog lint that rejects status:open cards whose Acceptance or Done when section contains a literal TODO: placeholder. Stop scanning at the next peer heading, exclude quoted historical examples, and preserve non-open status handling. Parameterize status, CRLF, multiple criteria and section boundaries. Gate: npm run test:unit -- we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs; named test rejects open acceptance TODO placeholders must fail before the rule and pass after.

## Acceptance

- [A1] **Executable** — Add `rejects open acceptance TODO placeholders`, parameterized for open/non-open status, CRLF, multiple criteria, quoted historical examples, Acceptance/Done when headings, and the next peer heading. The open placeholder fixture must fail against the current rule set and pass once the lint lands. Run `npm run test:unit -- <suite>` from the WE checkout, using the repository-relative path for suite `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs`.
- [A2] **Executable** — Run scoped `npm run check:standards -- --files=<fixture-card>` with a malformed open card and then a completed card; assert a named error for the former and no placeholder error for the latter.

## Non-goals

- [N1] Changing daemon auth behavior or rewriting unrelated existing cards.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Treat Markdown as data; literal placeholder text outside the acceptance section is not an error.
2. **Truncated reads** — Scan the complete card through its next peer heading; CRLF must behave like LF.
3. **Shared state files** — n/a: the lint reads cards and writes no shared state.
4. **Fail closed** — Reject an unfinished open acceptance section with a named diagnostic.
5. **Identity scoping** — Evaluate the card status, never the invoking session identity.
6. **State over time** — Changing status or completing acceptance changes the next lint result without stale cached diagnostics.
7. **Who wrote it** — n/a: all open cards receive the same lint regardless of author.
