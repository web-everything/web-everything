---
bornAs: xq9ew91
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:tools/drain-daemon/daemon.mjs", "we:tools/drain-daemon/lib.test.mjs", "we:tools/drain-daemon/__tests__/daemon.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Extract the refresh orchestration into we:lib.mjs with injected fs/exec/rebuild seams, and add a test tha… (from plateauapp/plateau-app#207 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:tools/drain-daemon/daemon.mjs:289` — Extract the refresh orchestration into we:lib.mjs with injected fs/exec/rebuild seams, and add a test that reddens on dropping the alias check or the fallback.
2. `we:tools/drain-daemon/daemon.mjs:289` — Add a policy check in refreshCodeClone, or in we:daemon-overlay.mjs add --clone=<drain code clone>, that requires pinned SHAs or a trusted-author branch. Document the privilege in the README.
3. `we:tools/drain-daemon/daemon.mjs:299` — Require the code clone to sit under lanesRoot/we-drain-daemon, or to carry a daemon-owned marker, and refuse wePrimary, plateauRoot and selfSyncRoot. Put this in a pure we:lib.mjs validator with tests.
4. `we:tools/drain-daemon/lib.test.mjs:76` — Extract the alias check and the migration into we:lib.mjs functions that take injected fs and overlay deps, and test them. A check:standards rule that flags untested guard branches in we:tools/drain-daemon/daemon.mjs would catch the class.
5. `we:tools/drain-daemon/daemon.mjs:303` — Add a deterministic orchestration test covering direct and symlink aliases, asserting that overlay migration and rebuild are never called; verify that removing the alias guard makes that named test fail.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#207@e2d4f9914465ddd617d73823dcf1d37dcff4b6f7

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
