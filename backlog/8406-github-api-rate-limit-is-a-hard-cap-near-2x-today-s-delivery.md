---
bornAs: xuartk9
kind: story
size: 5
status: active
scaffoldedBy: "cards-batch-21"
dateScaffolded: "2026-11-16"
scope: ["we:scripts/conveyor/"]
dateOpened: "2026-11-16"
tags: []
related: ["3886"]
---

# GitHub API rate limit is a hard cap near 2x today's delivery: spread, webhook, ETag

Simulator finding (adds to the daemon-levers entry): the GitHub API rate limit becomes a hard cap at about 2x today's delivery. Busiest App: 12,000 calls/h vs about 20,000/h needed late 2027, about 80% daemon polling. Beyond batching git/gh calls: spread daemons across GitHub Apps, use webhooks instead of polling, use ETag conditional requests (304s do not count). Also check: census shows about 10k gh calls/h vs 4,100 measured; do some gh calls use a separate personal token? Measure calls/h per App/token before and after.

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

## Duplicate admission

webhooks-vs-polling decision
