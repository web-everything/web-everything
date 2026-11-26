---
bornAs: xkoxrzn
kind: story
size: 3
status: open
dateOpened: "2026-11-25"
scope: ["we:scripts/lib/drain-api-reads.mjs", "we:scripts/lib/__tests__/drain-api-reads.test.mjs", "we:scripts/__tests__/merge-ai-prs-forge-net-diff.test.mjs"]
tags: []
---

# Prove safe pure test renames in forge net diffs

The forge compare reader deliberately holds test renames because its response cannot prove unchanged mode and type.
Review of [PR 7478](https://github.com/web-everything/web-everything/pull/7478) requests support for a zero-change
rename when both paths remain under test discovery and immutable evidence proves the same blob, mode and type.
Until that proof exists, operators must review and merge these refactors outside the drain; clear-human cannot
make an unverified compare admissible.

## Acceptance

- [A1] **Must** — add a parity test comparing the tamper scan over real `git diff` output for a pure test rename
  with the synthesized forge diff. Both paths must remain test paths and additions, deletions and changes must be zero.
- [A2] **Must** — bind bounded forge metadata reads to the compared merge-base and head; accept only identical blob
  identities, modes and types. Unknown, missing, truncated or failed evidence still holds with a named reason.
- [A3] **Must** — test renames into or out of test discovery, copies, binary changes, mode/type changes, nonzero
  content changes, docs/config/data paths and malformed paths. Preserve existing conservative behavior for those inputs.
- [A4] **Executable** — a CLI case with a proven pure rename delivers; the same case with missing mode/type proof
  parks without enqueue or merge calls. The current refusal remains pinned by the test-renames case in
  we:scripts/lib/__tests__/drain-api-reads.test.mjs.

## Non-goals

- [N1] Do not infer unchanged type or mode from `changes: 0`, or bypass the hold with a clearance marker.

## Edge cases this change must handle

1. **Untrusted text** — retain conservative validation of both paths and bind every read to the drained repo.
2. **Truncated reads** — refuse incomplete tree/blob evidence and bound calls, response sizes and deadlines.
3. **Shared state files** — n/a: metadata proof should use fresh reads without persistent shared state.
4. **Fail closed** — unavailable or ambiguous mode/type/blob proof preserves the existing hold.
5. **Identity scoping** — prove both immutable endpoints and both paths, never a branch name that can move.
6. **State over time** — a changed head invalidates prior proof and requires a new read.
7. **Who wrote it** — clearance authorship never substitutes for rename evidence.

## Duplicate admission

A local backlog search for pure test rename and forge net-diff rename support found no existing item covering
mode/type proof and real-git parity. This captures the explicitly owed follow-up from PR 7478; it does not relax
the refusal in that repair.
