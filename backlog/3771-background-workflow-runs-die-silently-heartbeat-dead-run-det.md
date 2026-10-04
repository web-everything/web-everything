---
bornAs: x0y6xk4
kind: story
size: 5
parent: "3383"
status: resolved
scope: ["we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/review-dispatch.mjs"]
dateOpened: "2026-09-20"
dateResolved: "2026-10-03"
tags: []
---

# Background workflow runs die silently: heartbeat, dead-run detection, resume path, and a subscribe-with-retry helper

FOUND 2026-09-20. (1) A background workflow run died silently. The jury run wf_de7a8ca4-29f (task wy05njq9e) stopped making progress after a session reconnect. Confirmed from its journal: it holds 14 lines, ending at the round-2 panel start (one started record with no result, then a restarted panel that logged failed, then a reduce that returned needs-human with every lens unknown); the harness no longer tracked the task (a stop request returned no such task); no completion notice arrived; it was found only by a manual journal read about 45 minutes later; resuming from the saved run id worked. The journal records carry a type, key, agent id, label and phase and NO timestamp, so a reader cannot tell a run that is thinking from one that is dead. (2) Subscribing to an idle notice for a just-spawned claude --bg session failed once with "No agent named ... is reachable" and succeeded a few seconds later (reported by the orchestrator, seen once, not reproduced here). DESIGN: a heartbeat or completion record per background run (a small file the run writes at each step and at the end, with a timestamp), detection of a dead run (heartbeat older than a bound while the task is untracked), a documented resume path (resume from the saved run id, what to check first), and a subscribe-with-retry helper for dispatch (short bounded retries with a clear final error, so a spawn race is not read as a permanent failure). Link to, do not duplicate, the hand-dispatch card (backlog 3752, which makes every dispatch subscribe to an idle notice) and to the orchestrator status view card filed alongside this one (it should show run liveness from this heartbeat). Related jury relay failures live in backlog 3741. DESIGN TO SETTLE: (1) who writes the heartbeat (the workflow script, the harness, or the run wrapper) and where; (2) the dead-run rule and its bound, so a long round is not called dead; (3) whether resume is automatic on detection or only reported to the orchestrator; (4) the retry count and delay of the subscribe helper and where it lives (the dispatch scripts under we:scripts/operations/, shared by the hand path). ACCEPTANCE: a test with a run whose heartbeat is older than the bound and no tracked task is classified dead and names the resume command; a completed run is classified done from its completion record; the subscribe helper retries a fake unreachable-agent error twice then succeeds, and after the limit fails with the last error.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
