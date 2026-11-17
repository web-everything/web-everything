---
bornAs: xfyg7wz
kind: story
size: 3
status: open
scope: ["we:scripts/lib/lane-verify.mjs", "we:scripts/conveyor/await-verify-pass.mjs"]
dateOpened: "2026-11-12"
tags: []
---

# Reinforce the infra CI-green fallback: keep failing-test names in infra markers; stale dead claim owner

Reinforce-later for the await-verify CI-green fallback (branch lane/await-verify-ci-green-fallback, R895+R903 residuals). (1) we:scripts/lib/lane-verify.mjs verifyFinishBody drops failing-test names on an infrastructure failure, so the fallback in we:scripts/conveyor/await-verify-pass.mjs cannot prove no assertion failed; keep them in infra markers. (2) Wait for infraRetry attempts before the fallback, or document why not. (3) Claim owner Mac:82182 is a dead pid but is still refreshed as a live claim owner on fix-6693; find and fix the refresh path.

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
