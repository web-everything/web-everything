---
bornAs: x54p82i
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/remote-exec.mjs"]
dateOpened: "2026-11-09"
tags: []
---

# Forge fallback bundle-credential-hit: the git bundle credential scan trips and the run falls back to the Mac

Seen in the heavy-admission remote-fallbacks log on 2026-11-09 (lane-29, kind files, detail null). Find what the bundle scan matches (real secret or false positive), put the matched rule in the fallback detail without printing the secret, and fix the false positive or the source. See we:scripts/readiness/remote-exec.mjs.

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

Checked candidate list; no card covers the bundle-credential-hit fallback class (found live in R817).
