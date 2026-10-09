---
bornAs: xnfbsxx
kind: story
size: 2
parent: "5488"
status: open
blockedBy: ["5497"]
scope: ["we:packages/longshore/LICENSE", "we:packages/longshore/NOTICE"]
dateOpened: "2026-10-08"
tags: []
---

# Publish Longshore under Apache-2.0 after the flip and a clean history scan

Ruling S6: the Longshore licence is Apache-2.0 and the repo goes public only after the daemon switch-over (the flip) and a clean secret scan of the published history. Add the LICENSE and NOTICE, re-run the scan on the final history, then the operator flips visibility.

## Acceptance

- [A1] **Executable** — the published repo has an Apache-2.0 LICENSE and a secret scan of its full history is clean, with the report linked.
- [A2] The operator flips the repo to public; the card records the date.

## Non-goals

- [N1] Ruling the open line (#5410); its current default is consistent with this ruling.
