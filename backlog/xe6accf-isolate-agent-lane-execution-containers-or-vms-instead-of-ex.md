---
kind: decision
status: open
scope: ["we:docs/agent/"]
dateOpened: "2026-10-04"
tags: []
---

# Isolate agent/lane execution (containers or VMs) instead of exempting dev tools from macOS malware scanning

Operator 2026-10-04: the host was overloaded, and macOS XProtect alone took ~30% CPU rescanning fresh tool binaries in ~90 lane clones plus every git/node spawn. As a stopgap the operator enabled the macOS Developer Tools exemption (spctl developer-mode; Terminal + VS Code), so processes launched from those apps skip XProtect/Gatekeeper assessment. That weakens host protection for everything agents, Codex and tests run. We want a better security posture: run agent/lane/Codex execution inside isolated environments, then remove the exemption.
Options to research:
(a) per-lane or per-agent containers (Docker/OrbStack/Apple Containerization framework) with the lane mounted;
(b) a lightweight Linux VM (e.g. Lima/OrbStack) hosting the lane pool and the daemons;
(c) cloud VMs (we already have VM-session docs);
(d) the status quo with a narrower exemption.
Weigh: CPU/IO cost (fseventsd and XProtect load move off the host), git/gh credential scoping per sandbox (ties to the per-daemon credential question in the runner-split item), dev-server/port access, and the cost of migrating the daemons.
Done when: a ruling picks the isolation approach and a slice plan exists, and the exemption-removal step is named.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
