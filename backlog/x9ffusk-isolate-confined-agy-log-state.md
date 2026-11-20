---
kind: story
status: open
size: 3
dateOpened: '2026-11-19'
scope: ['we:scripts/lib/agy-sandbox.mjs', 'we:scripts/lib/agy-confined-build.mjs', 'we:scripts/lib/__tests__/agy-confined-launcher.test.mjs']
tags: [security, agent-infrastructure]
---

# Isolate confined agy logs from unsandboxed sessions

PR #7134 security review identified a shared-state write grant: confined workers can plant entries in the real agy log directory that a later unsandboxed session may follow.

Probe a supported per-run log destination and route confined runs there in `we:scripts/lib/agy-confined-build.mjs`. If the CLI cannot redirect logs, evaluate a private HOME with the minimum login state and prove compatibility before changing production. Post-run cleanup alone leaves a concurrent-reader window and must not be presented as isolation.

## Acceptance

Planned cases in `we:scripts/lib/__tests__/agy-confined-launcher.test.mjs`, run with `npm run test:unit -- <test-file>` using that file's repository-relative path after the `we:` prefix:

- [A1] `isolates worker-planted log symlink from later host logger`: a fake worker plants a link to a dummy operator fixture in its own log tree; a subsequent unsandboxed fake logger writes its legitimate log. Assert target bytes and metadata are unchanged and the host logger never opens a worker-owned pathname.
- [A2] `isolates logs during concurrent confined and host sessions`: hold the worker after planting the link and start the host logger before worker cleanup. Assert unchanged target bytes, disjoint log destinations and continued host logging. Repeat with two confined sessions to prove per-run identity.
- [A3] `isolates logs when confined cleanup is interrupted`: interrupt after link creation and before cleanup; run the host logger while the abandoned tree remains. Assert unchanged target bytes and no host traversal into the abandoned tree. Exercise success, refusal, timeout and interrupted cleanup separately.
- [A4] `refuses unsupported private log destination`: when a per-run destination or private login state cannot be established, assert no worker spawn, provider fallback and no shared-HOME write grant added as a fallback.

These are planned regressions, not passing proofs. Until isolation lands, the shared log directory remains writable and is an outstanding review risk, not a confinement guarantee. Production must remain unavailable. Detached descendant lifetime is tracked separately in #x7agyp4.
