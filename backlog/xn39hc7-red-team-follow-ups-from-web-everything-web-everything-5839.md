---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/codex-job.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5839 (head 2673ff131)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5839 (reviewed head `2673ff131886fa1e8bb6bc7dd8114f3729d067f9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/codex-job.mjs:418` — (edge-case, degraded) Branch availability checks do not prevent updating a concurrently created branch.
   - Scenario: After ls-remote reports lane/example absent, another actor creates that branch at the job's pinned base SHA before the push connects. The job's commit descends from that base, so the ordinary push fast-forwards the other actor's branch and reports success. The injected transcript confirmed no creation-only condition accompanies the push. Enforce branch absence atomically and retry a suffix when another actor wins.
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
