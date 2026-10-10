---
kind: story
size: 5
priority: high
status: resolved
scope: ["we:scripts/conveyor/fix-context-pack.mjs", "we:scripts/conveyor/__tests__/fix-context-pack.test.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/settings/fix-context-pack.json"]
dateOpened: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Fixer context pack in every fix brief + proof-only local tests

Fixer work-time study 2026-10-10: a fix round's median 11.5 active min spends 2.8 orienting (every round re-fetches gh pr view comments and ~6 files because the finding is not in the 61 KB brief) and 28% on local test runs (same files ~3x per round, then the verify gate runs them again). A: fix.contextPack — the harness stages the finding verbatim, each named file:line with +-N lines (fix.contextLines, default 30), the failing check/tests + failed-log tail for ci-heal, and the PR changed-file list with sizes, in front of the brief; it trims the sections the pack makes redundant and caps the pack at the bytes trimmed, so the brief gets smaller. B: fix.localTests proof-only — run the failing/new test once as red proof, the verify gate supplies the after-run. Built in we:scripts/conveyor/fix-context-pack.mjs, wired into we:scripts/conveyor/reconcile-fix-dispatch.mjs and we:scripts/operations/ci-heal-pr-dispatch.mjs; settings in we:scripts/settings/fix-context-pack.json. No harness guard on repeated identical test commands exists today; the rule is brief-only.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/fix-context-pack.test.mjs` (run from the WE root) passes: the brief carries the pack for a sample finding (verbatim finding, the `file:line` excerpt with the named line marked, the changed files, the proof-only rule); the pack stays within `fix.contextMaxBytes` and the packed brief is smaller than the plain one; both settings off = the old brief byte for byte; a ci-heal pack carries the failing check, failing tests and log tail.
- [A2] **Replay** — a real recent fix dispatch (PR #4764, session d1773f84; PR #4714, session 71aa75fb) replayed through the new builder shows the pack in the brief.
- [A3] **Live** — after adoption on the fix daemon, the next real fix round's transcript shows no `gh pr view --json comments` before the first edit and a single local test run (timings vs the study's 2.8 min orientation / 3.8 min tests medians).

## Non-goals

- [N1] No harness guard that refuses repeated identical test commands (none exists today; the proof-only rule is brief text). No change to the shared brief templates (open PRs #4756/#4757/#4771 edit them); trimming is done in code by heading.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — reviewer text is quoted (`> `) and `{{TOKEN}}` shapes are broken with a word joiner, since the pack is applied to the template before `fillBrief`.
2. **Truncated reads** — every block is clipped with an explicit "truncated — the full text is on the PR thread" note; excerpts shrink (±N → ±N/2 …) before they are dropped.
3. **Shared state files** — n/a: read-only (one `gh pr view`, one raw-contents read per named file); nothing is written.
4. **Fail closed** — any read failure returns the brief unchanged (plus only the tests rule); a dispatch never fails because of the pack.
5. **Identity scoping** — excerpts are read at the PR's current head sha, never the daemon checkout's own tree.
6. **State over time** — the finding is the LATEST changes-requested (or advisory, by the brief's own label rule) comment; older rounds are left to the round-history section (#4756).
7. **Who wrote it** — n/a: the pack quotes the PR thread as data; it grants nothing.
