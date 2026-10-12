---
kind: story
size: 3
status: open
dateOpened: "2026-10-12"
tags: []
---

# Retire a tool-less seat's claim on a verifier's "not reproduced" only with corroboration, so a steered verifier cannot silently drop a real hold

The confirmation turn (#4815) records one read-only verifier answer of reproduced=false, with any non-empty evidence, as a sticky not-reproduced for the head, and that retires the mandatory referral. The verifier reads an untrusted checkout, so a planted instruction can steer it. Require a second independent signal before the retirement is recorded (a second verifier seat, or evidence that cites a path and line inside the claim's own cited file), and keep the claim a live referral when only one signal is present.

Found by the converge panel's security lens on #4815 (a carve-out there, because retiring on one answer is the operator's ruling for that card).

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/operations/__tests__/review-pr.test.mjs we:scripts/operations/__tests__/review-pr-io.test.mjs` includes a case where a lone `reproduced: false` answer (one signal) leaves the claim a live referral, fails before this item lands and passes after.
- [A2] **Executable** — the same suites include a case where two independent signals retire the claim as #4815 does today.

## Non-goals

- [N1] Giving every reviewer tools (the operator's later option on #4815).
- [N2] Treating an unavailable verifier differently (that is the sibling card `xf74q20`).

## Edge cases this change must handle

1. **Untrusted text** — the verifier's evidence and any cited path or line are folded (`foldVerifyReason`) before they are stored or compared; a cited path is matched as data against the claim's own `file`, never used as a path to open.
2. **Truncated reads** — an unreadable or degraded PR head is a failed verification, never a corroborating signal.
3. **Shared state files** — the second signal rides the same `verified` list on the head's referral record (no new file); a record write is still atomic through the existing persist and read-back.
4. **Fail closed** — one signal, a missing second signal, or a malformed one keeps the claim a live referral (the base behaviour), and names the reason.
5. **Identity scoping** — both signals are keyed by repo, PR, head sha and finding key; a signal from another head or another seat's key never counts.
6. **State over time** — a first signal recorded on a run that died before the second is not enough on its own on the next run; a new head starts with no signals.
7. **Who wrote it** — the two signals must come from different seats or sessions; the same verifier answering twice is one signal.
