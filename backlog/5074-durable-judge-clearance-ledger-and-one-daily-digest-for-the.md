---
bornAs: xfbj1fa
kind: story
size: 3
parent: "5060"
status: open
blockedBy: ["5072"]
scope: ["we:scripts/lib/verdict-ledger.mjs", "we:scripts/conveyor/judge-digest.mjs", "we:scripts/operations/judge-clear.mjs", "we:scripts/operations/__tests__/judge-clear.test.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs", "we:scripts/conveyor/__tests__/judge-digest.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "e1f0523e0881357fc863f3e88da72e0164eb7091"
tags: []
---

# Durable judge clearance ledger and one daily digest for the operator

Every independent-judge clearance appends a durable ledger record (PR, head, author provider, judge provider and model, verdict, reasoning, time) beside its PR comment, and a once-a-day digest summarizes the past day of judge clearances for the operator in one message.

Builds rule 4 of `we:docs/agent/platform-decisions.md#independent-judge-clears-review-human-outside-protected-list`. The PR comment itself already ships in `5072`; this adds the machine-readable record and the digest.

## Design

**Reuse the existing verdict ledger — do not add a second one.** `we:scripts/lib/verdict-ledger.mjs` is already the single owner of an append-only JSONL record of every review verdict, and `we:scripts/review-set-label.mjs` already appends to it on every label swap (`buildVerdictRecord` / `appendVerdict`). So:

- **The clear path is owned by `5072`, which this story builds on:** the `clear-human-judge` → `clear-human` mapping in `verdictForLabelTarget`, the optional `judge` block on `buildVerdictRecord` (`{ provider, model, actorId, authorProvider, verdict, protectedConcern, reasoning, refusal }`, absent for every non-judge verdict, ledger version stays 1), and the row appended at the label home in `we:scripts/review-set-label.mjs` before the swap (fail closed). That is where the append actually happens, so the clear row cannot live in this story's scope. This story adds a small reader, `judgeRecordsSince(records, since)`, in `we:scripts/lib/verdict-ledger.mjs` that returns the records carrying a `judge` block.
- `we:scripts/operations/judge-clear.mjs` appends a record for a judge **refusal after spawn** (the judge answered `keep-human`), with verdict `observed` (a non-bearing verdict, `NON_BEARING`), so the digest can show what the judge declined. Refusals before spawn (protected list, kill switch, independence) are not ledgered — nothing judged them.

**Digest** `we:scripts/conveyor/judge-digest.mjs [--since=<ISO>] [--dry-run]`:

- Reads the ledger (`verdictLedgerPath(repo)`) for records with a `judge` block in the last 24 hours (America/New_York day boundary by default, the operator's timezone).
- **A clear whose swap failed is not counted.** `5072` appends an `observed` row with reason `swap-failed` for the same PR and head when the label swap failed after the clear row was written; the digest nets those out (a clear row with a later `swap-failed` row for the same PR and head is listed as "cleared but the label swap failed", not as a clear). 
- Renders one short message: count of clears and declines; one line per PR (number, title, author provider, judge model, one-sentence reasoning, link); and a line if the kill switch was off or a wait was set during the window (read from the switch store's `at`). The digest must work while the judge is switched off (the conveyor pass sends it on those days too, see `5075`): it reads the switch state itself, and when the judge is OFF it puts "judge OFF since <time> (<reason>)" first, or "judge OFF: switch store unreadable (<parse error>)" when the store failed to parse. It reads only the ledger and the switch store, never the judge or a PR, so an off judge cannot stop it.
- Delivers through the existing operator notification path (`notifyDesktopChecked` in `we:scripts/operations/operator-notify-io.mjs`, the same channel the NEEDS-YOU pass in `we:scripts/operations/operator-notify-cli.mjs` uses), as one notification whose body points at the full digest text written beside the ledger; a delivery failure is printed, never swallowed. `--dry-run` prints only. Idempotent per day: a marker records the last digest day, so a second run on the same day sends nothing.
- Zero judge records in the window → still one line ("no judge clearances today"), so silence never looks like breakage.

## MVP

1. Must have one durable ledger record with a `judge` block for every judge clear (appended at the label home, built in `5072`) and every post-spawn judge decline (appended by the runner, here).
2. Must leave every existing ledger record shape and reader unchanged.
3. Must send at most one digest per local day, listing every judge clear in the window with its reasoning.
4. Must send a "none today" digest when the window is empty.
5. Must treat ledger lines as untrusted data: a malformed line is skipped and counted in the digest, never crashes it, and its text is never executed or followed.

## Done when

1. **Executable — Musts 1–2:** a Vitest run of `we:scripts/lib/__tests__/verdict-ledger.test.mjs` passes with new `judge`-block cases and every existing case unchanged.
2. **Executable — Musts 3–5:** a Vitest run of `we:scripts/conveyor/__tests__/judge-digest.test.mjs` passes (new file).
3. **Observable:** `--dry-run` of the digest against the real ledger prints today's digest, pasted in the PR.

## Test plan

Extend `we:scripts/lib/__tests__/verdict-ledger.test.mjs` (matching source: `we:scripts/lib/verdict-ledger.mjs`):

- `judgeRecordsSince` returns only the records with a `judge` block inside the window and skips a record without one. Red today: `judgeRecordsSince` does not exist. (The `judge` block round trip and the mapping are tested in `5072`'s extension of this same file.)
- A judge decline records verdict `observed` and is not counted as clearing by `verdictClears`. Red today: no judge record is written.

New `we:scripts/conveyor/__tests__/judge-digest.test.mjs` (matching source: `we:scripts/conveyor/judge-digest.mjs`):

- Three judge clears and one decline in the window, one clear outside it → the digest lists exactly the four in-window records. Red today: the digest does not exist.
- A clear row followed by a `swap-failed` row for the same PR and head → listed as "cleared but the label swap failed", not counted as a clear. Red today: the digest does not exist.
- A second run on the same day sends nothing; the next day sends again. Red today: the digest does not exist.
- Empty window → the "none today" line. Red today: the digest does not exist.
- A malformed JSONL line is skipped and reported as "1 unreadable record". Red today: the digest does not exist.
- A record whose reasoning contains markdown or a fake instruction is rendered as quoted text. Red today: the digest does not exist.
- The kill switch was turned off during the window → the digest says so. Red today: the digest does not exist.
- The judge is OFF now (store reads `judgeEnabled: false`), with two clears recorded earlier in the window → the digest still lists both and leads with the "judge OFF since" line; an unreadable store → the line names the parse error. Red today: the digest does not exist.

`we:scripts/operations/judge-clear.mjs` gains one assertion in its existing test file (`we:scripts/operations/__tests__/judge-clear.test.mjs`, from `5072`) that a post-spawn `keep-human` answer appends one `observed` row carrying the `judge` block. The clear row itself is asserted end to end through `runReviewLabelCli` in `5072`; the digest test here reads a row produced that way (a fixture built by the real `buildVerdictRecord` with a `judge` block, never a hand-typed JSON line).

## Proof plan

Tests first, red. After the build: both test files green, output pasted. Live: run the digest `--dry-run` against the real ledger and paste it; if `5072` has cleared a real PR by then, that clear must appear. `npm run check:standards` last. This PR edits `we:scripts/lib/verdict-ledger.mjs`, which is on the protected list (merge/approval record), so the human clears it.

## Follow-ups

- Scheduling the digest once a day is `5075`.

## Progress

- Prepared 2026-10-03. Original scope named a new judge ledger module; corrected to extend `we:scripts/lib/verdict-ledger.mjs`, the existing single owner of the review-verdict record that `we:scripts/review-set-label.mjs` already appends to on every swap (`buildVerdictRecord`, `appendVerdict`, `verdictLedgerPath`). A second ledger would be a second answer to a question that already has one home.
