---
bornAs: xbxx07q
kind: story
size: 5
priority: high
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:scripts/conveyor/health-watch-core.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/__tests__/health-watch*.test.mjs", "we:scripts/conveyor/__tests__/health-watch-core*.test.mjs", "we:scripts/conveyor/health-smells/operator-hold-aged.mjs", "we:scripts/conveyor/health-smells/__tests__/operator-hold-aged.test.mjs", "we:scripts/conveyor/health-smells-notify-list.mjs", "we:scripts/conveyor/__tests__/health-smells-notify-list*.test.mjs", "we:scripts/conveyor/health-smells/__tests__/notify-list.test.mjs"]
dateOpened: "2026-10-09"
preparedDate: "2026-10-10"
preparedAgainstSha: "3ae21af26612e2de207da84ce65ffaea034c573b"
tags: []
---

# Health smell when an operator-only hold on a PR passes an age

Holds that only the operator can clear sit with no age alarm. Review-side PR-minutes in the coroner-4 window: cap-exhausted 1,106 (#4433, #4478 218 min), stood-down 942 (#4461 218), review-referrals-pending 934 (#4388 315), ruling-dispute 656 (#4361 515; the false-alarm part is held item 141). They show on /wip, but nothing pings when one passes an age. Fix idea: one operator-hold-aged health smell (setting, default 30 min) over these hold kinds, reporting PR, kind and age, honouring quietHours (held item 134); it clears itself when the hold clears. Historical evidence: we:.conveyor/review-daemon.log 'no review dispatched — cap-exhausted|stood-down|review-referrals-pending|ruling-dispute'. Found by coroner-4 (held item 192).

## Acceptance

- [A1] **Executable** — the planned test in `we:scripts/conveyor/health-smells/__tests__/operator-hold-aged.test.mjs` feeds complete review-daemon hold snapshots through the health core: one cap-exhausted hold continuously observed for 45 minutes opens one `operator-hold-aged` episode naming repository, PR, kind and observed age.
- [A2] Covers cap-exhausted, stood-down, review-referrals-pending and ruling-dispute. Below the configured threshold (default 30 minutes), no episode opens; at the threshold it opens.
- [A3] A successful snapshot without the hold clears its episode; a returning hold starts a new age. Unknown input never counts as clearance. Quiet hours suppress delivery, not observation or episode bookkeeping.
- [A4] Live proof on the running health-watch shows an aged open hold and subsequent confirmed clearance, with before/after evidence. Notification delivery uses the existing quiet-hours gate, including in shadow mode.

## Non-goals

- [N1] Does not clear, auto-resolve or dispatch work for a hold; it only alerts.
- [N2] Does not fix the ruling-dispute false alarm (held item 141).
- [N3] Does not reconstruct exact historical hold onset from incomplete legacy logs, change reconciler refusal policy, or replace the aggregate stood-down smell.

## Edge cases this change must handle

1. **Untrusted text** — consume only validated repository identity, positive integer PR number, allowlisted kind and finite timestamp. Do not copy titles, free-text reasons or commands into the new records or notifications.
2. **Truncated reads** — retain an incomplete last record until its newline arrives; malformed, missing or unreadable snapshots are unknown, never an empty hold set.
3. **Shared state files** — the review daemon appends observations to its existing log; the watch persists hold history in its existing state. No additional shared state file or writer.
4. **Fail closed** — absent, nonnumeric, nonfinite, zero or negative threshold uses 30 minutes. Reject malformed snapshot records atomically.
5. **Identity scoping** — one episode per (repository, PR, hold kind); deduplicate repeated rows and distinguish equal PR numbers in different repositories.
6. **State over time** — use the first valid observation of the current uninterrupted observed hold, not the most recent repeated row. Confirmed removal then return resets age. Unknown intervals do not prove continuous holding or clearance; retain an existing episode without advancing it, and restart onset observation when continuity cannot be established.
7. **Who wrote it** — the daemon emits structured observations from its own reconcile plan; health-watch does not interpret arbitrary PR text as a hold record.

## Progress

- Validation repair: the previous scope relied on the broad `we:scripts/conveyor/__tests__/health-watch*.test.mjs` pattern and the existing nested notification suite. Add the explicit `we:scripts/conveyor/__tests__/health-watch-core*.test.mjs` pattern and planned `we:scripts/conveyor/__tests__/health-smells-notify-list*.test.mjs` pattern required by preparation validation. The core suite already imports the fold and tick functions (`we:scripts/conveyor/__tests__/health-watch-core.test.mjs:10-12`); the existing notification suite imports the membership set (`we:scripts/conveyor/health-smells/__tests__/notify-list.test.mjs:12`) and checks membership and delivery (`we:scripts/conveyor/health-smells/__tests__/notify-list.test.mjs:53-88`). The new notification test path is planned, not an existing file. Goal and size remain unchanged.

- Preparation research: the old premise was that repeated “no review dispatched” log rows fully describe all four holds, with implementation confined to the smell directory and watch shell. The goal remains an age alarm for those four operator-action hold kinds. The corrected scope includes the producer, health memory and notification opt-in, with matching tests for each source.
- Evidence: `we:skills-src/conveyor/review-daemon.mjs:217-219` deliberately suppresses many referral-hold explanations; `we:skills-src/conveyor/review-daemon.mjs:1013-1014` emits dispatch and explanation rows but no complete hold snapshot. Therefore absence of a legacy row cannot establish clearance. `we:scripts/conveyor/reconcile-core.mjs:1212-1221` confirms referral holds can wake on a new head, ruling or send-back: “operator-only” describes the alert population, not a claim that no code transition can end a hold.
- `we:scripts/conveyor/health-watch-core.mjs:142-209` does not parse these explanation rows. Its refusal memory overwrites timestamps (`we:scripts/conveyor/health-watch-core.mjs:305-308`) and estimates bootstrap tick times (`we:scripts/conveyor/health-watch-core.mjs:354-357`); it is not a continuous-hold clock. The existing stood-down smell is an aggregate count threshold of five, not this per-hold age alarm (`we:scripts/conveyor/health-smells/stood-down-prs.mjs:25-36`). The goal is not already delivered.
- Corrected framing: report **observed continuous age**, with no invented pre-bootstrap onset. Complete successful snapshots establish both presence and removal. Quiet hours gate notifications already (`we:scripts/conveyor/health-watch.mjs:1310-1321`); a new smell also needs explicit shadow-mode notification membership (`we:scripts/conveyor/health-smells-notify-list.mjs:28`). Disk discovery requires no registry edit (`we:scripts/conveyor/health-smells/index.mjs:10-13`).
- Size changed **2 → 5**: producer extraction and per-repository result propagation (`we:skills-src/conveyor/review-daemon.mjs:511-527`, `we:skills-src/conveyor/review-daemon.mjs:609-630`), persisted observation folding (`we:scripts/conveyor/health-watch-core.mjs:311-326`), missing-input handling (`we:scripts/conveyor/health-watch-core.mjs:790-801`) and notification wiring make this wider than one smell. Source/test pairs are now explicit in scope. No dependency-edge change is proposed.

## Design

1. In `we:skills-src/conveyor/review-daemon.mjs`, extract the four allowlisted kinds from the successful reconcile plan, including nested `reviewRefusal` rows. Emit one versioned, timestamped, single-line JSON hold snapshot per successfully observed repository per tick, containing the complete deduplicated list of `{prNumber, kind}`. An empty list is positive clearance evidence. Carry this result through the per-repository aggregation to CLI logging; do not derive it from `pendingNotDispatched`. Emit no successful snapshot when PR discovery or reconciliation failed, was skipped, or used unavailable shared PR reads. Preserve existing human-readable explanations and dispatch behavior.
2. In `we:scripts/conveyor/health-watch-core.mjs`, parse and fold those records separately from legacy refusal memory. Persist per-repository snapshot time and per-key first/last observation in the existing daemon state. Repeated identical holds preserve onset; an authoritative empty/changed set removes the absent keys. Ignore duplicate and out-of-order snapshots. Use record timestamps, never inferred spacing of legacy tick summaries. Bootstrap starts at the earliest complete valid retained snapshot, explicitly an observed lower bound on age.
3. Continuity follows the existing daemon interval: a gap greater than two expected review intervals makes the observation unknown, matching a missed-refresh interpretation rather than asserting clearance. Also mark unknown on missing/unreadable review-log input or invalid records. Preserve existing episodes while unknown, suppress fresh alerts, and begin a new continuous-age measurement on recovery. A fresh complete snapshot can still positively clear an old episode. Keep this state bounded to current snapshot keys plus unresolved episodes; discard cleared history.
4. Add `we:scripts/conveyor/health-smells/operator-hold-aged.mjs` with alert-only action, medium severity and one-sample open/close hysteresis. Read validated `operatorHoldAgeMinutes` from the existing health configuration (default 30). Use a stable repository/PR/kind subject, observed age and threshold in the summary/measure. Unknown input must take the core's skipped-evaluation route, not return an empty result array that closes episodes. Ensure per-repository unknown data cannot clear healthy or unknown repositories indiscriminately.
5. In `we:scripts/conveyor/health-watch.mjs`, supply review-log availability to the fold/evaluation, distinguishing an empty append from a missing log. Reuse the complete-line cursor logic at `we:scripts/conveyor/health-watch.mjs:279-289`. Add the new smell to `we:scripts/conveyor/health-smells-notify-list.mjs` so the requested alarm reaches the operator in shadow mode. Reuse ordinary notification cooldown/deduplication and quiet-hours delivery; give this smell no emergency breakthrough tag. Keep observing and clearing during quiet hours.

## MVP

- Ship the complete producer-to-log-to-memory-to-smell-to-notification path for all four kinds together; legacy explanation parsing alone is insufficient.
- Support the existing health configuration override, persisted watch restarts, complete-line reads, per-repository unknown handling, confirmed clearance and recurrence.
- Leave the existing aggregate stood-down detector and all reconciliation/hold-resolution policy unchanged. No new registry entry, dashboard, automatic remediation or separate service is needed.

## Test plan

- `we:skills-src/conveyor/__tests__/review-daemon.test.mjs`: complete snapshots for all four kinds, nested refusals, deduplication, referral cases suppressed by the existing explanation helper, multiple repositories, successful empty sets, and no false empty sets after discovery/reconcile failure, skipped ticks or unavailable PR reads. Assert dispatch outputs remain unchanged.
- `we:scripts/conveyor/__tests__/health-watch-core.test.mjs`: fold timestamped snapshots across ticks/restart; repeated rows preserve onset; duplicates/out-of-order rows do not regress state; bootstrap cannot invent earlier age; valid empty sets clear; changed kind and clear/return reset; unknown/stale/malformed inputs preserve episodes without accumulating unproven age; one repository's failure cannot clear another's holds.
- Planned `we:scripts/conveyor/health-smells/__tests__/operator-hold-aged.test.mjs`: each kind at 29, 30 and 45 minutes; configurable threshold and invalid-value fallback; same PR number in two repos; one entry per kind; opening, clearing and recurrence through `runHealthTick`, not just direct evaluator calls.
- `we:scripts/conveyor/__tests__/health-watch.test.mjs`: temporary real log/state directories exercise partial final lines, rotation, missing/unreadable logs, persistence and recovery; notification spy proves one alert per episode in shadow mode, ordinary quiet-hours suppression/digest behavior and no breakthrough. Keep notification and GitHub effects stubbed.
- `we:scripts/conveyor/health-smells/__tests__/notify-list.test.mjs`: new notification membership is additive and preserves previously approved members. Planned `we:scripts/conveyor/__tests__/health-smells-notify-list.test.mjs` adds focused coverage of the new operator-hold membership and its shadow-mode delivery through the health core, satisfying the explicit source-matching test scope.
- Run affected tests only through `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <test-file>` (remove the display-only `we:` prefix when invoking from the repository root). Run the standards check through that same admission wrapper with `npm run check:standards`. The preparation itself changes only this card; these are implementation checks, not claimed results.

## Proof plan

1. Before implementing, retain a timestamped, redacted sample of a real held PR's review-daemon observations and current health output showing the missing per-hold age alarm. Record repository, PR, kind and observed window; do not equate a coroner aggregate with continuous hold age.
2. Replay the same observation sequence through the candidate health-watch with isolated state and notification capture, showing below-threshold silence, one aged episode, a confirmed empty snapshot clearing it, and a returned hold beginning at zero. Use the new producer against captured successful reconcile inputs to prove referral omissions no longer affect health evidence.
3. After normal deployment, observe the running review daemon emitting valid snapshots and the running health-watch consuming them for a naturally aged hold. Capture the episode/report, one delivery outside quiet hours (or held-delivery evidence during them), and clearance after an independently authorized normal hold transition. Do not mutate a real hold merely to obtain proof.
4. Attach timestamps, revision, commands and before/after artifacts to the implementation review. If no real hold clears during observation, mark live clearance proof pending; fixture success alone does not satisfy A4.

## Follow-ups

- Exact pre-bootstrap hold onset would require durable producer history; do not present retained-window age as that history.
- The ruling-dispute false-alarm correction remains separate (held item 141).
- Additional hold kinds, emergency quiet-hours exceptions or reminder escalation require separate scope; this item covers only the four named kinds and the existing notification lifecycle.
