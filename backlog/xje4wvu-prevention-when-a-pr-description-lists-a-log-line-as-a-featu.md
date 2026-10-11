---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — When a PR description lists a log line as a feature, add an assertion on that line to the same te… (from web-everything/web-everything#4814 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/__tests__/heavy-admission.test.mjs:1850` — When a PR description lists a log line as a feature, add an assertion on that line to the same test that drives the branch.
2. `we:scripts/readiness/heavy-admission.mjs:240` — Split the settings leaves into caller-only and cross-caller classes. Only platform-preferences (or standard) may set a cross-caller leaf; env and tool layers are recorded in `ignored[]`. Add a lint or test that every leaf in `PER_CALLER_LEAVES` is shown to have no effect on other waiters. Also require repair patterns to be anchored and to contain a literal prefix.
3. `we:scripts/readiness/__tests__/heavy-admission.test.mjs:1831` — Add a deterministic deadline-exhaustion test using injected clock and matcher seams, asserting that no further match executes once the total budget is exhausted; verify that removing deadline enforcement makes that named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4814@5c5a140c559e9c1843a815ab363aaa2adde12929

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
