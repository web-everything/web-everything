---
bornAs: xiqtf7w
kind: story
size: 3
status: active
scaffoldedBy: "fixd-supersede-verdict"
dateScaffolded: "2026-10-09"
scope: ["we:scripts/conveyor/supersede-rule.mjs", "we:scripts/conveyor/supersede-watch.mjs", "we:scripts/conveyor/stand-down.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Fix daemon holds a PR another merged PR declares it supersedes

Live 2026-10-09: #4532 (merged) says 'Supersedes #4522', yet the fix daemon launched fix-4522 at 04:34Z. A supersede watch now posts a superseded stand-down + label on such PRs (closing stays an operator decision).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/supersede-rule.test.mjs we:scripts/conveyor/__tests__/supersede-watch.test.mjs we:scripts/conveyor/soak/breaks/superseded-pr-dispatched.soak.test.mjs` passes; the soak break is expected-fail on a tree without `we:scripts/conveyor/supersede-rule.mjs`.
- [A2] **Live** — after the overlay loads on the fix daemon, #4522 carries a `superseded` stand-down + labels and its log shows `reconcile-refused stood-down … PR #4522`.
- [A3] Must: a mid-sentence or lower-case mention, a fenced block, or an untrusted stand-down never counts; a still-open superseder never holds anything.

## Non-goals

- [N1] Never closes the superseded PR — closing on an author's claim is an operator decision (no sanctioned auto-close exists for this signal).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the marker is read only from a MERGED PR's body and only as a whole line, and only when that PR's author is trusted (the automation or the operator, `isTrustedSupersedeAuthor`; an `app/<slug>` login counts only on a bot row and only against the automation list; a missing author fails closed) and its body was not last edited after the merge by anyone else (`isBodyEditedAfterMergeByUntrusted`, GraphQL `lastEditedAt`/`editor`, read only for a PR with an open target; a failed read ignores that PR and is reported). A hold comment counts only from a trusted login. Residual (accepted): only the LAST editor is checked, and a trusted lane PR can still name any open PR (capped at `MAX_SUPERSEDE_TARGETS` per body); both need a trusted principal to write the marker.
2. **Truncated reads** — `gh pr list` is capped at 200; a truncated merged list only misses older supersedes (newest first), never invents one.
3. **Shared state files** — n/a: no local state file — the hold lives on the PR thread.
4. **Fail closed** — setting missing/malformed/off = no hold; a failed read skips the repo this tick.
5. **Identity scoping** — per repo; the `#N` is resolved inside the same repo as the merged PR.
6. **State over time** — idempotent: an existing trusted supersede hold is read back from the thread; the operator answer ceremony resumes it (`we:scripts/conveyor/stand-down-answer.mjs`).
7. **Who wrote it** — only automation/operator-authored stand-downs count (`isTrustedMarkerAuthor`).
