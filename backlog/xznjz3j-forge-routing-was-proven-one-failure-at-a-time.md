---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/__tests__/forge-verify-marker.test.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Forge routing was proven one failure at a time

HIGH priority hint. 394. (coroner-1031, held, HIGH) Forge routing was proven one failure at a time: card 7533 failed 4 live proofs and #6141 hit Forge-only test failures late; one full trace would have found them together. Live lane runs failed closed on "unshipped-symlink" (11:39 ET, tracked we:.claude/skills symlink), "ignored-test-file" (16:47 ET, ignored _site build output), and two more before the 19:39 ET pass (16/16 on slot-7); each was found only by the next live run, each reverting the host client within 2 min. #6141 added late Forge-only failures (we:scripts/readiness/__tests__/forge-verify-marker.test.mjs policy-cascade log line; codex-direct-task "kills a same-group straggler" passes on Mac, fails on Forge). #6141 and #6132 each show 6 extra review rounds across 5-6 subsystems. Fix idea: a `forge-offload preflight` run (no lane run needed) that in one pass lists every tracked symlink, ignored-but-test-matching file, GIT_DIR/worktree edge and every test that differs between Mac and Forge (full suite once on a slot, results into an env-dependent list with reasons), and refuses to flip a route until the list is empty or each entry is carded. Evidence: handoff 11:39, 16:47, 19:39 ET entries; cards 16:28 ET (codex-direct-task straggler) and 19:46 ET (#6141); coroner changeRequests (#6132, #6141 extra rounds 6). Scope: we:scripts/lib/verify-remote-routing.mjs, we:scripts/forge. Size 4.

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
