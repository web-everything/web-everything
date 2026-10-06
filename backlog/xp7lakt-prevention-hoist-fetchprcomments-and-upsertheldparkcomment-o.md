---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs-held-park-upsert.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Hoist fetchPrComments and upsertHeldParkComment out of runCli as functions that take an injected… (from web-everything/web-everything#4048 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:3880` — Hoist fetchPrComments and upsertHeldParkComment out of runCli as functions that take an injected exec, then add tests for read:false → zero writes and for maxBuffer being passed to exec. A lint that flags exported-constant-only assertions would also help.
2. `we:scripts/merge-ai-prs.mjs:2608` — Add a startup or test assertion that the drain's own `gh api user` login is in the trusted set. Alternatively, dedupe on the comment's `viewerDidAuthor` or on author == current viewer, in addition to the marker.
3. `we:scripts/__tests__/merge-ai-prs-held-park-upsert.test.mjs:37` — Extract `fetchPrComments` and the write-gating into an injectable-exec module and test them with a stub exec that throws ENOBUFS. Failing that, add a standards rule that every `gh ... --json comments` execFileSync call must set `maxBuffer: PR_COMMENTS_MAX_BUFFER`.
4. `we:scripts/__tests__/merge-ai-prs-held-park-upsert.test.mjs:36` — Add deterministic subprocess-stubbed tests covering oversized successful reads and throwing reads through both comment-writing paths; require these tests in CI.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4048@21ce5ea4b688e97787c3bf6edbe90d2785b68abc

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
