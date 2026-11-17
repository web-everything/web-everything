---
bornAs: xki5fpy
kind: story
size: 2
status: active
scaffoldedBy: "fix-5460"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/operations/worker-wrapper.mjs", "we:scripts/operations/__tests__/worker-wrapper.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# worker-wrapper result prose: redact before the 500-char tail cut, not after

Found fixing PR #5460 (operator send-back: redact first, then truncate). we:scripts/operations/worker-wrapper.mjs#tail cuts unparseable worker stdout to its last 500 chars, and the router redacts it later, so a quoted secret straddling the cut leaves its tail unredacted (pre-existing on main; used by extractClaudeResult, extractAgyResult and the result-file refusal path). PR #5460 fixed the same class for the daemon smoke diagnostics in we:scripts/lib/daemon-rebuild/smoke-classify/redact-detail.mjs (redactSecrets whole, then cut; fail closed). Apply the same here, or cut at whole-line boundaries, and add a straddling-secret test.

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
