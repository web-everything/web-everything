---
name: verify-identity-claims-live
description: "Before telling the operator which GitHub App, identity or permission a daemon uses, verify it live from the daemon's own environment and from evidence (timeline actor, installation permissions), never from the orchestrator shell."
metadata:
  type: feedback
---

Prove which identity or permission a daemon uses before stating it.

**Why:** On 2026-10-25 the orchestrator made two wrong claims (legacy app, then reviewer, then worker) based on its own shell. The evidence showed `plateau-worker` (contents:write) can mark a PR ready and `plateau-reviewer` (contents:read) cannot. The orchestrator shell's identity is not the daemon's.

**How to apply:** Check from the daemon's own environment, then confirm with outside evidence: the PR timeline actor and the installation's permissions. Say which evidence you used. If you only have a guess, label it a guess. See [[never-touch-secrets-even-filenames]] for what not to inspect.
