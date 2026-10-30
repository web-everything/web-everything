---
kind: story
size: 1
status: active
scaffoldedBy: "heavy-remote-client-override"
dateScaffolded: "2026-10-30"
scope: ["we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-10-30"
tags: []
---

# Remove the host-set remote client path once the prototype Forge client merges (R254)

Remove the host-set `heavyAdmission.remote.clientPath` override once the Forge remote-exec client merges into the bundled client. Delete `we:scripts/readiness/remote-client-import.mjs` and its tests, and retire the override's resolution and provenance plumbing so admission uses the bundled client without importing host-selected code.

## Acceptance

- [A1] **Executable** — `grep -rn "remote.clientPath" scripts/readiness` returns no matches (the absence assertion fails before removal and passes after), and `npx vitest run we:scripts/readiness/__tests__/heavy-admission-remote.test.mjs` stays green. Run the test through the host heavy-admission queue.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the bundled client or the exit-124 contract for unconfirmed remote termination.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Until removal, log client paths and SHAs only through the bounded one-line sanitizers; never treat provenance text as code or authority.
2. **Truncated reads** — Unreadable or partial the provenance state file is missing provenance, never proof of safe execution; removal must not depend on reading it successfully.
3. **Shared state files** — Retire the the provenance state file provenance file beneath the pool's `lockRoot` admission state tree without resetting unrelated admission state.
4. **Fail closed** — Invalid clients rejected before import allow local admission; imported clients with unconfirmed termination keep exit 124 and refuse a local rerun.
5. **Identity scoping** — Only platform preferences may select the override, including with private pools; tool settings and environment cannot select it, and lane-pool paths are rejected.
6. **State over time** — After removal, old platform settings and persisted provenance must not reactivate the override; the bundled client covers remote execution.
7. **Who wrote it** — Host platform configuration selects the client before removal; the path/SHA event records provenance without conferring trust on lane-authored code.

## Risks

- The override imports host-selected code into the admission process; only the platform tier may set it, and lane-pool paths are rejected.

## Test plan

Before removal, run `we:scripts/readiness/__tests__/heavy-admission-remote-client.test.mjs` through the host heavy-admission queue to preserve the override's safety coverage. After removal, delete that override-specific suite and run `we:scripts/readiness/__tests__/heavy-admission-remote.test.mjs` through the same queue to verify bundled routing and the exit-124 contract. Check A1's grep absence assertion after deleting the override plumbing.
