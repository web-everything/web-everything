---
kind: decision
size: 2
parent: "xliqbhq"
status: open
dateOpened: "2026-10-08"
tags: []
---

# Licence for the open delivery standard and kernel: Apache-2.0, AGPL or Fair Source

Source: AI Delivery Landscape research brief, 2026-10-08, section 'Where the open line sits' (licence options and 'pick the licence once'). Options: Apache-2.0 for the most adoption (brief's recommendation for the open parts); AGPL to deter closed clones while staying open source (Grafana, Redis 8, Elastic); Fair Source (FSL) if two years of non-compete matter more than being called open source. Market evidence: HashiCorp's BSL switch cut community PRs from 21% to 9% and produced OpenTofu; Redis relicensed and reversed after ~14 months. The standard and kernel may take different licences. Operator's call; not ruled here.

## Done when

1. **Executable** — n/a: a decision, no code. Tier 3 instead: the card is prepared (`/prepare`: options, rejection reasons, bold default, `preparedDate`), then the operator rules it and the ruling is recorded on the card; the chosen licence(s) per tier are recorded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
2. **Truncated reads** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
3. **Shared state files** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
4. **Fail closed** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
5. **Identity scoping** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
6. **State over time** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
7. **Who wrote it** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
