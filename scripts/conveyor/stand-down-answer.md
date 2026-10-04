# Answering a fix agent's stand-down

Only an explicit operator instruction authorizes this ceremony. The orchestrator relays the operator's
answer verbatim with we:scripts/conveyor/stand-down-answer.mjs; it must not invent an answer or invoke the
ceremony autonomously. Like the `clear-human` ceremony in we:scripts/review-set-label.mjs, the comment
records the named actor, channel, and explicit instruction. Attribution is a recorded assertion; the
posting principal is authenticated by GitHub and checked against the existing automation/operator identities.

The CLI requires a PR, `--repo`, nonblank `--reason`, `--actor` (GitHub login), and `--channel`. It reads
comments and posts one machine-marked answer targeting the latest unresolved terminal stand-down's
comment ID. No unresolved stand-down means refusal. A repeated invocation after the answer is visible
refuses unless a different unresolved escalation exists. A failed or ambiguous write is never retried
automatically: inspect the thread before retrying. Concurrent invocations are not serialized by GitHub;
the orchestrator must run this ceremony once per explicit instruction.

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
