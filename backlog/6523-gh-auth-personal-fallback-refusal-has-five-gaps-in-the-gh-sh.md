---
bornAs: x4065w7
kind: story
size: 5
status: open
scope: ["we:scripts/lib/gh-app-shim.mjs"]
dateOpened: "2026-10-19"
tags: []
---

# gh-auth personal-fallback refusal has five gaps in the gh shim

The gh shim refuses a personal-account fallback, but five paths still let it through. (1) The env override WE_GH_AUTH_PERSONAL_FALLBACK=allow overrides the refusal (we:scripts/lib/gh-app-shim.mjs ~line 347). (2) A personal GH_TOKEN plus its hash bypasses the refusal (~583). (3) com.webeverything.* launchd labels are not detected as daemon contexts (~254). (4) Dispatched children lose launchd detection (~875). (5) A missing gh, missing config, or failed shim write falls back outside the shim (~866). Line numbers are as reported by the operator; re-locate on main. Close each gap so the refusal cannot be bypassed, with a named test per gap.

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
