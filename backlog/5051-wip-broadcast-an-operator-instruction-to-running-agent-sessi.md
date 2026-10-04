---
bornAs: x4lad92
kind: story
size: 8
status: open
scope: ["plateau:wip-relay.js", "plateau:scripts/wip-publish.ts", "plateau:src/wip/glance/glance-view.ts"]
dateOpened: "2026-10-03"
tags: []
---

# WIP: broadcast an operator instruction to running agent sessions

Operator ask (2026-10-03): a "Message agents" action on the WIP page that sends one instruction to the running agent sessions, to all of them or filtered by kind (fix, ci-heal, build, review) or repo. The text is recorded verbatim with the operator's identity and the time. Delivery status is shown per session, live (delivered, held, refused). A durable record with an expiry (default 4 hours, a config dimension) lets sessions that start later read it through the dispatched-agent brief. A broadcast can never grant approval or clear a review gate: the wrapper says so and obvious approval wording is refused.

Finding that shapes the build: the claude CLI has no command to send a message into a running background session (it offers attach, logs, stop, respawn and agents --json only). Delivery has to ride a hook: a UserPromptSubmit or PostToolUse hook that reads the active broadcasts at a session's next step, injects them as a relayed operator instruction, and records delivered for that session; until then the session shows held. Hooks live in settings files, so installing one needs the operator's approval.

Build: relay action agent-broadcast in plateau:wip-relay.js; laptop handler and store in plateau:scripts/wip-publish.ts (records under .operations/broadcasts/); the hook script; the hook into the dispatched-agent brief; the page action and per-session status in plateau:src/wip/glance/glance-view.ts. Done when a broadcast reaches at least two real running sessions and a session started afterwards sees it.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
