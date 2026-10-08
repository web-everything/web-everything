---
kind: story
size: 5
parent: "xpd5nhi"
status: open
blockedBy: ["xgqueiz"]
scope: ["we:scripts/daemons/shadow-compare.mjs", "we:scripts/daemons/__tests__/shadow-compare.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Dual-run the watch passes, verify, review and fix daemons from the Longshore mirror in shadow

Point one daemon role at a time at a Longshore mirror clone, with a WE-clone twin in shadow, and compare their journals. Order: watch passes, verify, review, fix. Each role must match for three days before the next one flips.

## Acceptance

- [A1] **Executable** — the shadow-compare tool diffs two daemon journals for the same events and exits non-zero on any different action.
- [A2] For each of watch passes, verify, review and fix: three days of same actions on the same events, no lost lane, no double push. Evidence per role in the PR or card.
- [A3] Rollback is proven once: one plist re-pointed back to its WE clone.

## Non-goals

- [N1] Build-dispatch and the drain (next slice).
