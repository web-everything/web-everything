---
kind: story
status: open
size: 3
dateOpened: "2026-11-20"
scope: ['we:scripts/lib/agy-confined-build.mjs', 'we:scripts/lib/__tests__/agy-confined-build.test.mjs']
tags: [security, testing, agent-infrastructure]
---

# Pin every agy snapshot budget and actual read range

PR #7134's 2026-11-20 security and simplicity advisories found that snapshot rejection coverage lacks entry-count, depth and aggregate-byte boundary cases and does not assert actual read budgets. Add deterministic injected small-limit tests without allocating large trees or files. Keep the production unavailable gate closed.

## Acceptance

- [A1] Planned table `voids snapshot at each resource limit before post-worker git` in `we:scripts/lib/__tests__/agy-confined-build.test.mjs` covers entries, depth, per-file bytes and total bytes. For each limit, exercise just below, exactly at and one above; assert the first two capture successfully and the last voids the entire run with no post-worker Git or applied patch and an explicit next-provider fallback.
- [A2] Planned `never reads beyond snapshot budget` in the same file instruments filesystem metadata calls, allocations and actual read offsets/lengths. Assert no content read/allocation for a file rejected by metadata, aggregate reads never exceed the configured total, no descent beyond depth, and no entry processing after exhaustion. Parameterize partial reads, truncation and metadata changes during capture; assert refusal without exceeding any remaining budget.
- [A3] Planned `pins production snapshot limits independently of injected cases` in the same file checks defaults of 100,000 entries, depth 128, 64 MiB per file and 1 GiB total so raising a default fails a named test. Test-only dependency injection must not create an environment or settings bypass for the bounds.

Run `npm run test:unit -- <test-file>` using the A1 file's repository-relative path after the `we:` prefix. All cases are planned. Reuse the capture seam for tracked and untracked worker files, large directories and cleanup after errors. Rejection alone is not read-budget proof. No benchmark, production admission widening or large host allocations are required.
