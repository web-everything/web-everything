---
bornAs: x2pw8uz
kind: story
size: 5
status: open
scope: ["we:scripts/lib/permission-change.mjs", "we:scripts/lib/review-escalation.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# permission-change: compare workflow permissions trees structurally, not line by line

PR 4446 advisory (prevention owed): we:scripts/lib/permission-change.mjs reads a workflow diff line by line, so each new YAML spelling of a grant needs a new rule. Replace the line reading with a YAML parse of the before and after files, a comparison of their permissions trees (workflow level and per job), and a fail-closed result on any parse error. The detector is pure and sees only hunks today, so the caller must hand it both file versions.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/permission-change.test.mjs` fails before this item lands and passes after: a table of YAML spellings of one grant (anchor, tag, alias, split lines, flow mapping, unlisted scope, merge key) all report `workflow-permissions` through the tree comparison, and a file that does not parse reports it too.
2. **Must (refuse on error)** — a workflow file that fails to parse, or whose before or after version is missing, reports `workflow-permissions` (fail closed), never null.
3. **Must (other input kinds)** — a workflow with no `permissions:` key at all, or a pure rename, still holds; a diff that touches no permissions tree (a new step, an `env:` value) stays free.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the workflow comes from a PR author: parse with a safe loader (no custom tags executed), cap file size and alias expansion, and treat any parse failure as a hold.
2. **Truncated reads** — the full before and after files are read, not hunks; a read that is cut off or fails holds.
3. **Shared state files** — n/a: the detector stays pure, with no state file.
4. **Fail closed** — parse error, missing version, over-size file and unknown top-level shape all hold.
5. **Identity scoping** — n/a: the comparison is per file path, and a renamed file compares against its old path's content.
6. **State over time** — compare against the PR's base at the scored head, so a later push is judged again against the same base.
7. **Who wrote it** — the author is untrusted; the comparison does not depend on who opened the PR.
