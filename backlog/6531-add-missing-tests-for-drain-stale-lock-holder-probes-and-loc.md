---
bornAs: xtka48a
kind: task
locus: plateau-app
status: open
dateOpened: "2026-10-19"
tags: []
---

# Add missing tests for drain stale-lock holder probes and lock preservation (plateau-app #226)

Follow-up from plateau-app PR #226 (drain stale-lock fix), five referral findings ruled card by the operator 2026-10-19. Code is plateau:tools/drain-daemon/lib.mjs; tests go in plateau:tools/drain-daemon/lib.test.mjs. Missing tests, verbatim from the findings:

1. plateau:tools/drain-daemon/lib.mjs:107 - "COVERAGE: Injected probe tests do not defend the production holder-detection guarantees."
2. plateau:tools/drain-daemon/lib.mjs - "COVERAGE: No supplied test defends preservation of a replaced or touched lock."
3. plateau:tools/drain-daemon/lib.mjs - "The production holder probes have no tests defending their fail-closed and external-target guarantees."
4. plateau:tools/drain-daemon/lib.mjs - "No named test defends the promise that a replaced or touched lock is preserved."
5. plateau:tools/drain-daemon/lib.mjs:119 - "The default `processProbe` and `listGitCwds` (lsof/ps parsing, fail-closed rules) are never exercised by any test."

Tests to add: (a) processProbe/listGitCwds fail closed with a stubbed spawnSync or fake lsof/ps: lsof ENOENT, non-empty stderr, status 2, a ps git pid absent from lsof, and git -C <clone> / --git-dir / --work-tree from an unrelated cwd, each asserting the lock survives; (b) "preserves a lock replaced during holder checks" and (c) "preserves a lock touched during holder checks", asserting cleared is false and the lock remains. Mutation check each: dropping the stderr/signal/status check, turning `if (!cwd) throw` into `continue`, removing the lstat.isFile() check, and removing the identity/timestamp guard must each redden a test.

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
