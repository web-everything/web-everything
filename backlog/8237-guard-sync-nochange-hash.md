---
bornAs: x07lxaq
kind: story
size: 3
status: open
dateOpened: "2026-11-13"
tags: []
---

# Guard sync no-change path: hash tracked content instead of trusting the stat cache

sync-guard-clone fast path (unchanged revision) trusts git's stat cache; forged .git/index stat fields could hide a tampered tracked file. Reader trusts the same cache (pre-existing). Hash tracked content on the no-change path. Disclosed residual of lane/guard-sync-short-lock (R907/R903).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- sync-guard-clone -t "repairs forged index statistics with default configuration"` must report that exactly that test ran and passed (a run that matches no test is a failure, not a pass), and fails before this item lands. The test (to be added in we:scripts/hooks/__tests__/sync-guard-clone.test.mjs) forges every stat field `git status` compares for a tampered tracked file (extend the `forgeStatCache` helper until `git status --porcelain` reports clean under default configuration), runs sync on an unchanged revision, and asserts the tampered bytes are restored before FETCH_HEAD is refreshed. Reproducing the forgery needs care: with the current helper `git status` still reports the file modified under default configuration, so the test must first assert that the forged index reads clean.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] This item does not change the reader (the pinned-guard launcher), which trusts the same stat cache, and does not defend against a same-user attacker who can also rewrite the object database or the sync script itself.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: hashing reads tracked file bytes through git, never interpolates them into a command.
2. **Truncated reads** — hash through bounded, NUL-framed git output (for example `git diff-index` after clearing the stat cache); a failed, cut-off or oversized result refuses sync, as the tracked-file listing already does.
3. **Shared state files** — the hash runs inside the exclusive guard lock, after live readers drain, so no writer changes the tree meanwhile.
4. **Fail closed** — any hash mismatch or hashing error takes the whole-tree repair (or refuses); it never publishes a fresh FETCH_HEAD over unverified content.
5. **Identity scoping** — n/a: one owned clone per host, already pinned by the `we.guardClone` marker.
6. **State over time** — measure the cost on the largest real clone (about 16k files). Do not gate hashing on index or file timestamps: the same user can forge them, which would re-trust the cache this item removes.
7. **Who wrote it** — a same-user process may write the index; that is the residual this item closes for tracked content, not a new trust boundary.

## Duplicate admission

residual from the guard-sync-short-lock PR
