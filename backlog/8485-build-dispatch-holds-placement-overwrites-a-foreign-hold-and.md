---
bornAs: xjdasws
kind: task
status: active
scaffoldedBy: "fix-4162"
dateScaffolded: "2026-10-06"
scope: ["we:scripts/conveyor/build-dispatch-claim.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Build-dispatch holds: placement overwrites a foreign hold and release has no reason guard

Found reviewing PR #4162 (items 95+96). Holds are keyed by card number alone. placeBuildDispatchHold deletes and recreates the lock, so a prepare hold placed by the failure ledger (failPrepare, and the stamp-recovery path) silently replaces an operator, supervisor, gate-red or #4465-routed hold on the same card, which then becomes releasable by a backoff release or --rearm-false-holds. releaseBuildDispatchHold takes no expected-reason argument, so the callers' list-then-release is not atomic. Fix: let place refuse (or preserve) a differing live hold unless told to replace it, and let release take an onlyReasons filter checked under the same lock. Add a test where a foreign hold survives place and release.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
