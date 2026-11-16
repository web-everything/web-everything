---
bornAs: xwam00j
kind: task
status: resolved
scope: ["we:scripts/lib/repo-profile.mjs", "we:scripts/operations/gate-health.mjs", "we:scripts/operations/operator-queue.mjs"]
dateOpened: "2026-11-15"
dateResolved: "2026-11-15"
tags: []
---

# Per-repo capability filter for sweeps that iterate every constellation repo (longshore registered with all capabilities off)

After backlog-split S1 registers the longshore repo with every capability off, gate-health, operator-queue, item-activity, delivery-metrics and close-items still iterate every CONSTELLATION_REPOS entry and query the empty private repo. Add a capability filter so read-only sweeps skip repos that declare no review, fix, ciHeal or build.

## Acceptance

- [A1] **Executable** — the command below checks the shared filter in `we:scripts/lib/__tests__/longshore-locus.test.mjs`. Tests `any-capability selection includes repos with just one capability` and `named-capability selection includes only that capability, independently of any-capability selection` distinguish any-capability and named-capability selection, including both build modes and undeclared capabilities.
- [A2] **Daemon admission** — longshore creates no per-repo daemon entry. Test `never launches a daemon for capability-less longshore` in `we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs` also rejects its slug in daemon arguments; the existing per-capable-repo tests retain the other repos' watchers.
- [A3] **Maintenance sweeps** — the following tests in `we:scripts/conveyor/__tests__/capabilityless-sweeps.test.mjs` pin default exclusion and preserved safeguards: `queue loadProtectedNums reads only capable repos and preserves protections` (PR, build-claim, fix-claim and run protection), `queue refuses pruning when a capable repo cannot be read` (fail-closed refusal), `REVERIFY_SWEEP_REPOS excludes longshore`, `countOpenPrsAllRepos excludes longshore without hiding capable-repo failures`, `draft-promotion-loop excludes longshore`, `supersede-watch excludes longshore`, `orphan-fix-round excludes longshore` and `ledger-backfill-rulings excludes longshore`.
- [A4] **Reader sweeps** — all three capable repos remain queried, with no longshore reads. Tests in `we:scripts/operations/__tests__/capabilityless-readers.test.mjs` are `readOpenPrsForClose never queries longshore`, `createItemActivityReader never lists longshore`, `createPrOwnershipReader never reconciles longshore` and `delivery-metrics collectDay never queries longshore`.
- [A5] **Daemon replay** — the `capabilityless-repo-sweeps` soak scenario exercises the real manifest and default draft/orphan passes with injected transport reads. Its wrapper is `we:scripts/conveyor/soak/breaks/capabilityless-repo-sweeps.soak.test.mjs`.

```bash
npm run test:unit -- scripts/lib/__tests__/longshore-locus.test.mjs
```

## Non-goals

- [N1] No backlog-card migration, repo creation, new longshore capabilities, or changes to explicit single-repo requests. This item changes default sweep admission only.
- [N2] No local checkout fallback for longshore card refs. Existing test `a longshore ref without @pr fails closed (no local checkout)` in `we:scripts/lib/__tests__/longshore-locus.test.mjs` pins this boundary.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: selection consumes the code-owned registry; it introduces no external text parser or receive endpoint.
2. **Truncated reads** — n/a: this filter does not alter pagination, buffers or remote result parsing.
3. **Shared state files** — n/a: selection is pure and writes no state, lock or cache.
4. **Fail closed** — missing capabilities and unknown capability names select nothing (`named-capability selection includes only that capability, independently of any-capability selection`); capable-repo read failures still refuse pruning (`queue refuses pruning when a capable repo cannot be read`).
5. **Identity scoping** — selection preserves registry keys and slugs for all three capable repos (`skips a repo with no capabilities, for every capability and for none named` in `we:scripts/lib/__tests__/longshore-locus.test.mjs`, plus the per-sweep tests in A3/A4).
6. **State over time** — eligibility derives from declared capabilities, never a longshore-specific denylist (`is derived from each entry's declared capabilities (same source repoProfile reads)` and the mixed-capability selection tests in `we:scripts/lib/__tests__/longshore-locus.test.mjs`).
7. **Who wrote it** — n/a: no authorship or authorization policy changes; the registry remains code-owned configuration.
