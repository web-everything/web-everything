---
name: pr-reconcile
description: Explain PR state and holds through the declared pr-reconcile operation before dispatching review or human approval. Use when asked to "explain PR holds", "reconcile PRs", "what is blocking these PRs", or prepare a review or human-approval pass. NOT for clearing holds, labeling or merging (that's the review ceremony and drain), and NOT for choosing between rival PRs (that's the reading agent's judgment).
---

# Explain PR holds before acting

Establishing PR state by hand is expensive, and labels alone miss holds recorded in comments.
The report contract lives in [delivery-loop.md → Explain PR holds before dispatching](../../docs/agent/delivery-loop.md#explain-pr-holds-before-dispatching).

## The hard rule

Before dispatching a review or a human-approval pass, read this report and its evidence.
Merged and closed PRs remain visible; do not dispatch work just because a historical label remains.

## Invocation

```bash
node scripts/operations/run.mjs pr-reconcile --repo=web-everything/web-everything --json
```

Use the target repository's owner/name; add `--pr=<number>` to inspect one PR.
Read `verdict.prs` for state, mergeability, required-check status, every `review:*` label,
`heldBy`, `heldByEvidence`, all `holds`, and what would unblock each one. Diff `verdict` across runs.
Unrecognized comment prose stays visible for your judgment; `none` is not merge authorization.

## What this is not

This operation **explains** holds. It never clears them, never labels, never merges anything.
Follow the review ceremony for clearance and the drain for landing. Cross-PR arbitration — which
of two rival PRs wins — stays a judgment call for the agent reading the report.
