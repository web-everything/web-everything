---
kind: story
size: 2
status: open
scope: ["we:.github/workflows/ci.yml"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7224 (head 02f9f70ef)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7224 (reviewed head `02f9f70ef69d394b8e95143b2ba855fdf7a1dae6`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:.github/workflows/ci.yml:180` — (failing-input, degraded) Reused pushes create false red-main windows in the recovery watch
   - Scenario: Start with a genuine successful main run completing at 11:30. At 12:05, a reused main push completes with only main-execution failing; test, smoke and daemon-soak succeed. The unchanged we:reconcile-pass.mjs defaultReadMainRuns retains this intentional failure. Its recovery consumers return mainGreen.red=true and open a red window at 12:05. A PR whose own test fails at 12:10 is consequently attributed to main and refused as main-still-red instead of receiving its normal ci-heal. This reader must exclude proven reuse-only failures, preserving the last genuine execution verdict, as the updated merg
   - Class: correctness-in-normal-use (basis: A read-only Node probe executed the unchanged reader and reducer function bodies with complete injected run/job responses, reproducing the false red window. A second probe executed planMainRedRebases and reproduced the main-still-red refusal. Applying withoutReusedMainPushes to the same input preserved green and produced no red window.)
   - Claude's re-check: demonstrated break

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
