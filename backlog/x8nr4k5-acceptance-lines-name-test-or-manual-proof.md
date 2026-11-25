---
kind: story
size: 3
status: open
dateOpened: "2026-11-25"
scope: ["we:docs/agent/prep-gate.md", "we:scripts/check-standards.mjs", "we:scripts/conveyor/__tests__/no-code-rearm.test.mjs"]
tags: [prevention]
---

# Bind acceptance claims to named tests or explicit manual evidence

PR #7480 claimed a replay against real incident states, while its committed tests reconstruct required-check evidence. The offline repair has no captured live inputs and cannot independently verify the original one-off claim. Make the distinction visible and mechanically checkable in cards and PR bodies.

## Acceptance

- Each acceptance line names its automated test, or explicitly labels itself a manual one-off check with captured evidence and revision when available.
- Reconstructed incident fixtures cannot satisfy a claim of replaying captured real state.
- For #7448 and #7451, capture sanitized real labels, comments and check rollups and name a replay test, or keep the real-state claim marked manual and unverified until evidence is available.

## Origin

PR #7480 review, 2026-11-25: security/test-coverage finding 2 and the simplicity/codex advisory real-state replay suggestions. `we:scripts/conveyor/stand-down-answer.md` distinguishes reconstructed automated coverage from the unverified manual claim.
