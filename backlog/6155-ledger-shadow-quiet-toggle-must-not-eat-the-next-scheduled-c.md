---
bornAs: xu7ove8
kind: task
status: open
scope: ["we:scripts/lib/ledger-readiness-daily.mjs", "we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs", "we:scripts/lib/drain-ledger-shadow.mjs", "we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs", "we:scripts/lib/__tests__/ledger-promotion-readiness.test.mjs"]
estimatedLoc: 210
dateOpened: "2026-10-15"
preparedDate: "2026-10-17"
preparedAgainstSha: "ab2fae75c2432a5664313e5314d814c02b940473"
tags: []
---

# Ledger shadow: quiet toggle must not eat the next scheduled check; replay must not over-project agreement

Operator ruling 'card' on PR #5195 red-team breaks (2026-10-15 ~09:45 ET); do before the ledger promotion decision. Preserve scheduled readiness checks across an overnight quiet toggle, and preserve real ledger holds in shadow evidence so replay cannot invent agreement.

## Progress

- Preparation inspection: both defects remain in the current source; this is not already delivered. No implementation or preparation stamp is included here.
- Old premise/scope: the daily check was cited near line 89 and the hold-dropping `shadowRow` was attributed to we:scripts/lib/ledger-promotion-readiness.mjs near line 95; scope contained those two modules and the entire test directory.
- Corrected premise: we:scripts/lib/ledger-readiness-daily.mjs:83-98 uses an ET calendar day, checks `lastDay` before checking the toggle, and accepts an active toggle before checking the scheduled time. Its caller supplies only the latest history row's day at we:scripts/lib/ledger-readiness-daily.mjs:159-171. Thus a 00:01 ET toggle record suppresses that date's 22:00 scheduled check. The schedule uses the configured quiet-hours time zone, while deduplication uses ET.
- Corrected location: `shadowRow` is in we:scripts/lib/drain-ledger-shadow.mjs:96-134. At line 119, a missing verdict history replaces all derived holds with `no-ledger-row`. A referral event need not have a verdict row; the actual hold rule is we:scripts/lib/pr-state/holds/referral-unruled.mjs:4-8. The projection in we:scripts/lib/ledger-promotion-readiness.mjs:91-107 already retains any non-projectable code it receives. Fix the producer, and exercise the producer-to-projection boundary; no projection policy change is needed.
- Corrected scope: two production modules, their two existing matching tests, and the existing promotion test for the composition regression. Projection-only controls already exist in we:scripts/lib/__tests__/pr-state-review-exempt.test.mjs:29-38; those are validation coverage, not an expected edit. The replay CLI consumes the same projection at we:scripts/ledger-readiness.mjs:19-30 and needs no change.
- Estimate: previously no size or estimatedLoc. Set estimatedLoc to 210 changed lines: approximately 70 in we:scripts/lib/ledger-readiness-daily.mjs (slot identity, persisted identity, compatibility and comments), 85 in we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs (clock sequences and history), 5 in we:scripts/lib/drain-ledger-shadow.mjs (additive hold collection), 25 in we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs, and 25 in we:scripts/lib/__tests__/ledger-promotion-readiness.test.mjs. Anchors above and the existing daily integration fixture at we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs:68 support this bounded touch set.

## Design

### Scheduled checks and early observations

Replace calendar-day suppression with explicit persisted run-slot identity in we:scripts/lib/ledger-readiness-daily.mjs. A scheduled slot is identified by the schedule's local date, configured time zone and resolved HH:MM. A quiet-toggle observation before that scheduled time has a separate identity, so it cannot consume the scheduled slot. At or after the scheduled time, prefer the scheduled slot even if the toggle remains on. Repeated ticks in either slot must not append another record; a new date's scheduled slot remains eligible. This directly implements the operator's schedule-slot requirement, without changing readiness thresholds.

Keep `day` as the ET observation date for existing display consumers and retain `at` as the actual timestamp; add the slot identity as an additive history field. Compute local dates using the configured time zone, not fixed 24-hour subtraction. Repeated DST wall-clock times identify the same slot; a skipped scheduled minute becomes due on the first later local minute. Keep the existing at-or-after-time behavior rather than introducing historical catch-up runs.

The runner must use persisted identity, not just `latest.day`. Legacy schema-1 rows remain readable: derive their effective slot from their valid timestamp, trigger, and resolved schedule when unambiguous. A pre-schedule toggle row cannot count as a scheduled run. Unusable identity evidence must not suppress a due scheduled check. Do not rewrite existing history. Update the module's once-per-ET-day comments to describe per-slot deduplication, and retain latest/previous agreement comparison across actual observations.

### Shadow evidence and replay

In we:scripts/lib/drain-ledger-shadow.mjs, collect derived hold codes regardless of whether a verdict row exists; add `no-ledger-row` when applicable and retain live fact holds. Preserve order deterministically and avoid duplicate codes. Do not change the gate verdict, label authority, review exemption, or projection allowlist.

Pass actual `shadowRow` output with no verdict and an unruled referral into `projectDrainFactsRow` in the composition regression in we:scripts/lib/__tests__/ledger-promotion-readiness.test.mjs. Its result must remain disagreement because `referral-unruled` survives. This tests the information loss where it occurs rather than supplying a hand-built row that already has the missing evidence.

## MVP

1. Implement and persist scheduled/early-toggle slot identities in we:scripts/lib/ledger-readiness-daily.mjs, including legacy-history interpretation and updated contract comments.
2. Make hold collection additive in we:scripts/lib/drain-ledger-shadow.mjs.
3. Extend the three test files in scope with the sequences and composition cases below. No settings migration or new endpoint is required.

## Acceptance

- [A1] A toggle at 00:01 ET on October 15 followed by a scheduled tick at 22:00 ET on October 15 records the scheduled observation; repeated ticks do not duplicate either slot. Repeat with a preceding October 14 scheduled row and across a process restart.
- [A2] A label-clear PR with no verdict row and an unruled referral produces both `no-ledger-row` and `referral-unruled`; projecting that actual shadow row retains disagreement and does not set `projected: true`.
- [A3] A row with only projectable missing-verdict evidence still projects as before; unsafe-direction and unreadable rows never become agreement.
- Must preserve refusal on unreadable ledger evidence and preserve unknown/non-projectable holds. This work must not loosen the live merge gate.
- Must treat docs, configuration, data and source-code PRs identically here: no content-kind bypass is introduced, and existing review-exemption evidence requirements remain intact.
- Executable red/green verification uses the host heavy-run queue. Run `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs we:scripts/lib/__tests__/ledger-promotion-readiness.test.mjs`. The `we:` prefixes identify repository paths; remove that prefix when executing from the WE checkout. Newly added A1/A2 assertions must fail on the original implementation and pass after the fix.

## Test plan

- In we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs, use injected clocks and temporary history: 00:01 toggle, repeat tick, restart, toggle off, 21:59, 22:00, repeat tick, next date. Assert append counts and distinct slot identities, including when the toggle stays active through 22:00. Retain daytime early-toggle support, disabled checks, explicit HH:MM, invalid clock/time-zone handling and dry-run non-persistence.
- Cover a non-ET time zone whose date differs from ET, midnight schedule, spring-forward skipped time and fall-back repeated time. Assert scheduled slots neither disappear nor duplicate. Seed old schema-1 scheduled and pre-schedule toggle rows; scheduled rows deduplicate, toggle rows cannot swallow the scheduled check. Preserve torn-line recovery and latest/previous smell behavior.
- In we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs, construct a valid referral using the existing event builder, same repo/PR/head and no verdict. Assert complete hold codes and unchanged live label answer. Include an additional live-fact hold, no-event baseline, unreadable events, exact-head review exemption, and foreign repo/PR events to pin identity isolation.
- In we:scripts/lib/__tests__/ledger-promotion-readiness.test.mjs, feed that producer output through projection and readiness measurement: referral remains disagreement with no fabricated agreement gain. Include missing-verdict-only positive control and unknown hold, unreadable and unsafe-direction negative controls. Retain truncated-evidence refusal.
- Run the existing controls in we:scripts/lib/__tests__/pr-state-review-exempt.test.mjs through the same queue, followed by queued `npm run check:standards`. No bare test commands.

## Proof plan

During implementation, capture the two new regression failures before the source fix, then the queued suite results after it. The daily integration fixture must show actual temporary JSONL appends and a restarted runner, not only the pure due helper. The shadow proof must show actual event → derived holds → shadow row → replay output, with the referral code visible at the final boundary. Record concrete counts/slot keys and projected status in the implementation review.

Use temporary state and injected IO only; do not toggle production quiet mode, append production history, flip review authority or mutate PRs to prove this fix. The current preparation establishes the premise by source inspection; it does not claim runtime tests have passed. The runner owns preparation checks and stamping.

## Non-goals

- No ledger promotion, authority change, projection-allowlist expansion, threshold change or historical evidence rewrite.
- No reconstruction of referral evidence already discarded from old shadow records. Those records cannot prove an absent referral; the fix preserves evidence in newly produced rows.
- No new scheduler service, multi-writer locking redesign, or endpoint.

## Edge cases this change must handle

1. **Untrusted text** — keep reason text as data; carry structured hold codes and retain unknown codes conservatively.
2. **Truncated reads** — retain torn-history-line recovery and readiness refusal for truncated shadow evidence; incomplete slot evidence cannot cancel a scheduled check.
3. **Shared state files** — retain append-only history and the existing health-watch writer model; persist slot identity across restart. Do not rewrite shared files or claim new cross-process locking guarantees.
4. **Fail closed** — unreadable ledger stays unreadable; referral and unknown holds remain disagreement in replay. Invalid clocks do not run a check.
5. **Identity scoping** — keep repo/PR/head derivation boundaries; schedule identity includes the configured zone and local schedule date/time.
6. **State over time** — cover overnight toggles, persistent toggles, legacy rows, restart, DST, and successive scheduled dates without calendar-day suppression.
7. **Who wrote it** — preserve existing event provenance and review-exemption validation; replay never creates an operator ruling.
8. **Endpoint abuse controls** — body-size limits, rate limits, CSRF/origin and remote reset triggers are not applicable: these are local scheduled/read-only computations with append-only history, not receive/write endpoints.

## Follow-ups

- Re-run the read-only promotion report after corrected shadow records accumulate; this card does not authorize promotion or treating old incomplete evidence as repaired.
- No prerequisite edge changes proposed. Any separate historical-data remediation or multi-writer coordination change requires its own evidence and scope.
