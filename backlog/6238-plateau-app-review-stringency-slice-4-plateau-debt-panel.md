---
bornAs: xcwndpf
kind: story
size: 5
parent: "6236"
status: open
blockedBy: ["6237"]
dateOpened: "2026-10-17"
tags: []
---

# plateau-app: review stringency slice 4 — plateau debt panel

A read-only plateau-app panel over the debt items: class, severity, must-pay-before level, deadline, source PR. Built last, after the debt register exists. Ruled in 6239.

## Acceptance

- [A1] **Executable** — plateau-app rendering test `debt-panel-fields` displays class, severity, must-pay-before level, deadline and source PR/finding for ordinary debt and overdue expedite fixtures, using the register's effective state rather than recalculating payment from status.
- [A2] **Executable** — rendering test `debt-panel-untrusted-content` supplies instruction strings, markup, quotes, backticks, newlines, invisible characters and unsafe source URLs; text renders inert, links allow only validated source repository/PR destinations, and no debt content becomes HTML, script or an agent instruction.
- [A3] **Executable** — panel integration test `debt-panel-unavailable` supplies an unreadable or incomplete register and shows unavailable with its last successful revision/time, never a zero-debt or paid indication; paginated fixtures render all entries before the view is labelled complete.
- [A4] **Executable** — panel integration test `debt-panel-read-only-scope` uses the existing authenticated repository access boundary: unauthorized repositories refuse before returning debt, authorized reads remain read-only, and crafted requests expose no payment, level-change or deadline-change action.
- [A5] **Executable** — panel integration test `debt-panel-revision-refresh` replaces a snapshot during refresh; only one complete revision renders, older responses cannot overwrite newer state, and source/provenance links retain the matching repository and finding.
- [A6] **Executable** — endpoint test `debt-panel-request-bounds` rejects nonempty request bodies and query/header input above 16 KiB before parsing; enforce 60 reads per rolling minute per authenticated repository/principal, with request 61 refused. Foreign-origin credentialed requests refuse and CORS does not grant foreign origins access. CSRF-token `n/a:` because authenticated reads have no state mutation, refresh/reset/write action or cookie-changing side effect; A4 proves crafted write/reset attempts refuse. Test floods, oversized queries and foreign origins through the production read endpoint, preserving repository access checks.

Ruling and amended table: [we:backlog/6239](/backlog/6239-decision-review-stringency-classified-findings-per-level-out/) and the statute `we:docs/agent/platform-decisions.md#review-stringency-classified-outcomes`.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] This panel grants no debt or settings write authority and does not implement gate decisions. Slice 5 may follow the register independently; this is the last core delivery surface.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — inert rendering and validated source links (A2); content never supplies authority (A4).
2. **Truncated reads** — incomplete pages and unreadable snapshots show unavailable, never zero debt (A3).
3. **Shared state files** — the panel reads revisioned snapshots and writes no register files (A4–A5).
4. **Fail closed** — unavailable data cannot claim a clear gate (A3); the authoritative gate remains slice 3.
5. **Identity scoping** — repository access is checked before data disclosure (A4); source PR/finding remains attached (A1, A5).
6. **State over time** — stale responses cannot replace newer state and unavailable data is labelled with its last successful revision/time (A3, A5).
7. **Who wrote it** — no browser or agent claim authorizes a write through this read-only view (A4).

## Risks

Untrusted debt could execute markup or leak repository data (A2, A4), incomplete/stale state could appear paid (A1, A3, A5), or requests could exhaust the read endpoint (A6).

## Test plan

Planned file `plateau-app:tests/debt-panel.spec.ts` owns all named A1–A6 cases and the observable assertions above. Exercise the real authenticated read endpoint and rendered panel, including body-size, rate limit and origin refusals. This cross-repository file is an implementation destination; no panel tests are delivered by the decision PR.
