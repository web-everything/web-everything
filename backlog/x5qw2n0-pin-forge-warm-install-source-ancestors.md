---
kind: story
status: open
size: 3
dateOpened: '2026-10-31'
scope: ['we:scripts/readiness/forge-exec-run.mjs', 'we:scripts/readiness/__tests__/forge-exec-run.test.mjs']
tags: [security, forge]
---

# Pin Forge warm-install source ancestors before privileged copying

The PR #6059 review on 2026-10-31 identified a privileged source-path boundary in
`we:scripts/readiness/forge-exec-run.mjs:991`: the CLI checks the source spelling,
but `warmInstall` at line 749 passes the source to `copyLeaves` without pinning the
`<sha>.tmp` parent. A symlinked parent can redirect root reads before manifest
verification. This is a source-reviewed risk; no exploit was run in this repair.
The review explicitly permits tracking it as hardening debt for the single-operator release.

## Acceptance

- Open each source component with descriptor-pinned no-follow semantics before
  copying, following the `ownershipSource` pattern in the same module.
- Reject a symlinked `<sha>.tmp` parent or `tree` leaf with `Invalid warm source`
  or an ELOOP-style refusal before bytes reach the worker-owned tree.
- Test ancestor replacement between validation and copy, invalid source spellings,
  and a valid ordinary source. Keep valid warm installs working.

## Test plan

Extend `we:scripts/readiness/__tests__/forge-exec-run.test.mjs` with a source-parent
symlink pointing to a fixture containing a sentinel file. Assert refusal and no
copied sentinel; also exercise the production privilege boundary on Linux/root.
The fixture must not read real private files. Pin descriptors through the copy
and close them on success and every failure path.

## Non-goals

Do not redesign warm-cache selection, worker allocation, or the sudoers command set.
