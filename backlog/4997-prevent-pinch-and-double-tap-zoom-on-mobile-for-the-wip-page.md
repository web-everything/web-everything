---
bornAs: x6ugywx
kind: story
size: 2
status: closed
closedReason: duplicate
closedInto: "6202"
dateClosed: "2026-11-22"
scope: ["plateau:src/wip/", "plateau:src/wip/glance/"]
dateOpened: "2026-10-03"
tags: []
---

# Prevent pinch and double-tap zoom on mobile for the WIP page

Filed from owner request R-V2G2G (story). Operator reports the /wip page zooms on mobile (pinch and double-tap), which breaks the phone layout. Done when pinch-zoom and double-tap zoom no longer occur on /wip pages on a phone, via the viewport meta (maximum-scale=1, user-scalable=no) and touch-action: manipulation on the page root. Assumption: scope is the /wip pages only, not the rest of the app; input focus zoom on iOS is also prevented by keeping form control font size at 16px or larger.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Superseded by plan step DZ-SHELL (PL-WIP-CLEANUP, 2026-11-22). Unfinished acceptance carried to DZ-SHELL: no pinch or double-tap zoom on mobile, as a shell acceptance rule.
