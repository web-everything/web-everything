---
kind: story
status: open
size: 3
dateOpened: '2026-10-31'
scope: ['we:scripts/readiness/forge-exec-run.mjs', 'we:scripts/readiness/forge-exec-bases.mjs', 'we:scripts/readiness/__tests__/forge-exec-run.test.mjs']
tags: [security, forge]
---

# Pin Forge warm-install source ancestors before privileged copying

The PR #6059 review on 2026-10-31 identified a privileged source-path boundary in
`we:scripts/readiness/forge-exec-run.mjs:991`: at reviewed head `068dcb1db9`, the
CLI checked the source spelling, but `warmInstall` at line 749 passed the source
to a `copyLeaves` implementation that did not pin the `<sha>.tmp` parent. A
symlinked parent could redirect root reads before manifest verification.
The later automatic policy ruling blocks this finding; tracking it
as hardening debt alone does not satisfy that ruling.

## Implementation evidence

Merge `93aa7025a1` replaces the pathname-based `copyLeaves` implementation in
`we:scripts/readiness/forge-exec-bases.mjs` with `verifiedCopySource`. It opens
every absolute source ancestor and nested directory relative to a pinned
descriptor using `O_DIRECTORY | O_NOFOLLOW`, and reads regular, singly linked
leaves through no-follow descriptors. It verifies the pinned bytes' digest and
executable bit before creating a destination leaf. Warm installation and both
delta-assembly copies use this shared helper.

`we:scripts/readiness/__tests__/forge-exec-run.test.mjs` covers symlinked source
components, replacement of pinned ancestors, digest mismatch, FIFO and hardlink
refusals, and ordinary warm-install success. The Linux/root sentinel case is
explicitly skipped on other hosts. A focused run on 2026-10-31 passed 287 tests
with 3 skipped. This card remains open pending review of that implementation.

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
