---
kind: task
status: open
scope: ["we:scripts/operations/open-pr-io.mjs", "we:scripts/operations/__tests__/open-pr-audit-gate.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Audit-carry hardening: origin/main ref, repo binding, malformed WITHDRAWN waivers, bypass-note edges

Audit-carry items: refs/remotes/origin/main hardening; repository binding in carry; malformed-WITHDRAWN fail-open in the waiver store; bypass-note edge cases (first --body-file or empty body, we:scripts/operations/open-pr-io.mjs:97-104). Source: build-queue 23:56 ET 2026-11-20.

## Acceptance

- [A1] **Executable** — Planned `rejects audit carry from wrong ref or repository` in `we:scripts/operations/__tests__/open-pr-audit-gate.test.mjs`: Parameterize a non-origin/main ref and another repository; assert carry is refused and no PR is opened.
- [A2] **Executable** — Planned `rejects malformed WITHDRAWN waivers` in `we:scripts/operations/__tests__/open-pr-audit-gate.test.mjs`: Supply malformed waiver records; assert audit admission refuses each rather than carrying a verdict.
- [A3] **Executable** — Planned `checks first body-file and empty-body bypass notes` in `we:scripts/operations/__tests__/open-pr-audit-gate.test.mjs`: Exercise the first --body-file input and an empty body; assert required bypass notes cannot be omitted to obtain admission.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No broader audit-carry exemption.

## Edge cases this change must handle

1. **Untrusted text** — Waiver and body text cannot grant authority.
2. **Truncated reads** — Partial waiver or ref reads refuse carry.
3. **Shared state files** — Do not corrupt waiver records on parse failure.
4. **Fail closed** — Malformed evidence refuses carry with a visible reason.
5. **Identity scoping** — Bind carry to its repository and canonical origin/main ref.
6. **State over time** — Recheck carry after ref or waiver changes.
7. **Who wrote it** — Only valid approval provenance authorizes a waiver.

## Duplicate admission

nd
