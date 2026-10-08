---
kind: story
size: 3
status: active
scaffoldedBy: "daemon-clone-health"
dateScaffolded: "2026-10-08"
scope: ["we:scripts/lib/lane-repair.mjs", "we:scripts/lib/__tests__/clone-repair.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Heal dangling refs and broken daemon clones before any fetch (drain data clone, wev-* clones)

Daemon clones (the drain data clone `.lanes/we-drain-daemon/lane-1`, `we-drain-daemon/code`, the `wev-*` clones) are never acquired through lane-pool, so #4382's dangling-ref repair never ran on them. Their `refs/remotes/origin/lane/*` refs named objects missing from the shared store (`git fsck`: invalid sha1 pointer) and a drain overlay fetch was rejected. `repairCloneRefs` in `we:scripts/lib/lane-repair.mjs` now prunes dangling `refs/remotes/*` only, reports (never deletes) other dangling refs, verifies, and quarantines + re-clones a still-broken clean clone. It runs before every fetch in the rebuild prepare step, daemon self-sync, overlay load and the drain's own clone sync. Stacks on merged #4382 and #4387 (no open PR touches these files).

## Done when

1. **Executable** — the clone-repair test file (`we:scripts/lib/__tests__/clone-repair.test.mjs`) fails before this item lands and passes after; and `git -C /Users/nicolasgilbert/workspace/.lanes/we-drain-daemon/lane-1 fsck --connectivity-only` is clean after the product (not a hand edit) runs its repair.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: ref repair works on local git state only; no external text is parsed.
2. **Truncated reads** — a failing git call reads as no broken refs, never as a prune target.
3. **Shared state files** — the shared `--reference` store is never written; only this clone's own remote-tracking refs are deleted.
4. **Fail closed** — only `refs/remotes/*` is ever pruned; any other dangling ref is reported and left; re-clone is opt-in per caller (`allowReclone`, default off; the rebuild, self-sync and overlay paths opt in, the drain's own clone is prune-only), needs a standalone clone (`.git` a directory, no linked worktrees), and needs affirmative evidence of a clean tree: a failed `ls-files` probe, local edits, or staged edits (checked against HEAD) all refuse. With HEAD itself gone, staged-only edits cannot be seen, so that case is logged and the whole clone is kept in quarantine.
5. **Identity scoping** — n/a: acts only on the clone path passed in.
6. **State over time** — idempotent; a healthy clone costs two git calls per fetch (the deep checks, commit-graph verify and the HEAD/index/history probe, run when a ref is broken or once per 10 minutes, stamped in `.git`). A dangling non-remote ref is announced once per process. The repair never throws: any failure returns `ok:false` and the caller's own fetch proceeds as before.
7. **Who wrote it** — n/a: no authored content is consumed.
