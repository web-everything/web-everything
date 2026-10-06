---
bornAs: xhz06r5
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/check-standards.cache-parity.test.mjs", "we:scripts/lib/standards-cache.mjs", "we:scripts/lib/__tests__/standards-cache.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a unit test per fail-safe branch (foreign file, key lookup failure, scan throw, null version)… (from web-everything/web-everything#4118 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/check-standards.cache-parity.test.mjs:1` — Add a unit test per fail-safe branch (foreign file, key lookup failure, scan throw, null version). Add a small integration test that runs check-standards `--json` twice against a fixture repo, once with the cache on and once with WE_STANDARDS_CACHE=0, and diffs the output. A review lens that asks 'which test defends each guarantee in this comment' would catch the same class.
2. `we:scripts/lib/standards-cache.mjs:27` — Key every file by `git hash-object` on its worktree content, or add `git ls-files -v` filtering for S/h-flagged files to the dirty set. Add a parity-test case that sets skip-worktree, edits the file, and asserts cached == uncached.
3. `we:scripts/lib/standards-cache.mjs:143` — Add deterministic tests that inject each failure, assert uncached results, and verify no cache results are committed; removing either fallback should make its named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4118@a7bba4970d25b28c2f8bd167c6097a2a7e9ecebe

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
