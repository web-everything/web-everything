---
name: state
description: 'Read the state of PR/card from facts. Triggers: "state of PR/card", "what is happening on #N", "is anyone working on".'
---
# State

Run `node scripts/state.mjs <arg>` from the repository and present its output verbatim.
Never infer state from claims or labels yourself; all logic belongs to the command.

Before dispatching an item from the held list, run `node scripts/held-cards-io.mjs check --item=<N>` (read-only, heuristic): it flags items already on main.
