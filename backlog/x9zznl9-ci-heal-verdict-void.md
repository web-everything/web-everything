---
kind: story
size: 3
status: active
scaffoldedBy: "fixd-supersede-verdict"
dateScaffolded: "2026-10-09"
scope: ["we:scripts/conveyor/ci-heal-verdict-recheck.mjs", "we:scripts/conveyor/ci-heal-escalation-mark.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# A not-a-ci-break ci-heal verdict pins a PR whose required check went red later

Live 2026-10-09: #4535 ci-heal recorded not-a-ci-break at 02:29:18Z while checks still ran; test went red at 02:29:43Z and reconcile refused every heal on that head since. A void marker now voids a contradicted verdict, and the CLI refuses the verdict while required checks are pending or red.

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
