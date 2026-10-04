#!/usr/bin/env python3
"""Converge open PRs to landed, with NO work done in the calling session.

STATUS (2026-08-27/28): a PROVEN PROTOTYPE, not sanctioned automation. Built and used live across
one overnight session to unblock a batch of PRs, then to find and land two real bugs in the drain
(`#3379`'s numbering-push extraction, `we:scripts/verify-lane.mjs`'s `reset` mode) and to dispatch
independent reviews when the calling session was itself a PR's author and structurally could not
review its own work (`#2439`). It is NOT wired into CI or the drain, has no test suite of its own,
and its `heal_ci`/stale-label-clearing logic has NOT been ported into the real `merge-ai-prs.mjs` —
running it live is what surfaced the need for that, not a replacement for doing it. Saved here so
the next session that needs it does not have to rebuild it from a transcript, and so specific pieces
can graduate into real, tested, reviewed code over time rather than staying scratchpad-only forever.
See `#3321`'s children for the concrete follow-ons this session filed while using it.

SUPERSEDED (#3383): its `heal_ci` logic HAS since been ported and wired into real, tested, mechanized
code — `we:scripts/conveyor/tick-core.mjs`'s `planCiHealSpawns` + `we:scripts/operations/dispatch-lane.mjs`'s
`ci-heal` launch kind, driven by `we:skills-src/conveyor/runner.mjs`'s loop. Nothing live calls this script
any more (verified by grepping for callers repo-wide). Kept only as the historical prototype record.

One supervisor thread per PR. Each round it spawns a headless `claude -p` FIX agent, waits for it, then a
headless REVIEWER, and reads the label to decide whether to go again. The calling session only reads this
script's stdout.

INDEPENDENCE. The fixer and the reviewer are separate headless processes, so they mint separate session ids.
`review-set-label.mjs:586` refuses `--to=accepted` only on a proven self-clear, so an accept recorded by the
reviewer is legitimate precisely because the fixer is a different actor. This is also why `run_agent` alone
(not the Agent tool) can review a PR the CALLING session itself authored — an Agent-tool subagent inherits
the parent's session id verbatim (#2413's ratified statute) and would hit the same self-clear refusal; a
`claude -p` subprocess does not.

LANES ARE PINNED, NOT ACQUIRED. `lane-pool.mjs acquire` runs the #2748 ghost reaper first, and that reaper
reclaims a lane whose last PR is merged even when the lease is seconds old — measured 2026-08-26, seven
concurrent acquires all returned lane-24. Pinning distinct lanes per PR sidesteps it. Filed as
`x3884p1`; this is the workaround.

ROUND CAP is the documented one: `deriveNegotiationOutcome` escalates at 5, so this stops at 5 and says so
rather than inventing its own stopping rule.

USAGE. This file has no CLI of its own — it is imported and driven interactively (see the docstrings on
`run_agent`, `converge`, `heal_ci` for the shape of a call), or run directly after filling in `PLAN` below
for a one-off batch. `REPO`/`LANES` default to this machine's layout; override with the `WE_REPO`/`WE_LANES`
env vars on a different machine.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time

REPO = os.environ.get("WE_REPO", "/Users/nicolasgilbert/workspace/webeverything")
LANES = os.environ.get("WE_LANES", "/Users/nicolasgilbert/workspace/.lanes/web-everything")
SCRATCH = os.path.dirname(os.path.abspath(__file__))
ROUND_CAP = 5

# PRs the operator has explicitly lifted the cap for. The cap exists to stop CHURN — rounds that re-litigate
# the same defect. Escalating a PR that is visibly still making distinct, mutation-proven progress each round
# would hand a person a problem the loop is genuinely still solving. Lift per PR, on explicit instruction,
# never as a blanket default. Empty by default — fill in for a specific run.
UNCAPPED = set()

# pr -> (work lane, juror lane). The FIXER and the review DRIVER share the work lane — they run in sequence,
# never at once — so this needs two lanes per PR, not three. The juror is separate because `assertLaneCwd`
# refuses a juror lane that is the driver's.
#
# Fill this in per run — lane numbers must be disjoint from every lane any other agent (this loop's own
# earlier rounds, a peer session, a workflow) currently holds. Empty by default: this file is a library +
# an example driver, not a standing batch job with baked-in PR numbers.
PLAN = {}

lock = threading.Lock()


def emit(msg):
    with lock:
        sys.stdout.write(msg + "\n")
        sys.stdout.flush()


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def label_of(pr):
    r = sh(["gh", "pr", "view", str(pr), "--json", "labels,state",
            "--jq", '(.state) + " " + ([.labels[].name] | join(","))'], cwd=REPO)
    return r.stdout.strip()


def branch_of(pr):
    r = sh(["gh", "pr", "view", str(pr), "--json", "headRefName", "--jq", ".headRefName"], cwd=REPO)
    return r.stdout.strip()


def lease(lane, purpose):
    """Take a REAL lane-pool lease before working in a lane.

    My dispatchers pinned lanes by hand and took no lease at all — a workaround for the ghost-reaper bug
    (#3283) that outlived its reason. The consequence was worse than the bug: the pool handed lane-7 to a
    peer's agent while mine was working in it, and the contested-lease guard could not fire because there was
    nothing to contest. A lease is only a guarantee if EVERY consumer participates; one that opts out makes
    the guard structurally unable to protect anyone.

    Best-effort: a failed acquire returns None and the caller proceeds, because refusing to dispatch is worse
    than dispatching unleased — but it is REPORTED, so the hole is visible rather than silent.
    """
    r = subprocess.run(["node", "scripts/lane-pool.mjs", "acquire", f"--lane={lane}",
                        f"--purpose={purpose}", "--no-reset"],
                       capture_output=True, text=True, cwd=REPO)
    for line in r.stderr.splitlines():
        if "holder slug:" in line:
            return line.split("holder slug:")[1].split("—")[0].strip()
    emit(f"  lane-{lane}: acquire failed, working UNLEASED — {r.stderr.strip()[:90]}")
    return None


def unlease(lane, slug):
    if not slug:
        return
    subprocess.run(["node", "scripts/lane-pool.mjs", "release", f"--lane={lane}", f"--session={slug}"],
                   capture_output=True, cwd=REPO)


def run_agent(prompt, lane, tag, timeout=3600, verify=None):
    """One headless agent. Its own process, so its own session id.

    It also CLAIMS the lane on disk for the duration. Attribution used to be inferred from git state — match
    a lane to a PR by branch ancestry — and that is wrong for a REVIEWER, whose lane sits at `main` and never
    checks the PR out. #1573 was reported `STUCK: no reviewer` while two reviewer processes were working on
    it. A status that cries stuck at a live agent is exactly what would make a reconciler restart one.

    The dispatcher knows the PR, the lane and the role; a claim file records that fact instead of guessing at
    it. Liveness still comes from the pid, so a claim left behind by a crash cannot lie for long.
    """
    # RE-CHECK IMMEDIATELY BEFORE SPAWNING, not just when the supervisor started. State moves under a
    # dispatch: a PR merged while its re-review was being launched, so an agent ran against a PR that no
    # longer existed. The gap between deciding to dispatch and dispatching is small but it is not zero, and
    # everything in this loop is asynchronous.
    pr_id = tag.split("-")[0]
    if pr_id.isdigit():
        st = subprocess.run(["gh", "pr", "view", pr_id, "--json", "state", "--jq", ".state"],
                            capture_output=True, text=True, cwd=REPO).stdout.strip()
        if st in ("MERGED", "CLOSED"):
            emit(f"#{pr_id}: {st} — not dispatching {tag}, the PR is gone")
            return f"skipped ({st})"

    log = os.path.join(SCRATCH, f"conv-{tag}.log")
    claim = os.path.join(SCRATCH, f".worker-lane-{lane}.json")
    slug = lease(lane, f"conv-{tag}")
    with open(log, "w") as out:
        p = subprocess.Popen(
            ["claude", "-p", "--permission-mode", "bypassPermissions", prompt],
            cwd=os.path.join(LANES, f"lane-{lane}"),
            stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            with open(claim, "w") as ch:
                json.dump({"pr": tag.split("-")[0], "role": "rev" if "-rev-" in tag else "fix",
                           "pid": p.pid, "lane": lane, "tag": tag}, ch)
            p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            p.kill()
            # SALVAGE BEFORE THE NEXT ROUND RESETS THE LANE. Every fix brief opens with `reset --hard`, so a
            # timed-out fixer's uncommitted work is destroyed by its own successor, silently — the log said
            # only "fix timeout". Work has been lost this way and recovered by hand once already.
            # A stash is cheap and reversible; losing the work is neither.
            subprocess.run(["git", "-C", os.path.join(LANES, f"lane-{lane}"), "stash", "push", "-u",
                            "-m", f"salvaged from timed-out {tag}"],
                           capture_output=True, env={**os.environ, "LANE_SESSION": "salvage"})
            return "timeout(work stashed)"
        finally:
            try:
                os.remove(claim)
            except OSError:
                pass
            unlease(lane, slug)
    if p.returncode != 0:
        return f"exit{p.returncode}"
    # A CLEAN EXIT IS NOT A DONE JOB. An agent has exited 0 having written a few dozen bytes — "I'll stop
    # polling and wait for the monitor event" — and never touched the branch. The supervisor logged `ok`, the
    # caller believed it, and the PR stayed untouched with nothing watching it. An agent that declines the
    # work exits exactly as successfully as one that does it, so the exit code cannot be the evidence.
    try:
        did_something = os.path.getsize(log) > 400
    except OSError:
        did_something = False
    if not did_something:
        return "no-op (agent exited without working — see the log)"
    if verify is not None and not verify():
        # The caller's own post-condition, checked against the world rather than against the agent's say-so.
        return "unverified (agent finished but the outcome it was sent to produce is absent)"
    return "ok"


FIX = """You are a FIX agent for pull request #{pr} in `web-everything/web-everything`. You did not review it; your
job is to address the review that bounced it, and nothing else.

## Your lane

Work in `{lane_path}` and nowhere else. Put the PR's branch there first:

```
cd {lane_path}
git fetch origin {branch}
LANE_SESSION=conv-{pr} git reset --hard FETCH_HEAD
```

Never edit the primary checkout — a committed hook denies it.

## Read the findings

```
gh pr view {pr} --json comments --jq '.comments[-1].body'
```

Some PRs carry TWO comments: one the `review-pr` operation posted rendering the JUROR's verdict, and one the
reviewing operator posted with their own findings. When an operator overrode the juror, the operator's
comment is the one with the reasons. Read enough comments to be sure you have the real findings.

## The rule that has cost this PR every round so far

**A claim corrected in one place and left standing in another is the defect, not a tidiness issue.** Round
after round on these PRs has been bounced for exactly this: a false sentence fixed in the section the review
quoted, and the same sentence left intact two sections up, in the PR title, or in the PR body.

So for every finding:

1. Fix it where the review quoted it.
2. Then **grep the whole PR — every changed file AND the PR title AND the PR body — for the same claim**, and
   fix every instance.
3. **Retract, do not silently delete.** Where a claim was wrong, quote the wrong version and say it was
   wrong. That is this repo's convention and reviewers check for it.

## Verify, never assert

Every number you write must come from a command you ran in this lane in this session. Counts written from
memory are the single largest source of bounces here. If the review says a count is wrong, re-run it — do not
take the review's number on trust either.

## The PR body is part of the deliverable

If a finding is about the description or the title, fix them:

```
node scripts/pr-body-edit.mjs --pr={pr} --body-file=<file>     # NOT `gh pr edit --body`, which drops a stamp
gh pr edit {pr} --title "..."
```

When you edit the body with a script, **verify the edit actually landed** (`gh pr view {pr} --json body`).
A previous round's body edit failed silently and was reported as done.

## DO NOT BUNDLE A STRANDED-HASH HEAL

If `check:standards` reports stranded-hash errors for cards you did not touch, **leave them**. They read from
`origin/main`, so they error for everyone until a heal lands on main — you cannot clear them from a branch,
and a local fix helps nobody.

More importantly: `number-stranded` rewrites citations in `we:docs/agent/platform-decisions.md`. Bundling it
turns your PR into a **statute edit**, which draws `review:human` and parks a one-card change waiting for a
person, over a mechanical rename. The drain heals these after landing. Say in your PR body that the strays
are pre-existing and were deliberately not bundled.

## COMMIT AS YOU GO — you may be killed without warning

You have a wall-clock budget and you will not be told when it runs out. A previous fixer on a large PR was
killed at the limit and lost three new fixtures, a new test and four edited modules, because the NEXT round
opens with `git reset --hard`. Commit each coherent piece as you complete it rather than saving one commit
for the end. An extra commit costs nothing; a lost hour costs an hour.

If the work is large, push partial progress too — a bounced PR with half the findings fixed is strictly
better than one with none.

## Finish

- **Never read `check:standards` through a pipe.** `... | tail -1` or `| grep` gives you the exit code of
  `tail`/`grep`, not the gate — a red gate then reads as success. Run it plainly, or redirect to a file and
  grep the file. The printed count is trustworthy; a piped exit status is not.
- **Run it TWICE and report both.** The backlog loader is non-deterministic when any card is malformed, so a
  single reading is not evidence.
- `npm run check:standards` must show no new errors and no new warnings vs this lane's `main`. Measure the
  baseline yourself; it may have moved since you started, so do not trust a number written on a card.
- If the PR touches tests, run them.
- Commit with a message that states, per finding, what was wrong and what the check now says.
- `git push origin HEAD:{branch}`

Report: which findings you addressed, which you did not and why, and the commit sha.
"""

CI_HEAL = """You are healing a REAL CI FAILURE on pull request #{pr} in `web-everything/web-everything`. Its review
already ACCEPTED this diff's content — do not re-review it, do not second-guess the accepted changes. Your
job is narrow: make the failing CI check pass, and nothing else.

## Your lane

Work in `{lane_path}` and nowhere else. Put the PR's branch there first:

```
cd {lane_path}
git fetch origin {branch}
LANE_SESSION=conv-{pr} git reset --hard FETCH_HEAD
```

## What actually failed

```
gh pr checks {pr} --repo web-everything/web-everything
```

For the failing check, read its real log — not a guess:

```
gh run view --job=<the failing job id from the checks output> --repo web-everything/web-everything --log-failed
```

## Fix ONLY what the log says is wrong

A stale generated file (inventory, snapshot, lockfile) is the common case — regenerate it with whatever
script the error names and commit the regenerated file. A real test failure means the diff broke something;
fix the diff, not the test, unless the test itself is provably wrong (state why if so).

Do NOT touch anything the accepted review did not ask you to touch. This is a CI heal, not a second review
round — widening scope here is exactly the kind of drive-by edit that costs an extra round.

## Verify before pushing

Run the same check locally that failed in CI (`npm run check:standards`, `npm run test:unit`, whichever the
failing job ran) and confirm it is green BEFORE pushing — never read a gate through a pipe (`| tail -1` /
`| grep` reports the pipe's exit code, not the gate's) — and never push and hope CI re-run agrees with you.

## Finish

```
git add <only the files you changed>
git commit -m "ci-heal: <what was stale/broken and what you did>"
git push origin HEAD:{branch}
```

Report the failing check's name, what was actually wrong, and the commit sha.
"""

REVIEW = """You are an INDEPENDENT reviewer for pull request #{pr} in `web-everything/web-everything`. You did not
write it and you did not fix it — those were other sessions.

Run the declared operation, not a procedure of your own. Read `skills-src/review/SKILL.md`, then:

```
node scripts/operations/run.mjs review-pr --pr={pr} --repo=web-everything/web-everything --cwd={juror_path} --json
```

`--cwd` is the juror's own lane and is REQUIRED. You work in `{drv_path}`. The operation has a `confirm`
step — resume it with `--resume=<run-id> --answer=<verdict>` once you have satisfied yourself the juror's
findings are real. Note the juror frequently returns `accept` on PRs that have real defects in their
DESCRIPTION rather than their code; overriding it is normal and expected.

## THIS IS A ONE-SHOT PROCESS — YOU CANNOT COME BACK LATER

If `review-pr` reports its gate step is running in the background, you do NOT get a later turn to check on
it. "I will wait for the notification" or "I will pick this up later" both mean the review never completes —
this is a real, reproduced failure mode, not a hypothetical one. Whether to block, poll, or resume on a
backgrounded gate is mechanical, not a judgment call: POLL IN THIS TURN. Run `sleep 20` via Bash, then
re-check/resume, in a loop, inside this one turn, until the gate finishes or a hard timeout (10 minutes) is
reached. Do not end your turn while the gate is still running.

## READ THE TOUCH-SET FIRST — it decides the lenses, not you

`gh pr view <pr> --json files` before anything else. What the diff touches decides how it is reviewed, and
that decision cannot be made inside the operation: the step list is fixed at registration, before any PR is
read. It is the caller's job — yours.

| the diff touches | what to run |
| --- | --- |
| `we:docs/agent/platform-decisions.md`, a leash, any cite-able cluster rule | omit `--lens`, and **say in your write-up that only `correctness` ran** — see the warning below |
| code (`scripts/`, `skills-src/`, `src/`) | omit `--lens`, so the mandatory pair (correctness + security) both seat |
| backlog cards / docs only | `--lens=correctness` is fine — a security juror on a markdown card is spend for nothing |

**Check what `review-pr` actually wires before assuming single-lens.** An earlier version of this brief
claimed `review-pr` is single-lens today regardless of `--lens`. That was found stale in review: this repo's
`review-pr` already wires two judge steps (`judge` + `judgeSecurity`) when `--lens` is omitted on a code diff.
Verify against the current source rather than trusting this paragraph — it has been wrong before.

## DO NOT FORCE A LENS WHEN THE DIFF TOUCHES A STATUTE OR A LEASH

Check the changed files FIRST. If the diff touches `we:docs/agent/platform-decisions.md`, any leash, or any
other cite-able cluster rule, **omit `--lens` entirely** and let the operation's care model choose the panel.
A statute touch is maximum care by rule: full panel, more than one juror.

The pragmatic bar below applies to ORDINARY changes. It does not relax anything for a statute: there,
imprecise wording IS the defect, because the wording is what gets cited.

## RECORDING THE VERDICT IS THE DELIVERABLE — do not exit without it

A review that produces findings and records nothing is worse than useless: the PR is left labelled
`review:pending`, indistinguishable from never having been reviewed, so the next pass spends a full run
rediscovering the same things. **Do not exit while the juror is still running. Wait for it** (see the polling
instruction above). If it will not return inside the hard timeout, record YOUR verdict with your own findings
and say the juror did not complete — a verdict with a stated gap is worth far more than an unrecorded one.
Your analysis is not the product; the verdict on the PR is.

## Triage the previous round explicitly

```
gh pr view {pr} --json comments --jq '.comments[-1].body'
```

For every finding the last round raised, say **addressed** / **not addressed** / **wrongly addressed**, and
quote the text. "Wrongly addressed" — the author changed something but introduced a new false claim, or fixed
one instance and left another — is a failure mode worth checking for specifically: grep the changed files and
the PR body for the claim, not just the line the last review quoted.

## THE BAR — this is the most important section

**Bounce only what would cause someone to do the wrong thing.** We are shipping, not polishing.

**BLOCK on:**
- code that is wrong, or a test that does not test what it claims
- an acceptance criterion that is unachievable, already green, or tests a different item's work
- a claim that would send a builder down a wrong path — a cited API that does not exist, an instruction that
  throws, a mechanism described backwards
- a description asserting the PR does something its diff does not do

**DO NOT BLOCK on** — note it as non-blocking and ACCEPT:
- prose accuracy that changes nobody's actions: which commit introduced which line, attribution in argument
  text, historical narrative
- stale figures that no acceptance criterion depends on
- wording, emphasis, a table narrower than its own caption, off-by-one line numbers in a citation whose
  target is still findable
- anything you would describe as "degraded impact" and cannot tie to a wrong action

If your finding is real but the fix is one word in a sentence nobody executes, that is a **non-blocking
note**, not a bounce. Say it and accept.

A second bounce on the same PR should clear a higher bar than the first, not a lower one. If the previous
round's blocking findings are addressed and what remains is prose, ACCEPT and list the residue.

## Standing rules

1. Open every `file:line` the PR or its cards cite. Run every count they state. Do not accept a number
   because it is written down.
2. A citation pointing at a real line is not the same as the conclusion drawn from it holding.
3. Where the PR touches tests, run them and try a mutation that SHOULD redden a named case.
4. If nothing is blocking, record `accept` — do not manufacture findings. Equally, do not accept a PR whose
   description asserts something its diff does not do.
5. A CONFIRMED finding owes a prevention; say whether one is filed.

Report the verdict and the run id.
"""


def make_landable(pr, branch, lane):
    """An ACCEPTED PR is not a landable one, and the gap is silent both ways.

    Two independent reasons a converged PR parks forever while looking finished:

      * `review-set-label.mjs` STRIPS `ready-to-merge` on a bounce (correct — a bounced PR must not land) and
        nothing restores it on the eventual accept. The drain selects on that label, so it never even
        considers the PR.
      * The lander deliberately SKIPS a `BEHIND` PR — "the sweep never force-updates someone's branch"
        (`merge-ai-prs.mjs:34-35`). Nothing here rebases after main moves, so every PR that took a while to
        converge ends up behind and is skipped by design.

    Both are the author lane's job, which is this loop. Doing them is what turns `accepted` into `merged`.
    """
    lp = os.path.join(LANES, f"lane-{lane}")
    env = {**os.environ, "LANE_SESSION": "landable"}

    # NEVER LABEL OVER A LIVE REVIEW HOLD. A duplicate supervisor can re-arm a PR to `review:pending` while
    # this function is mid-flight; stamping `ready-to-merge` on top then leaves a PR that carries a hold and a
    # clearance at once. The drain honours the hold, so the PR sits BLOCKED forever while reading as accepted.
    # A contradiction is worse than either label alone: it makes the PR unlandable AND invisible.
    lbl = subprocess.run(["gh", "pr", "view", str(pr), "--json", "labels", "--jq",
                          "[.labels[].name]|join(\",\")"], capture_output=True, text=True,
                         cwd=REPO).stdout
    if "review:pending" in lbl or "review:changes" in lbl:
        return f"held ({lbl.strip()}) — not labelling over a review hold"

    subprocess.run(["gh", "pr", "edit", str(pr), "--add-label", "ready-to-merge"],
                   capture_output=True, cwd=REPO)
    sh(["git", "-C", lp, "fetch", "origin", branch, "main"])
    subprocess.run(["git", "-C", lp, "reset", "--hard", f"origin/{branch}"], capture_output=True, env=env)
    r = subprocess.run(["git", "-C", lp, "rebase", "origin/main"], capture_output=True, text=True, env=env)
    if r.returncode != 0:
        # A conflict is a human's call, not something to force past. Leave the PR accepted and say so.
        subprocess.run(["git", "-C", lp, "rebase", "--abort"], capture_output=True, env=env)
        return "rebase-conflict"
    push = subprocess.run(["git", "-C", lp, "push", "--force-with-lease", "origin", f"HEAD:{branch}"],
                          capture_output=True, text=True, env=env)
    return "landable" if push.returncode == 0 else f"push-failed: {push.stderr.strip()[:80]}"


def heal_ci(pr, branch, lane):
    """Classify a `ci:failed` PR and act on it — never leave it silently accepted-but-blocked.

    `converge()`'s own `ready-to-merge + review:accepted -> hand to drain` early return fires on a ci:failed
    PR too, since it only checks those two labels. A PR can sit accepted, ci:failed and landable-looking with
    NOTHING downstream ever looking at CI again — stranded exactly like an unreviewed PR is before the
    r0-dispatch fix, same shape, different axis. The call site guard goes BEFORE that return, not inside it.

    ci:failed conflates two different things the same way a lost review verdict does: a REAL code failure
    (fix it) and a transient run failure (startup_failure / cancelled / timed_out — rerun it, a fix agent
    would find nothing to fix and either loop or invent scope). Classify from GitHub's own per-job
    `conclusion` field, not from log text — the log's wording is not a contract, the conclusion enum is.
    """
    checks = subprocess.run(
        ["gh", "pr", "checks", str(pr), "--repo", "web-everything/web-everything", "--json", "name,state,link"],
        capture_output=True, text=True, cwd=REPO).stdout
    try:
        rows = json.loads(checks)
    except (json.JSONDecodeError, ValueError):
        return "no-op (gh checks output unparseable — leaving as-is)"
    failing = [r for r in rows if r.get("state") == "FAILURE"]
    if not failing:
        # NOT A NO-OP — a stale label re-observed and left untouched is a real defect: a fixed-but-relabelled
        # PR can burn its whole round cap with `heal_ci` correctly diagnosing "stale" every round but never
        # ACTING on that diagnosis, so nothing ever removes the label. Confirming "stale" and then leaving it
        # is not a safe default here; the label is demonstrably wrong given every check passed.
        subprocess.run(["gh", "pr", "edit", str(pr), "--repo", "web-everything/web-everything",
                        "--remove-label", "ci:failed"], capture_output=True, text=True, cwd=REPO)
        return "cleared stale ci:failed (every check passed)"

    run_ids = set()
    for r in failing:
        m = re.search(r"/actions/runs/(\d+)/job/\d+", r.get("link") or "")
        if m:
            run_ids.add(m.group(1))
    if not run_ids:
        return "no-op (failing check has no parseable run id)"

    # TRANSIENT UNTIL PROVEN OTHERWISE, but proven from the job's own `conclusion`, not assumed from silence.
    transient = True
    for run_id in run_ids:
        out = subprocess.run(
            ["gh", "run", "view", run_id, "--repo", "web-everything/web-everything", "--json", "jobs"],
            capture_output=True, text=True, cwd=REPO).stdout
        try:
            job_rows = json.loads(out).get("jobs", [])
        except (json.JSONDecodeError, ValueError):
            transient = False
            continue
        for j in job_rows:
            if j.get("conclusion") not in (
                "success", "skipped", "startup_failure", "cancelled", "timed_out", None,
            ):
                transient = False

    if transient:
        for run_id in run_ids:
            subprocess.run(["gh", "run", "rerun", run_id, "--repo", "web-everything/web-everything", "--failed"],
                           capture_output=True, text=True, cwd=REPO)
        return f"transient (startup_failure/cancelled/timed_out) — reran {len(run_ids)} run(s)"

    st = run_agent(CI_HEAL.format(pr=pr, branch=branch, lane_path=os.path.join(LANES, f"lane-{lane}")),
                   lane, f"{pr}-ci-heal")
    return f"real failure — dispatched a fix agent — {st}"


def converge(pr):
    work_lane, jur_lane = PLAN[pr]
    branch = branch_of(pr)
    if not branch:
        emit(f"#{pr} FAILED: no branch")
        return
    cap = 99 if pr in UNCAPPED else ROUND_CAP
    for rnd in range(1, cap + 1):
        state = label_of(pr)
        # ONCE QUEUED, IT IS THE DRAIN'S. Re-running landability on every tick re-labels and force-pushes a
        # branch nobody changed — and on a ci-red PR it never terminates. This guard must live in the SHARED
        # converge(), not duplicated per call site — a fix applied in one place and left standing in another
        # is the same defect this loop exists to catch in a PR's own content, reproduced in its own code once.
        # CI:FAILED IS NOT COVERED BY ANY BRANCH BELOW — checked BEFORE the "hand to the drain" return, which
        # otherwise fires on ci:failed + review:accepted too (both labels present is a real, seen shape) and
        # abandons the PR permanently: nothing downstream of that return ever looks at CI again. Excludes
        # review:human — a human-gated PR is not this loop's to touch, CI or otherwise.
        # STALE `review:pending` SURVIVING AN ACCEPT — seen repeatedly: a retry review accepts and the tool
        # correctly refuses to label OVER a hold, so `review:accepted` and `review:pending` sit together and
        # the "hand to the drain" branch below never matches (it checks `ready-to-merge`, which nothing here
        # ever added while the hold stood). `--to=accepted` is `review-set-label.mjs`'s own sanctioned
        # resolution for exactly this contradiction — not a label edit invented here.
        if "review:accepted" in state and "review:pending" in state:
            r = subprocess.run(
                ["node", "scripts/review-set-label.mjs", str(pr), "--repo=web-everything/web-everything",
                 "--to=accepted"],
                capture_output=True, text=True, cwd=REPO)
            emit(f"#{pr} r{rnd}: cleared stale review:pending alongside an accept — {r.stdout.strip()[:120]}")
            continue
        if "ci:failed" in state and "review:human" not in state:
            st = heal_ci(pr, branch, PLAN[pr][0])
            emit(f"#{pr} r{rnd}: ci:failed — {st}")
            time.sleep(90)  # give the re-run/heal push time to reach a new Checks run before re-reading state
            continue
        if "ready-to-merge" in state and "review:accepted" in state:
            emit(f"#{pr} queued — handing to the drain, not re-converging")
            return
        if "MERGED" in state:
            emit(f"#{pr} LANDED (merged)")
            return
        if "review:accepted" in state or "ready-to-merge" in state:
            st = make_landable(pr, branch, PLAN[pr][0])
            emit(f"#{pr} ACCEPTED after {rnd - 1} round(s) — {state} — {st}")
            return
        if "review:changes" not in state:
            # NEVER dispatch a fixer with no findings to work from. A reviewer launched earlier may still be
            # running, so wait for it rather than racing it — and if it never lands a verdict, stop and say so
            # instead of spawning an agent that would invent work.
            emit(f"#{pr} r{rnd}: {state} — waiting for a verdict before dispatching anything")
            for _ in range(60):
                time.sleep(30)
                state = label_of(pr)
                if "review:pending" not in state:
                    break
            if "review:accepted" in state or "ready-to-merge" in state or "MERGED" in state:
                st = make_landable(pr, branch, PLAN[pr][0]) if "MERGED" not in state else "merged"
                emit(f"#{pr} ACCEPTED on the in-flight review — {state} — {st}")
                return
            if "review:changes" not in state:
                if "review:human" in state:
                    emit(f"#{pr} AWAITING A HUMAN — {state}. Terminal for this loop by design: an agent that "
                         f"stopped to ask must never be auto-restarted, or it re-asks forever.")
                else:
                    # A REVIEW THAT RECORDED NOTHING leaves the PR indistinguishable from unreviewed, and the
                    # fixer guard then refuses to act — correctly, there are no findings. Without this, the PR
                    # is stranded forever, because nothing re-reviews it either. Re-dispatch the REVIEW, never
                    # a fixer.
                    n_verdicts = subprocess.run(
                        ["gh", "pr", "view", str(pr), "--json", "comments", "--jq",
                         '[.comments[]|select(.body|test("[Vv]erdict"))]|length'],
                        capture_output=True, text=True, cwd=REPO).stdout.strip()
                    if "review:pending" in state and n_verdicts == "0":
                        emit(f"#{pr} r{rnd}: reviewed but NO verdict recorded — re-dispatching the review")
                        st = run_agent(REVIEW.format(pr=pr,
                                                     drv_path=os.path.join(LANES, f"lane-{PLAN[pr][0]}"),
                                                     juror_path=os.path.join(LANES, f"lane-{PLAN[pr][1]}")),
                                       PLAN[pr][0], f"{pr}-rev-r{rnd}retry")
                        emit(f"#{pr} r{rnd}: retry review {st} — label now {label_of(pr)}")
                        continue
                    emit(f"#{pr} STOPPED: still `{state}` after 30m — no findings to fix, not dispatching blind")
                return

        emit(f"#{pr} r{rnd}: dispatching FIX (lane-{work_lane})")
        st = run_agent(FIX.format(pr=pr, branch=branch,
                                  lane_path=os.path.join(LANES, f"lane-{work_lane}")),
                       work_lane, f"{pr}-fix-r{rnd}")
        emit(f"#{pr} r{rnd}: fix {st}")

        emit(f"#{pr} r{rnd}: dispatching REVIEW (driver lane-{work_lane}, juror lane-{jur_lane})")
        st = run_agent(REVIEW.format(pr=pr,
                                     drv_path=os.path.join(LANES, f"lane-{work_lane}"),
                                     juror_path=os.path.join(LANES, f"lane-{jur_lane}")),
                       work_lane, f"{pr}-rev-r{rnd}")
        emit(f"#{pr} r{rnd}: review {st} — label now {label_of(pr)}")

    # RE-READ BEFORE DECLARING FAILURE. The loop tests the label at the TOP of each iteration, so an accept
    # recorded by the FINAL round's review is never seen by it — control falls straight out of the `for` and
    # into this line. Escalation exists to spend a human's attention only when it is needed, so a false one is
    # the expensive kind of bug.
    final = label_of(pr)
    if "review:accepted" in final or "ready-to-merge" in final or "MERGED" in final:
        emit(f"#{pr} ACCEPTED on the final round ({ROUND_CAP}) — {final}")
        return
    emit(f"#{pr} ESCALATE: {cap} rounds without accept — the documented non-convergence case ({final})")


def main():
    if not PLAN:
        emit("converge: PLAN is empty — fill it in with {pr: (work_lane, juror_lane)} before running "
             "main(), or call converge(pr)/run_agent(...) directly for a one-off.")
        return
    threads = [threading.Thread(target=converge, args=(pr,), daemon=False) for pr in PLAN]
    emit(f"converge: supervising {len(threads)} PRs, round cap {ROUND_CAP}")
    for t in threads:
        t.start()
        time.sleep(2)
    for t in threads:
        t.join()
    emit("converge: all supervisors finished")


# GUARDED so this file can be imported. A PR opened AFTER a launch has no reviewer and no findings, and the
# `review:changes` guard correctly refuses to dispatch a fixer for it — which is right, and leaves the PR
# stranded unless something dispatches the FIRST review. `converge()` is that entry point.
if __name__ == "__main__":
    main()
