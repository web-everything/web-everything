---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/red-main-hold.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/readiness/red-main-remediation.mjs", "we:scripts/lib/drain-skip-reasons.mjs", "we:scripts/settings/red-main-hold.json"]
dateOpened: "2026-10-09"
tags: []
---

# Drain red-main-hold: while main is red only the main-fix PR lands (contain third of the safety net)

Held items 164+166. Freeze marker lived in the importing clone's .conveyor/; the daemon flips code root lane-1/code, so a freeze raised in the code clone (2026-10-09 01:03Z) was ignored and #4537/#4539 merged. Now ONE source in the coordination root. While main is red (health-watch main-ci-red-state/main-red-priority or manual freeze) the drain lands only the published main-fix PR(s); others skip with red-main-hold; lifts when the record clears. Setting redMainHold (x5wnfcg cascade, default on). Replay fixtures 2026-10-09 windows. Branch lane/red-main-contain, stacked on #4619.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/red-main-hold.test.mjs` passes (absent module before): replay holds #4537/#4539 and #4563/#4604/#4615/#4603/#4618/#4606/#4616/#4613, lets #4532/#4617 through.
- [A2] **Live** — while main is red, a drain pass logs `skip-reasons` rows of kind `red-main-hold` for every non-fix local PR; the fix PR is not held.
- [A3] **Must** — the hold only ADDS a skip after every other gate: an allowed fix PR still passes every merge gate. Setting `off` restores the old full stop on a manual freeze.

- [A4] **Quarantine mode (OFF, `redMainMode: stop`)** — `npm run test:unit -- we:scripts/lib/__tests__/red-main-quarantine.test.mjs we:scripts/lib/__tests__/red-main-quarantine-io.test.mjs` passes: only red-main-safety-net/operator write `ops/quarantine` (push-ref guard, exact ref), add/remove events in `events.jsonl`, the main-fix PR skips nothing, entries removed on green, PRs overlapping the fix PR or the test area held (replay: #4613 held on 2026-10-09), no live entry ⇒ stop.

## Non-goals

- [N1] Turning quarantine on (needs a red-team review), wiring the CI skip step into we:.github/workflows/ci.yml and the health watch's auto add/prune (CLI ready: we:scripts/lib/red-main-quarantine-io.mjs). Auto-clearing a MANUAL freeze marker (it still needs `unfreeze`); rebasing the fix PR (the merge-queue refresh does that).

## Edge cases this change must handle

1. **Untrusted text** — fix PRs come only from the health watch's published record (trusted-author rule in findOwnerPrs), never from a PR title read here.
2. **Truncated reads** — an unreadable or malformed record reads as absent (no hold); same as the builder's main-red freeze.
3. **Shared state files** — one marker in the coordination root, written atomically; tests keep the per-clone path.
4. **Fail closed** — a red signal with no published fix PR holds every local PR.
5. **Identity scoping** — only local-repo (WE) PRs are held; a priority record for another repo exempts nothing.
6. **State over time** — records carry expiresAt (30 min TTL); a stopped health watch cannot hold the queue past it.
7. **Who wrote it** — health watch (published records) or the operator (manual freeze CLI).
