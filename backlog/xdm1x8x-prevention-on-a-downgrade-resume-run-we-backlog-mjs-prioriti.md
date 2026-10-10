---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/request-intake.mjs", "we:scripts/lib/request-store.mjs", "we:scripts/lib/intake-config.mjs", "we:scripts/lib/__tests__/request-intake.test.mjs", "we:scripts/lib/__tests__/request-store.test.mjs", "we:scripts/lib/__tests__/intake-config.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — On a downgrade resume, run we:backlog.mjs prioritize card --clear before the commit, and assert in the re… (from plateauapp/plateau-app#220 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/request-intake.mjs:193` — On a downgrade resume, run `we:backlog.mjs prioritize <card> --clear` before the commit, and assert in the resume test that it is called. Also state in the resume test that the card's priority matches the saved flag.
2. `we:scripts/lib/request-store.mjs:158` — Have the intake write the effective `intake.buildNow` into state when it first reads the request (before the question rounds), so the view never falls back to the raw request value. Test the chip with the ceiling set and the phase at 'asking'.
3. `we:scripts/lib/request-intake.mjs:28` — Make project-file `buildNow:false` a ceiling the same way env `=0` is, or rename the key to something like `buildNowDefault` so it does not read as a switch. Add a test that a project-file false beats an explicit request true. Longer term, add a standards rule requiring any config that gates unreviewed landing to be a ceiling, not a default.
4. `we:scripts/lib/intake-config.mjs:78` — Gate CI on parameterized configuration tests covering absent, empty, whitespace-only, recognized-on, and unrecognized values; distinguish environment-variable presence from its normalized content.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#220@cdf862d082b8dc679dd1c99d1ff8d8c8647072cc

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
