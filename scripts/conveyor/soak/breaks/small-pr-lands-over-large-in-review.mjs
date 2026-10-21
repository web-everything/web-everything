/**
 * @file breaks/small-pr-lands-over-large-in-review.mjs — #4308 (land-time complement of #4295; ratified
 * decision #4307 Fork 1 A; live incident 2026-09-27, PR #2821/#2826 — see backlog #4308's own "Evidence").
 *
 * LIVE INCIDENT (recap). #2821 (`lane/fix-procedure`, 20 files, +1807/-118) sat in review while smaller PRs
 * touching the SAME files landed under it: #2826 merged (touching `we:scripts/conveyor/review-status-tag.mjs`)
 * while #2821 was mid-review, immediately conflicting it (`merge-status:conflicting`) — a fixer round, a full
 * CI run and a fresh review round, twice in one day. Nothing at LAND time looked at overlap between an
 * already-open, in-review PR and a smaller ready one; #4295 only coordinates DISPATCH through the daemons' own
 * claim stores, and #2821/#2826 were orchestrator-dispatched (never went through them).
 *
 * FIX: `we:scripts/conveyor/land-overlap-yield.mjs` (`overlapYieldWaits`), wired into
 * `we:scripts/merge-ai-prs.mjs#planLabelDrain` as one more `waitOn` source (`overlap-yield:#<pr>`) — a ready PR
 * X HOLDS for a bounded, non-renewable window (settings-driven, `we:scripts/drain-overlap-yield-config.json`,
 * on by default) while a LARGER PR Y sharing a changed file is open, in review, on the same base.
 *
 * POLICY: `drain.overlapYieldRequiresLandable` now defaults ON. An in-review PR without readiness is no
 * longer a yield target. The default-policy scenario checks that S lands while L remains in review; the
 * original two #4308 scenarios explicitly opt OUT of this policy to retain their ordering and budget proofs.
 *
 * SCENARIOS: the real `drain` pass daemon
 * (`sim/daemon-host.mjs#PASS_DAEMONS.drain` — the real `scripts/merge-ai-prs.mjs --label=ready-to-merge`
 * spawned once per tick) against the fake GitHub. Large PR L and small PR S both touch `overlap/shared.md`; S
 * opens `ready-to-merge` + `review:accepted` (an automation-authored `reviewed-sha` marker for its head); L
 * opens `review:pending` only (never ready). Both scenarios observe the COMPUTED `mergeStateStatus` from the
 * fake GitHub (never the label) — the same up-to-date rule the live incident actually hit.
 *   (i) L LANDS WITHIN THE WINDOW: at round 2 (well inside the 45-minute default window — 3 sim-minutes/round),
 *       L's review clears (`review:pending` → `ready-to-merge` + `review:accepted`, mirroring a human `/review`
 *       accept). RED (pre-#4308): the drain lands S on tick 1, oblivious to L — when L is later cleared it
 *       reads BEHIND (`large-pr-conflicted`). GREEN: S defers (`overlap-yield:#<L>`) until L lands clean, then
 *       S is released and lands too — S's own resulting conflict, if any, is a separate, allowed cost.
 *   (ii) BUDGET RUNS OUT: L never clears review for the whole run (16+ rounds, 45+ sim-minutes). RED: S lands on
 *       tick 1 exactly as if L did not exist (no yield mechanism to observe at all — vacuous, not a pass).
 *       GREEN: S defers, then is RELEASED once its own budget elapses and lands anyway — L becoming CONFLICTING
 *       afterwards (main having moved) is the documented, accepted cost (#4308 "What it does and does not buy").
 * A `scenario-ran` check (in `judge`) requires BOTH branches to have actually exercised the yield (an
 * `overlap-yield:` log line observed), never just "eventually merged" — that alone would also be true, coincidentally, with the feature entirely absent.
 *
 * BASELINE (RED, pre-#4308): `origin/main` at 9f7dd3d3e (2026-09-28, "drain: mark card 4371 resolved on land"),
 * this break's own two files (this module + its `.soak.test.mjs`) applied with NO other #4308 change —
 * `node scripts/conveyor/soak/run.mjs break small-pr-lands-over-large-in-review` exits 1 on both scenarios
 * (`large-pr-conflicted` on (i); `vacuous` on (ii), since the mechanism does not exist yet to observe).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSoak } from '../soak.mjs';

const LABELS_READY = ['ready-to-merge', 'review:accepted'];
const LABELS_IN_REVIEW = ['review:pending'];
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const SHARED_FILE = 'overlap/shared.md';
const LARGE_LINES = 400; // total changed lines — comfortably bigger than the small PR's few lines (rule 3)

function bigContent(n) {
  return `${Array.from({ length: n }, (_, i) => `line ${i}\n`).join('')}`;
}

/** Push a branch off `main` carrying ONE commit with the Claude co-author trailer (the drain's AI-authorship
 *  gate reads it off the commit body) — mirrors `couple-split-by-unrelated-merge.mjs`'s own helper. */
function pushAiBranch(originPath, branch, files) {
  const work = mkdtempSync(join(tmpdir(), 'soak-overlap-'));
  const g = (args) => execFileSync('git', args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  try {
    execFileSync('git', ['clone', '--quiet', originPath, work], { stdio: ['ignore', 'pipe', 'pipe'] });
    g(['checkout', '-q', '-b', branch, 'origin/main']);
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, name)), { recursive: true });
      writeFileSync(join(work, name), content, 'utf8');
    }
    g(['add', '-A']);
    g(['-c', 'user.email=agent@example.com', '-c', 'user.name=Lane Agent', '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', `feat: ${branch}\n\n${TRAILER}`]);
    g(['push', '-q', 'origin', `HEAD:${branch}`]);
    return g(['rev-parse', 'HEAD']).trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function openReadyPr(w, head, sha) {
  const n = w.gh.openPr({ repo: 'we', head, title: `small: ${head}`, body: 'the small, ready PR', labels: LABELS_READY });
  w.gh.comment('we', n, `review:accepted\n\n<!-- reviewed-sha: ${sha} -->`);
  return n;
}

function openInReviewPr(w, head) {
  return w.gh.openPr({ repo: 'we', head, title: `large: ${head}`, body: 'the large, still-in-review PR', labels: LABELS_IN_REVIEW });
}

/** Seed the large (in review) + small (ready) pair sharing `SHARED_FILE`; returns their PR numbers. */
function seedPair(w) {
  const we = w.repos.we.originPath;
  execFileSync('git', ['config', 'user.name', 'GitHub'], { cwd: we });
  execFileSync('git', ['config', 'user.email', 'noreply@github.com'], { cwd: we });
  pushAiBranch(we, 'lane/xovl001-large', { [SHARED_FILE]: bigContent(LARGE_LINES) }); // L's own head sha isn't needed until it later goes ready-to-merge (round 2's perRound reads it fresh via w.gh.pr)
  const l = openInReviewPr(w, 'lane/xovl001-large');
  // Independent content (both branch off `main`, where the file does not exist yet) — a genuinely SMALL diff,
  // never a superset/subset of L's, so a real GitHub would show BOTH adding the same new path (the live
  // #2821/#2826 shape: unrelated commits touching the same file, not a stacked edit of one another).
  const sSha = pushAiBranch(we, 'lane/xovl002-small', { [SHARED_FILE]: 'small tweak\n' });
  const s = openReadyPr(w, 'lane/xovl002-small', sSha);
  return { l, s };
}

/** Did any `drain` tick's captured log carry an `overlap-yield:` defer line naming candidate PR `num` (as its
 *  `<repo>#<num>` subject — the repo prefix is whatever slug this pass's own `REPOS` resolution used, which the
 *  scenario does not control, so this matches on the number alone, not a hardcoded repo string)? */
function sawYieldLog(report, num) {
  const re = new RegExp(`overlap-yield: \\S*#${num} yields to`);
  return report.ticks.some((t) => t.daemon === 'drain' && (t.logs || []).some((l) => re.test(String(l))));
}

function state(w, repo, num) {
  return w.gh.pr(repo, num)?.state;
}

async function runDefaultPolicy({ log }) {
  let outcome = null;
  const report = await runSoak({
    name: 'break:small-pr-lands-over-large-in-review:default-policy',
    rounds: 3,
    daemons: ['drain'],
    mainEvery: 0,
    fleet: false,
    scorecards: false,
    setup(w) {
      // Exercise the code default even if the invoking shell has an operator override.
      delete w.env.WE_DRAIN_OVERLAP_YIELD_REQUIRES_LANDABLE;
      return seedPair(w);
    },
    perRound(w, round, ctx) {
      // L never clears review. Observe S after two ticks, well before its 45-minute budget could expire.
      if (round === 2) outcome = { s: state(w, 'we', ctx.s), l: state(w, 'we', ctx.l) };
    },
    log,
  });
  const sawDefaultPolicy = report.ticks.some((t) => t.daemon === 'drain'
    && (t.logs || []).some((line) => String(line).includes('drain.overlapYieldRequiresLandable=on (source: default)')));
  return { report, outcome, sawYield: sawYieldLog(report, report.ctx?.s ?? -1), sawDefaultPolicy };
}

async function runWithinWindow({ log }) {
  let outcome = null;
  const report = await runSoak({
    name: 'break:small-pr-lands-over-large-in-review:within-window',
    rounds: 6,
    daemons: ['drain'],
    mainEvery: 0,
    fleet: false,
    scorecards: false,
    env: { WE_DRAIN_OVERLAP_YIELD_REQUIRES_LANDABLE: '0' },
    setup: seedPair,
    perRound(w, round, ctx) {
      // Round 2's perRound runs BEFORE that round's drain tick — well inside the 45-minute default window
      // (2 rounds x 3 sim-minutes/round = 6 minutes elapsed) — a human `/review` accept on the large PR.
      if (round === 2) {
        w.gh.removeLabels('we', ctx.l, ['review:pending']);
        w.gh.addLabels('we', ctx.l, ['ready-to-merge']);
        w.gh.comment('we', ctx.l, `review:accepted\n\n<!-- reviewed-sha: ${w.gh.pr('we', ctx.l).headRefOid} -->`);
        w.gh.addLabels('we', ctx.l, ['review:accepted']);
      }
      if (round === 5) {
        const lPr = w.gh.pr('we', ctx.l);
        outcome = { l: lPr?.state, lMergeState: lPr?.mergeStateStatus, s: state(w, 'we', ctx.s) };
      }
    },
    log,
  });
  return { report, outcome, sawYield: sawYieldLog(report, report.ctx?.s ?? -1) };
}

async function runBudgetExpires({ log }) {
  let outcome = null;
  const report = await runSoak({
    name: 'break:small-pr-lands-over-large-in-review:budget-expires',
    rounds: 17, // 17 x 3 sim-minutes = 51 minutes — comfortably past the 45-minute default window
    daemons: ['drain'],
    mainEvery: 0,
    fleet: false,
    scorecards: false,
    env: { WE_DRAIN_OVERLAP_YIELD_REQUIRES_LANDABLE: '0' },
    setup: seedPair,
    perRound(w, round, ctx) {
      // L NEVER clears review this whole run — the budget-expiry path is the only way S can ever land.
      if (round === 16) outcome = { s: state(w, 'we', ctx.s), l: state(w, 'we', ctx.l) };
    },
    log,
  });
  return { report, outcome, sawYield: sawYieldLog(report, report.ctx?.s ?? -1) };
}

export default {
  id: 'small-pr-lands-over-large-in-review',
  title: 'the drain applies the landable-target policy and preserves bounded overlap-yield when opted out',
  card: 'backlog #4308 (drain-overlap-yield-landing-order, decision #4307; live incident 2026-09-27, PR #2821/#2826)',
  fixedBy: { sha: 'PENDING-fill-in-at-land — see this file’s own header for the RED-side baseline sha', where: 'main', paths: ['scripts/conveyor/land-overlap-yield.mjs', 'scripts/merge-ai-prs.mjs'] },
  fixPresent(root) {
    try {
      return /computeOverlapContext\(/.test(readFileSync(join(root, 'scripts/merge-ai-prs.mjs'), 'utf8'));
    } catch { return false; }
  },
  async run({ log } = {}) {
    const defaultPolicy = await runDefaultPolicy({ log });
    const withinWindow = await runWithinWindow({ log });
    const budgetExpires = await runBudgetExpires({ log });
    const reports = [defaultPolicy.report, withinWindow.report, budgetExpires.report];
    return {
      // `run.mjs`'s own CLI prints `report.ticks.length` — a real concatenation, not just for show.
      ticks: reports.flatMap((r) => r.ticks),
      violations: reports.flatMap((r) => r.violations),
      fatal: reports.find((r) => r.fatal)?.fatal || null,
      lines: reports.flatMap((r) => r.lines),
      ms: reports.reduce((sum, r) => sum + r.ms, 0),
      ctx: { defaultPolicy, withinWindow, budgetExpires },
    };
  },
  judge(report) {
    const problems = [];
    const { defaultPolicy, withinWindow, budgetExpires } = report.ctx || {};

    if (!defaultPolicy?.outcome) problems.push(`default-policy: no post-pass outcome recorded${defaultPolicy?.report?.fatal ? ` (fatal: ${defaultPolicy.report.fatal})` : ''}`);
    else {
      const { s, l } = defaultPolicy.outcome;
      if (s !== 'MERGED') problems.push(`default-policy: the small ready PR did not land promptly over an in-review target (state=${s})`);
      if (l !== 'OPEN') problems.push(`default-policy: the large PR's review hold was bypassed (state=${l})`);
      if (defaultPolicy.sawYield) problems.push('default-policy: the small PR yielded to a target that was not landable');
      if (!defaultPolicy.sawDefaultPolicy) problems.push('default-policy: scenario-ran check failed — never observed the default landable-target policy');
    }

    if (!withinWindow?.outcome) problems.push(`within-window: no post-pass outcome recorded${withinWindow?.report?.fatal ? ` (fatal: ${withinWindow.report.fatal})` : ''}`);
    else {
      const { l, lMergeState, s } = withinWindow.outcome;
      if (s === 'MERGED' && l !== 'MERGED' && lMergeState && lMergeState !== 'CLEAN') {
        problems.push(`large-pr-conflicted: the small PR MERGED while the larger, review-cleared PR is ${l} with computed mergeStateStatus=${lMergeState}`);
      }
      if (l !== 'MERGED') problems.push(`within-window: the large PR (review cleared at round 2, well inside the window) never landed (state=${l})`);
      if (!withinWindow.sawYield) problems.push('within-window: scenario-ran check failed — never observed an overlap-yield log line (vacuous: proves nothing about the mechanism)');
    }

    if (!budgetExpires?.outcome) problems.push(`budget-expires: no post-pass outcome recorded${budgetExpires?.report?.fatal ? ` (fatal: ${budgetExpires.report.fatal})` : ''}`);
    else {
      const { s } = budgetExpires.outcome;
      if (s !== 'MERGED') problems.push(`budget-expires: the small PR never landed even after its own yield budget should have expired (state=${s})`);
      if (!budgetExpires.sawYield) problems.push('budget-expires: scenario-ran check failed — never observed an overlap-yield log line (vacuous: proves nothing about the mechanism)');
    }

    return problems;
  },
};
