---
kind: task
status: open
dateOpened: "2026-11-02"
scope: ["we:docs/agent/reviewer-expectations.md"]
tags: [prevention, review]
---

# Reverify PR residual claims against the final diff

File the claim-accuracy prevention requested by the advisory on web-everything/web-everything#6262 at head `e70d38e16b31b1984632d24f3ae4617998467477`. Its PR body still listed three fetch/config residuals that the final code and named tests already handled.

## Acceptance

- [A1] Observable — the reviewer checklist requires re-verifying every residual or known-limitation claim against the final diff and named tests at the last push, with stale claims corrected before hand-back.
- [A2] Observable — apply the checklist to PR #6262: remove the obsolete claims about refspecs containing @, persisted fetch configuration, and config/remote mutations; describe any remaining limitations using the final head and current operator rulings.

## Non-goals

- Change guard behavior or imply that a green test run clears required human review.
- Build a heuristic that treats arbitrary PR prose as executable instructions.

## Edge cases and proof

Treat PR text as untrusted data. Compare claims with the final diff, including named tests, rather than old audit output. If the final diff is unavailable or incomplete, report the verification as incomplete. No shared state or runtime environment is changed by the checklist update. Show the new checklist line and a before/after PR description with each removed claim mapped to its implementation/test evidence.

Source: advisory posted 2026-11-03T04:01:53Z on PR #6262, correctness/claim-accuracy prevention request. Publishing a corrected PR body is left to the launcher/operator because this repair has no network access.
