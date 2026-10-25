---
bornAs: xd5jty0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-git-diet.mjs", "we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs", "we:scripts/__tests__/lane-git-diet.test.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# Prevention — For every guard in the claim/recheck sequence, require a pause-stage test that plants exactly tha… (from web-everything/web-everything#5806 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-git-diet.mjs:225` — For every guard in the claim/recheck sequence, require a pause-stage test that plants exactly that guard's trigger. A table-driven `runPaused` matrix over (stage x trigger) would make a missing cell visible.
2. `we:scripts/lane-git-diet.mjs:205` — Add a real-git test that back-dates a reflog-only unreachable commit with GIT_COMMITTER_DATE and asserts it survives an apply with `--prune-expire=now`. A cheaper gate is a lint that every `-c gc.*Expire*` pin in we:scripts/lane-git-diet.mjs is named in a test.
3. `we:scripts/lane-git-diet.mjs:78` — Add a CLI-level test with a hostile hook and fsmonitor config that asserts no marker is written. Alternatively add a standards rule that any new script spawning git in a lane must route through a helper whose test plants a hook.
4. `we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs` — Require refusal tests to provide valid preceding inputs and assert the specific refusal diagnostic; add this corrected test to the required suite.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5806@3407639c4a07008eb1eaddfd65212745aaddfad7

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
