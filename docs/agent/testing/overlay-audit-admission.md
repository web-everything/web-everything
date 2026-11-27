## Overlay audit admission

`daemon-overlay add` and the in-process loader require canonical audit evidence for the guard's
fetched candidate SHA before registration, under the add lock. `--expected-sha` also binds the guard
to the approved SHA. `--check` uses the same evaluation and reports `wouldRegister:false`, exit 3,
and `no-audit-evidence` on refusal. An operator must run codex-audit or supply a matching waiver;
`--allow-no-pr` does not bypass this gate. Replace, retire and remove keep their existing policies.

`overlaySafety.auditEvidence` defaults to `refuse`; only an explicit file `warn` permits warnings.
`WE_OVERLAY_AUDIT_EVIDENCE` may tighten to `refuse`, but cannot loosen the file/default. Invalid
values refuse. Admission logs the effective mode and source. Older real-Git fixtures must supply
candidate audit records (see `scripts/__tests__/fixtures/overlay-audit.mjs`) or explicit file settings.
An environment `warn` alone is insufficient. Injected registration/admission functions remain test IO seams.

`overlay-audit-evidence.test.mjs` covers malformed records, unusable negative vetoes, platform read
errors, waiver time bounds and withdrawal damage. A malformed ledger needs repair before a re-audit
can admit it. Inventory loads each clone's audit ledger relative to that clone, retains global waiver
stores, and requires evidence for both branch tip and approved edge SHA. These paths are covered by
`daemon-overlay-audit-check.test.mjs`; admission and tightening by `daemon-overlay-audit-gate.test.mjs`.
`prototype-load.test.mjs` verifies that code 3 and its reason survive both check and registration.

Push-gate allowlist entries may pin `commands` as normalized literal Git subcommand/flag arrays,
in addition to site counts. `findRawPushes` enforces pins when supplied by the inventory test;
unknown commands and shell forms refuse. The unchanged-count push regression must stay red for
an unpinned push even when the site count matches.
