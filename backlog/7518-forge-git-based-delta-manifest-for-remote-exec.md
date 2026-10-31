---
bornAs: xlvqba8
kind: story
size: 5
status: open
scope: ["we:scripts/readiness/forge-exec-manifest.mjs", "we:scripts/readiness/forge-exec-bases.mjs", "we:scripts/readiness/forge-exec-run.mjs", "we:scripts/readiness/remote-exec.mjs", "we:scripts/lib/repo-scan-tests.mjs", "we:scripts/verify-lane.mjs", "we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-10-30"
tags: []
---

# Forge git-based delta manifest for remote-exec

Delivered by PR #6100 (stacked on #6059; R280 retro card). Remote runs shipped about 15k files (~52s) because the manifest hashed everything. The manifest now reuses base hashes for git-clean files and hashes only changed or untracked ones, falling back to a logged full scan on any git failure. Ignored build dirs are skipped (fixes the ignored-test-file fallback). Core: we:scripts/readiness/forge-exec-manifest.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/readiness/__tests__/forge-fast-manifest.test.mjs` (delivered by #6100).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: nothing beyond the digest is in scope.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new input path beyond the digest; existing handling unchanged.
2. **Truncated reads** — n/a: no new input path beyond the digest; existing handling unchanged.
3. **Shared state files** — n/a: no new input path beyond the digest; existing handling unchanged.
4. **Fail closed** — n/a: no new input path beyond the digest; existing handling unchanged.
5. **Identity scoping** — n/a: no new input path beyond the digest; existing handling unchanged.
6. **State over time** — n/a: no new input path beyond the digest; existing handling unchanged.
7. **Who wrote it** — n/a: no new input path beyond the digest; existing handling unchanged.
