---
bornAs: x7u0mjd
kind: story
size: 5
status: open
scope: ["we:scripts/lib/permission-change.mjs", "we:scripts/lib/review-escalation.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# permission-change: detect sandbox list edits whose owning key is outside the diff context

PR 4446 advisory (prevention owed): under scripts/ code, an entry added to a writableRoots style list whose key sits beyond the three context lines of the diff still reads as no change, because we:scripts/lib/permission-change.mjs only sees hunks. Give the detector the full file text (or a wider context) so the owning key of any edited list can be found, and keep the fail-closed path for unreadable files.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/permission-change.test.mjs` fails before this item lands and passes after: an entry added to a `writableRoots` list whose key is more than three lines above the change reports `sandbox-widening` for a `we:scripts/` module, and the same edit to an unrelated list stays free.
2. **Must (refuse on error)** — a sandbox-bearing file whose full text cannot be read reports `sandbox-widening` (fail closed), never null.
3. **Must (other input kinds)** — `.codex/*` config, `.claude/settings*.json` and shell scripts get the same full-file owner lookup; tests and docs stay exempt.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the file text comes from a PR author: bound the owner walk (line count and line length) so a huge file cannot stall the scorer; comments and strings are handled as the hunk reader does today.
2. **Truncated reads** — the full file at the scored head is read; a cut-off or failed read holds.
3. **Shared state files** — n/a: the detector stays pure, the caller supplies the text.
4. **Fail closed** — an unreadable file, an unbalanced opener walk, or an over-size file all hold.
5. **Identity scoping** — n/a: the lookup is per file path at the scored head.
6. **State over time** — the file is read at the head being scored, so a later push is scored again.
7. **Who wrote it** — the author is untrusted; nothing depends on who opened the PR.
