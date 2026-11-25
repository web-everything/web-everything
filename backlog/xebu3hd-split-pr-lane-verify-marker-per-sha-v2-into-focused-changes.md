---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/settings-registry-metadata.d/settings/verify.json", "we:scripts/lib/verify-lane-gate.mjs", "we:scripts/lib/verify-settings.mjs", "we:scripts/lib/verify-shared-marker.mjs", "we:scripts/pr-land.mjs", "we:scripts/push-gate-allowlist.json", "we:scripts/verify-lane.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Split PR lane/verify-marker-per-sha-v2 into focused changes

size-split-key:07fd3250db3e94e053a1665d5f5c5dae5d90ca8bb91f9ce7f109db260a1aa92b. Plan follow-up splits for PR lane/verify-marker-per-sha-v2. File groups: we:scripts/lib: 230; we:scripts/pr-land.mjs: 50; we:scripts/push-gate-allowlist.json: 6; we:scripts/verify-lane.mjs: 114

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
