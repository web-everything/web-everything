---
kind: task
status: open
scope: ["we:scripts/operations/", "we:scripts/operations/__tests__/"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention: version waiver handoff writers and enforce rejection contracts

PR #7493 review found that the waiver writers are outside the repository, so CI cannot defend their rejection guarantee. Move the installed waive.sh and waive-scratch.sh into a repository-owned handoff source and define installation ownership. Add one named rejection test per writer against isolated HOME and HANDOFF_DIR fixtures, asserting nonzero status and unchanged request and approval logs. The current installed scripts pass the local isolated probes, but those probes are not portable repository coverage. Reuse the deterministic Acceptance-to-test mapping work in #7050 for review-card admission.

## Acceptance

- [A1] **Executable** — Planned `handoff writers reject non-JSON input without appending: waive.sh` and `handoff writers reject non-JSON input without appending: waive-scratch.sh` in we:scripts/operations/__tests__/handoff-writers-contract.test.mjs run through `npm run test:unit -- <contract-test-file>`. Each invokes the repository-owned writer in an isolated home, asserts failure status and byte-identical request and approval logs, and asserts that the approval/recording subprocess was not invoked.
- [A2] **Executable** — The same suite accepts one valid request and rejects raw malformed JSON, quotes/newlines that would break manually composed JSON, and invalid or empty ref/sha/ruling inputs without appending. No developer-home files, installed scripts or network access are required.
- [A3] **Review** — Document the installation source and update mechanism for both writers. The deployed copy must match the version exercised by CI. Record local contract evidence separately until that ownership is established.
- [A4] **Executable** — Coordinate with #7050 so review-card admission requires a repository-qualified test file, exact case title and observable assertion for every acceptance promise. Missing mappings, unreadable files and nonexistent titles refuse admission; comments or skipped cases do not satisfy implemented guarantees.

## Non-goals

- [N1] No change to waiver approval authority, audit admission, historical log contents, or automatic publication of an approval.

## Edge cases this change must handle

1. **Untrusted text** — Quotes, CR/LF, Unicode and shell metacharacters remain data. Validate and serialize before appending; tests assert both failure and unchanged bytes.
2. **Truncated reads** — Partial JSON and failed input reads refuse without touching either log.
3. **Shared state files** — Tests use isolated destinations; retain existing append/deduplication behavior and avoid any dependency on the operator's live logs.
4. **Fail closed** — Invalid input or unavailable validators refuse before append or approval. There is no HTTP endpoint, so CSRF and network rate limits are inapplicable; bound local input and child execution.
5. **Identity scoping** — Test both writers and verify exactly which request and approval destinations each touches.
6. **State over time** — Pin unchanged logs on failure, including pre-existing entries; test deduplication when a request already exists.
7. **Who wrote it** — Repository source supplies the writer; installation provenance must bind the deployed copy to that source.

## Duplicate admission

#7050 covers generic mapping validation; this card covers external waiver writer ownership and behavioral rejection contracts.
