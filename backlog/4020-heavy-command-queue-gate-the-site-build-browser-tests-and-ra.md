---
bornAs: xxna58l
kind: story
size: 3
parent: "3383"
status: resolved
scope: ["we:package.json", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-09-23"
dateStarted: "2026-09-23"
dateResolved: "2026-09-23"
graduatedTo: one-off
tags: []
---

# Heavy-command queue: gate the site build, browser tests and raw vitest runs

Commands that load the machine but skip the queue: the eleventy site build (npm run build), the browser tests (playwright / smoke), plain npm test (vitest), and direct npx vitest run from a session. On the prototype, test:unit and check:standards in we:package.json are also still raw (main already wraps them, 3785). Wrap each in we:scripts/readiness/heavy-admission.mjs run in we:package.json, and extend the we:scripts/guard-bash.mjs raw-heavy-command check so a session's direct vitest / playwright / eleventy call is routed through the queue (a single targeted test file stays allowed if its cost is small — decide the threshold from measured timings and record it). Prototype work under #3383: build on lane/mechanical-dispatcher and commit there (no PR, one tracker note per push); the card lives on main; it reaches main through graduation slice #3916 (heavy-admission) or #3917 (dispatch-plan), whose merge notes must union it. Operator ask 2026-09-23: queue many stories and let the AI progress, but limit how many heavy commands run at once. Observed 2026-09-23 on the laptop: load average about 60 against the host core count with the admission cap at 2.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
