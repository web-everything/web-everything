---
kind: story
size: 3
status: active
scaffoldedBy: "fix-6345"
dateScaffolded: "2026-11-03"
scope: ["we:scripts/readiness/forge-exec-run.mjs", "we:scripts/readiness/__tests__/forge-exec-run.test.mjs"]
dateOpened: "2026-11-03"
tags: []
---

# Forge launcher refuses slot commands when the egress table is absent

Follow-up from PR 6345 review (fail-closed egress readiness). forge-exec-egress.service is only ordered Before=sshd; if it fails at boot (nft missing, a slot user lookup fails) slot commands run with full outbound network. Add a readiness gate in the execution launcher: before any slot command run 'nft list table inet forge_exec_egress'; when it fails, refuse the slot and fall back to local. Test: mock nft as missing and assert refusal plus the fallback reason. Sequence after open PR 6193 (it holds the launcher file); that is a pull request number, not a backlog item, so it is not a blockedBy edge.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/readiness/__tests__/forge-exec-run.test.mjs` passes with a test that mocks `nft list table inet forge_exec_egress` as failing or missing and asserts the launcher refuses the slot and falls back to local with the reason `egress-table-absent`; it fails before the gate exists.
- [A2] **Executable** — a second test deletes the table after a successful boot check (the `nft flush ruleset` case) and asserts the NEXT slot command is refused, so the gate runs per command, not once at launcher start.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not re-install or repair the table (forge-egress.sh and its timer own that), and does not change the allowlist contents.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the gate reads only the exit status of a fixed nft command, never its output.
2. **Truncated reads** — n/a: exit status only; no output is parsed.
3. **Shared state files** — n/a: no state file; the nft table is the state and is read live.
4. **Fail closed** — a failing, missing, hung (timeout) or unexecutable nft refuses the slot and falls back to local; only a zero exit lets a slot command run.
5. **Identity scoping** — the check covers the table that matches the slot users; a table with a different name or family does not pass.
6. **State over time** — the check runs before EVERY slot command. The table can vanish after boot (`nft flush ruleset` from nftables.service, ufw, docker or fail2ban reload, an admin), leaving open egress until the next 5-minute timer tick, so a boot-time-only check is not enough.
7. **Who wrote it** — n/a: the launcher only asks nft; nothing it reads is written by a slot user.
