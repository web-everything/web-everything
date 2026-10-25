---
bornAs: x371wkf
kind: story
size: 2
status: open
scope: ["we:scripts/operations/codex-job.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5839 (head f83fcf49c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5839 (reviewed head `f83fcf49c51729aecd0adbd559f8e1db145d3113`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/codex-job.mjs:55` — (failing-input, degraded) An accepted wait value triggers a pointless repair and reports tests-red without running tests
   - Scenario: Supply otherwise valid arguments with --wait-ms=86400001. parseArgs accepts it, but heavy-admission permits at most 86400000 and exits 3 before executing Vitest. runTests treats that usage error as failing tests, invokes repair Codex, retries the same invalid command, and returns tests-red. A probe running the real admission CLI with injected repair/filesystem effects observed two exit-3 refusals, one repair invocation, and tests.status=red. Reject the unsupported wait value as bad-args before acquiring resources or running Codex.
   - Claude's re-check: demonstrated break

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
