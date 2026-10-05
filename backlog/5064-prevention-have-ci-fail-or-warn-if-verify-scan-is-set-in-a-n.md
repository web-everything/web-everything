---
bornAs: xfyzxye
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/repo-scan-tests.mjs", "we:scripts/lib/__tests__/repo-scan-tests.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Have CI fail or warn if VERIFY_SCAN_* is set in a non-verify context. Alternatively, honour VERIF… (from web-everything/web-everything#3890 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/repo-scan-tests.mjs:28` — Have CI fail or warn if VERIFY_SCAN_* is set in a non-verify context. Alternatively, honour VERIFY_SCAN_ROOT only when a second marker set by the gate is also present. If neither is worth building, record the assumption in the we:scripts/lib/repo-scan-tests.mjs header.
2. `we:scripts/lib/repo-scan-tests.mjs:165` — Add a deterministic regression that supplies an inherited scope, changes a scanner input, and verifies that the widened invocation catches a violation outside that scope; explicitly clear the scope in widened commands.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3890@0f78379ad6a67f547d1ac811024aad403044f0ba

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
