---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/__tests__/health-responder.test.mjs"]
dateOpened: "2026-10-02"
tags: []
---

# Health responder: a real no-external-write boundary test

Follow-up from the #3490 advisory (2026-10-02). we:scripts/conveyor/__tests__/health-responder.test.mjs:23 defends the shadow "no external write" guarantee with a tripwire that passes vacuously plus a narrow static regex, so a new write path would not redden any named test. Fix: run the shadow tick in a child process with network and git-push access denied and a stubbed gh, and add a check that health-responder files spawn no binary outside a small allowlist; mutation proof: adding a write call fails the test.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
