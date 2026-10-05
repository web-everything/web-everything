---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/__tests__/pass-daemon.test.mjs", "we:skills-src/conveyor/pass-daemon.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Spawn with async spawn, wait for the idle line on stderr (with a generous ceiling), then kill the… (from web-everything/web-everything#4021 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/__tests__/pass-daemon.test.mjs:23` — Spawn with async `spawn`, wait for the idle line on stderr (with a generous ceiling), then kill the child. This avoids a fixed short timeout.
2. `we:skills-src/conveyor/pass-daemon.mjs:173` — Add a follow-up so the idle loop re-checks a fresh manifest (a dynamic import, or an exit-0 restart once self-sync reports new code). Add a test for it.
3. `we:skills-src/conveyor/__tests__/pass-daemon.test.mjs:28` — Add a parameterised test over adversarial pass names (path-like, prototype keys) that asserts idle and no spawn. For a deterministic gate, add a standards check that any card Must line naming 'bypass' or 'refuses' has a matching test reference.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4021@220f9e4b73f4010543c386d591c9aadfce7cba04

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
