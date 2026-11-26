# Answering a fix agent's stand-down

Only an explicit operator instruction authorizes this ceremony. The orchestrator relays the operator's
answer verbatim with we:scripts/conveyor/stand-down-answer.mjs; it must not invent an answer or invoke the
ceremony autonomously. Like the `clear-human` ceremony in we:scripts/review-set-label.mjs, the comment
records the named actor, channel, and explicit instruction. Attribution is a recorded assertion; the
posting principal is authenticated by GitHub and checked against the existing automation/operator identities.

Operator ruling R123 additionally authorizes the bounded CI recovery cases documented in
we:scripts/conveyor/stand-down-auto-proceed.md. That automation uses the same builder and strict parser;
judgment questions still require an explicit operator answer.

The CLI requires a PR, `--repo`, nonblank `--reason`, `--actor` (GitHub login), and `--channel`. It reads
comments and posts one machine-marked answer targeting the latest unresolved terminal stand-down's
comment ID. No unresolved stand-down means refusal. A repeated invocation after the answer is visible
refuses unless a different unresolved escalation exists. A failed or ambiguous write is never retried
automatically: inspect the thread before retrying. Concurrent invocations are not serialized by GitHub;
the orchestrator must run this ceremony once per explicit instruction.

Optional `--disposition=rearm-review` clears earlier fix claims and the reviewed-head baseline when a trusted
answer names the latest terminal stand-down in the fix window. A trusted `--no-code-owed` answer records the
live head H; the first trusted fix-begin after it consumes eligibility and, only if its sha prefixes H, is the
answered resume and not an empty round, so review re-arms pinned to H; any later claim or stand-down first
counts that resume as a claim, so a pushed change still re-arms and an unchanged head requires a fresh answer.
Legacy headless answers and plain rearm-review answers grant no resume exemption. A changes verdict clears it.
The answer may be posted by the human operator or relayed on their explicit instruction by an allowlisted
automation identity. Each stand-down can be rearmed only once; stale or nonexistent targets grant no exception.
`--preview` runs identical validation and prints the typed JSON result and exact body without posting a comment.
A new trusted stand-down after a later fix-begin reopens the answer window for that newest stand-down,
even on the same head. Plain rearm-review answers clear the current round once; later claims still count.
Unrelated or nonexistent targets and other answers do not grant this exception.
`--disposition=close-superseded` retains its existing close behavior.

The bare `--no-code-owed` flag requires `--disposition=rearm-review` and records an explicit boolean
ruling in the answer and its visible body. It closes the open fix round as no-change and re-arms review,
even when two earlier plain rearm waivers exhausted the verdict window's cap. It must name the latest
stand-down, consumes no waiver, and cannot be replayed to clear later fix claims. The CLI refuses it
while `red-team:blocked` stands (a security fix is owed), or when labels cannot be read completely.
Only one cap override is available per changes-verdict window. After it is spent, both a fresh answer
and a retry superseding an ignored answer refuse before posting; a new changes verdict resets it.
The CLI uses the reader's `rearmWindow().wouldHonour(answer)` for both paths. A failed mechanical
attempt with a trusted receipt has the explicit replacement exception described below.
The deterministic test `rearm-review succeeds after a cap-blocked no-code-owed answer` in
we:scripts/conveyor/__tests__/stand-down-answer.test.mjs verifies the answer-to-command workflow,
including the successful `review:pending` label write and durable re-arm comment through local GitHub IO.
This test does not replace the post-load live proof owed on #7321.

## Mechanical executor: guarded writes and scheduling

Every grant or spend write uses one guard, with no intervening I/O after its decision. It reads
fresh evidence in this order: promotion reads labels, complete comments, and the fix claim;
restore-review-label reads labels and the claim; a no-code receipt reads labels, complete comments,
and the claim; its writer reads labels, complete comments excluding only its own confirmed receipt
(by string ID), and the claim again; close-superseded reads complete comments and the claim.
Each guard re-decides from that evidence. Missing, malformed, incomplete or unreadable evidence
refuses the entry; inspect the named evidence and restore it before retrying. A live claim waits
for its owner. At the first durable write it also probes adoption fresh; errors latch an adoption
yield. Once the receipt commits, adoption cannot strand its writer. Late evidence after the receipt
refuses the writer and leaves the ruling spent; an operator must inspect the handoff before replacing it.

Clearing awaiting-CI status and removing ready-to-merge after a committed write are authority-reducing
follow-ups. They finish with the entry; failures are reported. Adoption is observed after every attempted
entry, including refusals and follow-ups. A latched yield defers all later entries and halves.

A call admitted before its deadline attempts at least one entry per half unless adoption has latched.
Only later entries are bounded by the phase deadline, with at most one late entry in each half.
Promotion keeps its numeric cursor; rearm, restore and close rotate independently after scalar
repo-key/PR cursors. Exhaustion clears a cursor; zero attempts preserve it. Every unattempted entry
and skipped repo is named once, with adoption taking precedence over the deadline. Action timestamps
and monotonic per-call sequence numbers record execution order even when timestamps tie.
An unreadable half cursor restarts only that rotation at its lowest PR, with a named reset. Failed
cursor persistence keeps memory authoritative until restart, which resumes the last successful save.

The isolated CLI accepts --budget-ms=<positive integer>; invalid values refuse before planning.
The deadline starts at CLI entry. A deterministic injected clock proves both pre-admission expiry
(zero work) and planning overruns after admission (one attempt per half). Each external operation
retains its timeout; this bounds attempts, not total wall time. Option B rearm uses three complete
thread reads, each at most ten pages plus a count query; its writer is bounded to 120 seconds.
Promotion also reads required checks, check rows, and conditionally merge-gate labels/verdict/freeze
before its guard. Restore uses one label read and at most two writes; close reads owned cards on
main before its complete-thread guard. No retry loop is introduced.

The predicate in we:scripts/conveyor/stand-down-answer-core.mjs requires a trusted `author.login`, an
exact versioned record, and a later answer targeting the specific stand-down. A quoted marker, unrelated
comment ID, outsider's body, or `viewerDidAuthor` alone cannot clear the hold. Other unresolved stand-downs
remain terminal. No review label, round cap, lifecycle field, or other refusal is cleared by this ceremony.

we:scripts/conveyor/reconcile-core.mjs treats that answer as the third supersede predicate. It carries the
ruling through we:scripts/conveyor/reconcile-fix-dispatch.mjs into fresh and resumed fix prompts before
the work instructions. The original answer is retained byte-for-byte in the structured record and brief;
HTML comment delimiters are escaped in the visible quote so quoted marker text stays inert.

## PR description handoff: live case #3181

After merge, from the WE checkout, the orchestrator should run this exact command on the operator's
explicit instruction (not run during implementation):

```bash
answer_cli=we:scripts/conveyor/stand-down-answer.mjs
node "${answer_cli#we:}" 3181 --repo=web-everything/web-everything --reason="Scope correction is fine but must be careful to going against goal and decision and escalate if needed" --actor=chalbert --channel="Codex chat"
```

Command entry point: we:scripts/conveyor/stand-down-answer.mjs. Operator answer dated 2026-09-30.
The ruling allows a prepare to add, replace, or narrow card scope provided it does not contradict the
card's goal or a ratified decision it depends on. Such a conflict escalates. Lifecycle fields stay locked.

Live proof must show the single attributed answer comment targeting #3181's stand-down, the next fix-daemon
pass re-dispatching #3181, and the actual fix prompt carrying the quoted ruling verbatim. Then inspect the
fixer's diff and gate result: it must implement the allowed scope correction, preserve lifecycle locks,
and escalate contradictions with the goal or ratified decisions. Local tests and the simulated daemon soak
are not that live proof. If another independent refusal blocks dispatch, report that refusal rather than
claiming the answer path has proved end-to-end recovery.

## Follow-ups

Copy the command and live-proof checklist above into the eventual PR description. No PR is opened by this
job. The #3181 live ceremony and observation remain intentionally pending until after merge.

An explicit `--disposition=rearm-review --no-code-owed` ruling is executed mechanically: the conveyor takes a cross-checkout PR lock, reads the complete thread and fresh labels inside that exclusion, posts one durable receipt, and invokes the existing head-pinned rearm writer without launching a fixer. Only observed writer labels confirm success. A receipt spends the ruling even if the child crashes or cannot confirm. A later trusted changes verdict, fix-begin, or changed head retires that ruling and resumes ordinary planning; the old answer is never passed to a fixer.

The no-code ceremony requires a readable head on the named stand-down, including replacement answers.
For a legacy headless stand-down, record a new stand-down with the current head before answering it;
the CLI refuses the unsupported answer before posting. Already-posted headless rulings remain held
until superseded: later trusted verdicts or claims and removal of `review:changes` retire them.
A changed head also retires them when the latest trusted claim (or the verdict if there is no claim)
in the pre-answer window supplies the earlier head. That fallback never authorizes a rearm.

If the original window still carries `review:changes`, a spent ruling requires an operator to inspect the failed handoff and post a replacement answer naming the same earlier stand-down. A held ruling has an explicit exit: clear the red-team hold, restore readable evidence, answer the newer unresolved stand-down, or post a replacement answer naming a stand-down with the current head. A lock with unknown ownership requires operator inspection; proven process death permits recovery, while a live holder has no expiry-based takeover. Planner branches that `continue` on a held state must document such an operator exit; superseded windows must fall through to ordinary planning.

After inspecting a receipted failure, invoke the same `--disposition=rearm-review --no-code-owed`
ceremony with the new explicit instruction. The CLI records `supersedes` for the latest ruling without
requiring `status:answered-waiting-fixer`. Each replacement grants one attempt and needs its own receipt
before another replacement. The receipt must name the prior answer and the current full head. Missing or
untrusted receipts, an intervening stand-down, fix claim, changes verdict, successful rearm or no-change
marker, or a moved head refuse recovery. This exception does not replenish the shared writer's waiver
or cap-override budget. Full and abbreviated stand-down SHAs use the same case-insensitive prefix match.

Regression coverage: `superseded no-code ruling does not hold a red-team fix` in
`scripts/conveyor/__tests__/no-code-rearm.test.mjs` combines retirement with both red-team holds;
`receipted replacement preserves consumed writer budgets` in
`scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs` refuses an exhausted replacement before calling the writer. The same file's `post-receipt ... refuses the writer`
cases pin the fresh evidence check, spent ruling and zero label writes.
