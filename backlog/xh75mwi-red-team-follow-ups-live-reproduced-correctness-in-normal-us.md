---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/stuck-prs.mjs", "we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7190 (head 76e40da9d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7190 (reviewed head `76e40da9d5f3b92121006ac0ba5241344a10c4a5`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/stuck-prs.mjs:58` — (edge-case, degraded) Live wrapper workers can be reported as dead claim holders
   - Scenario: A wrapped fix worker has a live runnerPid, its claim mtime is 11 minutes old, and the Claude agent listing is empty. collectClaims returns live:false and evaluateStuck emits R-c, cause D. Wrapper workers have no Claude agent row; their runner PID must be checked, or liveness must remain unknown. The existing claim refresher already handles runnerPid separately.
   - Class: live-reproduced (basis: An in-memory probe executed the production collectClaims and isClaimSessionLive function bodies with an injected claim whose runnerPid was the probe process. A signal-zero probe confirmed that PID existed, yet the detector produced live:false and R-c.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs:130` — (edge-case, degraded) Commit timestamps incorrectly bind historical labels to a new head
   - Scenario: Create commit B at minute -10 without pushing it. Apply ready-to-merge to existing head A at minute -5, then push B at minute 0. The collector compares the historical label timestamp with B's committedDate and assigns the label action to B. At minute 61 it reports ready-no-gate missed for B despite no readiness action on that head. Commit creation time cannot establish when a commit became the PR head; the old action should be excluded or remain unbound.
   - Class: live-reproduced (basis: An in-memory probe executed the production collector function body with B's committedDate at -10 and the historical label at -5. The imported evaluator returned a missed expectation on B. This requires ordinary delayed pushing, without timestamp manipulation.)
   - Also class: correctness-in-normal-use
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
