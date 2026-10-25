---
bornAs: xchfioc
kind: task
status: open
scope: ["we:scripts/lib/daemon-overlay-proofs.mjs", "we:scripts/lib/__tests__/daemon-overlay-proofs.test.mjs", "we:scripts/daemon-overlay.mjs", "we:scripts/__tests__/daemon-overlay.test.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs", "we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-rebuild/adopt.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs", "we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-version-runtime.mjs", "we:scripts/worker-brief.mjs", "we:scripts/__tests__/worker-brief.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Worker brief: hard stop between audit and load

Require authenticated green-test and NOT WEAKENED audit proofs for the exact overlay identity/full SHA before registration and every adoption. Put verification at shared rebuild/adoption boundaries as well as add/load entry points, pin the verified commit through application, and retain the last verified build on refusal. A worker-written JSON marker is not authentication; implementing the trusted producers and storage boundary remains an explicit prerequisite to enabling this gate.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/__tests__/daemon-overlay.test.mjs` — add an add-command matrix: no proofs, audit only, tests only, wrong overlay/SHA, malformed/negative verdict and both valid. Only the last registers. These cases fail before proof enforcement exists.
- [A2] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/daemon-rebuild.test.mjs` — register/adopt proven A, advance its branch to B, then exercise automatic self-sync and rebuild. Missing/invalid B proof retains A; both valid B proofs permit B. Repeat through ready-candidate adoption, retry and a branch move after validation, asserting the applied SHA is precisely the proven SHA.
- [A3] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/daemon-load-overlay.test.mjs` — cover direct load and queued/versioned load so neither bypasses proofs. Refusal names the missing/invalid proof and checked SHA; no override may disable the check.
- [A4] Attack the proof store as the worker: forged writer fields, copied genuine proofs for another overlay/SHA, symlink redirection and requests to trusted producers with fabricated successful results must fail. Genuine producers attest their own completed runs; unavailable trusted storage refuses.
- [A5] The generated brief orders green tests, read-only audit, then register/load. Consumers accept only a structured NOT WEAKENED enum and a successful test run from independently authorized producers, never a phrase quoted in prose.

## Non-goals

- [N1] Do not change the audit rubric, automatically unregister loaded overlays, or gate non-overlay main updates.
- [N2] The consumer gate validates proofs; it does not run tests or audits itself. Producer integration and authenticated storage are nevertheless required for completion.

## Edge cases this change must handle

1. **Untrusted text** — Parse a fixed verdict schema and validated overlay identity; free audit prose cannot authorize adoption.
2. **Truncated reads** — Unreadable, incomplete or malformed proofs refuse; no partial record becomes success.
3. **Shared state files** — Publish proofs atomically in the trusted store and keep checked-SHA adoption under existing clone locks.
4. **Fail closed** — Missing authentication, inaccessible storage or mismatched SHA refuses and retains the verified running build.
5. **Identity scoping** — Bind both attestations to repo, overlay, full SHA and actual run identity; same-name overlays in another clone cannot borrow proof.
6. **State over time** — Every new SHA needs both proofs; revalidate ready candidates, automatic refresh and retries and carry pinned SHAs through application.
7. **Who wrote it** — Workers must be unable to write/replace the trusted records or invoke a producer with arbitrary results. Same-user writable files plus writer labels are insufficient.

## Grounding

- we:scripts/daemon-overlay.mjs:513 registers the overlay directly with addOverlay.
- we:scripts/lib/daemon-load-overlay.mjs:634 injects the registration/rebuild effects and line 662 calls the registration effect.
- we:scripts/lib/daemon-rebuild/prepare.mjs:260 invokes planRebuild; we:scripts/lib/daemon-rebuild/plan.mjs:514 resolves each moving remote overlay tip.
- we:scripts/lib/daemon-rebuild/rebuild.mjs:105 prepares under the clone write lock; proof checks must also cover ready adoption.
- we:scripts/worker-brief.mjs:120 starts the edge step without the requested audit-proof sequence. The planned we:scripts/lib/daemon-overlay-proofs.mjs does not exist in this checkout.
- Size 13 covers multiple adoption routes, hostile-worker tests and trusted producer integration, not a worker-brief wording patch.

## Open questions

Who operates the worker-inaccessible proof producers/store? Options: an isolated service/OS principal authenticating actual audit/test runs, or same-user local receipts. **Pick: isolated producers/store**; local receipts cannot satisfy the stated hostile-worker boundary. Human ownership/deployment choice is required, and the producer files cannot be named honestly until it is made. The scope above covers known consumers and planned proof module; extend it with those producers before dispatch. Slice seams (>8 points): trusted attestation service and producers; registration gate; automatic/ready/versioned adoption plus attack tests. No verified unresolved prerequisite card was found, so no invented blockedBy edge is added.
