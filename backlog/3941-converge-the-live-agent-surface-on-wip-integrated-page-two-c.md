---
bornAs: xjusaki
kind: story
size: 3
parent: "3931"
status: open
locus: plateau-app
blockedBy: ["3939", "3940"]
dateOpened: "2026-09-22"
tags: []
---

# Converge the live agent surface on /wip — integrated page, two clean review rounds in both themes, webcases per state

Build-UI phases 5–7 (we:docs/agent/build-ui.md) for the live agent surface: every state of plateau:docs/wip-live-agent.md §5 on the integrated page at 390px and ≥ 900px, fresh-reviewer rounds on the pixels until two in a row are clean, and one webcase per state.

## Done when

1. **Executable** — a webcase conformance test in plateau-app with one case per §5 state id passes under `npx vitest run`.
2. **Recorded** — the design doc's review history lists two consecutive fresh-reviewer rounds (light + dark, 390px and ≥ 900px) with zero MUST-FIX.

Merged into plan step PD-LIVE (PL-WIP-CLEANUP, 2026-11-22).
