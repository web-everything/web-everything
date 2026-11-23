---
bornAs: xt9bmkj
kind: story
size: 5
status: open
blockedBy: ["2209", "2250", "2251", "2252", "2253"]
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:src/_layouts/base.njk", "plateau:branding.html", "we:package.json", "we:src/assets/icons", "we:src/assets/logo.svg", "we:src/assets/favicon.svg", "frontierui:src/assets/logo.svg", "plateau-app:favicon.svg"]
dateOpened: "2026-11-22"
tags: [plateau, design-plan, carried-acceptance]
---

# check:branding validator, icon cleanup and gradient hue-span normalization (carried from #2255)

Carried from closed #2255: after #2209 ratifies, build the check:branding validator in we:scripts/check-standards-rules.mjs (file, gradient id and stop, per-category icon colour consistency), the named icon cleanup for the plateau and frontierui icons, and cross-repo gradient hue-span normalization. Also tracked on plan step DZ-BRAND.

## Acceptance

- [A1] **Executable** — npm run check:branding fails on the current icon set and gradient spans and passes after the cleanup; wired into check:standards. The check enforces every icon viewBox is 0 0 128 128 and every stroke-width is at least 6, and the cleanup fixes the 18 icons below the floor (including weblayout.svg at a 24 viewBox, range-anchor.svg, prefetch.svg and the other 15 named in the closed #2255) so the check passes with none left.
- [A4] Carried from #2255 (full done-when): we:src/_layouts/base.njk carries the small-variant favicon link only if #2251's resolution says a variant shipped, otherwise this is stated N/A in the PR; plateau.svg and frontierui.svg icons visually match frontierui:src/assets/logo.svg and plateau-app:favicon.svg, verified by eye against plateau:branding.html after regeneration; the check:branding validator lives in we:scripts/check-standards-rules.mjs, is wired into we:scripts/check-standards.mjs, and the icons pass it or every remaining failure is a grandfathered exception named in the validator (no silent skip); weblayout.svg, webtraces.svg and range-anchor.svg no longer violate the floors; plateau:branding.html is regenerated and shows every changed asset; hue-span normalization edits only hue spans, never glyph or construction (those stay with #2251, #2252, #2253); one PR per repo touched, the validator may ship as a warning first and flip to blocking after remediation.
- [A3] Carried from #2255: the favicon consumer link wiring is done where the ratified favicons are consumed, and the we:src/assets/icons/webtraces.svg placeholder (the unmodified _template.svg content) is replaced by a real icon; the check fails while the placeholder remains.
- [A2] The regenerated icon gallery is checked visually against the shipped marks, and the standards checks pass in every touched repository (web-everything, frontierui, plateau-app).



## Non-goals

- [N1] The scope covers the icon assets and the cross-repo mark files.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
2. **Truncated reads** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
3. **Shared state files** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
4. **Fail closed** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
5. **Identity scoping** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
6. **State over time** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
7. **Who wrote it** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
