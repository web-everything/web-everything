---
bornAs: xlaxpgf
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:vitest.shared.ts", "we:./__tests__/vitest.shared.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Create the template under a fresh fs.mkdtempSync dir, or a per-uid dir with an owner and mode (07… (from web-everything/web-everything#3905 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:vitest.shared.ts:47` — Create the template under a fresh `fs.mkdtempSync` dir, or a per-uid dir with an owner and mode (0700) check, and verify that hooks/ is empty on each use. A standards-gate lint could also flag fixed-name directories under os.tmpdir() that are later used as an exec or config trust root.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3905@70184d1619f5e5d0a1a7bde5150d7b73ffb10a0c

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
