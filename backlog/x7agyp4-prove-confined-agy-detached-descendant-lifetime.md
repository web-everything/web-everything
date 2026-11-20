---
kind: story
status: open
size: 3
dateOpened: "2026-11-20"
scope: ['we:scripts/gemini-direct-task.mjs', 'we:scripts/__tests__/gemini-direct-task.test.mjs', 'we:scripts/lib/agy-confined-build.mjs', 'we:scripts/lib/__tests__/agy-confined-build.test.mjs']
tags: [security, testing, agent-infrastructure]
---

# Prove detached agy descendants cannot outlive successful evidence

PR #7134's 2026-11-20 security advisory identified that stopping the original process group does not establish termination of a descendant that creates a new session. Add real process coverage on Darwin and non-Darwin hosts; kill-call mocks cannot establish descendant lifetime. Keep the production unavailable gate closed.

## Acceptance

- [A1] Planned `real detached descendant cannot yield successful exclusive transcript` in `we:scripts/__tests__/gemini-direct-task.test.mjs`: a fake Node worker spawns a detached Node child that starts a new session, retains stdout and periodically updates a dummy log fixture. Prove the child was running independently; after parent exit assert either the descendant is dead or the run is explicitly voided within a bounded deadline. Never return successful evidence while the child remains alive. Verify fixture bytes stop changing when termination is claimed.
- [A2] Planned `voids build when descendant shutdown is unproved` in `we:scripts/lib/__tests__/agy-confined-build.test.mjs`: feed the real runner's nonterminal or failed shutdown outcome into the build path; assert zero applied files and provider fallback. Parameterize normal exit, timeout, spawn error and interruption, with inherited pipes both open and closed.
- [A3] The fixture records and cleans up only its own child PIDs in a finally path, including assertion failure; verify no child or pipe survives the test. Run `npm run test:unit -- <test-files>` using the A1/A2 files' repository-relative paths after the `we:` prefix on Darwin and a non-Darwin host.

These are planned cases. No machine-wide process termination, new process grants or enablement. A process-fork restriction may be an alternative only if a real probe proves it blocks this detached-child shape while required worker behavior remains supported. Shared log isolation is separately tracked in #x9ffusk.
