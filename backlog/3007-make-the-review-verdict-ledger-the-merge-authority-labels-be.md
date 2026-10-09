---
bornAs: x3q28ce
kind: epic
priority: high
blockedBy: ["3214", "3215", "3217", "3216", "3255", "3929", "x3mls27", "x72nwuy", "5444"]
status: open
parent: "2405"
dateOpened: "2026-08-08"
relatedTo: ["2841", "2416", "2750", "2820", "2745", "2979", "2830", "3013", "3054", "3035", "2946"]
scope:
  - we:scripts/lib/verdict-ledger.mjs
  - we:scripts/lib/__tests__/verdict-ledger.test.mjs
  - we:scripts/review-ledger-check.mjs
  - we:scripts/__tests__/review-ledger-check.test.mjs
  - we:scripts/review-set-label.mjs
  - we:scripts/operations/review-pr-io.mjs
  - we:scripts/merge-ai-prs.mjs
  - we:scripts/lib/pr-merge-gate.mjs
scopeRationale: "Phase 1 (landed) touches the first six. we:scripts/merge-ai-prs.mjs and we:scripts/lib/pr-merge-gate.mjs stay in scope for PHASE 2 — the drain reading the ledger, plus the drain-side park writer Phase 1 deliberately left out."
tags: [review-integrity, drain, gate, governance, prevention]
---

# Make the review-verdict ledger the merge authority — labels become display only

Record every review verdict in an append-only ledger keyed by PR + the content it covered, and make the
drain merge only what the ledger clears. GitHub labels stay for humans to read but stop being the decision.
This closes the whole "hold that didn't hold" class (#2750, #2820, #2745, #2416) as one mechanism instead
of a patch per leaked path, and it is the durable review-seam record the enforce flip already names as its
missing precondition.

## Why labels cannot be fixed path-by-path

Every confirmed gate failure is the same bug wearing a new path: a mutable label carried the decision, and
some code that swaps labels erased it. PR #870 and PR #956 merged carrying `review:changes`; an operator's
`review:human` escalation evaporated in a label swap (#2745). #2841 already names the meta-problem —
"discover every decision-gate site instead of remembering them." As long as any label-writing code can
erase a verdict, new holes keep appearing. The fix is to move the truth somewhere append-only.

## What the ledger is

- An **append-only JSONL file** next to the drain's existing history (e.g.
  [we:scripts/lib/verdict-ledger.mjs](scripts/lib/verdict-ledger.mjs) owning the format). No database —
  the drain lease already guarantees a single writer, and a file is unit-testable gate-self code. If the
  planned conveyor state store lands later (#2626/#2742), the ledger migrates in as one table; the
  versioned schema makes that a one-off import.
- Each record carries a **versioned schema**: PR number, the diff content-hash the verdict covered
  (content-pinned per #2979, so a mechanical rebase does not void it), verdict, reviewer identity
  (human / named agent pass), timestamp, and reason.
- **Records are only appended, never edited.** A newer verdict supersedes an older one for the same PR +
  content-hash; a hold is cleared by a later clearing record, never by deleting anything.

## What changes at the seams

- The drain's merge gate ([we:scripts/lib/pr-merge-gate.mjs](scripts/lib/pr-merge-gate.mjs), consumed by
  [we:scripts/merge-ai-prs.mjs](scripts/merge-ai-prs.mjs)) answers "may this merge?" from the ledger:
  latest verdict for this PR at this content-hash must be a clear, and no unanswered hold may exist.
- [we:scripts/review-set-label.mjs](scripts/review-set-label.mjs) writes the ledger record first, then
  mirrors it to the label. A label that disagrees with the ledger is a display bug, not a gate bug.
- The shadow reviewer's would-clear decisions append to the same ledger — giving the enforce flip the
  durable shadow-vs-human agreement history it requires (today that seam "only logs to stderr").

## Rollout — shadow first

Phase 1: write the ledger alongside labels; the drain still reads labels; a checker reports any
ledger/label disagreement. Phase 2 (after ~a week of agreement): the drain reads only the ledger.

---

## PHASE 1 LANDED (2026-08-10) — and four things above are WRONG

**This item stays OPEN.** Phase 2 is unbuilt and the authority has not moved: the drain still merges on
labels, `we:scripts/lib/pr-merge-gate.mjs` is untouched, and nothing in the merge path reads the ledger.

Shipped: [we:scripts/lib/verdict-ledger.mjs](scripts/lib/verdict-ledger.mjs) (the format's single owner — a
versioned append-only JSONL, the fold, and the pure ledger↔label comparator),
[we:scripts/review-ledger-check.mjs](scripts/review-ledger-check.mjs) (the checker CLI,
`npm run review:ledger-check`), the writer inside
[we:scripts/review-set-label.mjs](scripts/review-set-label.mjs), the real sink behind #3035's reserved
`verdict-ledger.append` seam in
[we:scripts/operations/review-pr-io.mjs](scripts/operations/review-pr-io.mjs), and 58 tests across
`we:scripts/lib/__tests__/verdict-ledger.test.mjs` and `we:scripts/__tests__/review-ledger-check.test.mjs`.

### 1. The key is NOT the content hash — the premise above is false, proven twice

This card says records are *"keyed by PR + the diff content-hash the verdict covered (content-pinned per
#2979, so a mechanical rebase does not void it)"*. **That parenthetical is false**, and it was disproved the
day after this card was written:

- [#3046](/backlog/3046-a-stale-acceptance-re-park-fires-on-an-unchanged-contributio/) — the digest embeds
  each hunk's inter-hunk **gap**, invariant only under a *uniform* whole-file displacement. Measured on WE
  PR #1106: 1,534 normalized lines each side, differing in exactly two, both of them gap values.
- `#3052` — git's `xfuncname` picks the nearest preceding column-0 declaration as the `@@` **heading**, so a
  base *insertion* of a new declaration changes it with zero content lines differing. Observed on WE PR #1100,
  clearance revoked 52 seconds after it was granted.

Both are open slices of `#3054`, with [#3021](/backlog/3021-the-contribution-fingerprint-still-collides-on-an-intra-sect/)
(the converging direction) and [#2884](/backlog/2884-acceptance-coverage-keys-on-head-sha-identity-so-a-no-op-reb/) (the caller).

**So the identity is `repo` + `pr` + append order.** The three content digests (`coverage.headSha`,
`coverage.reviewedDiff`, `coverage.reviewedContribution`) are recorded verbatim as **attributes**, never as
the thing a lookup joins on. Keying the *authority* on that digest would make a legitimate clearance
*unreachable* after an unrelated rebase — strictly worse than today, where the same defect costs a false
re-park that a re-clear repairs. Two properties follow, and both are the reason: when `#3054` fixes the
digest the stored witnesses re-interpret with no migration, and "which verdict is current?" stays separate
from "does it still cover this head?" — the second question keeps its one owner, `acceptanceCoversHead`,
which the built-but-unwired `ledgerCoversHead` delegates to rather than forking. A unit test reproduces the
#3046 divergence from real `git diff` text and then shows the record is still found.

### 2. The drain lease does NOT make the writers single

This card says *"the drain lease already guarantees a single writer"*. It does not, for this file. That lease
serializes **drain runs**. Every ledger writer reaches the file through `we:scripts/review-set-label.mjs`, and
**none of its callers holds the lease**: the operator's `/review` ceremony from an arbitrary session, the
#3035 operation, the loop console, and `we:scripts/conveyor/rearm-review.mjs`. Two can run at once in two
checkouts. The append therefore takes its own short-TTL lock on the shared
`we:scripts/readiness/file-locks.mjs` primitive. A lock it cannot get does **not** drop the record — the row
is written and stamped `unlocked: true`, because a lost verdict is worse than an interleaved line.

### 3. "Next to the drain's existing history" would break it

The per-checkout `.conveyor/` convention (`we:scripts/lib/jury-ledger.mjs`) cannot host a merge authority: the
reviewer runs in a lane clone and the resident drain runs in its own dedicated clone, whose per-checkout log
`we:scripts/converge-daemon-pass.mjs` already documents as *"its own EMPTY log"*. The ledger is HOME-anchored
at `~/.claude/verdict-ledger/<owner>-<name>.jsonl`, for the identical reason `DRAIN_LOCK_ROOT`
(`we:scripts/readiness/drain-lock.mjs`) is: the contenders run in different checkouts. Machine-local,
disposable, never committed.

### 4. The test path in `scope` was wrong

The old `scope` named a test under `we:scripts/__tests__/` — the module lives in `scripts/lib/`, and every
sibling library test sits beside it in `scripts/lib/__tests__/`. Corrected in `scope` above.

### What the identity field proves, stated in the schema

`actor` records `declared` (the free-text `--actor`), `session` (`currentActorId`), `channel`, the
machine-checked `independence` status, and a constant `proves: 'sanctioned-path'` on **every** row. It proves
which harness session wrote the row and that the sanctioned tool wrote it. It **cannot** prove a human did it
(nothing here distinguishes operator from agent — [#2946], `tier: someday`), cannot distinguish the operator
from a subagent (a subagent inherits its parent's session id), and cannot prove `declared` named a real person.
`proves` and `clears` are both re-derived on read, so a hand-written row cannot upgrade its own claim.

One thing the ledger *does* improve: the row is written from the writing process's own `currentActorId()`, and
is **never** recovered by parsing a comment. The comment trail is forgeable — `CLEARED_HUMAN_PROSE_RE`
(`we:scripts/lib/review-escalation.mjs`) matches a literal prose sentence with no HTML-comment syntax, so
`neutralizeCommentMarkers` does not touch it and a `--body-file` on an ordinary `changes` verdict makes
`parseOperatorClearance` report a clearance that never happened (reproduced against the live code 2026-08-10;
non-gating today — it only affects re-hold wording — and filed separately).

### Write ordering — the card and #3035 both stand

The card says the ledger is written first; #3035's declaration says its ledger effect must come *after* the
label effect. Both are right, at different seams, and the rule is one rule: **never write the row while a
refusal is still reachable.** Inside `runReviewLabelCli` the append sits after every refusal (argv, the #2953
OPEN-state gate, the #2844 self-clear refusal, `decideSetLabel`, the size guard) and before the two `gh`
transport calls — a transport failure does not un-form a verdict. From outside, the operation cannot see those
refusals, so its ordinal-2 effect stays after the label. Consequently the operation's sink is a **reconciler**,
not a second writer: it reads back the row the single home wrote and appends only when that fail-soft write
missed (stamped `source: 'operation-reconcile'`). One verdict never becomes two rows.

### The sidecar: discarded, not migrated

The gitignored session-local sidecar under `.operations/review/` is deleted as a sink, per its own instruction
(*"this default is deleted rather than migrated"*). Not imported: exactly **one** row existed (PR #1146,
accepted, 2026-08-09) and it carries no write timestamp, no session id and no head sha — importing it would
mean inventing the fields the schema exists to attest. It is gitignored and session-local, so there was never
a complete set to import; the label and comment on #1146 remain its durable record. The leftover file is inert
and machine-local.

### The checker

`npm run review:ledger-check [--repo=…] [--json] [--all]`. One `gh pr list`; writes nothing, changes no label.
It sweeps the **union** of open-PRs-with-a-review-label and open-PRs-with-a-ledger-row, and classifies each as
`agree` / `disagree` / `unledgered` / `unlabeled`, with a disagreement **direction** — because the two
directions are not equally bad. `ledger-holds-label-clears` is a live escaped hold under today's label
authority and **exits 1**; the others report and exit 0. The output names the PRs to act on rather than
printing a count, and ends with an explicit Phase-2 readiness line.

**It runs standalone, not in a gate.** `npm run check:standards` must stay offline and deterministic, so a live
`gh` sweep would make it flaky; the drain must not gain a per-pass API call or a new failure mode. What *is*
gated is the whole comparison logic — `compareLedgerToLabels`, `labelVerdictOf`, `summarizeAgreement` are pure
and covered by the unit suite. The exit code was chosen so the CLI can later be wired into a gate unchanged.

## What Phase 2 still needs — none of it built

1. **A drain-side writer.** The ledger covers the review seam only. Holds the drain applies itself
   (`applyLabel` in `we:scripts/merge-ai-prs.mjs`, including the #2409 stale-acceptance re-park) are
   **unledgered**, which the checker counts on its own line. Flipping the authority without this would make
   every drain re-park a no-op — re-opening "the hold that didn't hold" from the other side. This is the
   blocking precondition, not a nice-to-have.
2. **The gate read.** `we:scripts/lib/pr-merge-gate.mjs` / `decideReviewGate` answering from the fold plus
   `ledgerCoversHead`, with no unanswered hold. The affordances exist; the wiring does not.
3. **Fail-closed on a ledger write miss.** Phase 1's append is deliberately fail-soft (a miss costs an
   observation). At Phase 2 a miss costs an un-mergeable PR, so the posture must be revisited.
4. **The evidence.** ~A week of clean `review:ledger-check` runs: zero disagreements **and** zero unledgered
   labels (item 1 is what makes the second reachable). `summarizeAgreement().phase2Safe` is that predicate.
5. **The shadow reviewer's would-clear decisions** appending to the same ledger — named in "What changes at
   the seams" above, still only logging to stderr, and not touched by Phase 1.
6. **The `idempotent` flag** on #3035's ledger effect stays `false`. Reconciliation makes a replay harmless in
   practice; flip it when the dedupe is load-bearing rather than incidental.

---

## SLICED 2026-08-20 — this item is now the GATE READ only

Phase 2's "what it still needs" list was six unbuilt things plus a storage question none of them could
answer. That is not one story. It is sliced per *backlog-workflow.md → step 1*'s edge case: this item
**already has a parent** (`#2405`), so it is NOT converted into a nested epic — it stays a story, re-sized
to its core slice, and the rest are **siblings under the same parent**.

**What stays here:** the gate read. `we:scripts/lib/pr-merge-gate.mjs` / `decideReviewGate` answering from
the fold plus `ledgerCoversHead`, with no unanswered hold. That is the authority flip itself and it is the
one piece that cannot be delivered independently of the others.

**What moved out, each independently deliverable:**

| slice | why it is separable |
| --- | --- |
| `#3214` (decision) | where the ledger lives once it is the authority — blocks everything below |
| `#3215` | ledger the drain's OWN holds; the blocking precondition, and what makes `phase2Safe` reachable |
| `#3217` | the shadow reviewer's would-clear decisions append; useful even if the flip never happens |
| `#3216` | the write-miss posture, which follows the home decision rather than pre-empting it |

**The storage question is a decision, not a build**, and it is carved out rather than narrated here — per
*backlog-workflow.md → Rules*, an item that narrates an open fork in its body is burying a decision. It is
`#3214`, and this item `blockedBy` it.

### What that decision found

`verdictLedgerDir()` is a **machine-global** path (`~/.claude/verdict-ledger/`), not in the repo and not
shared. On a credential-less host the only working writer is CI, which runs the real label CLI **on a
GitHub runner** with no ledger persistence — so six verdicts recorded in one session wrote six rows that no
longer exist anywhere. `#2626` (ratified a week after Phase 1 landed) names a third home for exactly this
class of state but **does not list the verdict ledger**, because it did not exist in that taxonomy yet.

That is a seventh Phase-2 precondition the list above never had, and it is why the decision blocks the flip.

### Still true, and unchanged by the slicing

`ledgerCoversHead` is built and wired nowhere outside its own module; `we:scripts/lib/pr-merge-gate.mjs` contains zero
ledger references; `summarizeAgreement().phase2Safe` is `disagree === 0 && unledgered === 0`. All three
verified 2026-08-20.
