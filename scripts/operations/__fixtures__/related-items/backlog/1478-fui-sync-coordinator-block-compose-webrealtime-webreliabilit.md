---
kind: story
size: 5
status: parked
parkedReason: maturityGated
maturityTrigger: "externalConsumers>=1"
dateOpened: "2026-06-21"
locus: frontierui
relatedProject: webrealtime
tags: [sync, offline-first, realtime, conflict-resolution, fui-block, deferred]
---

# FUI sync-coordinator block — compose webrealtime + webreliability + change-tracking + mutation for offline replay

The offline-first sync compose recipe ratified by #1420 (no new WE standard), realized as a FUI sync-coordinator block (locus: frontierui). Composes the four ratified homes — webrealtime transport, webreliability durable outbox/replay, change-tracking CustomChangeStrategy merge (LWW default, CRDT opt-in), and the mutation apply/reconcile/rollback intent — and owns ONLY the replay-on-reconnect choreography (FIFO + exactly-once + sync-cursor/checkpoint) that spans homes with no single end-to-end owner. The draft-persistence block shape (compose storage + LWW + presence) is the precedent. Optional/deferred per `we:src/_data/protocols/storage.json`'s bar: build when a real cross-cutting consumer (a collaborative/offline exercise-app feature) appears.
