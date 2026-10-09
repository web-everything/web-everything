---
name: policy-cascade-team-practice
description: delivery policies (merge queue mode, batching, auto-revert, priority, review rounds, quiet hours…) are team practices — declared in the standard, preferred at the platform (Platform Forever) level, overridden per tool/project; the tool delegates to the platform preference when it has no override
metadata:
  type: project
---

A delivery policy is not just a tool setting — it is a **team practice**. Operator, 2026-10-09 (on merge-queue strategies: serial / batched+bisection / staging / auto-revert): these are configs Ship Evermore (the delivery protocol) must support, AND Platform Forever settings, because they express how a team works; the tool (Longshore) delegates to the platform preference in the absence of an override.

So every policy resolves through one cascade:
1. **Standard** (Ship Evermore) — names the policy, its allowed values and a safe default; replay fixtures define behaviour.
2. **Platform preference** (Platform Forever) — the team's chosen practice, declared once for the platform/workspace and shared by every tool.
3. **Tool / project override** (Longshore settings files, per repo) — only when this project deliberately differs.
The tool reads its override first, else the platform preference, else the standard default.

**Why:** the same practice (e.g. "re-test on code changes before merge", "pause builds while main is red", quiet hours) should hold across every repo and tool a team uses; hard-wiring it into one tool's settings duplicates it per tool and lets them drift. It mirrors Web Everything's intents (user preferences consumed by implementations).

**How to apply:** when designing any delivery setting (today's: merge-queue mode, batch size, auto-revert, priority classes, interrupt vs reserve, review round budget, revert-red mode, quiet hours, fixer caps), define it as a standard policy with a default, expose it as a platform-level preference, and make the tool setting an optional override that falls back to the platform. Related: [[project_monetization_strategy]], [[149-operation-limit-fixed-on-prototype]].
