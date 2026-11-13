---
kind: story
size: 3
status: open
scope: ["we:scripts/verify-lane.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# Periodic local spot-check of Forge-confirmed reds

Reinforce-later for the Forge red-confirm (lane/verify-red-confirm-on-forge): a red is now confirmed by a second Forge run, so a Forge-only deterministic fault could erase a real red. Sample Forge-confirmed reds (ranOn.remoteRedConfirmed=forge) and re-run a few on the Mac periodically; report disagreements. Touches we:scripts/verify-lane.mjs markers and a we:scripts/ spot-check reader.

## Acceptance

- [A1] **Executable** — the spot-check reader (to be built) re-runs a sampled Forge-confirmed red locally and a test fails before it exists, passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: card only; design lands with the build.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — to be handled by the build (see digest).
2. **Truncated reads** — to be handled by the build (see digest).
3. **Shared state files** — to be handled by the build (see digest).
4. **Fail closed** — to be handled by the build (see digest).
5. **Identity scoping** — to be handled by the build (see digest).
6. **State over time** — to be handled by the build (see digest).
7. **Who wrote it** — to be handled by the build (see digest).
