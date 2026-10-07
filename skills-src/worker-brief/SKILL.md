---
name: worker-brief
description: Print the standard worker-brief block (lane acquire/release, Codex for scoped coding, red-green tests through the heavy queue, one PR via open-pr, free-scope pre-check + register/release + pre-push recheck, optional edge overlay and adoption proof, the no-polling rule, no pkill, no --force, ET times, report length) so briefs stop drifting. Use whenever you are writing a brief for a worker agent or subagent you are about to dispatch ("write a worker brief", "brief a build agent", "dispatch a worker for X", "standard rules block"). Paste its output under the task-specific part of the brief; never retype the rules by hand.
---

# Standard worker brief

A brief is two parts: the task-specific text (what to build, why, acceptance), then the standard block.
The script prints the standard block. Never hand-write or hand-edit it. If a rule is wrong or missing, fix
`we:scripts/worker-brief.mjs` in a PR.

## One call

```bash
node scripts/worker-brief.mjs --purpose=<slug> --files=we:scripts/a.mjs,we:scripts/__tests__/a.test.mjs \
  [--edge-clone=<daemon clone path>] [--proof="<what live evidence proves it>"] \
  [--repo=we|plateau-app] [--report-lines=8] [--out=<brief file>]
```

- `--purpose`: a lowercase slug. It is used for the lane, the scope registration and the `lane/<purpose>` PR ref.
- `--files`: every file the worker may touch, listed up front (rule 26). Bare paths get the `--repo` prefix.
- `--edge-clone`: add it only when the fix must also run on a daemon clone. It adds the overlay, the gated load
  and the `git merge-base --is-ancestor` adoption check.
- `--proof`: the proof requirement. The default asks for before/after evidence on the live case.

## Before dispatching

Run the free-scope check on the same `--files` yourself first (skill `free-scope`). Do not dispatch a worker
onto occupied files.

If `free-scope-cli register` exits non-zero (scope occupied), the worker must stop and report; it must not edit anything.
