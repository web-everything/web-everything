---
kind: story
size: 5
status: open
scope: ["we:scripts/collect-review-requests.mjs", "we:scripts/operations/record-verdict.mjs", "we:scripts/lib/git-transport-branch.mjs", "we:scripts/operations/record-verdict-io.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A request whose apply failed (or never ran) can never be re-delivered: re-staging the same verdict is a no-op…

Flow-sim gap R7b-G2, class K3 (one-shot step, no re-driver). Failing input: we:10-changes.json (or we:10-accepted.json) pushed to ops/review-requests. The apply job exits non-zero (the CLI refused: PR not OPEN, #2844 self-clear, mandatory referral not cleared, gh 5xx, ledger transport unreachable F4) or the run failed at setup. 'The session (or operator) re-runs record-verdict --to=<same> for the same … Cited: we:scripts/collect-review-requests.mjs:98, we:scripts/operations/record-verdict.mjs:160, we:scripts/lib/git-transport-branch.mjs:320-323, we:scripts/operations/record-verdict-io.mjs:387-389. Soak-break sketch: Fixture: a transport branch already holding we:10-changes.json byte-identical to what record-verdict would stage, PR labels show no verdict applied. Action: run the stage effect sink again. Assertion that fails today: the sink (or a follow-up check) re-delive…

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
