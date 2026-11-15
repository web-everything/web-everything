---
bornAs: xe0n4rr
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/forge-exec-manifest.mjs we:scripts/readiness/remote-exec.mjs"]
dateOpened: "2026-11-15"
tags: []
related: ["8233"]
---

# Forge manifestEntry and remote-exec must content-scan all paths, not only credential-named ones

we:scripts/readiness/forge-exec-manifest.mjs (2026-11-15 07:07 ET, HIGH, hard line, next after the forge-key-structure S1 card): manifestEntry content-scans only credential-named paths, so an untracked ordinary file (for example we:docs/notes.md) holding a base64 private key is admitted, for every pattern including BEGIN. Scan all paths in manifestEntry and in we:scripts/readiness/remote-exec.mjs. Found by the codex audit on the S1 PR. Prove on the live case with before/after evidence.

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

adjacent but distinct

different failure
