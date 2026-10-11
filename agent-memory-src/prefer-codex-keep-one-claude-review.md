---
name: prefer-codex-keep-one-claude-review
description: Claude usage is too high — run workers as Codex workers wherever possible (don't just spawn fewer), keep at least one Claude reviewer seat on every review
metadata:
  type: feedback
---

Operator 2026-10-11: "Claude is using too much usage, we will have to switch more to codex if possible", "I'd still keep at least one Claude review", and "in past weeks have been using codex worker so that should be an option instead of just reducing, we have been using worker to unblock".

**Why:** Claude quota is the binding constraint. A 24h measurement (2026-10-11) showed fixer sessions = 65% of Claude output tokens (457 sessions), orchestrator subagents = 23% (plus the largest cache writes), main orchestrator 4%, ci-heal 3%, prepare 4%. Workers are how stuck PRs get unblocked, so the answer is to move them to Codex, not to stop using them.

**How to apply:**
- Unblocking workers run as **Codex workers**: the task runs in Codex agentic mode (`scripts/codex-direct-task.mjs --task-file=<brief> --dir=<lane>`, synchronous, foreground inside whatever wraps it). Any Claude wrapper stays thin: lane lease, hand the brief to Codex, review the diff, commit, verify, open the PR, edge-load, prove. It never reads or writes code itself unless Codex fails (and says why).
- Conveyor roles route Codex-first through the provider-routing cascade (`we:scripts/lib/provider-routing.mjs`; fixers/builders already support `executor: codex`), Claude as fallback — biggest lever is the fixer.
- Reviews: Codex may replace the SECOND Claude seat, never all of them — always at least one Claude reviewer.

Related: [[148-workflow-lane-model-policy]]
