---
bornAs: x1jss8u
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Verify daemon: a ps -axww per lookup, and a restart on every commit

[held entry 317] (daemon-async-audit 2026-10-14, held) Verify daemon: a ps -axww per lookup, and a restart on every commit. The lane scan takes 3.4 s, yet the mean tick is ~58 s (p90 ~260 s), mostly in gateJobs.sync, with no phase timer. 44 code-changed restarts/day, 11 s median each (max 89 s). Fix idea: one ps snapshot per tick + a phase timer (we:verify-daemon.mjs:376-395, we:verify-gate-job.mjs:194,520-600). Restart only when an imported file changed (reuse daemonRebuild.skipUnrelated, we:verify-daemon.mjs:149,181). Design: cache + lazy. Saves 10–40 s/tick and ~8 min/day. Size 2.

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
