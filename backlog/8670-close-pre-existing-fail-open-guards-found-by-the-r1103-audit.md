---
bornAs: xnfch47
kind: task
status: open
scope: ["we:scripts/conveyor/ci-heal-reserve.mjs", "we:scripts/conveyor/dispatch-throttle.mjs", "we:scripts/conveyor/resource-gate.mjs", "we:scripts/conveyor/__tests__/resource-gate-fail-closed.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Close pre-existing fail-open guards found by the R1103 audits

Seven fail-open guard sites found by the R1103 audits: we:scripts/conveyor/ci-heal-reserve.mjs:44 claim-read failure counts as zero holders; we:scripts/conveyor/ci-heal-reserve.mjs:52 host-gate exception admits; we:scripts/conveyor/dispatch-throttle.mjs:113 unavailable host measurement admits; we:scripts/conveyor/dispatch-throttle.mjs:192 claim-read failure counts as zero live sessions; we:scripts/conveyor/dispatch-throttle.mjs:197 gate exception fails open; we:scripts/conveyor/resource-gate.mjs:400 same claim-read fallback; heavy-admission lease-expired holders and gh-throttle-holders age-based reaping admit while old work still runs.

## Acceptance

- [A1] **Executable** — Planned `refuses admission at every audited fail-open site` in `we:scripts/conveyor/__tests__/resource-gate-fail-closed.test.mjs`: Use one table row for each of the seven audited sites, including claim-read failure, gate exception, unavailable host measurement and expired holder with live work; assert explicit refusal and zero admitted work for every row.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No unrelated admission-policy expansion.

## Edge cases this change must handle

1. **Untrusted text** — Holder records remain data.
2. **Truncated reads** — Unreadable claims or host measurements refuse admission.
3. **Shared state files** — Do not reap a holder solely because its lease or age expired.
4. **Fail closed** — Each guard failure blocks admission with an operator-visible reason.
5. **Identity scoping** — Tie holders to the actual running work.
6. **State over time** — Cover expired leases and old holders with still-running work.
7. **Who wrote it** — Only verified holder/liveness evidence can free capacity.
