---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x0p1395-fix-the-workspace-not-trusted-launch-race.md"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a check:standards rule that fails a backlog card whose text mentions trust, refusal or gate r… (from web-everything/web-everything#3899 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/x0p1395-fix-the-workspace-not-trusted-launch-race.md:14` — Add a check:standards rule that fails a backlog card whose text mentions trust, refusal or gate relaxation unless it has Must lines for the fail-closed case and a trust-scope bound. The template hint already prompts for this, but nothing enforces it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3899@809b8e0a3de718083cffc4cb9e1a589917ccb8a3

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
