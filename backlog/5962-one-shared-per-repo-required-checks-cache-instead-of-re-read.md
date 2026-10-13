---
bornAs: xqd4v1o
kind: story
size: 3
status: open
scope: ["we:scripts/lib/required-status-checks.mjs", "we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:scripts/lib/pr-state-io.mjs", "we:scripts/lib/__tests__/required-status-checks.test.mjs", "we:scripts/lib/__tests__/pr-state-io.test.mjs", "we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs", "we:scripts/settings/required-checks-cache.json"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-13"
preparedAgainstSha: "c6f9247d2538ff39705a46ff4171d70c4c52870b"
tags: []
---

# One shared per-repo required-checks cache instead of re-reading branch protection on every check

Held finding 226 (coroner-5). repos/.../branches/main/protection was read 5,470 times in 12 h (await-verify-loop 3,807, ci-red-recovery-watch 501, reconcile-pass 445, reconcile-fix 355, review-daemon 293); still 322/h after the 18:30 ET fix, though the required list changes a few times a week. Since #4924 the reader goes to rulesets first; same issue. Fix: one per-repo cache file (TTL setting default 15 min, ETag so revalidation is a free 304), invalidated by a ruleset/branch_protection event from the pr-events feed; every reader goes through it.

## Acceptance

- [A1] **Executable** — the vitest file we:scripts/lib/__tests__/required-status-checks.test.mjs passes, and its new cases fail on `main` today: (a) two `getRequiredStatusChecks` calls from different `process.cwd()` values share one cache file and the second makes zero reads; (b) `defaultReadRequiredContexts` in we:scripts/conveyor/ci-red-recovery-watch.mjs and the required-check probe in we:scripts/lib/pr-state-io.mjs make zero direct `gh api …/protection` calls (they go through `getRequiredStatusChecks`).
- [A2] **Executable** — after the cache TTL, the revalidating read sends `If-None-Match` and a `304` keeps the cached set without a counted API call.

## Non-goals

- [N1] The pr-events Worker (we:scripts/conveyor/pr-events-worker/core.mjs) is not changed: it keeps its accepted-event list. Event-driven invalidation is a follow-up (see Follow-ups).
- [N2] The declared/fallback degradation chain in `getRequiredStatusChecks` is not changed.

## Edge cases this change must handle

1. **Untrusted text** — n/a: the cache stores only context-name strings parsed from a GitHub JSON body (`requiredChecksFromRules`/`requiredChecksFromBranch` already filter to non-empty strings); no cache text reaches a shell, argv or path. The cache path is built from the fixed coordination root, never from a repo slug.
2. **Truncated reads** — the rules read stays `--paginate --slurp` with `per_page=100`; the new ETag revalidation must treat a `304` only as "keep the entry whose etag matched" and a missing/blank body on a `200` as a failed read, never "no checks".
3. **Shared state files** — the cache is now shared by many daemons: write with `writeJsonAtomic` and a read-merge-write under `withFileLock` (we:scripts/lib/atomic-json-file.mjs) so two repos' entries never clobber each other; a lock timeout skips the write, never fails the read. Test: two interleaved writers for different repos keep both entries.
4. **Fail closed** — an unreadable/corrupt cache is "no cache" (fresh live read), never an empty required set; a failed live read keeps the existing degrade chain (stale-cache, declared, fallback). Readers that today return `null` on a failed direct read must instead get the shared result and its `source`.
5. **Identity scoping** — entries stay keyed `repo@branch`; an anonymous (cwd-inferred) repo is never cached (unchanged). The shared file path is independent of cwd so lane clones do not each get their own copy.
6. **State over time** — TTL from a settings file (default 15 min); an entry older than the TTL is revalidated, not trusted; the `fetchedAtMs` of a `304` is refreshed. A restart mid-write leaves the previous file intact (atomic rename).
7. **Who wrote it** — n/a: the file is local daemon state under the operator's coordination root; no label/comment/ref grants trust from it.

## Design

Premise check against `main` (c6f9247d2): the goal is NOT delivered, but the card's premise is partly stale. `getRequiredStatusChecks` (we:scripts/lib/required-status-checks.mjs) already has a per-`repo@branch` cache with a 15 min TTL (`DEFAULT_CACHE_TTL_MS`), and the protection/rulesets read already goes through it. Three real causes remain:

1. **The cache is per working directory.** `defaultCachePath()` joins `process.cwd()` with a `reports` sidecar name — every lane clone and every daemon cwd has its own file, so the 15 min TTL is not shared and a cold clone always re-reads. Fix: default the path to a fixed shared location under `resolveCoordinationRoot()` (we:scripts/operations/coordination-root.mjs, already imported by we:scripts/conveyor/await-verify-loop.mjs), keeping the `cachePath` parameter for tests.
2. **Two readers bypass the cache.** `defaultReadRequiredContexts` in we:scripts/conveyor/ci-red-recovery-watch.mjs (~line 783) runs `gh api repos/<repo>/branches/<branch>/protection` directly on every call, and we:scripts/lib/pr-state-io.mjs (~line 108) reads the `protection/required_status_checks` endpoint directly. Route both through `getRequiredStatusChecks` (keep their injectable seams; the ci-red reader keeps its `null`-means-unknown contract by mapping a `source` of `fallback`/`unavailable` with empty checks to `null`).
3. **Revalidation is a full re-read.** After the TTL, `defaultReadRequiredStatusChecks` re-runs both `gh api` calls and pays for them. Route the two GETs through `ghRestGetJson` (we:scripts/lib/gh-rest-read.mjs), whose ETag cache makes an unchanged answer a free `304`. The rules read keeps its pagination (`ghRestGetPaged`, or the existing `--paginate --slurp` call when ETag is unavailable).
4. **TTL setting.** Replace the constant with a settings-file read following we:scripts/lib/settings-files.mjs (default 15 min), still overridable via the existing `ttlMs` option.

we:scripts/conveyor/reconcile-pass.mjs needs no code change: it already defaults `readRequiredChecks = getRequiredStatusChecks` (line 1368). we:scripts/conveyor/await-verify-loop.mjs has no direct required-check read (no `required`/`protection` reference); its 3,807 reads are attributed to child processes it spawns that import we:scripts/lib/pr-state-io.mjs, so fixing pr-state-io covers them. The build must confirm the per-caller split in the gh log before and after. The card's original scope named a file that does not exist; corrected above.

pr-state-io behavior choice: today it reads the `protection/required_status_checks` endpoint and falls back to `DECLARED_REQUIRED_STATUS_CHECKS[repo] ?? FALLBACK_REQUIRED_STATUS_CHECKS` on failure. After the change the shared reader's result wins (rules ∪ classic, with its own degrade chain, which ends in the same declared/fallback sets). Inject it as a `readRequiredChecks` seam defaulting to `getRequiredStatusChecks`, matching the other callers. Readiness must stay "unknown" (existing `required-check set empty` error) when the shared result is empty.

Seam for the 304 case: `defaultReadRequiredStatusChecks` gains an injectable `restGet` (default `ghRestGetJson`) so a test can return a 304.

Also in scope (found in review): the TTL settings file `we:scripts/settings/required-checks-cache.json`, and the readers' test files we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs and we:scripts/lib/__tests__/pr-state-io.test.mjs.

## MVP

Musts only:
- Shared cwd-independent default cache path under the coordination root, written atomically under a lock.
- The ci-red-recovery-watch and pr-state-io readers go through `getRequiredStatusChecks`.
- ETag revalidation for the two source reads.
- TTL from a settings file, default 15 min.

Out of MVP (see Follow-ups): event-driven invalidation from the pr-events feed; a call-volume health smell.

## Test plan

In we:scripts/lib/__tests__/required-status-checks.test.mjs plus the two readers' test files:
- `shared default path`: `defaultCachePath()` is identical for two different `process.cwd()` values and lives under the coordination root. Fails today (path embeds cwd).
- `second reader makes zero reads`: with a fresh entry, a second `getRequiredStatusChecks` from another cwd calls `readChecks` 0 times. Fails today (separate files).
- `ci-red reader uses shared cache`: `defaultReadRequiredContexts` with a cache hit makes no `gh` call. Fails today (always shells the protection endpoint).
- `pr-state-io reader uses shared cache`: same assertion for the required-check probe. Fails today.
- `304 keeps entry and refreshes fetchedAtMs`: an injected `ghRestGetJson` returning a 304 keeps checks and bumps the age. Fails today (no conditional read).
- `pr-state-io declared/fallback`: with the injected shared reader returning `source: 'declared'`/`'fallback'`, readiness uses those checks; with an empty result it reports `required-check set empty`. Fails today (no seam; always shells).
- `blank 200 body is a failed read`, `corrupt cache file is treated as no cache`, `two writers for different repos keep both entries` (edge cases 2, 3, 4). These are guards: they may already pass, and each must still be written; the two-writers case is red today only if the current write is not read-merge-write under lock, so the builder confirms and, if red, fixes the write.
- `ttl setting`: a settings value overrides the 15 min default.

## Proof plan

Before/after on the live fleet: count `branches/main/protection` and `rules/branches/main` calls in the gh-call log (`ghThrottleLogPath`, we:scripts/lib/gh-throttle.mjs) for one hour before and one hour after the change lands; expect the hourly count to fall from ~322 to about one revalidation per TTL per repo (≈4/h), with no counted calls on 304s. Break the counts down per caller (the gh log's caller field) so the await-verify-loop children, ci-red-recovery-watch and reconcile are each shown falling; the ~4/h target holds only if those callers account for the 322/h. Also show `defaultCachePath()` printed from two different cwds by a CLI probe, and the cache file's `repo@branch` entries after a run.

## Follow-ups

- Invalidate the cache on a `repository_ruleset` / `branch_protection_rule` event from the pr-events feed (needs `ACCEPTED_EVENTS` extended in we:scripts/conveyor/pr-events-worker/core.mjs plus the webhook subscription).
- Call-volume health smell that flags a protection read rate above N/h.

## Progress

- 2026-10-13 prepare: premise check — goal not delivered. Old premise: no shared cache exists. Corrected: a per-cwd cache exists; remaining causes are the cwd-relative path and two direct readers. Scope corrected to the four files listed in the frontmatter. Size 2 → 3: four files plus tests (evidence: `defaultCachePath` in we:scripts/lib/required-status-checks.mjs, we:scripts/conveyor/ci-red-recovery-watch.mjs:783, we:scripts/lib/pr-state-io.mjs:108).
