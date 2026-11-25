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
refuses unless a different unresolved escalation exists or an attempted no-code ruling qualifies for
the explicit recovery ceremony below. A failed or ambiguous write is never retried
automatically: inspect the thread before retrying. Concurrent invocations are not serialized by GitHub;
the orchestrator must run this ceremony once per explicit instruction.

Optional `--disposition=rearm-review` records that the operator ruled no code is owed. A trusted, exact
answer targeting the latest terminal stand-down since fix-begin lets review be re-armed on the unchanged
head by clearing earlier fix claims and the reviewed-head baseline; a fix-begin posted afterward starts
a new round and still requires a change. The answer may be posted by the human operator or relayed on
their explicit instruction by an allowlisted automation identity using its inherited credentials. Both
readers recognize that same posted answer, so it needs no second post under human credentials.
A new trusted stand-down after a later fix-begin reopens the answer window for that newest stand-down,
even on the same head. A later fix-begin alone preserves the answered rearm; its new claims still count.
Each unattempted ruling can be honored only once, and a stale target cannot clear newer claims.
Unrelated or nonexistent targets and other answers do not grant this exception.
`--disposition=close-superseded` retains its existing close behavior.

The bare `--no-code-owed` flag requires `--disposition=rearm-review` and records an explicit boolean
ruling in the answer and its visible body. It closes the open fix round as no-change and re-arms review,
even when two earlier plain rearm waivers exhausted the verdict window's cap. It must name the latest
stand-down, consumes no waiver, and cannot be replayed to clear later fix claims. The CLI refuses it
while `red-team:blocked` stands (a security fix is owed), or when labels cannot be read completely.
Only one cap override is available per changes-verdict window. After it is spent, both a fresh answer
and a retry superseding an ignored answer refuse before posting; a new changes verdict resets it.
An attempted ruling has a separate recovery path described below; it does not grant another cap override.
The CLI uses the reader's `rearmWindow().wouldHonour(answer)` for both paths.
A no-code rearm ruling (`--disposition=rearm-review --no-code-owed`) is executed by the conveyor, once,
and never by a fixer: the reconcile planner emits one `rearm-no-code` row and promote-draft-pr-dispatch runs
`rearm-review.mjs --expect-head=<head>` itself. New no-code answer records include the live full head SHA,
even when a push occurred after fix-begin. Receipts cannot rebind that ruling to another head.
A later fix-begin, unparseable claim, newer changes verdict, red-team label, moved head or review-label
handoff makes the ruling stale: ordinary planning resumes without passing the no-code instruction to a fixer.
Incomplete head, label or thread evidence holds the ruling until readable evidence is restored.
An intent, confirmation or failure receipt spends the attempt. While `review:changes` still stands and
the ruling is current, neither fix nor CI healing is dispatched. Check the live labels and thread, then
explicitly run `stand-down-answer` again with `--disposition=rearm-review --no-code-owed` to authorize one
fresh attempt on the same stand-down and head. This supersedes the spent answer, requires live
`review:changes`, and refuses after a newer fix claim/verdict or a security hold. Unattempted answers
still cannot be replayed. The deterministic test `%s on review:changes waits without fix or CI healing
and accepts a fresh CLI answer` in `scripts/conveyor/__tests__/no-code-rearm.test.mjs` covers all three
receipt states and legacy rearm/empty-round notes through the CLI and back into planning.
After the label handoff, remaining red required checks resume ordinary `ci-heal` planning, including
a `review:human` handoff, which preserves the human hold without adding `review:pending`.
Confirmed handoffs produce no new no-code decision ask. An unconfirmed intent still asks a person to
check the live labels. Ordinary work never receives the no-code `operatorAnswer` payload.
The executor passes `--no-code-rearm` with `--expect-head` to preserve live red-team labels. A head pin
alone keeps ordinary recovery semantics: the orphan guard can re-arm a repaired red-team send-back.
The handoff comment records the honoured no-code ruling without spending another repair round, so
the requested review remains eligible when the existing repair count is exactly at its cap.
The tests `incident #%s ruling rearms once with no refusals, then resumes required-check CI healing` cover both
incident IDs with reconstructed required-check evidence; captured real-state rollups were unavailable
in the offline repair context.
The PR body's original acceptance claim of a read-only replay on the real state of #7448 and #7451
at b74314d4 is a **manual one-off check**, not a named automated test. Its captured inputs and output
were not supplied to this repair, so it is not independently verified here. The automated coverage
is the reconstructed incident test above and the `no-code-rearm-handoff` soak replay through the
production planner, executor and label writer with injected IO.
The deterministic test `rearm-review succeeds after a cap-blocked no-code-owed answer` in
we:scripts/conveyor/__tests__/stand-down-answer.test.mjs verifies the answer-to-command workflow,
including the successful `review:pending` label write and durable re-arm comment through local GitHub IO.
This test does not replace the post-load live proof owed on #7321.

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
