---
kind: story
status: open
size: 3
dateOpened: '2026-11-19'
scope: ['we:scripts/lib/agy-sandbox.mjs', 'we:scripts/lib/agy-confined-build.mjs']
tags: [security, agent-infrastructure]
---

# Isolate confined agy logs from unsandboxed sessions

PR #7134 security review identified a shared-state write grant: confined workers can plant entries in the real agy log directory that a later unsandboxed session may follow.

Probe a supported per-run log destination and route confined runs there in `we:scripts/lib/agy-confined-build.mjs`. If the CLI cannot redirect logs, evaluate a private HOME with the minimum login state and prove compatibility before changing production. Post-run cleanup alone leaves a concurrent-reader window and must not be presented as isolation.

Acceptance: a fake worker plants a log symlink targeting an operator fixture; a subsequent unsandboxed fake logger cannot modify the target. Include concurrent sessions and interrupted cleanup. Until isolation lands, the shared log directory remains writable and this risk is explicitly accepted only as an outstanding review finding, not as a confinement guarantee.
