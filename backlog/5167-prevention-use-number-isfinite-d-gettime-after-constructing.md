---
bornAs: xbhnqel
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:tools/drain-daemon/lib.mjs", "we:tools/drain-daemon/daemon.mjs", "we:tools/drain-daemon/__tests__/lib.test.mjs", "we:tools/drain-daemon/__tests__/daemon.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Use Number.isFinite(d.getTime()) after constructing the Date, or wrap the display formatting in try/catch… (from plateauapp/plateau-app#208 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:tools/drain-daemon/lib.mjs:560` — Use Number.isFinite(d.getTime()) after constructing the Date, or wrap the display formatting in try/catch. Add an out-of-range case such as 1e20 to the it.each. Also give display-only log helpers a general 'must never throw' test.
2. `we:tools/drain-daemon/daemon.mjs:551` — Extract a pure `decideReasonsLog({entry, lastSignature})` returning `{log, nextSignature}` into we:tools/drain-daemon/lib.mjs and unit-test it.
3. `we:tools/drain-daemon/lib.mjs:566` — A shared `sanitizeForLog()` helper in we:tools/drain-daemon/lib.mjs used by every daemon log call that interpolates child/gh-derived text, plus a lint/check:standards rule flagging raw interpolation of entry.* fields into log().

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#208@f11cad65e2f96d96b14f3b4d8234faa05ea93974

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
