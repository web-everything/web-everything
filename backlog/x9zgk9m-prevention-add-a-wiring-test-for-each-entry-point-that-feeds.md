---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/open-pr-fetch.mjs", "we:scripts/conveyor/__tests__/pr-comments-complete.test.mjs", "we:scripts/conveyor/pr-comments-complete.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/open-pr-fetch.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a wiring test for each entry point that feeds a 100-comment PR and asserts the injected reade… (from web-everything/web-everything#4091 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4091's review (reviewed head `28868efab96bcb09f7188bada5becd3217a647e5`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/conveyor/open-pr-fetch.mjs:26` — Add a wiring test for each entry point that feeds a 100-comment PR and asserts the injected reader is called. A lint that requires every exported `default*Prs` reader to have a test referencing the enrichment would also catch it.
2. `we:scripts/conveyor/__tests__/pr-comments-complete.test.mjs:48` — Inject at the `execRead` `exec` option (its inner executor) rather than replacing `execRead`, and assert that `ProcReadError` is thrown.
3. `we:scripts/conveyor/pr-comments-complete.mjs:40` — Keep the PR in the snapshot with an `incompleteComments: true` marker that grant and note logic checks, or audit consumers for absence semantics.
4. `we:scripts/conveyor/reconcile-pass.mjs:177` — Cache the complete thread per PR number and head or `updatedAt`, or tag enriched PRs so a second pass skips them.
5. `we:scripts/conveyor/pr-comments-complete.mjs:35` — Add a shape-parity test asserting that the comment shape produced by `defaultListPrComments` and the shape produced by `gh pr list --json comments` give the same `isTrustedMarkerAuthor` answers for the same logical comment. Alternatively, have the REST path set `viewerDidAuthor` explicitly.
6. `we:scripts/conveyor/__tests__/pr-comments-complete.test.mjs:1` — Add tests that call `defaultFetchOpenPrs` and `defaultReadPrs` with injected `exec` and `readComments` and a ≥100-comment row. They should assert the returned `comments` are the complete thread and that a failing read drops the PR. Add a boundary test at 99 and 100 comments.
7. `we:scripts/conveyor/pr-comments-complete.mjs:37` — A unit test verifying idempotency: calling enrichPrsWithCompleteComments on a PR whose comments array is already larger than the page size must not invoke readComments.
8. `we:scripts/conveyor/open-pr-fetch.mjs:26` — A strict test environment sandbox that intercepts and throws on unmocked child_process calls during unit tests, ensuring no real network I/O occurs silently.
9. `we:scripts/conveyor/pr-comments-complete.mjs:37` — Enrichment must be performed by the daemon writing the snapshot, or the PR objects must include an idempotency flag (e.g. `_commentsComplete`), enforced by a test asserting that reading an already-enriched PR does not trigger a network call.
10. `we:scripts/conveyor/reconcile-pass.mjs:177` — A global test sandbox guard that throws if any real process execution (`child_process.execFileSync` or `execRead`) is attempted during unit tests without an explicit opt-in.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
