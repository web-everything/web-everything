---
bornAs: xizmpjs
kind: story
size: 3
status: open
dateOpened: "2026-11-16"
tags: []
---

# Reinforce forge-unreachable backoff: shared counter, ping cooldown, remote-exec exit-255 retry

Reinforce the short forge-unreachable backoff. Residuals: (1) health-read and run-result failures share one failures counter, so run failures can inflate the health escalation step; (2) every caller pings during an unreachable backoff with no shared cooldown, so queued callers can keep probing a down Forge; (3) the relabel fix had no third audit round; (4) owed: the we:scripts/readiness/remote-exec.mjs:1374 exit-255 retry with jitter and ssh error detail, held by #6880.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/readiness/__tests__/forge-remote-health.test.mjs` includes a test where run failures do not change the health escalation step and ping probes during backoff are rate limited; it fails before and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change Forge sshd limits.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: ssh error detail is already bounded to 200 chars.
2. **Truncated reads** — n/a: state file reads are unchanged.
3. **Shared state files** — the health state file is shared across lanes; changes stay inside its lock transaction.
4. **Fail closed** — a failed probe keeps the backoff; a truly down Forge still falls back.
5. **Identity scoping** — n/a: host-wide state.
6. **State over time** — backoff grows then resets on the next good read.
7. **Who wrote it** — n/a: no authored data.
