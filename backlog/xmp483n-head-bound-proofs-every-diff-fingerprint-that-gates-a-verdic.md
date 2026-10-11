---
kind: task
status: active
scaffoldedBy: "fix-4631"
dateScaffolded: "2026-10-10"
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/review-set-label.mjs", "we:scripts/check-standards.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Head-bound proofs: every diff fingerprint that gates a verdict or hold crossing is read at the SHA it stamps

Prevention owed by PR #4631 review round 7 (security/toctou-head-binding). Two proof sites read the net diff at the branch NAME and applied the result to a head SHA read earlier (we:scripts/review-set-label.mjs restamp carry; we:scripts/merge-ai-prs.mjs#carryHumanClearanceOnIdenticalDiff), so a force-push between the two reads could bind one commit's diff to another commit's clearance. PR #4631 added we:scripts/merge-ai-prs.mjs#readNetDiffAtHead (diff AT the SHA, require rev === headSha) and routed its three sites through it. This card is the guard against the class: a standards check or test convention that flags any computeNetDiffText / computeNetDiffSignals call whose text is fingerprinted and compared against, or stamped onto, a head SHA without going through readNetDiffAtHead.

## Acceptance

- [A1] **Executable** — `npm run check:standards` fails on a source file that passes a `computeNetDiffText` result for a branch-name `rev` into `normalizeDiffFingerprint` (or a reviewed-diff marker) beside a head SHA, and passes once that read goes through `readNetDiffAtHead`.

## Non-goals

- [N1] Does not change the drain's escalation scoring read (`computeNetDiffSignals` at the branch name), which sizes a PR and stamps nothing onto a SHA.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the check reads repo sources only.
2. **Truncated reads** — n/a: whole-file source scan.
3. **Shared state files** — n/a: no state is written.
4. **Fail closed** — a call site the check cannot classify is reported, never skipped silently.
5. **Identity scoping** — n/a: repo-wide.
6. **State over time** — a new fingerprinting helper is found by what it calls, not from a hand-kept list of file names.
7. **Who wrote it** — n/a: applies to agent and human authors alike.
