---
bornAs: x59d72k
kind: story
size: 3
status: open
scope: ["we:scripts/lib/github-app-identity.mjs", "we:scripts/lib/review-log-claims.mjs", "we:scripts/lib/drain-blocked-reason.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevent drain verdict-heading and gh-permission drift found in the stale merge-gate review

Owed prevention from the PR 7485 review. (1) The merger role is declared with actions read in we:scripts/lib/github-app-identity.mjs, so the drain's gh run rerun may be refused when it runs as the merger App: confirm live, then decide the grant, and add a check:standards gate mapping gh write verbs to the permission each caller role needs. (2) Share one review verdict-heading classifier (we:scripts/lib/review-log-claims.mjs already lists headings) and forbid new literal prefix lists; we:scripts/lib/drain-blocked-reason.mjs now holds its own copy. (3) Run a mutation check on new suppression guards so each clause is pinned by a test.

## Acceptance

- [A1] **Executable** — `npm run check:standards` fails on a `gh run rerun` caller whose role lacks `actions: write`, and on a second literal verdict-heading list; both pass after this item lands.

## Non-goals

- [N1] Changing which verdicts clear a PR, or granting an App permission without the operator's decision.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — comment bodies are matched at their start only, never interpolated into a command.
2. **Truncated reads** — the shared classifier is fed by the complete comment reader; a partial thread yields no verdict.
3. **Shared state files** — n/a: no state file is added.
4. **Fail closed** — an unknown verdict heading or an unmapped write verb fails the check.
5. **Identity scoping** — only trusted marker authors count as verdicts; permissions are compared per caller role.
6. **State over time** — a heading added by a later writer must be classified before the check passes.
7. **Who wrote it** — authorship stays with the shared marker-authorship helper.
