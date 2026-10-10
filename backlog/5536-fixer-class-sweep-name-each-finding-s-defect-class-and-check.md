---
bornAs: xet6iu0
kind: story
size: 3
priority: high
parent: "5467"
status: resolved
scope: ["we:skills-src/conveyor/fix-agent-brief.md", "we:skills-src/conveyor/fix-agent-ci-brief.md", "we:scripts/lib/class-sweep-rule.mjs", "we:scripts/conveyor/class-sweep-check.mjs", "we:scripts/lib/review-fix-policy-settings.json"]
dateOpened: "2026-10-08"
dateStarted: "2026-10-09"
dateResolved: "2026-10-09"
relatedTo: ["5466", "5468"]
tags: [fixer, review]
---

# Fixer class sweep: name each finding's defect class and check the same class elsewhere in the PR

Operator 2026-10-08 (fix quality first). The fix and ci-heal briefs require, per finding, the defect CLASS and a check of its sibling paths (same function family, callers, parallel branches, the fix's own new recovery/error paths): each sibling fixed or listed checked / n/a, in a structured class-sweep block in the evidence comment and the recorded sweep. A cheap deterministic check reports a missing or incomplete sweep; mode is a setting (off today, warn first). Evidence: fixer audit 2026-10-08 — 7 findings caused by fixes (uncovered sibling paths #4481, holes in the fix's own recovery code #4433).

## Done when

1. **Executable** — `npm run test:unit` on we:scripts/lib/__tests__/class-sweep-rule.replay.test.mjs, we:scripts/lib/__tests__/class-sweep-rule.pr-wide.test.mjs and we:scripts/conveyor/__tests__/class-sweep-check.test.mjs passes. Part 1 (PR #4536): the replay fixtures are the real fixer evidence of PRs 4441, 4481 and 4478, none with a structured sweep, so each reads `missing`. Part 2 (the same class anywhere in the PR): the pr-wide tests and the 5536 CLI cases fail on the #4536 rule (9 red) and pass after; the replay fixture is PR 4624's real round-1 fix evidence, whose sweep read `complete` while round 3 raised the same class in we:scripts/lib/red-main-hold.mjs, a file of the same PR no row named — the new rule flags that file in the same pass.
2. The fix brief (step 3) and the ci-heal brief (step 5) require, per finding, the defect class and the four sibling paths (`family`, `callers`, `branches`, `recovery`), each `fixed` / `checked` / `n/a` with a site and a reason, as one fenced `class-sweep` JSON block.
3. The mode is a declared setting (`classSweep.mode` in `we:scripts/lib/review-fix-policy-settings.json`, env `WE_CLASS_SWEEP`): built-in `off` is today; this host runs `warn` from 2026-10-08. Warn records and never blocks; enforce exits 2 on a missing, malformed or incomplete sweep.
4. The structured sweep is recorded per session under the coordination root (`class-sweep/<session>.json` + `class-sweep/log.jsonl`). Folding it into the completion record itself waits for the completion record v2 envelope (PRs 4436/4439), which owns that file.
5. **Proof** — the next real fixer's evidence comment carries the class and the sibling list, and its `class-sweep/<session>.json` record exists. Proven live: PR 4624's fix evidence (2026-10-09 12:00 ET) carries the block, and the coordination-root record for session fix-4624 + 15 `log.jsonl` rows from real fix sessions exist.
6. **The same class anywhere in the PR** — the briefs ask the fixer to look for each finding's class in every file the PR changes, in the same pass; every changed file must be named by one of the finding's rows (the four paths or extra `pr` rows; a `site` ending in `/` covers a directory; `backlog/` cards exempt). The check reads the PR's files from the lane (`--checkout=<lane> --base=origin/<base>`, `git diff --name-only base...HEAD`) or `--changed-files=<file>`, reports `<finding>: pr-unswept-<n>`, and records the file list (`unswept`). No file list, an unreadable one, or one past the bound fails closed (`pr-files-unknown` / `pr-files-truncated`), never `complete`.
7. **Adopted** — the fix daemon clone runs this check (overlay adopted; `git merge-base --is-ancestor <sha> HEAD` in the daemon clone).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the evidence is agent-written: it is only parsed as JSON, never executed or used as a path; the printed line carries codes and counts, never the text; finding ids are cut to a closed character set. The PR file list (5536): git runs with an argv array (no shell), a bounded buffer and a timeout; `--base` is checked against a ref grammar (no leading `-`, no `..`); the printed line carries counts only, file names go in the record.
2. **Truncated reads** — evidence and block sizes are bounded before parsing; a block past the bound reads as `missing` (`evidence-truncated-before-block`), never `complete`. A PR file list past its bound is `pr-files-truncated`, never checked partially.
3. **Shared state files** — the per-session record is written to a temp file and renamed; the log is append-only.
4. **Fail closed** — an unreadable evidence file is `missing`; an unknown mode value falls back to the built-in, never to a looser one.
5. **Identity scoping** — the record is keyed by the session slug, checked against the slug grammar; a bad slug writes the log only.
6. **State over time** — the warn start date is a setting (`since`) stamped on every record, for the enforce switch.
7. **Who wrote it** — the mode is read from the WE root running the check, never from the lane, so a lane cannot weaken its own check.
