---
bornAs: xvi6k7s
kind: story
size: 5
parent: "6188"
status: open
scope: ["we:scripts/operations/coroner-pr-postmortem.mjs", "we:scripts/operations/__tests__/coroner-pr-postmortem.test.mjs", "we:scripts/settings/coroner-postmortem.json", "we:scripts/conveyor/pass-daemons/pr-postmortem-pass.mjs", "we:scripts/conveyor/soak/breaks/postmortem-poison-merge*"]
dateOpened: "2026-10-17"
tags: []
---

# Per-PR delivery postmortem on merge (incident-coroner trigger 1)

we:scripts/operations/coroner-pr-postmortem.mjs — Operator 2026-10-17: the coroner postmortems every PR whose delivery exceeds configured thresholds, right after merge (defaults: lead time 8h, 4 or more fix rounds, 2 or more lost approvals, any stand-down; the operator will lower them as delivery improves). The report covers phases, hand-off gaps against p90 benchmarks, fix rounds by cause, false findings, approvals lost, scope creep and prepare history. It writes an incidents journal row per cause, and recurring causes become triage candidates for incident-coroner S1 (x334ind).

## Acceptance

- [A1] **Executable** — the test file `we:scripts/operations/__tests__/coroner-pr-postmortem.test.mjs` fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not edit drain merge code or the conveyor's shared files, and does not file cards (triage stays with incident-coroner S1).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — only authenticated known comment markers affect analysis; PR bodies are unused. Test: `treats outsider markers and PR bodies as data across every comment parser and reports actors`.
2. **Truncated reads** — malformed/missing core pages and invalid event timestamps or label names abort with an error carrying `incomplete: true`; optional failures carry structured completeness and warnings. Tests: `rejects missing timeline pages: %j`, `rejects %s events with invalid timestamps`, `rejects %s events with invalid label names`, `rejects invalid check-run pages: %j`, `rejects missing comment pages instead of returning an apparently clean report`, `rejects excessive observed heads`, `rejects excessive card revisions as incomplete optional evidence`, `marks failed card history incomplete while preserving core evidence`.
3. **Shared state files** — journal publication is append-only under the lock; dead local processes are reclaimed. Tests: `keeps independent cause windows separate and recovers journal-first publication`, `reclaims a dead local owner and preserves a live owner`.
4. **Fail closed** — unclassified label intervals have phase `unknown` and retain observed elapsed minutes; missing verdict history yields unknown lost approvals. Test: `marks missing phase evidence unknown while retaining observed fields`.
5. **Identity scoping** — report and cursor filenames use the same injective repository encoding. Test: `keeps colliding repository slugs independent in cursor and report filenames`.
6. **State over time** — receipts survive restarts; collection failures quarantine after at least three attempts spanning at least 30 minutes, retaining their retry subject, first failure time, error and incomplete marker. Later PRs run even during retries; publication/storage errors retain the cursor and abort. Tests: `persists cursor and done set, skips short PRs, and retries a failed read after restart`, `quarantines a permanently failing PR after three attempts without blocking later merges`, `keeps rapid collection failures retryable across restarts until the minimum duration`, `preserves the elapsed failure budget when upgrading a retry without firstFailedAt`, `retains cursor and retries publication failures without quarantine: %s`; daemon soak: `postmortem-poison-merge`.
7. **Who wrote it** — the report's event index names each observed actor (null when unavailable); it grants or revokes no delivery permissions. Test: `treats outsider markers and PR bodies as data across every comment parser and reports actors`.

## Prevention checks

Review each numbered edge case and each Risks guarantee against an existing test title before acceptance; distinguish rejecting incomplete core reads from degrading optional evidence. Every cursor loop must document poison-item handling and defend it with a cursor-sensitive restart fixture. Threshold tests inject settings explicitly and exercise independent nondefault boundaries (`honors nondefault numeric thresholds: %s`). Every pagination/history cap has a named failure-injection case. Recovery tests cover both dead and live lock owners. Repository filenames share `repoFilenameKey`; do not construct state paths with slash-to-hyphen replacement. CI boundary changes require paired changed-head and unchanged-head controls (`excludes CI-green review gaps across head changes with an unchanged-head control`).

- Every comment parser must have an outsider payload in `ignores outsider comments and PR bodies for marker kind: %s`, including carried verdicts and red-team false findings, with trusted controls proving those payloads reach their parsers. Exercise both REST and GraphQL author shapes and compare all analytical fields while retaining actors as evidence.
- A CI-green dispatch boundary requires a successful check for the observed head at completion and no head change through review. Keep paired stale/current-head controls, both completion orderings, unknown-head refusal, and assertions on the resulting gap, cause and journal in `excludes stale-head check completion before review: %s`.
- Preserve distinct check attempts through hand-off analysis; a later same-head/name rerun must not erase a completed earlier hand-off. Tests: `preserves historical %s hand-offs with a later %s attempt completing at %s` covers success/failure, pending and post-merge reruns, duplicate pages, and collector-to-journal wiring; `uses the newest %s boundary before a shared hand-off` pins supersession before the destination. `invalidates a historical %s boundary only for same-check reruns before its hand-off` covers opposite results, neutral/cancelled/pending attempts, and distinct-name/head controls.

## Risks and test plan

Run `we:scripts/operations/__tests__/coroner-pr-postmortem.test.mjs` and the `postmortem-poison-merge` daemon soak wrapper through the required verification gate.

- Quarantine is durable and visible in both cursor state and successful pass output; operators can inspect the reason and remove a quarantine row to retry while retaining its separate `failures` entry. Test: `retries a removed quarantine entry after cursor advancement`. For quarantine files written by the old version, let the upgraded pass run once to restore the separate retry entry before removing quarantine. Test: `upgrades legacy quarantine subjects and retries after operator removal`.
- Old ambiguous hyphen-named cursor/report files are left untouched; encoded names start a new 24-hour discovery window with a one-minute overlap. Test: `preserves ambiguous legacy files and starts fresh encoded discovery`.
- Journal event IDs keep replayed causes deduplicated. Tests: `publishes once across reruns and emits one candidate for three distinct PRs in 24 hours`, `retains cursor and retries publication failures without quarantine: %s`.
- Recurrence detection uses merge-time windows regardless of publication order. Prevention: retain all six publication permutations with within-24-hour, exact-boundary and outside-window controls, plus unchanged-journal replay assertions. Tests: `emits recurrence candidates after out-of-order retry publication: %s`, `checks later retry windows after a suppressed window: %s`, `emits a recurrence candidate when the watcher retries an earlier failed collection`; all run in the postmortem verification gate above.
- Local ledger coverage is explicitly bounded, never complete; malformed verdict rows degrade optional evidence while preserving comments, checks and phase observations. Parameterized prevention: `marks %s local ledgers bounded rather than complete` requires a retained valid row and bounded completeness for both small untruncated and oversized files. Tests: `marks missing local ledgers incomplete and truncated local ledgers bounded`, `bounds local ledger read ranges`, `marks malformed verdict ledger rows incomplete rather than reporting zero lost approvals`; all run in the postmortem verification gate above.
- Journals exceeding 64 MiB refuse publication before any append or report write. Test: `refuses oversized journals before publication`.
