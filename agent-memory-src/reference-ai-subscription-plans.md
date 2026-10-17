---
name: reference-ai-subscription-plans
description: The operator's AI subscription line-up and what each is best spent on; budget agent work against it
metadata:
  type: reference
---

Plans (operator, 2026-10-16): 2× Claude Max 20x, 1× Google AI Ultra 20x (Gemini / Antigravity `agy`), 1× Codex 500.

- Claude: the largest pool. Opus is for the orchestrator's decisions. Daemons default to Sonnet (#5382). The weekly cap still ran out about 2–3 days into the week of 10-13 at about 580M tokens/day.
- Codex: the bulk worker and the bulk non-Claude reviewer. No exhaustion seen.
- Gemini: half Claude's capacity. Run on every PR (about 280 sessions/day) it ran out in about 1.5 days (10-13 to 10-15), and quota-held seats silently fell back to Claude Opus. Use it where it adds the most value: a third-vendor seat on high-care PRs (gate, guard, security, human-only), long-context research and juries, and design or visual review. Daily cap, never on every PR (#5441 and the high-care follow-up).

Relates to [[feedback-orchestrator-responsive-light-agents]] and [[prefer-codex-keep-one-claude-review]].
