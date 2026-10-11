---
bornAs: xw0gw1n
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-clone-lock.mjs", "we:scripts/lib/__tests__/daemon-clone-lock.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a lint rule or standards check that flags bare heartbeat( calls on shared singleton keys (WRI… (from web-everything/web-everything#4922 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4922's review (reviewed head `40b09522f347a95332d352e8484c2d035fc7354a`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/lib/daemon-clone-lock.mjs:519` — Add a lint rule or standards check that flags bare `heartbeat(` calls on shared singleton keys (WRITER_KEY) and requires `heartbeatOwn`. Also add a lost-ownership test case to the clone-lock suite.

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
