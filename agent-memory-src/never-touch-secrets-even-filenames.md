---
name: never-touch-secrets-even-filenames
description: "Never read, list or print anything under ~/.secrets, not even file names; on 2026-10-25 the orchestrator listed ~/.secrets/github-apps filenames while debugging the gh shim, a violation."
metadata:
  type: feedback
---

Do not read, list, glob, stat or print anything under `~/.secrets`, including file names.

**Why:** On 2026-10-25 the orchestrator listed the file names in `~/.secrets/github-apps` while debugging the gh shim. Names alone reveal which credentials exist. The operator treats this as a violation, even though no contents were read.

**How to apply:** Debug auth through the shim's own output, its documented env vars, or by asking the operator. Never run `ls`, `find` or `grep -r` on that tree. Brief every subagent with the same rule. See also [[verify-identity-claims-live]].
