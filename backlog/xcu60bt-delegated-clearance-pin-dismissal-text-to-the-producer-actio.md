---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/__tests__/delegated-clearance-sweep.test.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Delegated clearance: pin dismissal text to the producer action block

PR #5983 deferred its later-round advisory coverage suggestion to a card. Add named boundary regressions for we:scripts/conveyor/delegated-clearance-sweep.mjs so only finding-specific dismissal lines in the producer action block can supersede a confirmed break; quoted findings and free-form text outside that block must leave the human hold intact.

## Acceptance

- [A1] **Executable** — The command below includes named cases where dismissal-shaped lines appear after a blank line, in quoted findings, and in free-form text below the producer action block. Each leaves the approval void and calls no label writer.
- [A2] The same suite includes a positive control: a trusted operator marker with matching PR, revision, result identity and finding indices dismisses only the named findings when the line is inside the action block. Cover both marker-only and marker-plus-heading formats.
- [A3] A mutation that scans beyond the action block makes at least one new negative case fail. The unchanged production parser is expected to pass these coverage tests already; record mutation evidence rather than claiming a live parser bug.

### Named planned cases (A1–A3)

Add these cases to `we:scripts/conveyor/__tests__/delegated-clearance-sweep.test.mjs`; these are planned tests, not claims of existing coverage. Use a complete synthetic thread with an older confirmed break, a matching pre-approval and injected state, event and label sinks.

- **A1 — `dismissal after a blank line leaves the approval void`**: put a matching dismissal line after the blank line terminating the trusted operator's action block. Assert `pre-approval-void` and zero label-writer calls.
- **A1 — `quoted dismissal in findings leaves the approval void`**: put the same line in a Markdown blockquote in the findings below the action block. Assert `pre-approval-void` and zero label-writer calls.
- **A1 — `free-form dismissal below the action block leaves the approval void`**: put the same line below a subsequent prose heading. Assert `pre-approval-void` and zero label-writer calls.
- **A2 — `in-block dismissal targets only named findings ($format)`**: parameterize marker-only and marker-plus-heading formats. Use a trusted operator marker matching PR, revision and result identity with two confirmed finding indices; dismiss one inside the block and verify the other still voids approval with zero label writes. A control dismissing both indices permits exactly one label write. Parameterize mismatched PR, revision, result identity, finding index and untrusted author as refusal controls.
- **A3 — `action-block boundary mutation is caught by blank-line dismissal`**: temporarily extend the parser's action-block scan past its terminating blank line in an isolated mutation checkout. Run the first A1 case and record its failure (missing `pre-approval-void` or an unexpected label write), then record the normal parser's passing run. Do not commit the mutation or describe it as a production defect.

Run from the WE checkout:

```bash
npm run test:unit -- scripts/conveyor/__tests__/delegated-clearance-sweep.test.mjs
```

## Non-goals

- [N1] Change dismissal authority, production parsing, clearance labels, or the human review ceremony. This is the deferred test-coverage suggestion, not a demonstrated runtime defect.

## Edge cases this change must handle

1. **Untrusted text** — Treat quotes, markdown and dismissal-shaped prose as comment data outside the action block.
2. **Truncated reads** — Use complete synthetic comment threads; no remote reads.
3. **Shared state files** — Inject isolated in-memory state and all write sinks.
4. **Fail closed** — Partial or absent finding-specific action lines cannot dismiss a break.
5. **Identity scoping** — Keep PR, head, result identity and finding indices matched in controls; mismatches refuse.
6. **State over time** — An older confirmed break remains unresolved after later unrelated prose.
7. **Who wrote it** — Only the trusted operator author can dismiss; include an untrusted-author control.
