---
kind: task
parent: "2405"
status: open
scope: ["we:skills-src/conveyor/daemon-manifest.mjs", "we:skills-src/conveyor/com.we.conveyor-pass-daemon.review-ledger-check.plist.example"]
dateOpened: "2026-10-09"
tags: []
---

# run review-ledger-check on a schedule via the generic pass-daemon so the 7-clean-days history fills itself

Follow-up of #3930. The checker now appends one run record per constellation repo per run, and 'node we:scripts/review-ledger-check.mjs --history' answers clean days per label family, but a clean day needs at least one run per repo per ET day and nothing runs it. Add a we:skills-src/conveyor/daemon-manifest.mjs entry 'review-ledger-check' (script we:scripts/review-ledger-check.mjs, no args, interval about 6h) plus a plist example, so we:skills-src/conveyor/pass-daemon.mjs runs it. Done when: a daemon-manifest test resolves the review-ledger-check pass with that script, and after one live daemon tick the --history output shows a run for today in every repo.

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
