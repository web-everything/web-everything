---
bornAs: xaxsu9o
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Make markWaiting write atomically (temp file + rename), or have the reap skip 'corrupt' markers y… (from web-everything/web-everything#4062 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/heavy-admission.mjs:935` — Make markWaiting write atomically (temp file + rename), or have the reap skip 'corrupt' markers younger than a few seconds by file mtime; add a test that a truncated marker file is not reaped on a fresh mtime.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4062@a7c305c1294c8f4e4ee2051f5441a7df35b31250

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
