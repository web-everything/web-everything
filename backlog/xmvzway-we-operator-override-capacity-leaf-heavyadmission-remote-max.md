---
kind: story
size: 3
parent: "6268"
status: open
scaffoldedBy: "operator-override-capacity"
dateScaffolded: "2026-11-13"
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/__tests__/heavy-admission-operator-override.test.mjs"]
dateOpened: "2026-11-13"
tags: []
related: ["6266"]
---

# we: operator-override capacity leaf heavyAdmission.remote.maxConcurrent wiring
Wire `heavyAdmission.remote.maxConcurrent` into the capacity-only operator-override layer. The leaf is in the design but refused by name today because `we:scripts/readiness/heavy-admission.mjs` was held by #6770 (R907, 2026-11-13). Add the operator layer in `loadAdmissionPolicy` (apply after `resolveAdmissionPolicy`, range 1..32, direction cap, fail-closed like the other leaves, source operator-db), with a test, once #6770 has landed.

## Acceptance

- [A1] **Executable** - `npm run test:unit -- we:scripts/readiness/__tests__/heavy-admission-operator-override.test.mjs`: an operator value of 4 resolves with source operator-db; a corrupt store keeps the stricter configured cap. Named tests: `operator cap 4 overrides lower layers with operator-db provenance` (assert effective cap 4 and source operator-db, with a configured cap of a different value) and `corrupt operator store preserves a stricter configured cap` (configure a cap below the fail-closed fallback, e.g. 1, corrupt the store, assert the effective cap stays 1).

