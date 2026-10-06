---
bornAs: xbd8xmt
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-facts.mjs", "we:scripts/lib/__tests__/pr-facts-merge-gate-isolation.test.mjs", "we:scripts/lib/__tests__/pr-facts.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a test of the sequence seed → bootstrap complete → read, and make the mirror re-derive bootst… (from web-everything/web-everything#4078 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-facts.mjs:96` — Add a test of the sequence seed → bootstrap complete → read, and make the mirror re-derive `bootstrap` from `/prs` coverage. For example, do a cheap /prs pull whenever the mirror's bootstrap is not `complete`, or when the TTL expires.
2. `we:scripts/lib/pr-facts.mjs:258` — Have the tests set `WE_GH_THROTTLE_LOCK_ROOT` to the temp dir, or make `logFactsHit` check `process.env.VITEST` as well as the injected env. A lint or write-gate could also flag tests that call logging helpers without an isolated lock root.
3. `we:scripts/lib/pr-facts.mjs:206` — Have the refresher compare the Worker's `coverage.bootstrap` (importId and baseCursor) on each delta pass and force a full pull on change, with a regression test that imports a bootstrap after the first read.
4. `we:scripts/lib/__tests__/pr-facts-merge-gate-isolation.test.mjs:20` — Replace the grep with a deterministic import-graph walk (a check:standards rule) that resolves the static import closure of the merge-path entry points and fails if we:scripts/lib/pr-facts.mjs is reachable.
5. `we:scripts/lib/pr-facts.mjs:273` — Honour the explicit-off flag before the injected-options shortcut and add an end-to-end disabled-read test; a lint rule is overkill here.
6. `we:scripts/lib/pr-facts.mjs:393` — Add a deterministic contract test with multiple pages for each collection, asserting all check identities and the actual latest review are returned.
7. `we:scripts/lib/pr-facts.mjs` — Add a deterministic transition test that caches an uncovered repo, completes bootstrap, refreshes, and requires a store answer; refresh coverage or force a full pull while coverage is incomplete.
8. `we:scripts/lib/pr-facts.mjs` — Add deterministic fault-injection tests for directory creation, lock creation, and atomic-write failures, requiring a cache miss and successful GitHub fallback.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4078@b6295500b979398837a620af6ce95e3f34ce2a56

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
