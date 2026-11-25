---
kind: story
size: 5
status: open
dateOpened: "2026-11-25"
scope: ["we:scripts/lib/overlay-audit-evidence.mjs", "we:scripts/daemon-overlay-audit-check.mjs", "we:scripts/lib/__tests__/overlay-audit-evidence.test.mjs", "we:scripts/__tests__/daemon-overlay-audit-check.test.mjs", "we:scripts/operations/prototype-load.mjs", "we:scripts/operations/ruled-weakened-store.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/push-gate-allowlist.json"]
tags: []
---

# Overlay audit inventory prevention and RS-7369-2 conditions

PR #7490 review (2026-11-25T14:13:57Z) requires durable prevention for the report-only RS-7369-1 inventory. The seven disclosed audit findings remain conditions on RS-7369-2: complete these before enabling admission enforcement. No existing RS-7369-2 conditions card was found in this checkout. This card records the conditions; it does not certify their implementation or authorize enforcement.

## Design

Keep the canonical audit evaluator shared with the prototype loader. Resolve evidence in each registered clone's context. Treat unreadable precedence layers and malformed evidence as unknown, while limiting attributable waiver-request damage to the affected ref. The inventory remains read-only and report-only until enforcement ships separately.

Current source was checked at we:scripts/lib/overlay-audit-evidence.mjs (loadAuditEvidence, auditEvidenceFor, mainCovers), we:scripts/daemon-overlay-audit-check.mjs (checkOverlays, main), we:scripts/operations/prototype-load.mjs (canonicalAuditEvidence), and we:scripts/operations/ruled-weakened-store.mjs (withdrawnRevocations, readStore). The shared revocation reader already supports scopeRef; the inventory currently omits it. Platform preference errors and non-ENOENT tool errors are currently ignored. The CLI currently shares one caller-relative evidence snapshot and omits edgeResolution.sha.

## MVP and acceptance

- [A1] Scope waiver-request damage per overlay ref: pass scopeRef to withdrawnRevocations for each overlay. Add `damage naming another ref preserves the current ref waiver` with a valid waiver and a damaged request whose other ref can be recovered. Also test same-ref damage, unattributable damage, unreadable and oversized request logs: refuse waivers and print the repair/archive fallback. A valid WITHDRAWN request still revokes regardless of unrelated damage. Cover settings and stored waivers through the CLI wiring.
- [A2] Refuse waiver admission on nonempty readPlatformPreferences.errors and on non-ENOENT tool-settings read/parse errors. Add separate named tests `corrupt platform preferences refuse stored waivers` and `corrupt tool settings refuse lower-layer waivers`, using otherwise usable stored evidence so dropping either guard makes its test fail. Test EACCES, malformed JSON, null/array/scalar settings, and ENOENT as the optional-layer absence case. Consider a scoped standards rule flagging readPlatformPreferences callers that never inspect errors; exercise its positive and negative fixtures.
- [A3] Require evidence for edgeResolution.sha as well as the locally resolved ref tip. Add `an unaudited edge resolution lists the overlay` with an audited ref tip; cover audited edge, malformed edge sha and missing ref. Do not grant from the historical registration sha when the ref moved or disappeared.
- [A4] Validate canonical record shape at the ledger boundary and in the shared evaluator. Table-test findings as string (`WEAKENED`), null, object, number and array with invalid elements. Test a valid older pass followed by a WEAKENED record with an invalid timestamp or contradictory findings, for the same base and another base. Both must refuse. Preserve a legitimate later re-audit's supersession and exact question/head/base binding. Include prototype-loader callers, not only inventory tests.
- [A5] Reject future-dated waivers so they cannot outlive a WITHDRAWN record. Test stored and settings waivers, dated and undated withdrawals, and ISO timezone variants. Preserve legitimate later operator rulings according to the shared revocation policy.
- [A6] Load audit evidence relative to each registered clone, not the caller cwd. Test two clones with the same relative auditRecordPath and different ledgers from a third cwd, plus absolute and home-relative settings. Each row must use its own clone's ledger; unreadable evidence in one clone grants that clone nothing.
- [A7] Bind push-gate migration pins to command identity, rather than only one-site counts. Cover both localSha and mainCovers: changing either read-only command to a write-capable command without changing its site count must fail the boundary test. Retain the validated ref/full-SHA guards, no-lazy-fetch and no-optional-lock guarantees.
- [A8] Prevent the two additional defects repaired in this review round. Both per-clone Git spawn sites now use scrubGitRepoEnv, and the CLI uses the shared realpath-based isDirectEntry helper. Add scoped standards rules rejecting per-clone spawns that pass process.env directly and lexical argv/import.meta entrypoint comparisons; include allowed shared-helper and rejected regression fixtures. Require named negative tests for the shared helper's repository/config override keys. Do not duplicate the existing helpers.
- [A9] Require mutation/revert-red evidence for fail-closed guards, using the sanctioned verify mechanism rather than hand-removing guards. The new real-repo mainCovers cases cover a non-ancestor, missing origin/main, bad cwd (returned and thrown spawn errors), and a resolvable non-40-hex base. New partly corrupt audits/store fixtures and unreadable-store fixtures pin refusal; directory tests cover ENOTDIR and ENOENT. Record which existing-behavior pins are deliberately non-discriminating on the pre-repair tree. Any new guard introduced for A1–A8 needs its own discriminating test.

## Edge cases

Unattributable request corruption remains fail closed [A1]; another ref's attributable damage does not suppress a usable waiver. Unreadable higher-precedence settings never fall back to granting from a lower layer [A2]. Exact SHA/ref matching, malformed schemas, contradictions and later unusable negative records remain explicit refusal cases [A3–A5]. No new write, fetch or admission gate is part of this follow-up's inventory repair [A6–A8]. Archive oversized request logs or restore readability and rerun; do not silently ignore unknown damage [A1, A9].

## Test and proof plan

Add the named cases to we:scripts/lib/__tests__/overlay-audit-evidence.test.mjs and we:scripts/__tests__/daemon-overlay-audit-check.test.mjs; add shared-evaluator cases beside existing canonicalAuditEvidence tests, and producer-side standards/boundary fixtures beside their current suites. Run affected tests through the normal queued test command and the diff-selected verify gate. Probe the actual CLI with isolated temporary HOME, two local repositories and no network, demonstrating an unaudited edge, scoped damage, per-clone paths, corrupt settings, symlink invocation and inherited Git overrides. Compare refs and persisted state before/after. Publish actual test/mutation results before RS-7369-2 enforcement is enabled.

## Non-goals

No enforcement, registry mutation, fetching, waiver grant, or broad rewrite of the prototype loader. This card records all supplied PR #7490 prevention obligations and the seven PR-body conditions; the review excerpt is truncated after the sixteenth visible finding, so an unavailable seventeenth finding is not claimed resolved here.
