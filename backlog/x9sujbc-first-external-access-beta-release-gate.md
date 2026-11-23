---
kind: story
locus: plateau-app
size: 2
status: open
dateOpened: "2026-11-22"
tags: [plateau, release-gate, beta]
---

# First external access (beta) release gate

The enforcement work for PL-BETA-GUARDS: an access-grant check in the Worker or auth flow refuses external invites (access for any non-internal user) while #3130 (auth-gated routes reachable logged off) or #3811 (deploy gate brute-force and session revocation) is open. Add blockers here as new pre-beta hardening cards are found.

## Acceptance

- [A1] **Executable** — an access-grant check in the Worker or auth flow refuses outside access (invites and the shared-code login) while #3130 or #3811 is not resolved, and allows it only when both are resolved. A test covers every status of each blocker: open, parked, active, preparing and closed refuse, an unreadable or missing status refuses, and only resolved allows. The same check also covers the shared-code login (the path #3811 documents, with no per-person identity): while either blocker is open, that login refuses any non-internal user, and a test drives that path directly, not only invites.



## Non-goals

- [N1] Does not build the #3130 or #3811 hardening itself.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the grant check reads only the two blocker ids; an unreadable state refuses.
2. **Truncated reads** — n/a: the grant check reads only the two blocker ids; an unreadable state refuses.
3. **Shared state files** — n/a: the grant check reads only the two blocker ids; an unreadable state refuses.
4. **Fail closed** — n/a: the grant check reads only the two blocker ids; an unreadable state refuses.
5. **Identity scoping** — the check requires a trusted internal identity; when identity cannot be established (including the shared-code login, which carries no per-person identity) it refuses outside access, and a test covers that refusal.
6. **State over time** — n/a: the grant check reads only the two blocker ids; an unreadable state refuses.
7. **Who wrote it** — n/a: the grant check reads only the two blocker ids; an unreadable state refuses.
