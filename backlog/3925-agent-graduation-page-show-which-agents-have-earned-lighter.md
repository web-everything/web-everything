---
bornAs: xj4ksy4
kind: epic
parent: "3383"
status: resolved
scaffoldedBy: "graduation-page-file"
dateScaffolded: "2026-09-22"
scope: ["we:scripts/operations/", "plateau:src/graduation/", "plateau:docs/"]
scopeRationale: "Epic container; each slice carries its own file-level scope and the epic itself writes nothing."
relatedTo: ["3690", "3784", "3893", "3734", "3443"]
dateOpened: "2026-09-22"
dateResolved: "2026-10-25"
graduatedTo: none
tags: [delegation, graduation, supervision, operator-page]
---

# Agent graduation page: show which agents have earned lighter checking, per kind of work, on the operator phone

A mobile-first operator page in plateau-app, sibling of /wip, that shows per agent ({provider, model}) and per kind of work (taskType) how much checking its delegated work gets today, its clean streak toward N, its trial marks, what evidence it still owes, and which triples wait on the operator's ratified promotion. It reads the ratified rule at we:docs/agent/platform-decisions.md#delegation-trial-record-graduation (#3690) through the router, shows unbuilt or undecided criteria as gaps with their card, and never invents a threshold. Operator ask, 2026-09-22: "a page … for agent graduation".

## Design

Design record and mock: `plateau:docs/graduation-page.md` and `plateau:mocks/graduation/graduation-mock.html`
(domain, per-triple states, page states, layout, data contract, transport). "Graduation" here means delegation
graduation of agents, not the prototype branch's graduation to `main` (#3443).

## Slices (in order)

1. `3926` — WE: `graduation-progress-report` returns schema 2 by calling the router.
2. `3927` — plateau-app: the laptop answers a `graduation` ask over the /wip relay; dev route.
3. `3928` — plateau-app: the `/graduation` view in every state, linked from /wip.

## Done when

1. **Executable** — every child is `status: resolved`:
   `node we:scripts/backlog.mjs show 3925` lists no open child.
2. **Observable** — on the running plateau-app dev server, `/graduation` renders the real trial record with the
   `codex · gpt-6-astra · other` row in the Needs-you section, in both themes at 390px and 1280px.
