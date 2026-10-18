---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/codex-usage-ledger.mjs", "we:scripts/lib/__tests__/codex-usage-ledger.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a wrapper-level test that drives withCodexUsage with the real spawnToCompletion resolve shape… (from web-everything/web-everything#5254 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/codex-usage-ledger.mjs:196` — Add a wrapper-level test that drives withCodexUsage with the real spawnToCompletion resolve shape and asserts exit === 0. Alternatively, treat a resolved launch with no code as exit 0 when no error was thrown.
2. `we:scripts/lib/codex-usage-ledger.mjs:88` — Record the rollout path and mtime with each quota sample. Set delta to null when before and after come from the same unchanged observation. Add a test for identical before/after samples.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5254@c0899e088573dcff71b3d5abf8dac651ef2cc658

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
