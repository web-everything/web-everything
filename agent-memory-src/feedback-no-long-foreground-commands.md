---
name: feedback-no-long-foreground-commands
description: Don't run long commands (verify, open-pr, multi-minute waits) in the orchestrator's foreground; delegate to a background subagent or background job
metadata:
  type: feedback
---

The operator asked on 2026-10-03 ~21:35 ET: "I would appreciate if you stop running long command on foreground".

**Why:** multi-minute foreground calls block the chat.

**How to apply:** quick reads only in the orchestrator's foreground. Card filing, lane verify, open-pr and fixes go to a background subagent, which runs verify in ITS own foreground to satisfy the synchronous-gate rule. Waits use background jobs or Monitor.
