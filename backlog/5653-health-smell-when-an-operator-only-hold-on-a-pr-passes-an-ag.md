---
bornAs: xbxx07q
kind: story
size: 2
priority: high
status: open
scope: ["we:scripts/conveyor/health-smells/", "we:scripts/conveyor/health-watch.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Health smell when an operator-only hold on a PR passes an age

Holds that only the operator can clear sit with no age alarm. Review-side PR-minutes in the coroner-4 window: cap-exhausted 1,106 (#4433, #4478 218 min), stood-down 942 (#4461 218), review-referrals-pending 934 (#4388 315), ruling-dispute 656 (#4361 515; the false-alarm part is held item 141). They show on /wip, but nothing pings when one passes an age. Fix idea: one operator-hold-aged health smell (setting, default 30 min) over these hold kinds, reporting PR, kind and age, honouring quietHours (held item 134); it clears itself when the hold clears. Evidence: review-daemon.log 'no review dispatched — cap-exhausted|stood-down|review-referrals-pending|ruling-dispute'. Found by coroner-4 (held item 192).

## Acceptance

- [A1] **Executable** — a test under `we:scripts/conveyor/health-smells/__tests__/` feeds review-daemon log rows with a cap-exhausted hold aged 45 min: before, no smell; after, one `operator-hold-aged` smell naming PR, kind and age.
- [A2] Covers the four hold kinds: cap-exhausted, stood-down, review-referrals-pending, ruling-dispute. A hold younger than the setting (default 30 min) raises nothing (test).
- [A3] The smell clears itself once the hold clears, and stays silent during quietHours (test).
- [A4] Live proof: on the running health-watch, an open aged hold shows the smell; before/after evidence in the PR.

## Non-goals

- [N1] Does not clear or auto-resolve any hold; it only alerts.
- [N2] Does not fix the ruling-dispute false alarm (held item 141).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR titles are not read; the smell uses only PR number, hold kind and timestamps from the log.
2. **Truncated reads** — a partial last log line is skipped; an unreadable log reports the smell as unknown, not as clear.
3. **Shared state files** — read-only over the review-daemon log; no new state file beyond the setting.
4. **Fail closed** — a malformed setting falls back to the 30 min default.
5. **Identity scoping** — one smell entry per (PR, hold kind); repeated log rows for the same hold do not multiply it.
6. **State over time** — age is measured from the first row of the current unbroken hold; a hold that clears and returns starts a new age.
7. **Who wrote it** — n/a: only the review daemon writes these rows.
