---
bornAs: x2kmk7v
kind: story
size: 3
parent: "4075"
status: resolved
scope: ["we:scripts/lib/required-status-checks.mjs", "we:scripts/lib/__tests__/required-status-checks.test.mjs", "we:scripts/lib/__tests__/review-ci-gate-io.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs"]
dateOpened: "2026-10-03"
dateStarted: "2026-10-06"
dateResolved: "2026-10-06"
preparedDate: "2026-10-06"
preparedAgainstSha: "75c39659a06fefd7ee76fb1af223d53880109a25"
tags: []
---

# Prevention — Reuse a shared denial classifier (the isRateLimitShaped guard in looksLikePersonalAccessDenial) instead… (from chalbert/web-everything#3672 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/required-status-checks.mjs:66` — Reuse a shared denial classifier (the `isRateLimitShaped` guard in `looksLikePersonalAccessDenial`) instead of ad-hoc status regexes. A unit test should assert that rate-limit 403s keep a live cache.
2. `we:scripts/lib/required-status-checks.mjs:68` — Classify on gh's structured HTTP status plus message (match `Resource not accessible by integration` or `Not Found`, exclude `rate limit`/`abuse`), and add a unit test asserting rate-limit 403 does not select `declared`. A table-driven classifier test in the existing file would be the cheapest gate.
3. `we:scripts/lib/required-status-checks.mjs:176` — Do not persist `declared` over an existing live entry (return it unsaved, or keep a separate declared key), and add a test that a live cache survives a subsequent denial.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3672@efb90dec3cc4dcb2453f0fdff18f4c03dcaa1fdd

## Done when

1. **Executable** — `npx vitest run we:scripts/lib/__tests__/required-status-checks.test.mjs` fails before this item lands (rate-limit 403 currently yields `declared`) and passes after.
2. **Refuse on error** — a rate-limit-shaped 403 is never treated as a protection denial: no `declared` selection, no cache write; it degrades like any other transient failure (stale cache, else declared `fallback`).
3. **Other input kinds** — an existing `live` cache entry is never overwritten by `declared`; on a genuine 403/404 denial past TTL the result is `stale-cache` with the live checks and the file still says `live`; a repeat call re-reads once more (readChecks call count +1).

## Progress

- Premise check (2026-10-06): not delivered. `git log --grep=4708` shows only the JIT-numbering commit. Code at `we:scripts/lib/required-status-checks.mjs` has moved since the card: the bare-status regex is `protectionAccessDenied` at line 66-69 (`/\b(?:403|404)\b/`), the denial branch is lines 176-179, and `save()` (157-168) overwrites `entries[key]` unconditionally. Card citations :66/:68/:176 still land on the right code; goal unchanged.
- Scope check: `scope:` (module + its test file) is correct. The shared classifier `looksLikePersonalAccessDenial` / `isRateLimitShaped` already lives in `we:scripts/lib/gh-throttle.mjs:1310` / `:674`, which this module already imports from (line 40) — no new dependency or cycle.
- Size 3 kept: one function swap, one guard in the denial branch, ~3 tests.

## Design

Today `protectionAccessDenied` (`we:scripts/lib/required-status-checks.mjs:66`) is a bare `/\b(?:403|404)\b/` over `error.message + error.stderr`. A rate-limit 403 ("HTTP 403: API rate limit exceeded") matches, so line 176-177 selects the repo's declared policy and `save()` (line 157) persists it as `declared`, clobbering a perfectly good `live` entry for a full TTL. The existing test `uses declared policy on protection denial` even pins `HTTP 403: API rate limit exceeded` → `declared` (test file ~line 110) — that expectation encodes the bug.

Changes, all in `we:scripts/lib/required-status-checks.mjs`:
1. Import `looksLikePersonalAccessDenial` from `we:scripts/lib/gh-throttle.mjs` (already imported from, line 40) and make `protectionAccessDenied` delegate to it over the same message+stderr text. That classifier is `isRateLimitShaped`-guarded and matches `HTTP 403`/`HTTP 404`, so rate-limit and abuse text is excluded, and the "Upgrade to GitHub Pro (HTTP 403)", "Resource not accessible by integration (HTTP 403)" and "Not Found (HTTP 404)" shapes still classify as denial. No new regex.
2. In the denial branch (176-179): if a `live`-sourced `cache` entry exists (necessarily past TTL, since a fresh one returns `cache` at line 152), do NOT `save()` and do NOT return `declared`: fall through to the existing tail (183-185), returning `stale-cache` with the last-known live checks and `cacheAgeMs` — identical to the rate-limit path. The live entry stays on disk, so each later call re-attempts the live read (one gh call per call, same as any stale cache today). A `declared`/`unavailable`/absent cache keeps today's behavior (save `declared`, retry after TTL).
3. Narrowing, deliberate: the old regex matched a bare `403`/`404`; the shared classifier needs the literal `HTTP 403`/`HTTP 404` (what gh prints). Pinned by a test row (a bare `403` without `HTTP` is treated as a transient failure).

## MVP

Musts only: (1) delegate `protectionAccessDenied` to the shared classifier; (2) never persist `declared` over a `live` entry (return `stale-cache` instead); (3) update/add the tests below.
Out of scope (Follow-ups): moving `protectionAccessDenied` into gh-throttle as its own export; making the classifier status-code-structured rather than text-based; auditing other `/\b403\b/` regex sites.

## Test plan

All in `we:scripts/lib/__tests__/required-status-checks.test.mjs`, in the existing `getRequiredStatusChecks` describe:
- Table-driven classifier cases (`it.each`): `Resource not accessible by integration (HTTP 403)`, `Not Found (HTTP 404)`, plan-feature 403 → `declared`; `HTTP 403: API rate limit exceeded`, `HTTP 403 … secondary rate limit`, `abuse detection` → NOT `declared` (no cache ⇒ declared repo gets `fallback`; undeclared gets `unavailable`). RED today: the rate-limit rows return `declared`.
- Move the `HTTP 403: API rate limit exceeded` row out of the existing "uses declared policy" `it.each` (its current expectation is the bug).
- Rate-limit 403 with a live cache past TTL → `stale-cache` with the live checks, and the cache file still holds `source: 'live'`. RED today: returns `declared` and rewrites the file.
- Live entry survives a genuine denial: seed `live` at now=1000 (ttl 1000); call at now=3000 with a `Not Found (HTTP 404)` reader → `{source:'stale-cache', checks:<live>}`, file entry still `source:'live', fetchedAtMs:1000`; call again at now=3001 → same result and reader called twice total. RED today: returns `declared` and rewrites the file.
- Pin the narrowing: a thrown error whose text is a bare `403` (no `HTTP`) with a declared repo and no cache → `fallback`, not `declared`. RED today.
- Regression guards (GREEN before and after, not RED): `Resource not accessible by integration (HTTP 403)`, `Not Found (HTTP 404)`, plan-feature 403 → `declared`. Rate-limit fixtures must include `HTTP 403` in the text (e.g. `HTTP 403: secondary rate limit`, `HTTP 403: abuse detection mechanism`) so they reach the denial branch and are genuinely RED today.

## Proof plan

Run a scratch script from the lane (cache in a temp dir) that seeds a `live` entry, then calls `getRequiredStatusChecks` past TTL with a reader throwing (a) `HTTP 403: API rate limit exceeded` and (b) `Not Found (HTTP 404)`, printing `result` and the on-disk entry `source`. Before (stash the module change with `git stash` of the module change (we:scripts/lib/required-status-checks.mjs)): `declared`, file clobbered. After: `stale-cache`, file still `live`. Same stash toggle runs the new test file RED then GREEN. Paste both outputs in the PR body.

## Follow-ups

- Export a single `isProtectionDenied(error)` from `we:scripts/lib/gh-throttle.mjs` so other readers share it.
- Sweep other bare `/\b(?:403|404)\b/` status regexes under `we:scripts/` for the same rate-limit confusion.
- Consider structured `gh` exit/HTTP status instead of text matching.
- Bound the live-entry protection by age (found by the #4708 converge red-team): a live entry kept on a genuine denial is returned `stale-cache` forever; once older than the admission gate's max-stale age (1 day) the gate refuses it, and a real, permanent denial (e.g. protection removed, `Branch not protected (HTTP 404)`) never self-heals until the sidecar is deleted. Past that age, a denial should fall back to the declared policy again.
