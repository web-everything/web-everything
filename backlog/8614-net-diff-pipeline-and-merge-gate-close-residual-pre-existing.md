---
bornAs: xisblhr
kind: task
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/pr-land.mjs", "we:scripts/lib/pr-merge-gate.mjs", "we:scripts/lib/review-escalation.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/conveyor/delegated-clear-human.mjs"]
deferredBlockedBy: ["7235"]
dateOpened: "2026-11-20"
tags: ["security-boundary"]
---

# Net-diff pipeline and merge-gate: close residual pre-existing gaps (security boundary)

Kind: security-boundary. Found by the R1085 audits of lane/netdiff-inplace (#7235, waived). Fix as one hardening change, after #7235 merges (deferredBlockedBy, not blockedBy: scopes overlap). All paths below are in the we: repo under scripts/; the 22 items are quoted in a block so each keeps its original path:line.

```text
1. merge-ai-prs.mjs:4030 - Git configuration remains trusted: core.bigFileThreshold=1 suppresses source hunks and produces zero line counts; successful output still receives scored:true, bypassing content checks.
2. merge-ai-prs.mjs:4443 - Binary source changes count as verified without readable content. A NUL inside a valid JavaScript comment can suppress hunks; the tampering scanner reports no findings.
3. merge-ai-prs.mjs:4027 - Neither diff.context nor GIT_DIFF_OPTS is normalized. Zero-context output hides unchanged invariant markers; the same assertion edit triggers human review with context and escapes without it.
4. merge-ai-prs.mjs:4030 - diff.ignoreSubmodules=all stays effective because the original configuration is retained. Gitlink changes vanish from statistics, paths and text while all reads report success.
5. lib/pr-merge-gate.mjs:168 - The retained header parser cannot identify C-quoted test paths. A tab-containing test filename makes the same added .skip return tampered:false; core.quotepath=false does not prevent quoting control characters.
6. lib/review-escalation.mjs:816 - Human triggers still receive raw numstat rename strings. docs/agent/{platform-decisions.md => notes.md} bypassed the statute trigger, while the original path required human review.
7. merge-ai-prs.mjs:6455 - All new verification and tampering checks stay inside REVIEW_ESCALATION. Bare drains and pass-wide --no-review-escalation bypass them; their backstop checks existing labels rather than requiring verified diff evidence.
8. operations/review-pr-io.mjs:405 - Reviewer callers pass mutable branch names into the changed resolver and read text and paths separately. Branch movement or a shadow ref can substitute another commit; pinning the drain's call does not protect these consumers.
9. conveyor/delegated-clear-human.mjs:139 - Checks only sig.scored, ignoring sig.netDiffText.scored. Failed text reads can produce humanRequired:false and authorize automatic removal of a human hold without inspecting the full diff.
10. pr-land.mjs:701 - The verification input defaults to netDiffScored=true. Omitting evidence silently bypasses the helper's fail-closed check, including when hunks are unavailable.
11. pr-land.mjs:1492 - ready-to-merge is applied before the head-mismatch guard. A refusal exits without retracting that authorization or installing a review hold, leaving the mismatched head eligible for drain paths that skip escalation.
12. merge-ai-prs.mjs:4816 - The engine-tier gate always receives false. Even correctly measured changes to the lander itself can bypass the independent red-team requirement.
13. merge-ai-prs.mjs:4032 - Inherited core.bigFileThreshold unrestricted: value 1 reduced a range's source diff to binary notices and zero counted lines; successful Git execution still counts as verified.
14. merge-ai-prs.mjs:4439 - Source containing a NUL byte gets binary diff output without hunks; added skip markers evade scanning while the diff stays scored:true.
15. merge-ai-prs.mjs:4027 - Missing --ignore-submodules=none lets inherited configuration suppress submodule pointer changes, so incomplete file, size and text evidence passes verification.
16. lib/pr-merge-gate.mjs:193 - The scanner cannot decode quoted Git paths (tab-containing test filename with it.skip returned tampered:false).
17. lib/pr-merge-gate.mjs:196 - The scanner checks only the destination's test naming pattern. Renaming check.test.mjs to check.mjs removes test discovery but returned tampered:false.
18. lib/pr-merge-gate.mjs:95 - Conditional suite disabling such as describe.skipIf(true) is absent from the skip matcher.
19. lib/pr-merge-gate.mjs:210 - Replacing a failing test with it.todo('case') preserves the counted opener and triggers no skip finding.
20. merge-ai-prs.mjs:5026 - The unverified-diff refusal stays inside the optional escalation pass (bare drain / --no-review-escalation skips it).
21. pr-land.mjs:1333 - Applying the human hold is best-effort; label-write failures are swallowed.
22. merge-ai-prs.mjs:4032 - Inherited diff.context=0 or GIT_DIFF_OPTS=-U0 can remove unchanged invariant markers from hunks.
```

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run -- node --test we:scripts/__tests__/merge-ai-prs-net-diff-computation.test.mjs we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs we:scripts/lib/__tests__/review-escalation.test.mjs` passes with one negative test per item above that fails on main. The design answers merge-path-checklist lines :6 (present vs absent: missing diff evidence refuses), :11 (fail-open catches: every unreadable input refuses), :15 (environment hardening: git config, GIT_DIFF_OPTS, quotepath, submodules and bigFileThreshold are pinned; fetched shas verified) and :16 (scope of exemptions: no skip or no-op rule trusts a label or policy string without re-deriving it from the diff).
- [A2] **Split rule** — If the change exceeds one reviewable PR, split into two cards: git-environment and diff-evidence items (1-4, 13-15, 22), and gate/scanner/landing items (the rest).

## Non-goals

- [N1] Does not redesign the review-escalation pass; it only makes verification mandatory and fail-closed on every path.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Diff text, paths and filenames are data; decode C-quoted paths before matching.
2. **Truncated reads** — Missing hunks, binary notices or failed text reads mean `scored:false` and refusal.
3. **Shared state files** — n/a: no shared state file; label writes are re-read after write.
4. **Fail closed** — Unreadable, unscored or mismatched evidence refuses; label-write failure refuses.
5. **Identity scoping** — Decisions pin an exact 40-hex head, not a branch name.
6. **State over time** — Authorization is retracted (hold installed) when a head-mismatch refusal follows ready-to-merge.
7. **Who wrote it** — A PR author can alter test names, paths, config-influencing content and renames; none may reduce evidence.
