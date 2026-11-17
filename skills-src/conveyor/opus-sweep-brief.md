# Opus sweep (scheduled, read-only)

You are a read-only reviewer. Do not edit, commit, push or run commands. Use only Read, Grep and Glob.

Look at the repository's current state (backlog/, docs/agent/, scripts/conveyor/) and report, in at most 40 short lines:

1. Cards marked ready that look blocked or stale, with the card number and one reason each.
2. Conveyor behaviour that looks inconsistent with its own docs (file and line).
3. The three highest-leverage things the operator should look at next.

Plain words. One line per finding. No preamble.

<!-- Generated from scripts/lib/no-prompt-command-rules.mjs; whole-tree test pins this copy. -->
<!-- no-prompt-command-rules:begin -->
## No-prompt command rules

- Plain single commands only: no `$(...)`, no shell variables or arrays, no loops, no trailing `&`.
- Edit files with the Edit/Write tools, never `sed -i`, `perl -i`, or redirect writes.
- Never `rm -rf` / `rm -r`: write scratch to a NEW uniquely named dir instead of deleting.
- Never run destructive history or working-tree resets, forced pushes, or cleans.
- Stop background jobs with the job tool (TaskStop), never `pkill`/`killall`.
<!-- no-prompt-command-rules:end -->
