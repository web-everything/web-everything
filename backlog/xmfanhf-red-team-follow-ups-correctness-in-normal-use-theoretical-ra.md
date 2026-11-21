---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/measure-base.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, theoretical-race] from web-everything/web-everything#7299 (head e3edde616)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7299 (reviewed head `e3edde616dec9008b66a39dcf39faa1596dcdffd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/measure-base.mjs:58` — (edge-case, degraded) A transient API failure permanently drops queued merges from measurement coverage.
   - Scenario: For linear main history S→A→B→C→D, let S be measured and the pending runs for A and B be replaced. If C's API lookup fails, the fallback measures HEAD^..C, covering only C. If C otherwise succeeds and uploads its sample, D selects C as its baseline and covers only D. A and B remain permanently unmeasured after API recovery. Instead, fallback samples must preserve the unresolved coverage gap rather than advance the cumulative baseline past it.
   - Class: correctness-in-normal-use (basis: Reproduced by invoking the exported main twice with an in-memory linear Git history and injected API responses: C's lookup threw, producing base HEAD^ and coverage C; D's lookup recovered, producing base C and coverage D. A and B were absent from both coverage lists. No attacker or concurrency race is required; production CI was not exercised.)
   - Also class: theoretical-race
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
