# Conveyor stuck-PR inspection brief (template) — diagnose why ONE PR stopped moving, then stop (epic #3383)

> **This is a TEMPLATE, not a runnable skill.** `we:scripts/conveyor/stuck-pr-inspect-dispatch.mjs` instantiates
> it — filling the `{{PLACEHOLDERS}}` below with one real, currently-stuck PR — and passes the result as the
> prompt for **one background inspection agent**. One agent = one PR = one stuck episode = one comment.

> **Why this exists.** Operator (2026-09-23): "we also should have a health watch that launch and inspection
> if pr are stuck." `we:scripts/conveyor/stuck-pr-watch.mjs` already decides WHETHER a PR is stuck (no progress
> past its stage's expected time, nothing live working it); this brief is what runs once it decides yes. It
> exists because the watch itself can only measure symptoms (no commit/label/comment, no bound session) — it
> cannot read WHY (a daemon crashed, a dispatch never fired, a session is silently blocked on a permission
> prompt, a genuine merge conflict, …). That is a judgment call, so a real agent makes it, once, per episode.

## Fill these before spawning

| Placeholder | What the dispatcher fills it with |
|---|---|
| `{{PR}}` | the stuck PR's number — e.g. `2505` |
| `{{REPO}}` | the target repo's gh slug — e.g. `web-everything/web-everything` |
| `{{SESSION_SLUG}}` | this inspection's session slug — `inspect-{{PR}}` for WE, `inspect-pa-{{PR}}` / `inspect-fui-{{PR}}` for the sibling repos |
| `{{STAGE}}` | which tracked stage the watch caught this PR in — `review` / `fix` / `approved` / `conflict` |
| `{{MINUTES_SINCE}}` | roughly how many minutes of no progress the watch measured |
| `{{THRESHOLD_MINUTES}}` | that stage's own threshold, for context |

> **Two kinds of placeholder.** `{{LIKE_THIS}}` are **dispatcher-injected** — substituted before you are spawned
> (the table above). `<like-this>` are **agent-runtime values** you produce as you work.

## Your job (one sentence)

Find the REAL, evidence-backed reason PR `{{REPO}}#{{PR}}` has had no progress for about `{{MINUTES_SINCE}}`
minutes while in the `{{STAGE}}` stage (threshold `{{THRESHOLD_MINUTES}}`m), post ONE comment naming it, write
a completion record, and stop. **You never change a label, write code, or touch a branch — diagnosis only.**

## You have no lane, and you acquire none

Every other dispatched agent in this repo starts with `lane-pool.mjs acquire`. You do not — there is nothing
for you to build, so there is nothing to isolate. You start in the primary WE checkout, read-only against
GitHub, `claude`'s own agent listing, and whatever daemon-clone state you can find on this machine. If a step
below needs a checkout you do not have (e.g. reading `{{REPO}}`'s own working tree), read it through `gh`
instead of cloning or checking anything out — you do not need a local copy to diagnose a stall.

## Report you started, immediately

```bash
node scripts/operations/completion-cli.mjs report --status=started --session={{SESSION_SLUG}} --kind=inspect --pr={{PR}} --json
```

Do this FIRST, before any investigation — a crash partway through still leaves a `started` record, which is
how a reader tells "still diagnosing" apart from "never dispatched at all" (`we:backlog/3436-*.md`'s own reason
for this two-write shape).

## Investigate — every claim below needs a command you actually ran

**The proof rule (non-negotiable): every claimed cause must be backed by a command output you actually ran.**
"It looks like the reviewer never ran" is not a finding; the exact command and its exact output that PROVES no
reviewer ran is. Cite the command and the relevant slice of its output for every cause you name.

**Redact before you quote.** Your comment is posted on GitHub, where anyone who can see the PR can read it.
Daemon logs and `ps aux` output can hold things that must never go there. Before you paste any slice of log,
process, or agent-listing output, remove: every token, key, password, or credential-looking string; every
environment variable value; and every absolute home-directory path (write `~/…` instead). When a line is
mostly sensitive, describe it in your own words ("the tick at 14:02 threw an auth error") instead of quoting it.

Work through these, in whatever order the evidence leads you — this is not a fixed checklist to complete
mechanically, it is where the evidence tends to live:

1. **The PR itself.** `gh pr view {{PR}} --repo {{REPO}} --json number,title,labels,mergeable,mergeStateStatus,headRefName,headRefOid,comments,statusCheckRollup,isDraft` — confirm it is still genuinely stuck (labels, CI state, mergeability) and read its full comment thread for context (a stand-down marker, a prior bounce, an existing dispatch marker from this same watch).
2. **The PR's timeline.** `node scripts/conveyor/stuck-pr-watch.mjs timeline --pr={{PR}} --repo={{REPO}}` (a fixed, GET-only read — raw gh api calls are denied to you, because they reach every GitHub write) — the authoritative record of every label/comment/commit/review event and WHEN it happened. This is where "nothing happened for {{MINUTES_SINCE}}m" either holds up or doesn't.
3. **Live agent sessions.** `claude agents --json --all` — is a `review-{{PR}}` / `fix-{{PR}}` (or the sibling-repo tagged form) session present at all? If present: what `state`/`status` does it carry — genuinely working, `done` but never reaped, or `waiting` on a permission prompt nobody is there to answer (a real, previously-observed failure mode — see `we:scripts/conveyor/reconcile-core.mjs#assessLiveness`'s own docblock)? If ABSENT: nothing ever dispatched for this PR, or a dispatched session already exited.
4. **Completion records.** `node scripts/operations/completion-cli.mjs show --session=review-{{PR}} --json` and the `fix-` equivalent (adjust the session-slug tag for a sibling repo, e.g. `review-pa-{{PR}}`) — did a review/fix agent ever report `started` or `done` for this PR? A `started` record with no matching `done` and no live session is a crashed dispatch.
5. **The daemon(s) that should have acted.** This repo's mechanical passes run resident, off a dedicated daemon clone (never the operator's own primary checkout) — find it (check for a sibling checkout under `~/workspace/` carrying a `.conveyor/` directory, or ask `ps aux | grep -E 'pass-daemon|supervisor|runner.mjs'` which checkout a running process points at) and read its logs: `.conveyor/*.log` under that clone (e.g. `.conveyor/pass-daemon.parked-pr-conflict-watch-we.log`, `.conveyor/pass-daemon.stuck-pr-watch-we.log`) for the tick around when this PR should have been picked up — a crash, a thrown error, or the pass simply not running (no daemon resident at all) all leave a trace here. `we:skills-src/conveyor/daemon-manifest.mjs` names every pass that should be running.
6. **Lane pools**, if the stage suggests a fix is owed: `node scripts/lane-pool.mjs list --json` (from the primary checkout, read-only — you are not acquiring one) — is the pool fully held, starving a fix dispatch of a free lane?
7. **CI**, if relevant: `gh pr checks {{PR}} --repo {{REPO}}` — is the required `test` check red, pending forever, or simply never queued?

## Post ONE PR comment

Exactly one comment, on `{{REPO}}#{{PR}}`, opening with the literal marker `🔎 stuck-PR inspection` so it is
never confused with the watch's own dispatch-marker comment (which opens differently). Required shape:

```markdown
🔎 stuck-PR inspection

**Cause.** <the real, root cause you found — not a symptom>

**Evidence.** <the exact command(s) you ran and what they showed — this is the proof rule, not optional>

**Should have acted.** <which daemon/pass/session should have picked this up, and what it actually did instead
(silent, crashed, never dispatched, blocked on a permission prompt, genuinely working slowly, …)>

**Suggested fix.** <a specific, actionable next step — resume/restart the daemon, dispatch a review by hand,
resolve the conflict, escalate to a human, or "nothing is actually wrong, re-check in N minutes" if that is
genuinely what the evidence shows>
```

```bash
printf '%s\n' '<the comment body above>' > <a scratch path in your own context, not disk — see the system prompt>
gh pr comment {{PR}} --repo {{REPO}} --body-file=<that file>
```

If GitHub's own state has already moved past "stuck" by the time you finish (a human or another agent already
acted) say so plainly instead of re-diagnosing a problem that no longer exists — that is itself a valid,
evidence-backed finding ("Cause: already resolved — see comment/label change at <timestamp>").

## Report done, then stop

```bash
node scripts/operations/completion-cli.mjs report --status=done --session={{SESSION_SLUG}} --kind=inspect --pr={{PR}} --outcome=diagnosed --json
```

Return a one-line result: `#{{PR}} stuck-inspection → <one-line cause>`. **Do not** change any label, push any
commit, open any PR, merge anything, or wait for a reply — nobody is watching this session turn by turn (see
the system prompt). Your job ends with the comment and the completion record.
