---
bornAs: xaua79o
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/smoke-classify/env-timeout.mjs", "we:scripts/lib/daemon-rebuild/smoke-classify/redact-detail.mjs", "we:scripts/lib/daemon-boot-smoke.mjs", "we:scripts/lib/__tests__/daemon-boot-smoke.test.mjs", "we:scripts/lib/daemon-rebuild/smoke-classify/__tests__/env-timeout.test.mjs", "we:scripts/lib/daemon-rebuild/smoke-classify/__tests__/redact-detail.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Make redactDetail's boot exemption part of the row (for example a row-level flag that preserves d… (from web-everything/web-everything#5460 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/smoke-classify/env-timeout.mjs:20` — Make redactDetail's boot exemption part of the row (for example a row-level flag that preserves diagnostics) or add a lint/test that every redactDetail caller passes the row name.
2. `we:scripts/lib/daemon-rebuild/smoke-classify/redact-detail.mjs:7` — Use a larger explicit cap for boot rows (for example 8k chars) and add a unit test pinning it.
3. `we:scripts/lib/daemon-rebuild/smoke-classify/redact-detail.mjs:6` — Add a check:standards rule or unit test that any detail field bypassing the length cap must go through a shared redactor with a per-line cap, a total-byte cap, and a generic secret-pattern pass (Authorization/Bearer, `*_TOKEN=`/`*_KEY=`/`*_SECRET=`, URL userinfo).
4. `we:scripts/lib/daemon-boot-smoke.mjs:183` — Redact and cap at capture, in `bootOneEntry`, so no unsanitized stderr ever leaves the module. Add a test that `entries[].stderrTail` contains no `ghp_` token.
5. `we:scripts/lib/__tests__/daemon-boot-smoke.test.mjs` — Add a deterministic parameterized scheduling test with more entries than each configured concurrency limit; assert outstanding child counts before resolving children.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5460@ee04f19ca4f8f881d0d940d9c27402ca1550cdcc

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
