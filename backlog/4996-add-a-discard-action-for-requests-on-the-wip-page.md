---
bornAs: x693p3m
kind: story
size: 3
status: closed
closedReason: duplicate
closedInto: "6202"
dateClosed: "2026-11-22"
scope: ["plateau:src/wip/", "plateau:src/wip/glance/"]
dateOpened: "2026-10-03"
tags: []
---

# Add a Discard action for requests on the /wip page

Filed from owner request R-482Z9 (story). The operator can file requests from the /wip page but has no way to drop one that was sent by mistake or is no longer wanted. Add a Discard control on each request that, after a confirm step suited to a phone screen, marks it discarded and removes it from the active request list. Assumption: discard is a soft state change (the request is kept, tagged discarded, and any linked card is left untouched), not a hard delete. Done when a request can be discarded from a 366px-wide view and no longer appears among open requests.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
