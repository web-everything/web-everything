---
kind: story
size: 5
status: open
blockedBy: ["2209", "2250", "2251", "2252", "2253"]
scope: ["we:scripts/check-standards-rules.mjs"]
dateOpened: "2026-11-22"
tags: [plateau, design-plan, carried-acceptance]
---

# check:branding validator, icon cleanup and gradient hue-span normalization (carried from #2255)

Carried from closed #2255: after #2209 ratifies, build the check:branding validator in we:scripts/check-standards-rules.mjs (file, gradient id and stop, per-category icon colour consistency), the named icon cleanup for the plateau and frontierui icons, and cross-repo gradient hue-span normalization. Also tracked on plan step DZ-BRAND.

## Acceptance

- [A1] **Executable** — npm run check:branding fails on the current icon set and gradient spans and passes after the cleanup; wired into check:standards. The check enforces every icon viewBox is 0 0 128 128 and every stroke-width is at least 6, and the cleanup fixes the 18 icons below the floor (including weblayout.svg at a 24 viewBox, range-anchor.svg, prefetch.svg and the other 15 named in the closed #2255) so the check passes with none left.



## Non-goals

- [N1] No second severity vocabulary and no work outside the named scope.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
2. **Truncated reads** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
3. **Shared state files** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
4. **Fail closed** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
5. **Identity scoping** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
6. **State over time** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
7. **Who wrote it** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
