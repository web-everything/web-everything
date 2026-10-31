---
bornAs: xb8z4kn
kind: story
size: 5
status: open
scope: ["we:scripts/readiness/host-capacity.mjs", "we:scripts/operations/host-capacity.mjs", "we:scripts/lib/host-load.mjs", "we:scripts/lib/host-overload-settings.mjs", "we:scripts/settings/host-overload.json", "we:scripts/conveyor/health-investigate-dispatch.mjs"]
dateOpened: "2026-10-30"
tags: []
---

# Honest host capacity reading for admission (cpu and memory)

Delivered by PR #6111 (R258; R280 retro card). macOS load average (~50 on 12 cores) counts IO and lock waiters and throttled work while the CPU was idle. New host-capacity reader reports CPU idle, memory pressure, swap, compressor, heavy queue and Forge, with a headroom verdict and admitNewWorkers. Core: we:scripts/readiness/host-capacity.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/readiness/__tests__/host-capacity.test.mjs` (delivered by #6111).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: nothing beyond the digest is in scope.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new input path beyond the digest; existing handling unchanged.
2. **Truncated reads** — n/a: no new input path beyond the digest; existing handling unchanged.
3. **Shared state files** — n/a: no new input path beyond the digest; existing handling unchanged.
4. **Fail closed** — n/a: no new input path beyond the digest; existing handling unchanged.
5. **Identity scoping** — n/a: no new input path beyond the digest; existing handling unchanged.
6. **State over time** — n/a: no new input path beyond the digest; existing handling unchanged.
7. **Who wrote it** — n/a: no new input path beyond the digest; existing handling unchanged.
