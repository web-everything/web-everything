---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/ci-selection-settings.mjs", "we:scripts/ci/dep-trace.mjs", "we:scripts/lib/__tests__/ci-selection-settings.test.mjs", "we:scripts/ci/__tests__/dep-trace.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a check:standards rule: every scripts/settings/*.json owner needs a loader test that uses non… (from web-everything/web-everything#7123 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/ci-selection-settings.mjs:16` — Add a check:standards rule: every `scripts/settings/*.json` owner needs a loader test that uses non-default values. Failing that, require a settings loader to ship with a test whose fixture differs from the defaults.
2. `we:scripts/ci/dep-trace.mjs:83` — Add a unit case in `we:dep-trace.test.mjs`: explicit child env without `NODE_OPTIONS` yields exactly `--import=<hook>`. Alternatively, when an explicit env omits it, start from an empty string.
3. `we:scripts/lib/ci-selection-settings.mjs:14` — Add a check:standards rule that every new `scripts/lib/*-settings.mjs` loader has a test file importing it. File this as a backlog item.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7123@4d80cc26c7cef36e38d8d201231b9155b5d2af38

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
