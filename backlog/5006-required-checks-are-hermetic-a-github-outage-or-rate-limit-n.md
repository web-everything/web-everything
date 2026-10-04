---
bornAs: x155hmp
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:.github/workflows/soak-replay-gate.yml", "we:.github/workflows/ci.yml", "we:config/platformDefaults.ts", "we:config/defineConfig.ts", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Required checks are hermetic: a GitHub outage or rate limit never fails a PR or turns main red

Operator ruling 2026-10-03. Live: PR #3828's required soak-replay-gate failed at 18:49Z with 'gh: API rate limit exceeded for installation', because we:.github/workflows/soak-replay-gate.yml calls the API to read the live PR body. A required check that depends on GitHub's API budget makes good code look broken, and on main it reads as main-red and blocks every PR. Fixed rules: (1) soak-replay-gate reads the PR body from the workflow's event payload (github.event.pull_request.body), not the API; this is the cheap first step. (2) Tests never call real gh or the network; they use recorded responses. Any live-GitHub test moves to a non-required scheduled group that alerts but never gates. (3) A guard fails any required test that spawns gh or opens a network socket. Configurable (config-extends-platform-default, we:config/platformDefaults.ts and we:config/defineConfig.ts): ciChecks.onGithubUnavailable = retry-then-neutral (default) | fail | skip, plus a retry budget; a neutral 'could not run' result never counts as main-red and never dispatches a fixer. Done when: soak-replay-gate passes with the API blocked; the guard catches a seeded gh call in a test; a rate-limited check reports neutral, not failure.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
