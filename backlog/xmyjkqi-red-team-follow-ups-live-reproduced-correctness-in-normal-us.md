---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/rerun-failed-once.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7142 (head c18283a6d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7142 (reviewed head `c18283a6df732ed7aad3be3ca49486331d1a1eea`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/rerun-failed-once.mjs:65` — (failing-input, degraded) Valid repeated test names prevent retries of unrelated failed files
   - Scenario: Supply a first-run report containing one failed assertion in we:other.test.mjs and a passing file with repeated assertion fullName values. This PR's we:rerun-failed-once.test.mjs:41 produces four tests named 'single failed-file retry core refuses invalid paths/statuses'. parseReport rejects these passing assertions before planRetry filters for failed files, so rerunOnce returns 1 without launching any retry. The same probe without the passing file retries successfully and returns 0. Valid repeated names in unrelated passing files should not prevent the promised failed-file retry.
   - Class: live-reproduced (basis: Reproduced through the exported rerunOnce function using an in-memory report and injected IO. The control launched one successful retry; adding the passing file produced 'invalid or duplicate assertion evidence' and no retry. Repeated names match parameterized tests introduced by this PR.)
   - Also class: correctness-in-normal-use
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
