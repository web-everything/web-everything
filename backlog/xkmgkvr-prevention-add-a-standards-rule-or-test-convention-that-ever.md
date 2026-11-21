---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/ci-selection-settings.mjs", "we:scripts/ci/dep-trace.mjs", "we:scripts/lib/__tests__/ci-selection-settings.test.mjs", "we:scripts/ci/__tests__/dep-trace.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a standards rule or test convention that every new scripts/settings/*.json owner gets a loade… (from web-everything/web-everything#7123 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/ci-selection-settings.mjs:16` — Add a standards rule or test convention that every new scripts/settings/*.json owner gets a loader test that does not inject the loader. For catch-fallback code, require a test that asserts the primary path succeeded.
2. `we:scripts/ci/dep-trace.mjs:62` — Add a contract test that lists every fs and child_process export, partitions it into traced and deliberately untraced, and fails on an unclassified API. Document the untraced set in we:docs/agent/testing.md.
3. `we:scripts/ci/dep-trace.mjs:210` — Have the tracer write a small marker file or in-progress sentinel at activation and remove it or mark it complete in the exit handler. mergeTraces would then treat a sentinel without a complete trace as unknown. Add a test where writeFileSync throws.
4. `we:scripts/ci/dep-trace.mjs:229` — Wrap activate in try/catch inside startTrace, emit a warning, and add a test where an injected activate throws and startTrace still resolves.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7123@1ea3e15b09a837065e7b1462fdff8ec174419591

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
