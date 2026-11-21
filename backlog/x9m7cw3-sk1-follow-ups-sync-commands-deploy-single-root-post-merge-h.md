---
kind: task
status: open
scope: ["we:scripts/sync-commands-deploy.mjs", "we:scripts/__tests__/sync-commands-deploy.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# SK1 follow-ups: sync-commands-deploy single root, post-merge hook skill watch, plateau-settings fixture test

SK1 items: sync-commands-deploy is single-root (no --root); the post-merge hook watches only WE skills-src, so plateau-ops skill edits do not trigger a sync; fixture-test the plateau-settings tier-screen and allowlist. Source: build-queue 00:50 ET 2026-11-21.

## Acceptance

- [A1] **Executable** — Planned `deploys only the explicitly selected root` in `we:scripts/__tests__/sync-commands-deploy.test.mjs`: Use two real temporary roots; assert deployment changes only the selected root.
- [A2] **Executable** — Planned `syncs plateau-ops skill edits after merge` in `we:scripts/__tests__/sync-commands-deploy.test.mjs`: Change a plateau-ops skill in a real repository fixture; assert the post-merge path requests its sync.
- [A3] **Executable** — Planned `applies plateau-settings tier-screen and allowlist fixtures` in `we:scripts/__tests__/sync-commands-deploy.test.mjs`: Exercise allowed and forbidden settings at each declared tier; assert allowed values pass and forbidden values are refused.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No unrelated skill deployment changes.

## Edge cases this change must handle

1. **Untrusted text** — Root and setting names remain data.
2. **Truncated reads** — Incomplete skill/settings reads fail the sync visibly.
3. **Shared state files** — Keep fixture roots separate from deployed state.
4. **Fail closed** — Missing root or invalid settings refuse deployment.
5. **Identity scoping** — Resolve sync against the selected root.
6. **State over time** — Cover a plateau-ops edit after merge.
7. **Who wrote it** — Only allowed settings enter the synced output.

## Duplicate admission

nd
