---
bornAs: xytdhg8
kind: story
size: 3
status: open
dateOpened: "2026-10-09"
tags: []
---

# Require per-attempt ownership for build-dispatch claim release

A stale delivery wrapper can delete a newer attempt's claim because releaseBuildDispatchClaim currently deletes by resource alone. Require a per-attempt owner token by default, with resource-only retirement an explicit opt-out, without choosing the full ownership protocol in this filing.

## Design

- Trace acquisition in we:skills-src/conveyor/build-dispatch-daemon.mjs through the dispatch CLI boundary and wrapper launch payload to release in we:scripts/conveyor/build-dispatch-claim.mjs. Inventory all callers and distinguish the originating attempt from administrative retirement.
- Mint and thread the attempt identity from acquisition through dispatch and wrapper launch; default release must prove it owns the current attempt. Resource-only release must require an explicit opt-out at intentional retirement callers.
- Consider an owner-less-call lint or write gate to prevent callers silently returning to unchecked release. Specify the storage race guarantees before choosing the protocol.
- The known gap is documented beside releaseBuildDispatchClaim. #4410 fixes successful hold persistence ordering only; its real-store test fixtures provide a starting point for the additional overlapping-attempt regression required here.

## Test plan

Drive acquisition through the real dispatch-to-wrapper call path. Attempt A becomes stale, attempt B acquires a newer claim, and A then releases: B must remain live. Cover valid-owner release, missing/wrong tokens, explicit resource-only opt-out, and propagation through the CLI payload. A final-state unit test of release alone is insufficient.

## Done when

Default release rejects missing or mismatched attempt ownership, every originating-attempt caller carries the token, intentional resource-only retirement is explicit, and the stale-attempt regression passes. Atomic hold replacement and the run-store CAS race remain separate work.
