---
bornAs: xviwnls
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/health-smells/__tests__/clone-behind-main.test.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a test fixture helper that builds a merge-commit history with back-dated branch commits, and… (from web-everything/web-everything#4171 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-watch.mjs:388` — Add a test fixture helper that builds a merge-commit history with back-dated branch commits, and require it for any smell that derives age from git commit times. Fix with `git log --first-parent --reverse --format=%ct head..tip` for both the count and the age.
2. `we:scripts/conveyor/health-smells/__tests__/clone-behind-main.test.mjs:18` — Add a deterministic real-git test with a divergent clone commit available in the probe repository, asserting that the clone is omitted; verify that removing the ancestor check fails that test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4171@aec61f0d5647ef55779e1ef66249b0f41457aa69

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
