---
bornAs: xf1e2k7
kind: investigation
size: 3
status: active
scaffoldedBy: "fix-6770"
dateScaffolded: "2026-11-14"
scope: ["we:scripts/readiness/heavy-queue-projection.mjs", "we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Harden the heavy-command kind classifier: quote-aware words, soak/agent precedence, other test-runner spellings

PR 6770 made the whole-suite guard in we:scripts/readiness/heavy-admission.mjs read shell words instead of splitting on whitespace and re-check kinds files, selected and other. The shared classifier in we:scripts/readiness/heavy-queue-projection.mjs still splits on whitespace (a quoted spaced value can read as a test file), returns soak or agent before it looks at a whole-suite vitest run chained next to it, and does not recognise pnpm test, npm t or npm run-script test. Make the classifier read quote-aware words and decide whether those other spellings and precedence cases may admit a whole suite under wholeSuite=refuse.

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

searched backlog for classifyCommandKind and heavy-queue-projection quoting; the open card xn91d5a covers coverage options only
