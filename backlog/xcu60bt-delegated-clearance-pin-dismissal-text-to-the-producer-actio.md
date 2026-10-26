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
