---
name: investigate-before-asking-override
description: "Before asking the operator to raise a cap or grant an override (lane-pool cap etc.), investigate why the cap tripped; a stale fixture lane inflated the check on 2026-10-24 and the operator said 'You could have investigated'."
metadata:
  type: feedback
---

Before asking the operator to raise a cap or approve an override, find out why the cap tripped.

**Why:** On 2026-10-24 the lane-pool cap check blocked work and the orchestrator asked the operator to raise the cap. The real cause was a stale fixture lane inflating the count. The operator replied "You could have investigated". An override request that hides a fixable cause wastes the operator's attention and papers over a bug.

**How to apply:** When a cap, limit or guard blocks you, read the evidence first (claims, leases, run records; see [[search-for-an-operation-before-asking-the-operator]]). Fix or report the real cause, and fix the tooling if it miscounted. Ask for an override only after you can state why the cap is correctly tripped, and say what you checked.
