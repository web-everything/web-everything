---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/verify-dispatch.mjs", "we:scripts/verify-lane.mjs", "we:scripts/conveyor/__tests__/verify-dispatch.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Authenticate verify in-band queue markers with a per-run nonce

Goal: gate output must not stretch its own ceiling by printing a line-anchored queue marker. Today we:scripts/conveyor/verify-dispatch.mjs:160 GATE_QUEUED_MARKER and scanLaterMarkers (~:417-424) accept any line starting with the marker as a re-queue and swap the gate timer for the ~2 h queue ceiling; writer is we:scripts/verify-lane.mjs:502; the existing test at we:scripts/conveyor/__tests__/verify-dispatch.test.mjs:364 only covers non-anchored text. Design: dispatcher makes a random nonce per run, passes it by env WE_VERIFY_MARKER_NONCE, verify-lane echoes it in both markers, scanLaterMarkers accepts only the current nonce; verify-lane strips the nonce from env handed to gate commands. Done when: new test with a spoofed no-nonce marker then hang gives timedOutPhase gate at the gate ceiling; real nonce marker still pauses the budget; vitest passes on we:scripts/conveyor/__tests__/verify-dispatch.test.mjs and we:scripts/__tests__/verify-lane.test.mjs; mutation proof (remove the nonce check, spoof test goes red). Out of scope: stdout/exit paths, supersede policy. Checklist: operator handoff checklist item 58. Follows #4054 (merged).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
