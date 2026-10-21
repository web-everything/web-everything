---
kind: task
status: open
scope: ["we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/daemon-rebuild/", "we:scripts/lib/daemon-overlay-proofs.mjs", "we:scripts/daemon-overlay.mjs", "we:scripts/worker-brief.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Worker brief: hard stop between audit and load

Three times on 2026-10-19/20 a worker registered or loaded a daemon overlay before tests were green or before the read-only Codex audit said NOT WEAKENED (overlap-yield-blocked v1 rolled back; filing-on overlay registered pre-audit, unregistered by the orchestrator). Proposal: registration and every overlay adoption, including automatic refresh, refuse unless trusted records attest a NOT WEAKENED audit and green tests for that overlay and exact full sha. Cover we:scripts/lib/daemon-load-overlay.mjs and we:scripts/daemon-overlay.mjs add, plus the automatic daemon-self-sync → rebuildClone → prepareRebuild → planRebuild path at its shared adoption boundary; we:scripts/worker-brief.mjs states the order. Deterministic, so it belongs in the tool, not in prose.

## Acceptance

- [A1] **Executable** — a test runs `daemon-overlay add` for a sha with no recorded audit verdict and expects refusal; with a verdict of NOT WEAKENED for that sha but no green test marker, expects refusal; with both for that exact sha, expects admission. Fails before, passes after.
- [A2] **Must** — a verdict for a different overlay or sha does not count. Resolve the target to an immutable full sha, verify both proofs for that overlay and sha, and apply only that verified sha. A branch tip moving after validation must not substitute an unverified commit.
- [A3] **Must** — a verdict other than NOT WEAKENED (WEAKENED, unclear, error, empty) refuses.
- [A4] **Must** — the refusal message names which of the two proofs is missing or invalid and the sha checked.
- [A5] **Must** — the worker brief states the order: tests green, then read-only audit, then register or load.
- [A6] **Must** — no override flag; the only way past is to record the real verdict and the real green marker.
- [A7] **Executable** — register and load audited, tested sha A, then advance the branch to nonconflicting sha B without proofs. Exercise automatic daemon-self-sync → rebuildClone → prepareRebuild → planRebuild: B is refused and A remains loaded. Repeat with only one proof, invalid proofs, a rebuild/retry, and a branch tip moving after validation; none may apply an unverified sha. With both trusted proofs for B, refresh may adopt B without re-registration.
- [A8] **Executable** — hand-made audit and test records with the accepted writer identities, correct overlay/full sha, and successful results are rejected, including copies placed at worker-controlled paths. Requests by a worker to publish successful proofs through either trusted producer are also rejected. Genuine records from the trusted audit dispatcher and test gate are accepted only for their attested overlay/full sha; copying a genuine record to another overlay or sha fails. Unavailable trusted storage refuses admission and automatic adoption.

## Non-goals

- [N1] Does not run the audit or the tests; it validates their recorded results, provenance, and overlay/full-sha binding.
- [N2] Does not change what the Codex audit judges or how it is dispatched.
- [N3] Does not unregister overlays already loaded; that stays an orchestrator step. Refusing a refresh retains the previously loaded, verified sha; an existing registration does not authorize a newer sha.
- [N4] Does not cover non-overlay daemon changes.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the verdict is read as a fixed enum from a structured record, not by searching free audit text for "NOT WEAKENED"; audit prose that quotes the phrase does not count.
2. **Truncated reads** — a record file cut mid-write fails to parse and counts as no verdict.
3. **Shared state files** — verdict and test markers are written atomically (temp file then rename) so a reader never sees a partial record.
4. **Fail closed** — missing, unparsable, unreadable, unauthenticated, or mismatched record, or unavailable trusted storage: refuse registration/adoption; automatic refresh retains the previously loaded, verified sha.
5. **Identity scoping** — records are keyed by overlay and full sha; one lane's marker cannot satisfy another lane's overlay.
6. **State over time** — any new commit or rebase needs fresh proofs for its full sha. Every adoption, including automatic refresh, rebuild, recovery, and retry, checks the resolved sha at the shared adoption boundary before applying it; checking only add/load entry points or reusing registration-time authorization is insufficient. Pin the checked sha through application; if the target changes, resolve and validate again before applying.
7. **Who wrote it** — provenance comes from a worker-inaccessible trusted store, writable only by the audit dispatcher and test gate through authenticated, role-specific access. Plan the trusted store access and producer integration in we:scripts/lib/daemon-overlay-proofs.mjs. Each trusted producer binds its actual run result to the overlay/full sha; workers cannot submit arbitrary successful results through those writers. Consumers read from the fixed trusted store, never a worker-selected path or cwd, and reject worker-controlled files, symlinks, and self-declared writer fields as authentication. Storage isolation must enforce this boundary even when workers share a host; a same-user writable file with an identity field is insufficient. A worker cannot create, alter, replace, or redirect either trusted record; a writer label is metadata only.
