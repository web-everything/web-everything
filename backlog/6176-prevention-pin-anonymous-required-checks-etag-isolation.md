---
bornAs: xcg5404
kind: story
size: 1
status: resolved
dateOpened: "2026-10-15"
dateResolved: "2026-10-15"
graduatedTo: none
scope: ["we:scripts/lib/__tests__/required-status-checks.test.mjs"]
tags: [testing, prevention]
---

# Prevention — Pin anonymous required-checks ETag isolation across working directories

The advisory review of web-everything/web-everything#5404 identified missing coverage for the cwd context supplied by `we:scripts/lib/required-status-checks.mjs`. Addressed in that PR with `isolates anonymous ETag reads across working directories` in `we:scripts/lib/__tests__/required-status-checks.test.mjs`.

## Acceptance

- [A1] `npm run test:unit -- required-status-checks` exercises two anonymous repositories through the real `ghRestGetJson` disk cache, sharing one cache directory and auth identity. Only cwd lookup and transport responses are substituted.
- [A2] Both rules and classic protection start unconditionally in each cwd, then revalidate independently with `If-None-Match` and 304 responses after switching back. Returned union and classic checks remain specific to each repository.
- [A3] Identical ETags across repositories expose a missing cwd context as reuse of another repository's body. No cache-key formula is reproduced in the test.
- [A4] The existing unit-test glob in `we:vitest.config.ts` includes this file; `we:scripts/ci/shard-assign.mjs` assigns it to the unit suite run by the required `test` gate in `we:.github/workflows/ci.yml`.

## Non-goals

- [N1] No production cache behavior, token routing, or review labels change.

## Edge cases this change must handle

1. **Untrusted text** — n/a: deterministic fixture names and fixed endpoint paths.
2. **Truncated reads** — n/a: single short rules page; pagination already has separate tests in the same file.
3. **Shared state files** — one real REST cache directory serves both cwd identities, with temporary-directory cleanup.
4. **Fail closed** — incorrect headers, response status, or another repository's required checks fail assertions.
5. **Identity scoping** — same anonymous endpoint, auth identity and ETag; cwd alone distinguishes repositories.
6. **State over time** — A → B → A → B proves cold isolation and cached-body revalidation for both endpoints.
7. **Who wrote it** — n/a: no external input or production state is used.
