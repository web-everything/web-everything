---
name: misses-improve-tooling-not-demote
description: A delegated model's miss defaults to automated attribution + a tooling fix, never a human gate or automatic demotion; demotion is the narrow exception, not the default.
metadata:
  type: feedback
---

When a delegated model (Codex/Gemini/etc.) makes a mistake, the default is automated attribution (no human in the loop) and a tooling/instruction fix; no step back to full review or loss of graduation unless the miss is critical AND cannot be fixed by tooling. Human confirmation is never the default path.

**Why:** the operator rejected #4029's first prep (2026-09-24), which made demotion automatic (unconditional step-back to `full` on any confirmed miss) and root-cause classification human-authored + human-confirmed. Both contradict [[failure-is-a-product-improvement]] ("we always take failure as an opportunity to improve our product, never as a problem that needs manual intervention"). The corrected shape treats a delegated model's miss exactly like any other tooling/product failure: fix the tooling, keep going — demotion and human gates are the narrow, named exception (critical + unfixable-by-tooling), not the default posture.

**How to apply:** when drafting forks or defaults on supervision, graduation, or failure-handling mechanisms (a model's miss, a daemon's stall, a gate's refusal), default to automated attribution + a tooling/instruction fix that keeps the current level; treat demotion, probation, or a required human checkpoint as the exception, and define "critical" and "cannot be improved/unfixable" concretely (ground them in an existing measure already in code — e.g. an escalation-risk or never-spot-check proxy, or "a fix landed and the same failure recurred" — rather than inventing a fresh scale or leaving them as vague judgment calls a human must exercise every time).
