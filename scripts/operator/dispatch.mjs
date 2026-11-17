/**
 * dispatch.mjs — the load-bearing primitives from `we:scripts/operator/converge.py`, ported to Node (#3383).
 *
 * WHY A PORT, NOT A REWRITE. `converge.py` is a PROVEN PROTOTYPE (see its own header): one supervisor thread
 * per PR, spawning a headless `claude -p` FIX agent then an independent `claude -p` REVIEWER, reading the
 * label to decide the next round. It worked live across a full session. This file ports exactly the three
 * mechanisms everything else in the epic depends on — `run_agent`, the `FIX`/`REVIEW`/`CI_HEAL` prompts, and
 * `heal_ci` — leaving the per-PR state machine (`converge()`), landability (`make_landable()`) and the
 * `PLAN`/`main()` driver for a later chunk, same sequencing PR #1671 used for the drain's own auto-clear.
 *
 * WHY NODE, NOT PYTHON. Every command this dispatches (`merge-ai-prs.mjs`, `lane-drain.mjs`, `pr-land.mjs`,
 * `verify-lane.mjs`) is already Node. `converge.py` had to shell out to `node scripts/...` for all of it
 * instead of importing the real functions — and that indirection is exactly where PR #1671's first-round bug
 * came from: `repoFlag()`'s two-token `gh`-CLI shape re-derived from memory instead of calling the real
 * `--repo=` format `review-set-label.mjs` actually parses. A Node module in the same runtime as the code it
 * dispatches can import instead of re-deriving.
 *
 * INDEPENDENCE IS UNCHANGED FROM THE PROTOTYPE. `runAgent` spawns a real `claude -p` OS process — never the
 * Agent tool. An Agent-tool subagent inherits the parent's session id verbatim (#2413, and see
 * `we:scripts/lib/judge-spawn.mjs`'s header for the same fact from the juror side) and would hit the same
 * self-clear refusal (#2439) a fixer or reviewer dispatched from THIS session would. A `claude -p` subprocess
 * mints its own session id, which is what makes it a structurally distinct actor rather than a nominal one.
 *
 * WHAT THIS FILE DOES NOT DO. It does not decide WHICH PRs to work, does not read or write PR labels, does
 * not touch `main`. `runAgent` and `healCi` are called BY something that already knows the PR, the lane, and
 * why — same division of labour `converge.py` had between its `run_agent`/`heal_ci` primitives and its own
 * `converge()` state machine.
 */

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, statSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
// #3383 — the spawned session is a WORKER; a hook-driven tick-once must never run in it (see session-role.mjs).
import { markWorkerEnv } from '../operations/session-role.mjs';
// #landing-freeze-2779 — this file's own `claude` spawn below built its env straight off raw `process.env`,
// with no sanitize step — the same gap `detached-dispatch.mjs#defaultSpawnDetached`'s own docblock names in
// full (a static, daemon-minted `GH_TOKEN` riding along unchanged until it expires mid-session). See
// `../lib/gh-app-shim.mjs#sanitizeSpawnEnv`'s own docblock for why a stale value is worse than none.
import { sanitizeSpawnEnv } from '../lib/gh-app-shim.mjs';
// #xg790dh-follow-up (epic #3383/#4075) — the SAME declared hold-check list `we:scripts/progress-board.mjs#ciFailed`
// and `we:scripts/operations/pr-status.mjs` already use, reused here so `healCi`'s own "is anything really red"
// scan can never disagree with them by re-deriving an ad-hoc `state === 'FAILURE'` filter with no exclusion at
// all — see the call site below for the incident this closes.
import { CI_TRUTH_EXCLUDED_CHECKS } from '../operations/pr-status.mjs';

export const REPO = process.env.WE_REPO || '/Users/nicolasgilbert/workspace/webeverything';
export const LANES = process.env.WE_LANES || '/Users/nicolasgilbert/workspace/.lanes/web-everything';
export const SCRATCH = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

/**
 * `run_agent`'s own bound: 3600s (one hour), the prototype's default and the one this port keeps — see
 * `converge.py`'s own docstring for why a FIX/REVIEW round needs an hour, not `we:scripts/lib/judge-spawn.mjs`'s
 * 20-minute `JUDGE_TIMEOUT_MS` (a tool-free juror emitting one JSON verdict vs. a tool-bearing editor that
 * reads, edits, tests and pushes).
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 3600 * 1000;

/**
 * `run_agent`'s "a clean exit is not a done job" threshold (converge.py:176-189, ported verbatim): a log under
 * this many bytes means the agent exited having written a few dozen bytes of "I'll wait for the notification"
 * and never touched the branch. PURE so the heuristic is unit-testable without a real spawn.
 * @param {number} logSizeBytes
 * @returns {boolean}
 */
export function didAgentDoSomething(logSizeBytes) {
  return logSizeBytes > 400;
}

const laneDir = (lanesDir, lane) => join(lanesDir, `lane-${lane}`);

/**
 * `lease()`'s own parse of `lane-pool.mjs acquire`'s stderr (converge.py:91-110). PURE — the acquire call
 * itself is `leaseLane`, this is just the text extraction, so both are separately testable.
 * @param {string} stderrText
 * @returns {string|null} the holder slug, or null if the line isn't present (acquire failed or refused).
 */
export function parseHolderSlug(stderrText) {
  for (const line of String(stderrText).split('\n')) {
    if (line.includes('holder slug:')) {
      return line.split('holder slug:')[1].split('—')[0].trim();
    }
  }
  return null;
}

/**
 * A REAL `lane-pool.mjs acquire` lease before working in a lane — see `converge.py`'s `lease()` docstring for
 * why this must never be skipped (a workaround that outlived its reason once cost a live lane collision).
 * Best-effort: a failed acquire returns `null` and the caller proceeds unleased, reported via `onUnleased`
 * rather than thrown — refusing to dispatch is worse than dispatching unleased, but the hole must be visible.
 * @param {{lane:number|string, purpose:string, repo?:string, exec?:Function, onUnleased?:(msg:string)=>void}} o
 * @returns {string|null} the holder slug, or null.
 */
export function leaseLane({ lane, purpose, repo = REPO, exec = spawnSync, onUnleased }) {
  const r = exec('node', ['scripts/lane-pool.mjs', 'acquire', `--lane=${lane}`, `--purpose=${purpose}`, '--no-reset'],
    { cwd: repo, encoding: 'utf8' });
  const slug = parseHolderSlug(r.stderr || '');
  if (slug) return slug;
  if (onUnleased) onUnleased(`lane-${lane}: acquire failed, working UNLEASED — ${String(r.stderr || '').trim().slice(0, 90)}`);
  return null;
}

/** Mirror of `unlease()` — a no-op release when there was no lease (acquire failed or was skipped). */
export function unleaseLane({ lane, slug, repo = REPO, exec = spawnSync }) {
  if (!slug) return;
  exec('node', ['scripts/lane-pool.mjs', 'release', `--lane=${lane}`, `--session=${slug}`], { cwd: repo });
}

/**
 * FIX agent prompt — `converge.py`'s `FIX` template, ported verbatim (the field names change from `{pr}` /
 * `{lane_path}` / `{branch}` to template-literal interpolation; the prose is unchanged, since it is exactly
 * what was proven live, not something this port gets to improve on rewrite).
 */
export function buildFixPrompt({ pr, branch, lanePath }) {
  return `You are a FIX agent for pull request #${pr} in \`web-everything/web-everything\`. You did not review it; your
job is to address the review that bounced it, and nothing else.

## Your lane

Work in \`${lanePath}\` and nowhere else. Put the PR's branch there first:

\`\`\`
cd ${lanePath}
git fetch origin ${branch}
LANE_SESSION=conv-${pr} git reset --hard FETCH_HEAD
\`\`\`

Never edit the primary checkout — a committed hook denies it.

## Read the findings

\`\`\`
gh pr view ${pr} --json comments --jq '.comments[-1].body'
\`\`\`

Some PRs carry TWO comments: one the \`review-pr\` operation posted rendering the JUROR's verdict, and one the
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

\`\`\`
node scripts/pr-body-edit.mjs --pr=${pr} --body-file=<file>     # NOT \`gh pr edit --body\`, which drops a stamp
gh pr edit ${pr} --title "..."
\`\`\`

When you edit the body with a script, **verify the edit actually landed** (\`gh pr view ${pr} --json body\`).
A previous round's body edit failed silently and was reported as done.

## DO NOT BUNDLE A STRANDED-HASH HEAL

If \`check:standards\` reports stranded-hash errors for cards you did not touch, **leave them**. They read from
\`origin/main\`, so they error for everyone until a heal lands on main — you cannot clear them from a branch,
and a local fix helps nobody.

More importantly: \`number-stranded\` rewrites citations in \`we:docs/agent/platform-decisions.md\`. Bundling it
turns your PR into a **statute edit**, which draws \`review:human\` and parks a one-card change waiting for a
person, over a mechanical rename. The drain heals these after landing. Say in your PR body that the strays
are pre-existing and were deliberately not bundled.

## COMMIT AS YOU GO — you may be killed without warning

You have a wall-clock budget and you will not be told when it runs out. A previous fixer on a large PR was
killed at the limit and lost three new fixtures, a new test and four edited modules, because the NEXT round
opens with \`git reset --hard\`. Commit each coherent piece as you complete it rather than saving one commit
for the end. An extra commit costs nothing; a lost hour costs an hour.

If the work is large, push partial progress too — a bounced PR with half the findings fixed is strictly
better than one with none.

## Finish

- **Never read \`check:standards\` through a pipe.** \`... | tail -1\` or \`| grep\` gives you the exit code of
  \`tail\`/\`grep\`, not the gate — a red gate then reads as success. Run it plainly, or redirect to a file and
  grep the file. The printed count is trustworthy; a piped exit status is not.
- **Run it TWICE and report both.** The backlog loader is non-deterministic when any card is malformed, so a
  single reading is not evidence.
- \`npm run check:standards\` must show no new errors and no new warnings vs this lane's \`main\`. Measure the
  baseline yourself; it may have moved since you started, so do not trust a number written on a card.
- If the PR touches tests, run them.
- Commit with a message that states, per finding, what was wrong and what the check now says.
- \`git push origin HEAD:${branch}\`

Report: which findings you addressed, which you did not and why, and the commit sha.
`;
}

/** CI_HEAL agent prompt — `converge.py`'s `CI_HEAL` template, ported verbatim. */
export function buildCiHealPrompt({ pr, branch, lanePath }) {
  return `You are healing a REAL CI FAILURE on pull request #${pr} in \`web-everything/web-everything\`. Its review
already ACCEPTED this diff's content — do not re-review it, do not second-guess the accepted changes. Your
job is narrow: make the failing CI check pass, and nothing else.

## Your lane

Work in \`${lanePath}\` and nowhere else. Put the PR's branch there first:

\`\`\`
cd ${lanePath}
git fetch origin ${branch}
LANE_SESSION=conv-${pr} git reset --hard FETCH_HEAD
\`\`\`

## What actually failed

\`\`\`
gh pr checks ${pr} --repo web-everything/web-everything
\`\`\`

For the failing check, read its real log — not a guess:

\`\`\`
gh run view --job=<the failing job id from the checks output> --repo web-everything/web-everything --log-failed
\`\`\`

## Fix ONLY what the log says is wrong

A stale generated file (inventory, snapshot, lockfile) is the common case — regenerate it with whatever
script the error names and commit the regenerated file. A real test failure means the diff broke something;
fix the diff, not the test, unless the test itself is provably wrong (state why if so).

Do NOT touch anything the accepted review did not ask you to touch. This is a CI heal, not a second review
round — widening scope here is exactly the kind of drive-by edit that costs an extra round.

## Verify before pushing

Run the same check locally that failed in CI (\`npm run check:standards\`, \`npm run test:unit\`, whichever the
failing job ran) and confirm it is green BEFORE pushing — never read a gate through a pipe (\`| tail -1\` /
\`| grep\` reports the pipe's exit code, not the gate's) — and never push and hope CI re-run agrees with you.

## Finish

\`\`\`
git add <only the files you changed>
git commit -m "ci-heal: <what was stale/broken and what you did>"
git push origin HEAD:${branch}
\`\`\`

Report the failing check's name, what was actually wrong, and the commit sha.
`;
}

/** REVIEW agent prompt — `converge.py`'s `REVIEW` template, ported verbatim. */
export function buildReviewPrompt({ pr, drvPath, jurorPath }) {
  return `You are an INDEPENDENT reviewer for pull request #${pr} in \`web-everything/web-everything\`. You did not
write it and you did not fix it — those were other sessions.

Run the declared operation, not a procedure of your own. Read \`skills-src/review/SKILL.md\`, then:

\`\`\`
node scripts/operations/run.mjs review-pr --pr=${pr} --repo=web-everything/web-everything --cwd=${jurorPath} --json
\`\`\`

\`--cwd\` is the juror's own lane and is REQUIRED. You work in \`${drvPath}\`. The operation has a \`confirm\`
step — resume it with \`--resume=<run-id> --answer=<verdict>\` once you have satisfied yourself the juror's
findings are real. Note the juror frequently returns \`accept\` on PRs that have real defects in their
DESCRIPTION rather than their code; overriding it is normal and expected.

## THIS IS A ONE-SHOT PROCESS — YOU CANNOT COME BACK LATER

If \`review-pr\` reports its gate step is running in the background, you do NOT get a later turn to check on
it. "I will wait for the notification" or "I will pick this up later" both mean the review never completes —
this is a real, reproduced failure mode, not a hypothetical one (see \`#3381\`). Whether to block, poll, or
resume on a backgrounded gate is mechanical, not a judgment call: POLL IN THIS TURN. Run \`sleep 20\` via Bash,
then re-check/resume, in a loop, inside this one turn, until the gate finishes or a hard timeout (10 minutes)
is reached. Do not end your turn while the gate is still running.

## READ THE TOUCH-SET FIRST — it decides the lenses, not you

\`gh pr view ${pr} --json files\` before anything else. What the diff touches decides how it is reviewed, and
that decision cannot be made inside the operation: the step list is fixed at registration, before any PR is
read. It is the caller's job — yours.

| the diff touches | what to run |
| --- | --- |
| \`we:docs/agent/platform-decisions.md\`, a leash, any cite-able cluster rule | omit \`--lens\`, and **say in your write-up that only \`correctness\` ran** — see the warning below |
| code (\`scripts/\`, \`skills-src/\`, \`src/\`) | omit \`--lens\`, so the mandatory pair (correctness + security) both seat |
| backlog cards / docs only | \`--lens=correctness\` is fine — a security juror on a markdown card is spend for nothing |

## DO NOT FORCE A LENS WHEN THE DIFF TOUCHES A STATUTE OR A LEASH

Check the changed files FIRST. If the diff touches \`we:docs/agent/platform-decisions.md\`, any leash, or any
other cite-able cluster rule, **omit \`--lens\` entirely** and let the operation's care model choose the panel.
A statute touch is maximum care by rule: full panel, more than one juror.

## RECORDING THE VERDICT IS THE DELIVERABLE — do not exit without it

A review that produces findings and records nothing is worse than useless: the PR is left labelled
\`review:pending\`, indistinguishable from never having been reviewed, so the next pass spends a full run
rediscovering the same things. **Do not exit while the juror is still running. Wait for it** (see the polling
instruction above). If it will not return inside the hard timeout, record YOUR verdict with your own findings
and say the juror did not complete — a verdict with a stated gap is worth far more than an unrecorded one.
Your analysis is not the product; the verdict on the PR is.

## Triage the previous round explicitly

\`\`\`
gh pr view ${pr} --json comments --jq '.comments[-1].body'
\`\`\`

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

1. Open every \`file:line\` the PR or its cards cite. Run every count they state. Do not accept a number
   because it is written down.
2. A citation pointing at a real line is not the same as the conclusion drawn from it holding.
3. Where the PR touches tests, run them and try a mutation that SHOULD redden a named case.
4. If nothing is blocking, record \`accept\` — do not manufacture findings. Equally, do not accept a PR whose
   description asserts something its diff does not do.
5. A CONFIRMED finding owes a prevention; say whether one is filed.

Report the verdict and the run id.
`;
}

/**
 * `run_agent(prompt, lane, tag, timeout=3600, verify=None)`, ported. One headless `claude -p` agent, its own
 * process (its own session id — see the header's INDEPENDENCE note). Claims the lane on disk for the
 * duration (`converge.py`'s own reasoning for why: attribution used to be inferred from git branch ancestry,
 * which is wrong for a REVIEWER whose lane sits at `main` and never checks the PR out).
 *
 * @param {object} o
 * @param {string} o.prompt - the agent's instruction (a `buildFixPrompt`/`buildReviewPrompt`/`buildCiHealPrompt`).
 * @param {number|string} o.lane - the lane number to work/claim in.
 * @param {string} o.tag - `<pr>-fix-r<n>` / `<pr>-rev-r<n>` / `<pr>-ci-heal`; `tag.split('-')[0]` must be the PR
 *   number when the PR-liveness re-check applies (skip it by passing a non-numeric first segment).
 * @param {number} [o.timeoutMs] - wall-clock kill bound; default {@link DEFAULT_AGENT_TIMEOUT_MS} (one hour).
 * @param {() => boolean} [o.verify] - the caller's own post-condition, checked against the world rather than
 *   the agent's say-so.
 * @param {string} [o.repo] - the primary checkout, for `gh`/`lane-pool.mjs` calls.
 * @param {string} [o.lanesDir] - where lane clones live.
 * @param {string} [o.scratchDir] - where the log and claim files are written.
 * @param {Function} [o.spawnFn] - injectable `child_process.spawn`, for tests.
 * @param {Function} [o.execFn] - injectable `child_process.spawnSync`, for `gh`/lane-pool/git calls.
 * @param {(msg:string)=>void} [o.emit] - progress line sink; defaults to a no-op (the caller decides how to surface it).
 * @param {string[]} o.disallowedTools - REQUIRED, non-empty. `Bash(<prefix>:*)`-shaped deny patterns baked into
 *   the spawned session's own argv via `--disallowedTools`. No default: this function has no live caller today
 *   and must never get one without a caller-chosen, role-appropriate list — see the guard inside the function
 *   body for the full reasoning (it is NOT `review-dispatch.mjs`'s list; that one would break this function's
 *   own FIX/CI_HEAL/REVIEW roles).
 * @returns {Promise<string>} a status string: `'ok'` / `'no-op (...)'` / `'unverified (...)'` / `'exit<N>'` /
 *   `'timeout(work stashed)'` / `'skipped (<STATE>)'`.
 */
export async function runAgent({
  prompt, lane, tag, timeoutMs = DEFAULT_AGENT_TIMEOUT_MS, verify,
  repo = REPO, lanesDir = LANES, scratchDir = SCRATCH,
  spawnFn = nodeSpawn, execFn = spawnSync, emit = () => {},
  disallowedTools,
}) {
  // GUARD (2026-09-19): this function hardcodes `--permission-mode bypassPermissions` below with the caller's
  // full trust — no sandbox, no lane-scoped restriction of its own. It has NO LIVE CALLER TODAY (see this
  // file's own header: the `converge()` state machine / `PLAN`/`main()` driver is explicitly future work), and
  // it MUST NEVER get one without an explicit, role-appropriate tool deny list — the standing lesson in
  // `we:agent-memory-src/scoped-approval-beats-global-bypass.md` (a scoped deny-list beats a global bypass) and
  // the worked precedent in `we:scripts/operations/review-dispatch.mjs`'s `REVIEW_DISPATCH_DISALLOWED_TOOLS`.
  // DO NOT default this to that list or import it: this function serves THREE different roles (see
  // `buildFixPrompt`/`buildCiHealPrompt`/`buildReviewPrompt` in this file) with different legitimate `gh`/
  // `run.mjs` needs — the FIX role calls `gh pr edit --title`, CI_HEAL calls `gh pr checks`/`gh run view`/`gh
  // run rerun`, and the REVIEW role calls `node scripts/operations/run.mjs review-pr ... --answer=<verdict>` as
  // ITS OWN sanctioned mechanism — `review-dispatch.mjs`'s wholesale `gh:*`/`run.mjs:*` ban would break every
  // one of them. Whoever wires a live caller must design a per-role list; this guard only makes skipping that
  // step impossible.
  if (
    !Array.isArray(disallowedTools) || disallowedTools.length === 0
    || disallowedTools.some((t) => typeof t !== 'string' || !t.trim())
  ) {
    throw new TypeError(
      'runAgent: `disallowedTools` is REQUIRED — a non-empty array of `Bash(<prefix>:*)`-shaped deny patterns '
      + '(the same shape `we:.claude/settings.json` and `we:scripts/operations/review-dispatch.mjs#'
      + 'REVIEW_DISPATCH_DISALLOWED_TOOLS` use). This spawns `claude -p --permission-mode bypassPermissions` '
      + 'with full trust and no sandbox; refusing to do that with zero tool restriction. See this function\'s '
      + 'own comment for why the list must be role-specific, not copied from review-dispatch.mjs.',
    );
  }
  const prId = tag.split('-')[0];
  if (/^\d+$/.test(prId)) {
    const st = execFn('gh', ['pr', 'view', prId, '--json', 'state', '--jq', '.state'],
      { cwd: repo, encoding: 'utf8' }).stdout?.trim();
    if (st === 'MERGED' || st === 'CLOSED') {
      emit(`#${prId}: ${st} — not dispatching ${tag}, the PR is gone`);
      return `skipped (${st})`;
    }
  }

  const lanePath = laneDir(lanesDir, lane);
  const logPath = join(scratchDir, `conv-${tag}.log`);
  const claimPath = join(scratchDir, `.worker-lane-${lane}.json`);
  const slug = leaseLane({ lane, purpose: `conv-${tag}`, repo, exec: execFn, onUnleased: emit });

  const logFd = openSync(logPath, 'w');
  let child;
  try {
    child = spawnFn('claude', [
      '-p', '--permission-mode', 'bypassPermissions',
      `--disallowedTools=${disallowedTools.join(',')}`,
      prompt,
    ], {
      cwd: lanePath, stdio: ['ignore', logFd, logFd], detached: true, env: markWorkerEnv(sanitizeSpawnEnv(process.env)),
    });
    writeFileSync(claimPath, JSON.stringify({
      pr: prId, role: tag.includes('-rev-') ? 'rev' : 'fix', pid: child.pid, lane, tag,
    }));

    const { code, timedOut } = await new Promise((resolvePromise) => {
      let timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      child.on('close', (c) => { clearTimeout(timer); resolvePromise({ code: c, timedOut: c === null }); });
      child.on('error', () => { clearTimeout(timer); resolvePromise({ code: -1, timedOut: false }); });
    });

    if (timedOut) {
      // SALVAGE BEFORE THE NEXT ROUND RESETS THE LANE — every fix brief opens with `reset --hard`, so a
      // timed-out fixer's uncommitted work is destroyed by its own successor, silently, unless it is stashed
      // first (converge.py:160-167; work has been lost this way and recovered by hand once already).
      execFn('git', ['-C', lanePath, 'stash', 'push', '-u', '-m', `salvaged from timed-out ${tag}`],
        { env: { ...process.env, LANE_SESSION: 'salvage' } });
      return 'timeout(work stashed)';
    }
    if (code !== 0) return `exit${code}`;

    const didSomething = existsSync(logPath) ? didAgentDoSomething(statSync(logPath).size) : false;
    if (!didSomething) return 'no-op (agent exited without working — see the log)';
    if (verify && !verify()) {
      return 'unverified (agent finished but the outcome it was sent to produce is absent)';
    }
    return 'ok';
  } finally {
    try { unlinkSync(claimPath); } catch { /* already gone, or never written */ }
    unleaseLane({ lane, slug, repo, exec: execFn });
    try { closeSync(logFd); } catch { /* already closed */ }
  }
}

/**
 * `heal_ci`'s classification step, extracted PURE: given the `jobs` GitHub reports for the failing check's
 * run(s), is this failure TRANSIENT (retry, no fix needed) or REAL (a fix agent has something to do)?
 * Classified from the job's own `conclusion` enum, never log text — the log's wording is not a contract, the
 * conclusion enum is (converge.py:497-499).
 * @param {Array<{conclusion?: string|null}>} jobRows
 * @returns {boolean} true iff every job's conclusion is one that never needed a code fix.
 */
export function isTransientCiFailure(jobRows) {
  const okConclusions = new Set(['success', 'skipped', 'startup_failure', 'cancelled', 'timed_out']);
  return jobRows.every((j) => j.conclusion == null || okConclusions.has(j.conclusion));
}

/**
 * Extract GitHub Actions run ids from `gh pr checks --json name,state,link`'s `link` field for the FAILING
 * rows — `converge.py`'s regex, ported verbatim. Pure.
 * @param {Array<{state?: string, link?: string}>} checkRows
 * @returns {string[]} deduplicated run ids, in first-seen order.
 */
export function runIdsFromFailingChecks(checkRows) {
  const ids = [];
  for (const row of checkRows) {
    if (row.state !== 'FAILURE') continue;
    const m = /\/actions\/runs\/(\d+)\/job\/\d+/.exec(row.link || '');
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/**
 * `heal_ci(pr, branch, lane)`, ported. Classifies a `ci:failed` PR and acts on it: clears a stale label if
 * every check is actually green, reruns transient failures, or dispatches a `CI_HEAL` fix agent for a real
 * one. See `converge.py`'s own docstring for why the call site guard (this must run BEFORE the
 * "ready-to-merge + review:accepted → hand to the drain" early return) matters — that ordering bug is
 * `#3382`'s subject and is NOT this function's job to fix; this is the mechanism the next chunk wires in.
 * @param {object} o
 * @param {number|string} o.pr
 * @param {string} o.branch
 * @param {number|string} o.lane
 * @param {string} [o.repo]
 * @param {Function} [o.execFn] - injectable `child_process.spawnSync`.
 * @param {typeof runAgent} [o.runAgentFn] - injectable, so a real fix dispatch is not required to test this.
 * @returns {Promise<string>} a status string describing what was found and done.
 */
export async function healCi({ pr, branch, lane, repo = REPO, execFn = spawnSync, runAgentFn = runAgent }) {
  const checksOut = execFn('gh', ['pr', 'checks', String(pr), '--repo', 'web-everything/web-everything',
    '--json', 'name,state,link'], { cwd: repo, encoding: 'utf8' }).stdout;
  let rows;
  try {
    rows = JSON.parse(checksOut);
  } catch {
    return 'no-op (gh checks output unparseable — leaving as-is)';
  }
  // #xg790dh-follow-up — LIVE INCIDENT 2026-09-26, PRs #2748/#2749/#2753 (web-everything/web-everything): `review-gate`
  // (`we:.github/workflows/review-gate.yml` + `we:scripts/check-review-gate.mjs`) is BY DESIGN red for as long
  // as `review:pending`/`review:human`/`review:changes` stands — that is its whole job, not a code-health signal
  // — yet a plain `state === 'FAILURE'` scan with no exclusion counted it as a real failure: `failing.length`
  // was never 0 on a PR merely awaiting review, so the stale-label clear below (the ONE thing this function
  // exists to do first) never ran, and the function fell through toward dispatching a CI_HEAL fix agent at a
  // PR with nothing actually broken. Excluding {@link CI_TRUTH_EXCLUDED_CHECKS} matches the SAME exclusion
  // `we:scripts/progress-board.mjs#ciFailed` and `we:scripts/operations/pr-status.mjs` already apply — one
  // declared list, reused here rather than a THIRD ad-hoc re-derivation of "which checks are hold-only".
  const failing = rows.filter((r) => r.state === 'FAILURE' && !CI_TRUTH_EXCLUDED_CHECKS.includes(String(r?.name ?? '')));
  if (failing.length === 0) {
    // NOT A NO-OP — a stale label re-observed and left untouched can burn a whole round budget re-diagnosing
    // "stale" without ever clearing it (converge.py:509-515).
    execFn('gh', ['pr', 'edit', String(pr), '--repo', 'web-everything/web-everything', '--remove-label', 'ci:failed'],
      { cwd: repo, encoding: 'utf8' });
    return 'cleared stale ci:failed (every check passed)';
  }

  const runIds = runIdsFromFailingChecks(failing);
  if (runIds.length === 0) return 'no-op (failing check has no parseable run id)';

  let transient = true;
  for (const runId of runIds) {
    const out = execFn('gh', ['run', 'view', runId, '--repo', 'web-everything/web-everything', '--json', 'jobs'],
      { cwd: repo, encoding: 'utf8' }).stdout;
    let jobRows;
    try {
      jobRows = JSON.parse(out).jobs || [];
    } catch {
      transient = false;
      continue;
    }
    if (!isTransientCiFailure(jobRows)) transient = false;
  }

  if (transient) {
    for (const runId of runIds) {
      execFn('gh', ['run', 'rerun', runId, '--repo', 'web-everything/web-everything', '--failed'],
        { cwd: repo, encoding: 'utf8' });
    }
    return `transient (startup_failure/cancelled/timed_out) — reran ${runIds.length} run(s)`;
  }

  const lanePath = laneDir(LANES, lane);
  const st = await runAgentFn({
    prompt: buildCiHealPrompt({ pr, branch, lanePath }), lane, tag: `${pr}-ci-heal`, repo,
  });
  return `real failure — dispatched a fix agent — ${st}`;
}
