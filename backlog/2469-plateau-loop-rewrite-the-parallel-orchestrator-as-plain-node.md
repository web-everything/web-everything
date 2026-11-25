---
bornAs: xpqrhnk
kind: story
size: 5
parent: "2445"
status: open
priority: low
blockedBy: ["5488"]
dateOpened: "2026-07-12"
tags: []
---

# Plateau Loop: rewrite the parallel orchestrator as plain Node fan-out over the runner interface

Replace the Claude-Code-coupled Workflow-sandbox orchestrator with plain Node fan-out over the runner interface — removing today's inline-mirror duplication of we:scripts/readiness/lane-partition.mjs. Gated on the runner decision (#2444).

## Preparation finding (2026-08-15) — NOT build-ready; blocked, and its stated premise is stale

**Do not hand this card to a builder as written.** Two independent problems, both verified against live
code/repo state, not inferred:

**1. The stated reason for the rewrite no longer exists.** The card's premise — "removing today's inline-mirror
duplication of `we:scripts/readiness/lane-partition.mjs`" — was true of the OLD (#1933) clone-orchestrator, but
that model was already retired **before this card was even opened**: #2183/#2189 (resolved 2026-07-03) rewrote
`we:skills-src/batch-backlog-items/parallel-execute.workflow.js` into a pure PR-fan-out probe-and-dispatch with
**no partition step at all** ("NO probe→partition… no confidence/monolith/merge-risk predicate" — see the file's
own header comment). Verified directly: the current file has zero references to `RUN_TOOLING`, `mustSerialize`,
`conflicts`, or any other export of `we:scripts/readiness/lane-partition.mjs` — there is nothing left to
un-mirror. Independent confirmation: `#2420` ("Implement RUN_TOOLING self-modifying-item exclusion in the
/workflow partition") — the build arm of decision #2077 that would have created such a mirror — was resolved as
**"superseded by #2183"** (commit `27851393`), i.e. it was never built. `#2422` (open, drain-side RUN_TOOLING
residual) says the same thing in its own words: *"The route-(a) apparatus its build arm #2420 specified was
superseded by the #2183 PR-fan-out orchestrator, which **dissolved** the in-run self-modification hazard."*
`we:scripts/readiness/lane-partition.mjs`'s file-header comment (lines 1–6) claiming the workflow orchestrator
"INLINE-MIRRORS these functions" is itself stale documentation, not current behavior — a separate, already-tracked cleanup (folds into #2422's scope, not a new item).

**2. The real content of "plain Node fan-out over the runner interface" is owned by a sibling decision that is
NOT yet ratified.** The runner interface itself is real and does exist — #2444 ratified 2026-07-16
(`we:docs/agent/platform-decisions.md#agent-runner-cli-backend`) and was built as `plateau:src/build-runner/runner.ts` (`AgentRunner`: `spawn/steer/stop/resume/redirect/observe`, CLI-spawn `claude -p --output-format
stream-json`) — but it is a **single-child, WIP=1** supervisor whose one live caller is `POST
/api/backlog/build` (#2530); there is no existing example of driving N of them concurrently, which is the whole
ask here. More importantly: WHERE a new plain-Node fan-out script would live — WE (today's home of the
orchestrator) vs. plateau-app (today's home of `AgentRunner`) vs. a future fourth "Loop" repo — is exactly the
question `#2446` ("Where does Plateau Loop live") was opened to answer. #2446 is `status: open` (prepared
2026-07-28, **not ratified**), and its own Delegation section names this card directly: *"the actual
extraction/move is already epic #2445's in-flight slice work (e.g. **the orchestrator-as-Node-fanout #2469**…).
This decision only authorizes the canonical home + rollout; the move rides those existing items."* Writing this
card's design/interfaces now would mean silently re-deciding that placement fork inline — exactly what the
story-preparation-checklist's item 4 forbids (`we:agent-memory-src/story-preparation-checklist.md`). Relatedly,
sibling epic child `#2472` (multi-project registry) is explicitly parked "Deferred behind the phase-1 evidence
gate (#2456)" for the same underlying reason — the Loop's build-out is intentionally throttled behind #2456's
still-unmet **≥2-week unattended-operation** evidence bar (last dated review 2026-07-14, ~26h/633 passes, gate
explicitly **not** met as of that entry).

**Recommendation:** stay parked (`blockedBy: 2446`, `priority: low`, as set above). When #2446 ratifies, this
card needs a **fresh scoping pass against the THEN-current shape** of both the orchestrator and the runner
interface, not a build against this text — the orchestrator has already been rewritten once since this card was
filed, and the runner interface did not exist yet when it was filed. Do not build from this card's original
one-line body as-is.
