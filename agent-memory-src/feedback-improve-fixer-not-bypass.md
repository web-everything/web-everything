---
name: feedback-improve-fixer-not-bypass
description: Don't fix conveyor PRs with direct Codex passes; improve the fixer's inputs instead (operator decisions, scope baseline, main-regression check)
metadata:
  type: feedback
---

Don't route a conveyor PR's fix through a direct Codex pass from the orchestrator. Put the operator decision in a sanctioned comment (review-set-label or stand-down-answer body), let the fixer act on it, and improve the fixer when it fails.

**Why:** Operator, 2026-10-17: "Why is a codex pass more efficient than a fixer, we have to keep improving the fixer." The direct passes only won because the orchestrator's brief was better. That is fixing a PR by hand, which the product rule forbids.

**How to apply:** Write decisions as binding fixer input: rulings, the scope baseline sha, the out-of-scope list, and "never weaker than main" for guards. Direct Codex passes are for emergencies only, and are labelled as such. Related: [[feedback-orchestrator-responsive-light-agents]].
