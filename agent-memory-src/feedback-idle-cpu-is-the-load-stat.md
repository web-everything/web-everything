---
name: feedback-idle-cpu-is-the-load-stat
description: Judge Mac capacity by idle CPU % (the capacity gate's stat), not load average — macOS load counts disk-waiting work and overstates pressure
metadata:
  type: feedback
---

Idle CPU % is the main capacity stat for the Mac. Load average is not.

**Why:** On 2026-11-14 07:04 ET the orchestrator called load "high" (66 on 12 cores) and proposed holding builds. Idle was 24%, above the capacity gate's 15% floor. Operator: "Isn't idle the main stat here" — "Ok try to remember." macOS load average also counts work blocked on disk (git pack-objects, fseventsd), so it overstates CPU pressure.

**How to apply:** When asked about load or deciding to hold or build, lead with idle % and free memory from the capacity gate. Trust its build/hold verdict. Mention load average only as context, never as a reason to override the gate.
