---
kind: epic
parent: "2445"
status: open
dateOpened: "2026-10-08"
tags: []
---

# Delivery standard: protocol home, open kernel and Plateau Loop as three tiers

Source: AI Delivery Landscape research brief, 2026-10-08, sections 'Proposed structure', 'Thirteen gaps' and 'What you already have'. No open standard covers running a whole AI delivery (roles, authority, handoffs, review verdicts, merge authority, human gates, policy, run record, cost, learning). The brief proposes three tiers, matching the operator direction of 2026-10-07/08: (1) a protocol home with zero implementation (JSON schemas, role registry, policy dimensions, glossary, conformance cases and verifier, bindings to MCP, A2A, OTel, in-toto, SARIF, Agent Trace); (2) an open kernel (state machines, validators, operations engine, one runtime and one forge binding, runs each step on request on one repo); (3) Plateau Loop as the paid product (#2445). First protocol set: core v0 = Work Item, Role and Authority, Handoff, Verdict, Integration Authority, Policy; next = Gate, Run Record, Decision Record, Learning, Cost. Minting rule: a protocol only where two roles can be filled by different vendors. Web Everything becomes the first adopter, not the host. Open forks are filed as child decisions; slice only after they are ruled.

## Covered elsewhere (not re-filed)

- Engine/kernel home: #2446 (option (b), own repo). The brief adds an open-kernel vs paid-autopilot split that #2446 should weigh.
- Policy as configurable dimensions: #4376 / #4305.
- Decouple dispatch from Claude Code: #3369 / #3580.
- Forge-neutral state (GitHub labels as state store): #4607, #2742.
- Decision Record protocol: #2575. Cost and budget: #2531, #4377, #4820.
- Run record envelope: #5348. Dispatch contract wiring: #4180.
- Shareable method and starter kit: #563 / #1678. "Provable conformity" product edge: #3049.

Gap with no card yet: a Releaser/Operator role (deploy, watch, incidents). Not filed; nothing in the constellation deploys yet.

## Done when

1. **Executable** — n/a: an epic. Done when every child decision is ruled and the protocol home holds the core v0 protocols (Work Item, Role and Authority, Handoff, Verdict, Integration Authority, Policy) with conformance cases that a reference kernel passes.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: an epic; each slice carries its own edge cases.
2. **Truncated reads** — n/a: an epic; each slice carries its own edge cases.
3. **Shared state files** — n/a: an epic; each slice carries its own edge cases.
4. **Fail closed** — n/a: an epic; each slice carries its own edge cases.
5. **Identity scoping** — n/a: an epic; each slice carries its own edge cases.
6. **State over time** — n/a: an epic; each slice carries its own edge cases.
7. **Who wrote it** — n/a: an epic; each slice carries its own edge cases.
