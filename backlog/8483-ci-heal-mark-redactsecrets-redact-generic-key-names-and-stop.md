---
bornAs: xii0fao
kind: story
size: 2
status: active
scaffoldedBy: "fix-5460"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/conveyor/ci-heal-mark.mjs", "we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# ci-heal-mark redactSecrets: redact generic *_KEY names and stop a declined word swallowing the next token= pair

Found fixing PR #5460. we:scripts/conveyor/ci-heal-mark.mjs#redactSecrets (the shape list the daemon smoke copy mirrors) does not redact SERVICE_KEY=x or serviceKey: x, and its single key=value pass lets a declined space-separated match ('Auth token=x', 'monkey token=x') consume the following token=x pair so it is never redacted. PR #5460 fixed both in we:scripts/lib/daemon-rebuild/smoke-classify/redact-detail.mjs (two passes: assignments, then --flag value; generic key-name check). Apply the same there and add the same parameterized cases.

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
