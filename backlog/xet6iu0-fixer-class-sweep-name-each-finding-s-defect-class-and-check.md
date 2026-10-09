---
kind: story
size: 3
parent: "5467"
status: open
scope: ["we:skills-src/conveyor/fix-agent-brief.md", "we:skills-src/conveyor/fix-agent-ci-brief.md", "we:scripts/lib/class-sweep-rule.mjs", "we:scripts/conveyor/class-sweep-check.mjs", "we:scripts/lib/review-fix-policy-settings.json"]
dateOpened: "2026-10-08"
relatedTo: ["5466", "5468"]
tags: [fixer, review]
---

# Fixer class sweep: name each finding's defect class and check its sibling paths

Operator 2026-10-08 (fix quality first). The fix and ci-heal briefs require, per finding, the defect CLASS and a check of its sibling paths (same function family, callers, parallel branches, the fix's own new recovery/error paths): each sibling fixed or listed checked / n/a, in a structured class-sweep block in the evidence comment and the recorded sweep. A cheap deterministic check reports a missing or incomplete sweep; mode is a setting (off today, warn first). Evidence: fixer audit 2026-10-08 — 7 findings caused by fixes (uncovered sibling paths #4481, holes in the fix's own recovery code #4433).

## Done when

1. **Executable** — `npm run test:unit` on we:scripts/lib/__tests__/class-sweep-rule.replay.test.mjs and we:scripts/conveyor/__tests__/class-sweep-check.test.mjs fails before this item (the rule and check do not exist) and passes after. The replay fixtures are the real fixer evidence of PRs 4441, 4481 and 4478: none carries a structured sweep, so each reads `missing`.
2. The fix brief (step 3) and the ci-heal brief (step 5) require, per finding, the defect class and the four sibling paths (`family`, `callers`, `branches`, `recovery`), each `fixed` / `checked` / `n/a` with a site and a reason, as one fenced `class-sweep` JSON block.
3. The mode is a declared setting (`classSweep.mode` in `we:scripts/lib/review-fix-policy-settings.json`, env `WE_CLASS_SWEEP`): built-in `off` is today; this host runs `warn` from 2026-10-08. Warn records and never blocks; enforce exits 2 on a missing, malformed or incomplete sweep.
4. The structured sweep is recorded per session under the coordination root (`class-sweep/<session>.json` + `class-sweep/log.jsonl`). Folding it into the completion record itself waits for the completion record v2 envelope (PRs 4436/4439), which owns that file.
5. **Proof** — the next real fixer's evidence comment carries the class and the sibling list, and its `class-sweep/<session>.json` record exists.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the evidence is agent-written: it is only parsed as JSON, never executed or used as a path; the printed line carries codes and counts, never the text; finding ids are cut to a closed character set.
2. **Truncated reads** — evidence and block sizes are bounded before parsing; a block past the bound reads as `missing` (`evidence-truncated-before-block`), never `complete`.
3. **Shared state files** — the per-session record is written to a temp file and renamed; the log is append-only.
4. **Fail closed** — an unreadable evidence file is `missing`; an unknown mode value falls back to the built-in, never to a looser one.
5. **Identity scoping** — the record is keyed by the session slug, checked against the slug grammar; a bad slug writes the log only.
6. **State over time** — the warn start date is a setting (`since`) stamped on every record, for the enforce switch.
7. **Who wrote it** — the mode is read from the WE root running the check, never from the lane, so a lane cannot weaken its own check.
