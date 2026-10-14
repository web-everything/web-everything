---
bornAs: xavo61k
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5241 (head 8c3032121)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5241 (reviewed head `8c3032121ae84bdda7201d9b8641e65598462761`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:308` — (edge-case, degraded) An older ineligible PR can permanently starve later eligible catch-up candidates.
   - Scenario: Set capacity=5 and queued=4. Supply two non-draft, unqueued ready-to-merge PRs: older #42 has a running check or persistent drain hold; newer #43 is fully eligible. The planner selects only #42 before checking eligibility. When #42 is skipped, #43 is never substituted, and the next interval selects #42 again. Read-only injected probes across three intervals observed wake reads [42,42,42] with no drains for the running-check case, and drain attempts [42,42,42] for the held case. #43 never gets attempted despite available room. Catch-up should advance past unsuccessful candidates so eligible lat
   - Claude's re-check: planCatchUp slices the oldest 'room' candidates before any eligibility check, and a drained-but-skipped PR is deleted from pending and not in the queue. Next interval it is picked first again. With room 1, a persistently ineligible older PR starves later eligible ones.
2. `we:scripts/lib/enqueue-on-event.mjs:372` — (edge-case, degraded) Retained catch-up work is excluded from capacity accounting and can overflow the advertised limit.
   - Scenario: Set capacity=5, queued=4, and eligible candidates #42 then #43. During the first catchUp(), close allowed() inside #42's wake read; line 396 retains #42 as pending. Reopen the window after 10 minutes with four entries still queued. The next plan skips pending #42 but allocates the one available slot to #43. The execution loop then drains both pending #42 and newly planned #43. A read-only stateful probe asserted launches [42,43], producing six modeled queue entries against capacity five. Existing catch-up reservations must consume room, and execution should enforce the remaining budget across
   - Claude's re-check: planCatchUp excludes pending PRs from candidates but computes room as capacity - queued without counting them. A retained catch-up entry (re-added when the window closes during the read) plus a newly planned PR both sit in pending, and the loop drains every due entry. That launches 2 fast drains against room 1, so the planned cap is exceeded.

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
