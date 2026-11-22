---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7246 (head 16723f730)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7246 (reviewed head `16723f730ce07ca47fea0946ebf2565d6d661aa2`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:5869` — (failing-input, degraded) Branching from inside a lane wrongly refuses an already-pushed verification hold
   - Scenario: In a clean, leased lane whose HEAD is pushed and has a fresh green verification marker, run from that lane: node &lt;checkout&gt;we:/scripts/lane-pool.mjs branch --lane=1 --session=&lt;holder&gt; --name=lane/next --pool=project. Without explicit --origin/--reference or an inherited canonical origin, resolveRepo recognizes the invoking checkout as a lane but skips primary discovery, which remains limited to gc/release. It returns originUrl:null, so the fresh-remote proof immediately fails and branching is refused as verified-unpushed. The command should discover the pool's trusted primary, verify the pushed H
   - Class: correctness-in-normal-use (basis: A read-only probe executed the actual resolveRepo function with filesystem/Git reads stubbed: primary cwd resolved the origin, while lane cwd returned originUrl:null. Executing the actual cmdBranch with that descriptor and clean, valid lease/verification facts reproduced the lane-hold refusal. This requires neither an attacker nor concurrency; a full filesystem integration reproduction was not performed.)
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
