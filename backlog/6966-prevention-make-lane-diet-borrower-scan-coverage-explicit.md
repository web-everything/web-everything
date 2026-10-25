---
bornAs: xo4hyg3
kind: story
size: 3
status: open
scope: ["we:scripts/lane-git-diet.mjs", "we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs"]
dateOpened: "2026-10-23"
tags: [prevention, data-safety]
---

# Prevention — Make lane diet borrower scan coverage explicit

Track the borrower-discovery prevention owed by PR #5806's advisory review. A borrower outside the configured roots can lose objects when a lane is pruned. Add a documented, tested way to include additional roots and show operators the scan's actual coverage before applying cleanup.

Source: [PR #5806 advisory review](https://github.com/web-everything/web-everything/pull/5806), posted 2026-10-24T00:54:30Z, security/data-safety finding at `we:scripts/lane-git-diet.mjs:78`, head `4a5ee48414889ace5d987b240b601ec1734aafa3`. This is prevention debt from an advisory, not a recorded human verdict or a clearance of `review:human`.

The other five owed preventions, including the duplicate later-round card suggestion, are tracked in #6965. Together these two cards cover every prevention requested by this advisory.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5806@4a5ee48414889ace5d987b240b601ec1734aafa3

## Acceptance

- [A1] Add a documented, repeatable `--extra-scan-root=<dir>` option in `we:scripts/lane-git-diet.mjs`. Scan each root's immediate repository children in addition to the existing workspace, temporary and pool roots. Print the canonical roots and depth covered before an apply; include equivalent coverage information in JSON output. Explain that unlisted locations and deeper repositories are outside that coverage.
- [A2] In `we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs`, create a real borrower outside every default candidate root, including the temporary directory's immediate repository children. Its ref must require an old object held only by the lane. With the extra root supplied, assert the CLI skips that lane before changing its config or refs and that the borrower still reads the object. The test must fail if extra-root discovery is removed; a generic refusal is insufficient.
- [A3] Test multiple extra roots, spaces in paths, canonical aliases, relative and quoted alternate entries, linked-worktree stores, and transitive alternate chains. Use the extra roots in startup, pre-repack and pre-prune discovery; a borrower appearing after startup must still prevent pruning.
- [A4] Missing, unreadable, empty or valueless extra roots must refuse apply before any lane write with an actionable diagnostic. Keep existing scan roots when extras are supplied. Bound scanning consistently with the existing alternate-graph guard; test its refusal and explain the operator fallback of narrowing roots or skipping cleanup.
- [A5] From the WE checkout, run `npm run test:unit --` with the repository-relative test path from A2 (remove its `we:` prefix), then run the diff-selected verify gate. Capture a failing regression before implementation and a passing gate after it, with the borrower object-read assertion as the data-safety proof.

## Non-goals

- [N1] A filesystem-wide search or a guarantee about repositories outside the reported coverage.
- [N2] Altering claim ownership, retention rules, pool eligibility, or human review labels.

## Edge cases this change must handle

1. **Untrusted text** — Treat root arguments as literal paths; reject missing values, preserve whitespace, and avoid shell interpolation. Document scan depth rather than silently implying recursive coverage.
2. **Truncated reads** — Abort incomplete or unreadable discovery; never turn a failed scan into an empty borrower list.
3. **Shared state files** — Re-scan all roots at the existing destructive boundaries, including a borrower introduced during repack.
4. **Fail closed** — Invalid roots or unresolved object stores must stop apply before pruning; the fallback is to repair coverage or skip cleanup.
5. **Identity scoping** — Canonicalize root aliases and alternate targets without trimming legal path bytes; keep borrower identity through alternate chains.
6. **State over time** — Test startup and late borrowers independently, with old objects that cannot survive solely through the prune grace period.
7. **Who wrote it** — An operator chooses additional coverage; a lane's config cannot choose scan roots or execute commands.
