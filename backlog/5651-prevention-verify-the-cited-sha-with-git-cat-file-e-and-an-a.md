---
bornAs: x99af0g
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/prepare-failure-policy.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/__tests__/prepare-failure-policy.test.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Verify the cited sha with git cat-file -e and an ancestor check against main before placing an al… (from web-everything/web-everything#4658 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4658's review (reviewed head `0d9c92641a4e205c2aab55506f7d90fed163abe4`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/conveyor/prepare-failure-policy.mjs` — Verify the cited sha with `git cat-file -e` and an ancestor check against main before placing an already-done route hold, behind a shared helper used by the runner and the daemon. A lint or standards rule could flag any `already done on main` hold constructed outside that helper.
2. `we:skills-src/conveyor/build-dispatch-daemon.mjs:419` — Extend the named parameterized release test to exhaust the real budget, release it, and record another failure, asserting that retries resume for both causes; run it as a deterministic CI regression gate.

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
