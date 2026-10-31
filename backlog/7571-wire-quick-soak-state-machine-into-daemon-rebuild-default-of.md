---
bornAs: xis8290
kind: story
size: 8
status: open
scope: ["we:scripts/lib/daemon-rebuild/quick-soak-job.mjs", "we:scripts/lib/daemon-rebuild/quick.mjs", "we:scripts/lib/daemon-rebuild/adopt.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/state.mjs", "we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/"]
scopeRationale: "New quick-soak state and control tests live under we:scripts/lib/daemon-rebuild/__tests__/. The basename-matched we:scripts/__tests__/state.test.mjs tests the unrelated /state CLI, not we:scripts/lib/daemon-rebuild/state.mjs."
blockedBy: ["7570"]
dateOpened: "2026-10-31"
preparedDate: "2026-10-31"
preparedAgainstSha: "06649b999eb6a4ddceadd53808ed09b5d9ee6cf6"
tags: []
---

# Wire quick-soak state machine into daemon-rebuild, default off; delete assertMarkerIdentity

Drive the daemon-rebuild quick soak through the pure state machine and CAS record from the prior card, behind a default-off setting; remove assertMarkerIdentity. Quick-off paths stay byte-identical.

## Acceptance

- [A1] **Executable** — the new wire-in tests under `we:scripts/lib/daemon-rebuild/__tests__/` fail before and pass after.
- [A2] **Executable** — with the quick setting off, daemon-rebuild outputs are byte-identical to `main` (control tests).
- [A3] **Executable** — `assertMarkerIdentity` no longer exists (`grep -rn assertMarkerIdentity scripts` is empty).

## Non-goals

- [N1] No default-on. The setting ships off; turning it on is a separate operator call.
- [N2] No change to the state machine tables (owned by card 7570).
- [N3] No migration: PR 6084 never landed.

## Design

Drive the quick soak through `step()` and the CAS record from card 7570.

- `we:scripts/lib/daemon-rebuild/quick-soak-job.mjs`: tick loop. At tick start read the record, run recovery, then apply events from observations and execute returned `effects[]` (git resets, smoke launch, pages). Each effect is bracketed write-intermediate, git-effect, write-next so a crash is recoverable.
- `we:scripts/lib/daemon-rebuild/quick.mjs`, `we:scripts/lib/daemon-rebuild/adopt.mjs`, `we:scripts/lib/daemon-rebuild/smoke.mjs`, `we:scripts/lib/daemon-rebuild/state.mjs`, `we:scripts/lib/daemon-live-smoke.mjs`: replace ad-hoc marker comparisons with record events; delete `assertMarkerIdentity` and its callers.
- `we:scripts/lib/daemon-rebuild/prepare.mjs`: `prepareRebuild` returns `rebuild-in-progress` (quick mode only, checked before `upToDate`) while a non-terminal record exists.
- A new default-off setting gates all of it; the PR body is generated from the settings keys present in the diff.
- If quick is disabled mid-soak, the record still runs to a terminal state.

## MVP

Musts: setting (default off), job, event wiring in the listed files, `rebuild-in-progress`, deletion of `assertMarkerIdentity`, tests. Out: default-on, new states.

## Test plan

- Per-state tick tests with real Git temp repos: smoked to adopting to soak-due to soaking to verified; failure path to rolling-back to rejected.
- Crash rows: kill between write-intermediate, git-effect, write-next; next tick recovers.
- `prepareRebuild` returns `rebuild-in-progress` in quick mode only, and before `upToDate`.
- Quick-off controls: byte-identical outputs on existing fixtures.
- Quick disabled mid-soak runs to terminal.
- Unreadable record pages once (`quick-record-unreadable`); a second tick does not re-page.
- Sibling daemons: concurrent CAS, fixed lock order, no deadlock.
- Earlier breaks as end-to-end rows (launcher after replaced adoption, stale finalizer, retired-token result).

## Proof plan

Replay the red-team's two 5b8f9977 probes on a throwaway clone before (main) and after (this branch), recording both outputs in the PR. Scripted mutation: drop each guard, at least one test fails. Port `soak/breaks/quick-soak-*`. Codex audit. Any throwaway process started is stopped by PID.

## Edge cases this change must handle

1. **Untrusted text** — record `cause`/history folded before write; no record text in argv or paths.
2. **Truncated reads** — git and process reads use full buffers; a partial read is an error, not "none".
3. **Shared state files** — one record, CAS under `withFileLock`; sibling daemons use a fixed lock order.
4. **Fail closed** — unreadable quick record: `quick-record-unreadable`, page once, no git effect.
5. **Identity scoping** — `(id, target.tree)`; page effects keyed `(id, rev)`; SHAs never compared.
6. **State over time** — restart mid-effect handled by recovery; deadline from injected time; disabled-mid-soak runs to terminal.
7. **Who wrote it** — attempt `pid/host/procStart` liveness check; result with a retired token refused.

## Follow-ups

- Operator decision to turn the setting on (separate card once soak data exists).
- Close PR 6084 linking these cards (orchestrator).
- Lint that every setting named in a PR body exists in the diff and has a test.
