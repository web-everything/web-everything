---
name: full-delegation-covers-workflow-clearances
description: "Operator R952 'You have still full authority' means the orchestrator clears workflow-file PRs itself once the advisory is accepted, the red-team is clear and required CI is green; only rule-14 hard lines go to the operator."
metadata:
  type: feedback
---

**Operator ruling R952: "You have still full authority."** Full delegation covers the clearance of
workflow-file PRs. The orchestrator clears such a PR itself when all three hold:

- the advisory review is accepted,
- the red-team check is clear,
- the required CI check is green.

Do not park these for the operator. Only the rule-14 hard lines go to the operator.

**Why:** asking the operator to approve a PR that already meets the clearance conditions adds a human
step with no new information, and stalls the queue.

**How to apply:** before escalating a workflow-file PR, check the three conditions above. If they hold
and no rule-14 hard line applies, clear it and record the clearance; if one fails, fix that, do not
escalate it.
