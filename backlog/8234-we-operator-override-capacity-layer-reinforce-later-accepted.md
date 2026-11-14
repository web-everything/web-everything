---
bornAs: x84e226
kind: story
size: 2
parent: "6268"
status: open
scaffoldedBy: "operator-override-capacity"
dateScaffolded: "2026-11-13"
scope: ["we:scripts/lib/operator-override-reader.mjs", "we:scripts/lib/resource-gate.mjs", "we:scripts/lib/red-team-dispatch-queue.mjs"]
dateOpened: "2026-11-13"
tags: []
related: ["6266"]
---

# we: operator-override capacity layer reinforce-later - accepted residuals
Reinforce-later for the capacity-only operator-override slice (rulings R903+R907+R915, 2026-11-13). Accepted residuals, disclosed in the PR and the ruledWeakened entry: (1) capacity writes carry an attested OS user and a reason but no signed attestation (the signed trust root is the guard-leaves card); (2) the 25% mem-free floor for raiseMinMemFreePct; (3) the operator-only red-team cap of 12; (4) an operator value beats a stricter configured value, and a floor override raises a configured ceiling. Revisit once the guard-leaves card lands: confirm each is still wanted, or add a confirmation step for loosening writes.

## Acceptance

- [A1] **Executable** - `npm run test:unit -- we:scripts/lib/__tests__/operator-override-store.test.mjs`: a loosening write below the configured value requires the confirmation the guard-leaves card defines. Named test `loosening writes require confirmation and leave the store unchanged without it` in that file: a loosening write without the confirmation is refused and the stored file stays byte-identical; the same write with it is accepted and audited.

