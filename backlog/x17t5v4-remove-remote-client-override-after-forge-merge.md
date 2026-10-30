---
kind: story
size: 1
status: active
scaffoldedBy: "heavy-remote-client-override"
dateScaffolded: "2026-10-30"
scope: ["we:scripts/readiness/heavy-admission.mjs"]
scopeRationale: "The test plan exercises the dedicated override and bundled-routing suites; the general admission suite is regression-only and does not need edits."
dateOpened: "2026-10-30"
tags: []
---

# Remove the host-set remote client path once the prototype Forge client merges (R254)

Remove the host-set `heavyAdmission.remote.clientPath` override once the Forge remote-exec client merges into the bundled client. Delete `we:scripts/readiness/remote-client-import.cjs` and its tests, and retire the override's resolution and provenance plumbing so admission uses the bundled client without importing host-selected code.

## Acceptance

- [A1] **Executable** — The removal PR runs this one-line grep absence check and requires no matches (exit 1; any grep error fails). The check fails before removal and passes after. Then verify bundled routing through the host heavy-admission queue:

```bash
grep -rn "remote.clientPath" scripts/readiness
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/readiness/__tests__/heavy-admission-remote.test.mjs
```

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the bundled client or the exit-124 contract for unconfirmed remote termination.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Until removal, log client paths and SHAs only through the bounded one-line sanitizers; never treat provenance text as code or authority.
2. **Truncated reads** — Unreadable, partial, malformed, oversized (over 4096 bytes), non-string or control-bearing provenance is missing provenance. The next run records the current sanitized pair and replaces the invalid state; removal must not depend on reading it successfully.
3. **Shared state files** — Retire the provenance state file beneath the pool's `lockRoot` admission state tree without resetting unrelated admission state.
4. **Fail closed** — Invalid clients rejected before import allow local admission; imported clients with unconfirmed termination keep exit 124 and refuse a local rerun.
5. **Identity scoping** — Only platform preferences may select the override, including with private pools; tool settings and environment cannot select it, and lane-pool paths are rejected.
6. **State over time** — After removal, old platform settings and persisted provenance must not reactivate the override; the bundled client covers remote execution.
7. **Who wrote it** — Host platform configuration selects the client before removal; the path/SHA event records provenance without conferring trust on lane-authored code.

## Risks

- The override imports host-selected code into the admission process; only the platform tier may set it, and lane-pool paths are rejected.

## Test plan

Before removal, run the suite at `we:scripts/readiness/__tests__/heavy-admission-remote-client.test.mjs` through the host heavy-admission queue:

```bash
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/readiness/__tests__/heavy-admission-remote-client.test.mjs
```

Preserve these concrete cases:

- `ignores tool clientPath in a private pool without importing it` and `ignores env clientPath in a private pool without importing it`.
- `rejects lane and falls back locally with a reason`, `rejects custom pool and falls back locally with a reason`, `rejects symlink into lane and falls back locally with a reason`, and `rejects case variants of lane pools on the %s path (%s)`.
- `rejects a custom LANE_POOL_ROOT with default laneRoots before import` and `forwards lockRoot through the production runWithRemoteDecision default executor`.
- `removing the clientPath setting leaves unrelated admission state untouched`.
- `treats oversized state file as missing provenance and replaces it without raw event data`, plus its oversized UTF-8, control-character, non-string, malformed JSON and truncated JSON cases; `bounds previous string fields and discards all other parsed fields`; and `accepts provenance at the 4096-byte read limit`.
- `sanitizes and bounds a control-bearing readSha through oneLine`, `refuses local rerun when import starts work before throwing`, and `refuses local rerun when import starts work before a missing runRemote export`.
- `production provenance reader bounds a file growing to %i bytes to one 4097-byte read` (4096 and 8192 cases) asserts the production reader's buffer size, read range, actual byte count and handle closure.

After removal, run the bundled suite at `we:scripts/readiness/__tests__/heavy-admission-remote.test.mjs` using A1's queued command to verify bundled routing and the exit-124 contract. A1's absence check is a one-line grep run by the removal PR after removing the override plumbing.
