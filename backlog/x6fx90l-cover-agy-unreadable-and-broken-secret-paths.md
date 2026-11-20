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
