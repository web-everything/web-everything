---
bornAs: xq69k27
kind: task
status: open
scope: ["we:scripts/lib/author-stamp-restore.mjs", "we:scripts/lib/__tests__/author-stamp-restore.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Author-stamp restore: real Markdown parser for snapshot HTML check, and stamp carry-over on full-body edits

Replace the heuristic HTML/inline-code scan in author-stamp-restore with a Markdown parser (multiline link titles, comment-allowlist ambiguity from the R1085 waiver) and build prep item 4: `pr-body-edit --body-file` carries the author stamp, and `gh pr edit --body*` is routed to it.

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run -- node --test we:scripts/lib/__tests__/author-stamp-restore.test.mjs` passes with new cases: a multiline link title and an allowlisted comment next to inline code are classified by a Markdown parser, not a regex; a `pr-body-edit --body-file` full-body edit keeps the existing stamp; a bare `gh pr edit --body*` is refused with a "use pr-body-edit" message. These cases fail on current main.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change who may author or restore a stamp, and does not add a network endpoint (body-size, rate-limit and CSRF controls do not apply). Does not rewrite other PR-body tooling.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR body is data: parse it with the Markdown parser, never execute or trust embedded HTML, comments or links.
2. **Truncated reads** — A body that fails to parse or is cut off refuses the restore; it never counts as clean.
3. **Shared state files** — n/a: the stamp lives in the PR body, not a shared file; re-read the body after the write and refuse if it changed.
4. **Fail closed** — Parser error, unknown node type or ambiguous comment allowlist refuses.
5. **Identity scoping** — The carried stamp keeps its original author and PR id; a stamp from another PR or author is not carried.
6. **State over time** — Repeated full-body edits keep exactly one stamp; no duplicates, no drift.
7. **Who wrote it** — The stamp is carried only when it was written by the expected author identity; an edit by someone else does not inherit it.
