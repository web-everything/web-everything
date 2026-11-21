---
name: providers
description: Choose or run a provider CLI for a task - which provider to use, Claude vs Codex vs Gemini, `claude`, `codex exec`, or agy (Antigravity, the Gemini CLI). Use when asked "which provider", "use Gemini", "hand this to agy", "use Codex", or when unsure which agent CLI fits a job.
---

# Which provider CLI for this job

Routing only. The method lives in the linked files; do not restate it here.

- **`claude`** - the default seat for orchestration, judgment and review.
- **`codex exec`** - code changes (workspace-write) and read-only audits. Run through `we:scripts/codex-direct-task.mjs`; audits must pass `--review`.
- **`agy`** (Antigravity, the Gemini CLI) - an escape hatch for one delegated coding task when Claude or Codex quota is low. It edits files and has no real sandbox. Run through `we:scripts/gemini-direct-task.mjs`; see the `use-gemini` skill. It is not a read-only research seat.

Capability and permission differences per CLI: `we:docs/agent/agent-cli-capability-map.md`.

Headless `agy` auto-denies tools unless permissions allow them. Never use skip-permission flags to get around that.
