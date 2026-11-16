---
kind: task
status: open
scope: ["we:skills-src/conveyor/prepare-item-agent-brief.md"]
dateOpened: "2026-09-30"
tags: []
---

# Make prepare lane acquisition valid from dispatch scratch sessions

The #4560 transcript reports lane acquisition failed because its scratch cwd had no origin URL. An explicit-origin attempt was then denied by the permission classifier. Prove an authorized acquisition path from the actual scratch launch context and encode a regression; do not retry or route around the denial. No listed overnight fix proves both causes removed.

## Done when

1. Add a regression reproducing the observed refusal from its original launch context; demonstrate red before the cause fix and green afterward.
2. Retain the terminal evidence and cite the removing commit in the reviewed prepare release manifest.
3. Keep the affected prepare hold until both evidence and regression are reviewable.
