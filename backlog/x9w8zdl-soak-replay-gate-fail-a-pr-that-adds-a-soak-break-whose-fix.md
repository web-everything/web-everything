---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/soak-replay-gate.mjs", "we:scripts/lib/__tests__/soak-replay-gate.test.mjs", "we:.github/workflows/soak-replay-gate.yml"]
dateOpened: "2026-10-14"
tags: []
---

# Soak-replay gate: fail a PR that adds a soak break whose fix marker is absent from its own net diff

PR #5282 added we:scripts/conveyor/soak/breaks/fast-drain-timeout-backoff.mjs whose fixPresent marker (the timeout back-off in we:scripts/lib/enqueue-on-event.mjs) a restack had dropped from the same PR. The break ran EXPECTED-FAIL (it.fails) so CI stayed green while the advertised fix shipped absent; only the human review panel caught it (round 4). Add a check to we:scripts/lib/soak-replay-gate.mjs: for every soak break a PR adds or changes, load the break against the PR head and fail when fixPresent(headTree) is false while the break's fixedBy names this PR's own lane. Optionally also require settings leaves named in a PR body to exist in the resolver VALID table. Prevention owed by review of web-everything/web-everything#5282.

## Acceptance

- [A1] **Executable** — the unit test `we:scripts/lib/__tests__/soak-replay-gate.test.mjs` gains a case: a PR diff that adds a break module whose `fixPresent(headTree)` is false and whose `fixedBy` names the PR's own head lane → gate verdict red with the break id; the same diff with the fix present → green. Fails before this item lands, passes after.
- [A2] A break whose fix legitimately lives on another branch (`fixedBy` names a different ref) stays allowed — the EXPECTED-FAIL mode keeps working.

## Non-goals

- [N1] Does not run the break scenarios themselves in the gate (the soak job does that); it only evaluates `fixPresent` against the head tree.
- [N2] The PR-body settings-leaf check is optional; split it out if it grows past this card's size.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — `fixedBy.sha` / `fixedBy.where` are compared as exact strings to the PR head ref; never passed to a shell or git argv.
2. **Truncated reads** — the changed-file list comes from the paged net diff; a truncated or failed listing makes the gate fail closed, not pass.
3. **Shared state files** — n/a: the gate reads the checked-out head tree only and writes nothing.
4. **Fail closed** — a break module that fails to import or whose `fixPresent` throws counts as "fix absent" → red.
5. **Identity scoping** — only breaks added or changed by THIS PR are evaluated; existing breaks for other branches are untouched.
6. **State over time** — a restack or rebase that drops the fix after the break was added is caught on every push, since the gate re-reads the head each run.
7. **Who wrote it** — n/a: the gate judges file content on the PR head, not the author.
