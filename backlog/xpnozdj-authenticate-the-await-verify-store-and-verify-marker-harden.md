---
kind: story
size: 5
parent: "5137"
status: active
scaffoldedBy: "fix-4151"
dateScaffolded: "2026-10-06"
scope: ["we:scripts/conveyor/await-verify.mjs", "we:scripts/conveyor/await-verify-pass.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Authenticate the await-verify store and verify marker; harden remaining daemon-side lane git (lane-whois, lane-resume)

PR 4151 review round 3 residuals: (1) the await-verify store record and the .lane-verify marker are agent-writable and unauthenticated, so the daemon's session-id/claim binding is circular (a rogue session can copy a live session id from the claim store); needs a daemon-minted secret or a daemon-owned store. (2) a clean filter named by info/attributes cannot be pinned off from the environment, so the verify re-request refuses such lanes instead of neutralizing them. (3) we:scripts/lane-whois.mjs and we:scripts/lane-resume.mjs run git status in lane clones: check their daemon callers and apply we:scripts/lib/lane-git-hardening.mjs (we:scripts/conveyor/await-verify-pass.mjs already uses it).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
