---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/cli-adapter.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7502 (head e027d764a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7502 (reviewed head `e027d764aa5548a49ca29cdd6cfa6cd26c3c658b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/cli-adapter.mjs:1057` — (failing-input, degraded) Timeout records name the declared model instead of the effective model
   - Scenario: Run review-loop-cli with --model=opus and let a mandatory juror time out. The review request declares model='sonnet'; createDefaultJudge overrides it to 'opus', but recordTimeout reads the original request and persists model='sonnet'. The CLI payload, ended record, and daemon log therefore blame Sonnet for an Opus timeout. Timeout evidence should carry the effective provider/model used by the factory.
   - Class: live-reproduced (basis: An in-memory Node probe executed the production createDefaultJudge and driveRun function bodies with a timeout-throwing provider stub. The provider received model='opus', while seatTimeouts recorded model='sonnet'. Unrelated request validation and provider-request copying were stubbed because checkout dependencies are unavailable.)
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
