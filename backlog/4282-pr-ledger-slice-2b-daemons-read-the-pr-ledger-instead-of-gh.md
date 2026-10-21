---
bornAs: xhq6gly
kind: story
size: 8
parent: "4075"
status: open
dateOpened: "2026-09-27"
tags: []
scope: ["we:scripts/lib/pr-ledger-client.mjs", "we:scripts/lib/__tests__/pr-ledger-client.test.mjs", "we:scripts/lib/pr-snapshot.mjs", "we:scripts/lib/__tests__/pr-snapshot.test.mjs", "we:scripts/lib/pr-events.mjs", "we:scripts/lib/__tests__/pr-events.test.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs"]
---

# PR ledger slice 2b: daemons read the PR ledger instead of gh pr list

The Worker now serves an authenticated per-PR projection, while shared snapshot discovery still pages GitHub. Add one shared ledger client and use its complete, fresh repo snapshot for review/fix discovery, retaining targeted GitHub hydration for fields the projection does not carry. Fall back to the existing bounded GitHub discovery path when feed health or coverage is inadequate; never mistake a partial ledger for an empty repo. Size 8 covers client/cache, snapshot integration and both daemon callers/tests. #4281 is resolved, so it is no longer an unmet dependency.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/pr-ledger-client.test.mjs` — a local HTTP fixture serves an authenticated /prs response; assert repo filtering, stateCursor/coverage validation, pagination/gap handling and a complete open-PR projection. The new client suite fails before implementation. No test uses live credentials.
- [A2] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/pr-snapshot.test.mjs` — add a warm-cache ledger discovery case that performs one Worker snapshot read and zero GitHub PR-list calls, plus changed-head hydration cases. Verify repeated review/fix consumers share the result and missing heavy fields are hydrated rather than fabricated.
- [A3] Unreachable/stale feed, missing bootstrap coverage, malformed projection, cursor gap or wrong-repo response triggers a named bounded GitHub fallback. If fallback also fails or is deferred, return an explicit unavailable/deferred result; do not report zero PRs or authorize mutations.
- [A4] Both daemon integration suites exercise ledger discovery, stale fallback and changed heads with recording subprocess adapters. Preserve GitHub re-derivation immediately before any mutation under we:docs/agent/platform-decisions.md#event-driven-land-is-wake-only; unknown checks/reviews are never green.
- [A5] Run a local Worker-to-client-to-daemon smoke fixture showing a create/head-change/close sequence and fallback after induced feed failure; capture PR-list call counts separately from targeted hydration/gate reads. Do not claim near-zero total GraphQL use merely from replacing list calls.

## Non-goals

- [N1] No ledger authority flip, label-policy change, second landing writer, Worker deployment or historical reconciliation.
- [N2] No removal of targeted GitHub evidence reads for comments/files/body or mutation-time authorization.

## Edge cases this change must handle

1. **Untrusted text** — Validate repo identifiers, numeric PRs, SHAs and endpoint configuration; labels/titles remain data, and credentials never appear in logs or child argv.
2. **Truncated reads** — Respect snapshot stateCursor versus event-page cursor; validate coverage and complete fallback pages, with bounded response size and named truncation refusal.
3. **Shared state files** — Reuse the host-shared snapshot lock and atomic cache writes; refresh under one owner and publish cursor plus rows together.
4. **Fail closed** — HTTP/auth/JSON/coverage failures invoke explicit fallback; failure of both sources is unavailable, never empty or approved.
5. **Identity scoping** — Key cache/cursors by endpoint and repo, rows by repo/PR/head; one repo’s bootstrap or health cannot establish another’s coverage.
6. **State over time** — Handle cursor reset/gap, close/reopen, head changes, restart and clock skew; expire stale hydration and do not revive closed rows from older snapshots.
7. **Who wrote it** — Use authenticated Worker reads and producer provenance; observed labels/reviews remain hints and cannot impersonate gate authority.

## Grounding

- we:scripts/conveyor/pr-events-worker/core.mjs:288 returns prs, stateCursor and coverage; :384–394 authenticates and serves /prs.
- we:scripts/lib/pr-events.mjs:95 classifies unreachable/stale/healthy; transport success alone is not fresh-delivery proof.
- we:scripts/lib/pr-snapshot.mjs:170 calls listOpenPrsLightPaged and :181 hydrates heavy fields; discovery is still GitHub-backed.
- we:scripts/conveyor/reconcile-pass.mjs:308 defines defaultReadPrs; :312 reads the shared snapshot before its direct GitHub fallback.
- we:skills-src/conveyor/review-daemon.mjs:1087 injects defaultReadPrs into the daemon path.
- we:backlog/4281-pr-ledger-slice-2a-derive-per-pr-state-from-the-webhook-even.md:6 is resolved; the prerequisite producer and its /prs route exist.
- we:docs/agent/platform-decisions.md:3741 retains live server-side gate derivation; the ledger changes discovery only.
