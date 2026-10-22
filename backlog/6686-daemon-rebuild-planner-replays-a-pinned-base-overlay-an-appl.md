---
bornAs: xn5h9sy
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# daemon-rebuild planner replays a pinned base overlay an applied top already contains (false overlay-conflict-unresolved)

we:scripts/lib/daemon-rebuild/plan.mjs replays a pinned base overlay even when an overlay top already applied on the clone contains it (stack-contained). Replaying the contained ref re-merges commits that are already in the tree, which conflicts and raises a false overlay-conflict-unresolved alarm. Seen 2026-10-20 for lane/hot-squash-refuse and lane/hot-redteam-stuck-review (both retired). Fix: before replaying a pinned base, skip it when any applied top has its tip as an ancestor, and log the skip with the containing top. Prove it on a live rebuild that has a contained pinned base: no alarm, and the same tree.

## Acceptance

- [A1] **Executable** — a new case in we:scripts/lib/__tests__/daemon-rebuild.test.mjs (run with `npx vitest run` on that file): a pinned base whose tip is an ancestor of an applied top is skipped (logged with the containing top), not replayed. Fails before, passes after.
- [A2] **Must refuse to skip** — named cases in we:scripts/lib/__tests__/daemon-rebuild.test.mjs: `E2 ancestry check fails` and `E2 ancestry check times out` (stubbed `git merge-base --is-ancestor` erroring and timing out) both replay the base as today; `E4 not a proven ancestor` (the base tip is not an ancestor of any applied top) replays it; `E5 top not applied here` (the containing top is registered but not applied on this clone, or is applied only on another clone) replays it; `E6 containing top dropped` (the top is unregistered before the next rebuild) replays it; `E6 containing top fails to apply` (the top that justified the skip fails to apply in the same rebuild) replays the base rather than losing it.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change which overlays are registered or auto-dropped; only whether a contained pinned base is replayed.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: inputs are git refs and SHAs from the overlay registry, not free text.
2. **Truncated reads** — an ancestry check that fails or times out counts as "not contained", so the base is replayed as today.
3. **Shared state files** — reads the overlay registry only; writes nothing new.
4. **Fail closed** — skips only on a proven ancestor; any doubt keeps the current replay.
5. **Identity scoping** — the check is per clone, against that clone's own applied tops.
6. **State over time** — re-evaluated on every rebuild, so a top that is later dropped makes the base replay again.
7. **Who wrote it** — n/a: no authorship decision is involved.
