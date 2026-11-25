---
bornAs: x4khjph
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

# Prevent horizontal elastic scroll on mobile in the WIP page

Filed from owner request R-H2JH3 (story). On mobile, the /wip page can be dragged sideways and shows elastic overscroll past its left and right edges. Done means the page stays fixed in width on narrow screens (checked at 366x747 in the lane/wip-quickview build) and vertical scrolling is unchanged. The likely fix is overflow-x control on the page root and the wip layout, plus checking any wide child such as the focus picker or board rows. Scope assumes the whole page, not one section.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Superseded by plan step DZ-SHELL (PL-WIP-CLEANUP, 2026-11-22). Unfinished acceptance carried to DZ-SHELL: no horizontal elastic scroll on mobile, as a shell acceptance rule.
