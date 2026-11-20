---
kind: story
status: open
size: 1
dateOpened: '2026-11-19'
scope: ['we:scripts/lib/__tests__/agy-confined-launcher.test.mjs']
tags: [testing, agent-infrastructure]
---

# Pin fail-closed canonical secret-path resolution

PR #7134 later-round advisory requested named regressions for unreadable paths and broken symlinks in canonical sandbox deny-path resolution.

Add launcher tests in `we:scripts/lib/__tests__/agy-confined-launcher.test.mjs` for an unreadable ancestor, a broken secret symlink and an absent ordinary path. Assert no spawn and private-temp cleanup for the first two; preserve the nearest-existing-ancestor rule for the third. Use injected filesystem errors where elevated test privileges would make permission bits ineffective.

## Acceptance

- [A1] Planned `refuses unreadable secret ancestor` injects EACCES and EPERM from canonical-path filesystem reads; assert refusal, zero worker spawns and removal of every launcher-owned temporary directory.
- [A2] Planned `refuses broken secret symlink` injects ENOENT from realpath with a successful symlink lstat; assert refusal, zero spawns and the same cleanup. Also cover an intermediate broken symlink, not only the final component.
- [A3] Planned `canonicalizes absent ordinary secret path through nearest existing ancestor` returns ENOENT for genuinely absent components and a canonical existing ancestor; assert that the final profile still denies the complete reconstructed secret path.

All three cases belong in `we:scripts/lib/__tests__/agy-confined-launcher.test.mjs`; run `npm run test:unit -- <test-file>` using that file's repository-relative path after the `we:` prefix. Do not remove the production unavailable guard to exercise the injected prototype seam. The tests are planned, not implemented by this card update.
