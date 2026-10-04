---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xx2g1ym-faster-isolated-edge-adoption-quick-smoke-urgent-overlays-on.md"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a check:standards rule that fails a backlog card whose text matches smoke, verify, or gate wi… (from web-everything/web-everything#3867 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xx2g1ym-faster-isolated-edge-adoption-quick-smoke-urgent-overlays-on.md:16` — Add a check:standards rule that fails a backlog card whose text matches smoke, verify, or gate with trim, cache, skip, or relax unless it has a Must line containing 'refuse on error'. The Hint text suggests this is already intended.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3867@73e0ffe2030732894577b7de10d5c1347cb7523f

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
