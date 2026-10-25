---
name: paid-capacity-state-dollars-per-hour
description: "Every ask for paid capacity (CI runners, machines) must quote $/hour (machines x per-minute rate x 60) and hours-to-budget; track live spend from job minutes because billing lags hours. Default CI to free runners."
metadata:
  type: feedback
---

State the cost in dollars per hour, and hours until the budget is gone, with every paid-capacity ask.

**Why:** On 2026-10-24 a GitHub 8-core paid runner burned $75 of a $100 budget in about 4 hours at up to 20 machines. Billing data lagged by hours, so the overrun was invisible until late. The paid runner was deleted (R80-R83).

**How to apply:** Quote `machines x per-minute rate x 60` as $/hour, plus hours-to-budget at that rate, before asking or enabling anything paid. Track live spend from job minutes, not the billing page. Default CI to free runners; paid capacity is an explicit, budgeted exception. Related: [[full-concurrency-is-the-default-never-a-cost-judgment]].
