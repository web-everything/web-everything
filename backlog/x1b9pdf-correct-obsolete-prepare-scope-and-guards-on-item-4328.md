---
kind: task
status: open
scope: ["we:backlog/4328-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md"]
dateOpened: "2026-09-30"
tags: []
---

# Correct obsolete prepare scope and guards on item 4328

The Claude transcript for #4328 explicitly declined: its scope names the #4309 card, two guards refer to a discarded write-queue design, and only the third guard applies. Reconcile the premise and real implementation scope before releasing its prepare hold. A corrected brief alone cannot fix this card.

## Done when

1. Add a regression reproducing the observed refusal from its original launch context; demonstrate red before the cause fix and green afterward.
2. Retain the terminal evidence and cite the removing commit in the reviewed prepare release manifest.
3. Keep the affected prepare hold until both evidence and regression are reviewable.
