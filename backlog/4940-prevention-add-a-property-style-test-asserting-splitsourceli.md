---
bornAs: xved2zu
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/citation-check.test.mjs", "we:scripts/lib/citation-check.mjs"]
dateOpened: "2026-10-01"
tags: []
---

# Prevention — Add a property-style test asserting splitSourceLines.length === countSourceLines across edge inputs. A… (from chalbert/web-everything#3343 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/citation-check.test.mjs:1172` — Add a property-style test asserting splitSourceLines.length === countSourceLines across edge inputs. A lint requiring each exported lib function to be referenced by at least one test file would catch the class.
2. `we:scripts/lib/citation-check.mjs:509` — Add a deterministic unit test asserting that a throwing read returns null, repeated reads do not retry, and the detector skips the resulting unreadable target.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3343@a07676a1b8ae9d2bd5aae6c0d0c15082dc8e86ba

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
