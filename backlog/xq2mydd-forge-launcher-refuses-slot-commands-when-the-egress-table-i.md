---
kind: story
size: 3
status: active
scaffoldedBy: "fix-6345"
dateScaffolded: "2026-11-03"
blockedBy: ["6193"]
scope: ["we:scripts/readiness/forge-exec-run.mjs", "we:scripts/readiness/__tests__/forge-exec-run.test.mjs"]
dateOpened: "2026-11-03"
tags: []
---

# Forge launcher refuses slot commands when the egress table is absent

Follow-up from PR 6345 review (fail-closed egress readiness). forge-exec-egress.service is only ordered Before=sshd; if it fails at boot (nft missing, a slot user lookup fails) slot commands run with full outbound network. Add a readiness gate in the execution launcher: before any slot command run 'nft list table inet forge_exec_egress'; when it fails, refuse the slot and fall back to local. Test: mock nft as missing and assert refusal plus the fallback reason. Lands after 6193 (the launcher file is held there).

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
