---
bornAs: xiga0w4
kind: story
size: 3
parent: "4075"
status: open

dateOpened: "2026-10-04"
tags: []
---

# Prevention — A review lens or write-gate that requires every behaviour sentence in a PR description or card 'F… (from web-everything/web-everything#3884 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-pr-io.mjs:546` — A review lens or write-gate that requires every behaviour sentence in a PR description or card 'Fix' section to map to a changed test file. A deterministic version would flag a changed non-test source file under scripts/ with no changed test in the same PR.
2. `we:scripts/operations/review-pr-io.mjs:550` — Add a deterministic sink test covering both an identical existing trusted record and an absent record, and run it in the standard test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3884@d843e9924be50eb7cdfccda19d4a6714d25b5209

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

## Findings (standalone worker, 2026-11-25)

The build-dispatch daemon held #5050 with:

> worker-declined: Not prepared: #5050 — could-not-prepare. The unresolved choice is whether existing test coverage may satisfy a behaviour claim, or every claim must map to a test file changed in that PR. Current review rules require named defending tests ('we:scripts/lib/review-core.mjs:225'), but do not require those files to change. A mandatory changed-test gate would therefore introduce a stricter policy, beyond extending the existing review lens. No files changed or stamped. No tests run.

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
