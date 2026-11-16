---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/health-smells/launchd-ops-copy-drift.mjs", "we:scripts/conveyor/health-smells/__tests__/launchd-ops-copy-drift.test.mjs"]
dateOpened: "2026-11-16"
tags: []
---

# Reinforce launchd-ops-copy-drift smell: four coverage gaps

Residuals ruled small under R825 from the launchd-ops-copy-drift audit: (1) a failed LaunchAgents directory read reports one launchd-agents subject, so an open drift episode can close on two unreadable scans; (2) Program plus ProgramArguments repeating one script gives two breaches in one tick, bypassing openAfter; (3) scripts hidden in sh -c command strings are skipped; (4) counterpart search covers only scripts/ on origin/main. Also add the smell to we:scripts/conveyor/health-smells-notify-list.mjs once PR 6913 lands.

PR #6927 review repair addresses (1): incomplete directory/plist scans carry persisted job subjects as unverified breaches until a complete scan establishes recovery. Coverage includes restarted watcher state, repeated failures, and matching or removed jobs. Gaps (2)–(4) and notify-list wiring remain open.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
