---
bornAs: xu48h7u
kind: story
size: 1
parent: "2562"
status: open
scope: ["plateau-app:src/backlog-view/proof-tiers.ts", "plateau-app:src/backlog-view/proof-tiers.test.ts"]
dateOpened: "2026-09-07"
dateStarted: "2026-09-13"
tags: []
---

# Harden the proof-tiers evidence-link sanitizer against protocol-relative/open-redirect URLs

plateau-app:src/backlog-view/proof-tiers.ts's safeHref() (we:backlog/2759-proof-provenance-tier-spine-agent-asserted-tier-review-surfa.md) allowlists the http(s) scheme but not the host, so a bottom-tier agent-asserted evidence.url like '//attacker.example/phish' resolves to https: and passes through verbatim as a live, trustworthy-looking href once wired into the future review surface (we:backlog/2555-real-launch-review-console-board.md) — add a same-origin (or explicit host-allowlist) check alongside the scheme check in plateau-app:src/backlog-view/proof-tiers.ts, with an integration-style test in plateau-app:src/backlog-view/proof-tiers.test.ts asserting a protocol-relative/cross-host URL is neutralized the same way a javascript:/data: URL already is.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
