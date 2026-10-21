---
bornAs: xaxajuq
size: 8
kind: story
status: open
scope: ["we:scripts/operations/free-scope-cli.mjs", "we:scripts/operations/free-scope.mjs", "we:scripts/operations/free-scope-io.mjs", "we:scripts/operations/__tests__/free-scope-cli.test.mjs", "we:scripts/operations/__tests__/free-scope-io-real.test.mjs", "we:scripts/operations/__tests__/free-scope.test.mjs", "we:scripts/worker-brief.mjs", "we:scripts/__tests__/worker-brief.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Scope registry: allow a change stacked on the holders' heads

Add an ancestry-checked `--stacked-on` registration for source-code overlaps: resolve an immutable base and require every overlapping PR head to be its ancestor. Keep docs/config/data and unproven agent overlaps refused. Preserve holder head metadata through collection and report owner-mismatch releases explicitly. Also make refused registrations write nothing: currently the CLI computes an occupied verdict but still invokes the registry writer before returning failure.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/free-scope-cli.test.mjs` — add registrations where a base includes all overlapping heads (admit), misses one (refuse), or git fails (unknown/refuse). Assert rejected requests leave registry bytes unchanged. Before this change the flag is unknown and occupied registrations can still be written.
- [A2] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/free-scope-io-real.test.mjs` — use temporary git repositories with two PR heads, a merge base containing both, a missing object, moved head and same PR number in another repo. Verify real merge-base ancestry and full-SHA resolution; preserve headRefOid in collected holders.
- [A3] Only explicit source files are eligible. Docs, config, data, unknown extensions and directory scopes remain occupied even when all heads are ancestors. Any live agent holder without immutable verified head evidence refuses; do not infer its head from its name.
- [A4] Registration/list output records requested base, resolved SHA and checked repo/PR/head tuples. List rechecks current heads and flags stale/unknown stacked proof; merged holders cease holding. Recheck before publication and reject moved heads outside the base.
- [A5] Release distinguishes owner mismatch from absent registration, without removing another owner’s entry. Without --stacked-on retain existing exclusions and verdict/exit semantics, while refusing occupied registration without writes.
- [A6] Update generated worker instructions and their tests to pass the same stack base through registration and pre-push checks; ordinary workers keep the main-based flow.

## Non-goals

- [N1] Do not merge/rebase PRs, decide landing order or edit the review daemon.
- [N2] Do not turn ancestry into permission to overlap mutable agent work or non-code files.

## Edge cases this change must handle

1. **Untrusted text** — Reject option-like base values; use git argv with option termination and verify a full commit SHA.
2. **Truncated reads** — Capped PR lists, incomplete file lists and missing head IDs refuse; pagination limits cannot prove all holders.
3. **Shared state files** — Keep assessment and registry mutation in one locked transaction, re-read owners and write proof atomically.
4. **Fail closed** — Any ancestry error refuses without a registration; non-code overlaps never gain an exemption.
5. **Identity scoping** — Bind holder heads to repo/PR and release to agent/owner; a same-named branch is not evidence.
6. **State over time** — Pin the base, recheck moving PR heads before registration/publication, and label stale list entries rather than silently renewing them.
7. **Who wrote it** — Ancestry is author-independent; ownership tokens remain required for an owned registration. No HTTP endpoint is added.

## Grounding

- we:scripts/operations/free-scope-cli.mjs:24 has no stacked-on flag; line 51 releases and line 52 prints only the count.
- we:scripts/operations/free-scope-cli.mjs:67 assesses then line 69 registers regardless of the verdict; line 77 returns the verdict afterward.
- we:scripts/operations/free-scope-io.mjs:129 requests headRefOid, but line 143 omits it from returned PR holders.
- we:scripts/worker-brief.mjs:72 starts registration instructions and line 95 starts pre-push checks.
- Size 8 includes collector/core/CLI changes, real-git regression tests and the generated subprocess instructions; review-daemon edits are unnecessary.
