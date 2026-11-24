---
bornAs: xbyclyl
kind: story
size: 3
status: open
scope: ["we:scripts/operations/codex-audit.mjs", "we:scripts/operations/codex-audit-io.mjs", "we:scripts/operations/audit-nonconvergence.mjs", "we:scripts/operations/__tests__/audit-nonconvergence.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Recover unreadable Codex audit lineages with preserved evidence

PR #7415 review requested an operator recovery path for unreadable audit history. A malformed JSONL line blocks parsing before ref filtering, and a historical WEAKENED record with empty findings invalidates its lineage. A later NOT WEAKENED audit then exits 3 without recording a pass. The existing design-pass request is diagnostic; it does not repair the ledger.

## Design

Prepare a bounded operator recovery operation, such as quarantine plus an explicit recovery record, that preserves the original bytes and identifies the affected ledger, ref and question hash. Choose and document its authorization and restart semantics before implementation. Ordinary audits must continue refusing unreadable evidence until recovery is explicitly completed; recovery must not silently discard a WEAKENED verdict or manufacture a pass.

## MVP

Recover a disposable ledger containing one torn JSONL line and a separate lineage containing an empty WEAKENED record. Preserve valid neighboring records, retain the original corrupt evidence, and allow a fresh full audit to record its independently obtained verdict after recovery.

## Acceptance

- [A1] **Executable** — Add a real-adapter regression in `we:scripts/operations/__tests__/audit-nonconvergence.test.mjs` covering malformed JSONL and empty WEAKENED findings: the ordinary NOT WEAKENED attempt exits 3 before recovery; the explicit recovery retains the original evidence and permits a subsequent full audit to record its verdict.
- [A2] **Executable** — Add negative cases for unreadable backups, failed writes, wrong ref/question hash, interrupted recovery, concurrent append and duplicate retries. Incomplete recovery must retain the refusal and must not emit a passing audit record.
- [A3] **Observed** — Document the operator command, its authorization, preserved-evidence location and recovery diagnostics. Replay a temporary ledger through refusal, recovery and a fresh audit, reporting exact exit codes and the untouched neighboring records.

Run the affected test file through `npm run test:unit -- scripts/operations/__tests__/audit-nonconvergence.test.mjs`. These are planned acceptance checks, not results from this filing.

## Non-goals

- [N1] No automatic skip-malformed mode, waiver of findings, merge authorization or change to the normal nonconvergence threshold.

## Edge cases this change must handle

1. **Untrusted text** — Treat ledger bytes and ref values as data; sanitize terminal diagnostics.
2. **Truncated reads** — Preserve torn records verbatim and refuse incomplete recovery evidence.
3. **Shared state files** — Serialize recovery with audit writers and preserve concurrent valid appends.
4. **Fail closed** — Backup, parse, authorization or persistence failures leave admission blocked.
5. **Identity scoping** — Bind recovery to the ledger, ref, question hash and preserved evidence; prevent cross-ref override.
6. **State over time** — Retry after crashes without double-applying recovery or losing records.
7. **Who wrote it** — Require explicit operator authority; an audit producer cannot grant itself recovery approval.

## Duplicate admission

Local backlog search for unreadable lineage, audit nonconvergence and Codex audit recovery found no matching card. #8039 concerns the separate PR-stall-sweep audit store and does not recover the Codex audit ledger. Filed locally because this repair sandbox forbids network access and Git writes used by file-item publication.
