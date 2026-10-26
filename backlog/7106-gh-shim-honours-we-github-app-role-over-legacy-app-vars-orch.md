---
bornAs: xthpie7
kind: story
size: 2
status: open
scope: ["we:scripts/lib/gh-throttle.mjs", "we:scripts/conveyor/health-smells/gh-shim-lane-path.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# gh shim honours WE_GITHUB_APP_ROLE over legacy app vars; orchestrator shell sets the key dir or warns

2026-10-25 12:31-13:00 ET: with the review-daemon plist key dir and WE_GITHUB_APP_ROLE=reviewer the gh shim still signs in as web-everything[bot] because daemon plists also set legacy WE_GITHUB_APP_ID / WE_GITHUB_APP_PRIVATE_KEY_PATH, which the shim prefers; plateau-* identities appear only on github-app-identity mint paths. #5874 mark-ready failed because the legacy app lacks Pull requests: write. The orchestrator shell has no key dir and falls back to the legacy app. Want: the shim honours the role over the legacy vars (operator OK then to drop legacy vars from the plists), the manual/orchestrator shell sets the key dir or warns on fallback, and health-watch alerts when the shim is in fallback. Related open cards 6931/6934.

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
