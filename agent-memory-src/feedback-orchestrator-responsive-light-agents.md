---
name: feedback-orchestrator-responsive-light-agents
description: Orchestrator session — avoid blocking commands, delegate investigations to lighter background agents, and route fixes to Codex
metadata:
  type: feedback
---

In the operator orchestration session, stay responsive. Avoid long blocking foreground commands. Run long checks and waits in the background (Bash run_in_background, or Codex runs that move to the background on their own). Delegate investigations and data gathering to lighter background agents (Haiku or Sonnet), not to Opus working inline.

**Why:** Operator, 2026-10-16: "Remember, avoid blocking cmd to stay responsive" and "use lighter agent for work". This came after the weekly Claude allowance ran out and stalled the conveyor overnight. They also said "use more other agents": fixes go to Codex (codex-direct-task), with no Claude helper.

**How to apply:** Opus handles decisions, approvals and short checks. Read-only research goes to a background Haiku or Sonnet Agent. Code fixes go to Codex in a lane. Waits use background Bash. Relates to [[operator-session-portable]].
