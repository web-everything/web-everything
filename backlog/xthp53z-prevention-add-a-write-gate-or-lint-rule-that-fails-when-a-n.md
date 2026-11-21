---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/ci-selection-settings.mjs", "we:scripts/readiness/trace-coverage.mjs", "we:docs/agent/testing.md", "we:scripts/lib/__tests__/ci-selection-settings.test.mjs", "we:scripts/readiness/__tests__/trace-coverage.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a write-gate or lint rule that fails when a new scripts/lib/*-settings.mjs loader has no test… (from web-everything/web-everything#7123 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/ci-selection-settings.mjs:14` — Add a write-gate or lint rule that fails when a new `scripts/lib/*-settings.mjs` loader has no test importing it. Meanwhile, add `loadCiSelection` tests for precedence, invalid-leaf retention, and a malformed settings file.
2. `we:scripts/lib/ci-selection-settings.mjs:14` — A check:standards rule requiring each new scripts/lib/*-settings.mjs loader to have a sibling test importing it. Alternatively, a review-lens checklist item that every settings catch fallback has a named test.
3. `we:scripts/readiness/trace-coverage.mjs:19` — A lint or standards rule that CLI entry guards delegate to an exported main(argv, io) returning an exit code. That makes the exit-code behaviour testable without a subprocess.
4. `we:scripts/lib/ci-selection-settings.mjs:13` — Add deterministic loadCiSelection tests using distinct standard, platform, repository and environment values, and run them in the existing test gate.
5. `we:docs/agent/testing.md:5100` — Add a deterministic alternate-realm URL test asserting that the original cwd reaches the wrapped function and the expected spawn edge is recorded.
6. `we:scripts/lib/ci-selection-settings.mjs` — Gate the settings loader with a deterministic precedence and invalid-value test matrix using distinguishable values at every layer.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7123@4eb36fa3e6ea4685d92c8e37ead066231d63e68d

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
