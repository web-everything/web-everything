---
bornAs: x0ymykb
kind: story
size: 5
parent: "5488"
status: open
blockedBy: ["5481", "5483"]
scope: ["we:conveyor/pr-events-worker/**", "we:scripts/docket/**", "we:scripts/progress-board/**", "we:scripts/usage-report/**"]
dateOpened: "2026-10-08"
tags: []
---

# Move the Plateau-bound implementation into plateau-app: pr-events worker, docket, tracker, progress board, PR view, usage report

Plan step 7, widened by ruling S4: move every piece classified Plateau in the ownership map (at least the pr-events Cloudflare worker, decision docket, prototype tracker, progress board, PR view and usage report) into plateau-app with history. Deployed webhooks and the Durable Object keep their names; only the code home changes.

## Acceptance

- [A1] **Executable** — the pr-events worker redeploys from plateau-app under the same name, and the docket and progress pages regenerate byte-identical to the WE-built ones.
- [A2] Every path the ownership map classifies `plateau` is gone from WE, with history carried over.
- [A3] Rollback documented: redeploy from the last WE sha.

## Non-goals

- [N1] Changing deployed webhooks or the Durable Object name.
