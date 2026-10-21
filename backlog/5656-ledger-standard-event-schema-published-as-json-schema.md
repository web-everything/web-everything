---
bornAs: xedhm8w
kind: story
size: 5
parent: "5445"
status: open
scope: ["we:schemas/verdict-ledger-event.v1.json", "we:scripts/lib/__tests__/verdict-ledger-event-schema.test.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Ledger standard: event schema published as JSON Schema

Publish the existing ledger wire acceptance contract as JSON Schema in we:schemas/verdict-ledger-event.v1.json (proposed). Cover every current EVENT_TYPES member, including review-exempt, plus legacy verdict rows with no type. The schema artifact version is distinct from row versions. Keep state vocabulary independent of GitHub label enums; the existing label-input payload remains an opaque string. This publishes current validation, not a stricter replacement.

## Acceptance

Run each criterion after adding its named regression cases (red before, green after). Queue helper, from the repo root:

```bash
q=we:scripts/readiness/heavy-admission.mjs
prove() { node "${q#we:}" run -- npx vitest run "${1#we:}"; }
```

- [A1] **Executable** — `prove we:scripts/lib/__tests__/verdict-ledger.test.mjs`: validate all existing buildLedgerEvent/buildVerdictRecord fixture cases against the schema, with at least one row for every EVENT_TYPE_VALUES member and a legacy untyped verdict; assert complete enum coverage and acceptance by both schema and validateLedgerEvent. Missing schema makes the added tests fail before publication.
- [A2] **Executable** — `prove we:scripts/lib/__tests__/verdict-ledger.test.mjs`: add shared accept/reject cases for each payload requirement, unknown types, wrong kind/version/id/repo/PR/time/source, optional fields, extra properties and normalization boundaries; compare validity on the same raw inputs, without coercion or default insertion. Include label-input as opaque data, not a lifecycle enum.

## Non-goals

- [N1] No runtime-validator behavior changes, label migration, new event types, store adapters, or derive-rule changes.

## Edge cases this change must handle

1. **Untrusted text** — Validate raw JSON values; text fields carry data, not authority. Include whitespace-only required strings and hostile-looking source/label strings.
2. **Truncated reads** — Invalid JSON is rejected before schema validation; missing required fields must match runtime rejection, while genuinely optional fields remain optional.
3. **Shared state files** — n/a: publishing a static schema and isolated fixtures does not write a live ledger.
4. **Fail closed** — Unknown event types and invalid required fields reject; preserve current extra-property and version acceptance rather than invent stricter rules.
5. **Identity scoping** — Match current repo/positive PR syntax and event-id validation; schema validity does not prove that a row belongs to a requested repository.
6. **State over time** — Retain legacy verdict acceptance and current v2+ event behavior; use fixed timestamps and test the runtime timestamp syntax, not an unrelated stricter date parser.
7. **Who wrote it** — Require source exactly as the runtime does; actor declarations and writer strings are not verified identity. No receive endpoint: HTTP size/rate/origin/CSRF controls and state-reset triggers are n/a.

## Grounding

- we:scripts/lib/verdict-ledger.mjs:532 declares 12 event types, including review-exempt; :611 defines label-input.
- we:scripts/lib/verdict-ledger.mjs:686 accepts legacy untyped verdicts and validates raw events; :699 accepts event versions at least the current version.
- we:scripts/lib/verdict-ledger.mjs:368 builds verdict fixtures; :651 builds non-verdict fixtures.
