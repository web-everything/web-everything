/**
 * @file breaks/worker-push-during-fix-claim.mjs — live break, 2026-09-27 (the fix procedure, operator-approved).
 * A second author pushed to a PR's lane while the daemon fixer was mid-repair, and the PR ended up buried.
 *
 * LIVE INCIDENT: web-everything/web-everything PR #2811. The daemon fixer `fix-2811` was repairing the PR; an
 * orchestrator worker (not a daemon session) pushed two commits (`efaae6300`, `60f0f3d57`) to the SAME branch
 * `lane/run-rating-slice1-mechanical-grade`. Nothing refused the push. The fixer saved its repair on
 * `lane/run-rating-slice1-fix-2811-alt` and posted a TERMINAL stand-down with no label and the wrong reason, and
 * the reconcile planner then held #2811 `stood-down` forever.
 *
 * FIX — `we:scripts/conveyor/fix-procedure.mjs` (`fix-begin`/`fix-end`, the per-PR fix claim) wired into the
 * planner (`fix-claimed`), the dispatchers, the status tagger, and the push paths (`pr-land.mjs`, the
 * `fix-procedure.mjs push` helper, `guard-bash.mjs`).
 *
 * SCENARIO (review + fix-dispatch daemons, no default fleet): ONE PR bounced `review:changes`, CI green. The
 * fixer runs the REAL `fix-begin` CLI from the daemon clone. DEFAULT (operator ruling 2026-09-27,
 * draft-only-on-withdrawal, `we:docs/agent/platform-decisions.md#fix-claim-draft-only-on-withdrawal`): the PR
 * stays READY, labeled `review-status:fixing` — never draft.
 *   round 1 — a worker (different session) pushes to the PR's branch through the push helper → must be REFUSED;
 *   round 2 — while the claim is held, no review/fix is dispatched, the PR stays READY (never drafted), and the
 *             `fixing` label survives the status tagger; then the fixer pushes (allowed), re-arms, runs `fix-end`;
 *   later   — the review daemon re-reviews the green, still-ready PR directly — no draft-first promotion is
 *             owed, because this claim never drafted it.
 * A SECOND PR proves the other half of the same ruling in the same run: `fix-begin --draft --reason=scope-change`
 * DOES convert to draft with its own `review-status:draft-scope-change` label, and `fix-end` leaves it draft and
 * DOES get promoted once required CI is green — that half still relies on the draft-first promotion. The
 * re-review that follows a promotion is PRE-EXISTING #2826 machinery (not this amendment's own logic) and shares
 * the same single-dispatch-per-tick daemons as the first PR, whose own review/fix cycle can bounce for many
 * rounds in this sim world — so this scenario does not gate on it (see the `round > 2 && sc.finished` block).
 *
 * RED  = the worker's push lands (pre-fix there is no claim to refuse it), the default claim ever drafts the PR,
 *        the PR is never re-reviewed, or the scope-change PR is NOT left draft / never promoted.
 * GREEN = push refused; fixer finishes; the ready PR re-reviewed with no promotion owed; the scope-change PR
 *         drafted, then promoted once green.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FALLBACK_REQUIRED_STATUS_CHECKS } from '../../../lib/required-status-checks.mjs';

// The sim has no branch protection, so the planner judges against the fallback required set. "Green" here means
// EVERY required check reported success — a lone `test` row is incomplete evidence (`unchecked`, never promoted).
const GREEN_ALL = FALLBACK_REQUIRED_STATUS_CHECKS.map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }));

import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { readStoreSnapshot } from '../../../operations/__tests__/helpers/fake-claude-shim.mjs';
import { runSoak } from '../soak.mjs';

const ROUNDS = 8;
const WE_SLUG = CONSTELLATION_REPOS.we.slug;
const HEAD = 'lane/soak-fix-claim';
const FIXER = 'fix-soak-claim';
const FIXER_SESSION = 'soak-fixer-session';
const WORKER_SESSION = 'soak-worker-session';
const INVARIANT = 'fix-procedure';
const PROMOTE_BY_ROUND = 5;
const REVIEW_BY_ROUND = 7;

const TOOL = (w) => join(w.simCloneRoot, 'scripts', 'conveyor', 'fix-procedure.mjs');

function toolEnv(w, over = {}) {
  const env = { ...w.env, ...over };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.WE_FIX_WHO;
  return { ...env, ...over };
}

function labelNames(w, pr) {
  return (w.gh.pr('we', pr)?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
}

/** Clone the fake origin at `branch`, commit one file on top of it, run `push(work)`; returns its spawn result. */
function withCommitOnHead(w, branch, file, push) {
  const work = mkdtempSync(join(tmpdir(), 'soak-fix-claim-'));
  try {
    const g = (args) => execFileSync('git', args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    execFileSync('git', ['clone', '--quiet', '--branch', branch, w.repos.we.originPath, work], { stdio: 'ignore' });
    g(['config', 'user.email', 'sim@example.com']); g(['config', 'user.name', 'Sim World']); g(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(work, file), `${file}\n`, 'utf8');
    g(['add', file]); g(['commit', '-q', '-m', `soak: ${file}`]);
    return push(work);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

function sessionsFor(w, pr) {
  const store = readStoreSnapshot(w.claude.env.FAKE_CLAUDE_STORE);
  return (store.sessions ?? []).filter((s) => [`review-${pr}`, `fix-${pr}`, `ci-heal-${pr}`].includes(String(s.name ?? '')));
}

export default {
  id: 'worker-push-during-fix-claim',
  title: 'a worker pushes to a PR branch while the daemon fixer is mid-repair — nothing refuses it and the PR is buried stood-down',
  card: 'fix procedure (operator-approved 2026-09-27) — live incident PR #2811',
  fixedBy: {
    sha: 'acbb07c6b',
    where: 'lane/fix-procedure',
    paths: ['scripts/conveyor/fix-procedure.mjs', 'scripts/conveyor/fix-claim-store.mjs', 'scripts/conveyor/stand-down.mjs', 'scripts/pr-land.mjs', 'scripts/guard-bash.mjs', 'scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/review-status-tag.mjs', 'scripts/conveyor/fix-dispatch-claim.mjs', 'scripts/conveyor/reconcile-pass.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs', 'scripts/operations/ci-heal-pr-dispatch.mjs'],
  },
  fixPresent(root) {
    return existsSync(join(root, 'scripts', 'conveyor', 'fix-procedure.mjs'));
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:worker-push-during-fix-claim',
      rounds: ROUNDS,
      daemons: ['review', 'fix-dispatch'],
      mainEvery: 0,
      scorecards: false,
      fleet: false,
      setup(w) {
        // The review CI gate only trusts a declared (live) required set — serve the fallback set as branch protection.
        w.gh.setRequiredChecks('we', FALLBACK_REQUIRED_STATUS_CHECKS);
        w.git.createBranch('we', HEAD, { from: 'main', files: { 'soak/fix-claim.txt': 'a PR bounced for changes\n' } });
        const pr = w.gh.openPr({ repo: 'we', head: HEAD, base: 'main', title: 'soak: fix claim vs a concurrent worker push', labels: [], body: 'No backlog item.' });
        for (const name of ['review:changes', 'review:pending']) {
          execFileSync('gh', ['label', 'create', name, '--repo', WE_SLUG, '--force'], { env: w.env, stdio: 'ignore' });
        }
        w.gh.addLabels('we', pr, ['review:changes']);
        w.gh.comment('we', pr, '🔁 review — changes requested\n\nthe soak finding: handle the empty case');
        w.gh.setChecks('we', pr, GREEN_ALL);
        const ctx = { pr, begun: false, workerRefused: null, finished: false, reviewedAt: null, reported: new Set() };
        if (existsSync(TOOL(w))) {
          const r = spawnSync(process.execPath, [TOOL(w), 'fix-begin', String(pr), `--repo=${WE_SLUG}`, `--who=${FIXER}`, '--why=soak: address review'], {
            cwd: w.simCloneRoot, env: toolEnv(w, { CLAUDE_CODE_SESSION_ID: FIXER_SESSION }), encoding: 'utf8',
          });
          ctx.begun = r.status === 0;
          ctx.beginOut = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
        }

        // A SECOND PR proves the other half of the SAME ruling: `--draft --reason=scope-change` DOES draft the
        // PR, with its own label, and that half DOES rely on the draft-first promotion once CI is green.
        const HEAD2 = 'lane/soak-fix-claim-scope-change';
        w.git.createBranch('we', HEAD2, { from: 'main', files: { 'soak/fix-claim-2.txt': 'a PR needs a scope-change draft\n' } });
        const pr2 = w.gh.openPr({ repo: 'we', head: HEAD2, base: 'main', title: 'soak: fix claim scope-change draft', labels: [], body: 'No backlog item.' });
        w.gh.addLabels('we', pr2, ['review:changes']);
        w.gh.setChecks('we', pr2, GREEN_ALL);
        const ctx2 = { pr: pr2, head: HEAD2, begun: false, finished: false, promotedAt: null, reviewedAt: null, reported: new Set() };
        if (existsSync(TOOL(w))) {
          const r2 = spawnSync(process.execPath, [
            TOOL(w), 'fix-begin', String(pr2), `--repo=${WE_SLUG}`, `--who=${FIXER}-2`, '--why=soak: scope changed mid-review', '--draft', '--reason=scope-change',
          ], { cwd: w.simCloneRoot, env: toolEnv(w, { CLAUDE_CODE_SESSION_ID: `${FIXER_SESSION}-2` }), encoding: 'utf8' });
          ctx2.begun = r2.status === 0;
          ctx2.beginOut = `${r2.stdout ?? ''}${r2.stderr ?? ''}`.trim();
        }

        return { ...ctx, scopeChange: ctx2 };
      },
      perRound(w, round, ctx, api) {
        const flag = (key, detail) => { if (!ctx.reported.has(key)) { ctx.reported.add(key); api.violation(INVARIANT, detail); } };
        const view = w.gh.pr('we', ctx.pr);
        const labels = labelNames(w, ctx.pr);
        api.say(`r${String(round).padStart(2, '0')} PR #${ctx.pr}: draft=${view?.isDraft} labels=${labels.join(',')} sessions=${sessionsFor(w, ctx.pr).map((s) => s.name).join(',') || '-'}`);

        const sc = ctx.scopeChange;
        const flag2 = (key, detail) => { if (!sc.reported.has(key)) { sc.reported.add(key); api.violation(INVARIANT, detail); } };
        const view2 = w.gh.pr('we', sc.pr);
        const labels2 = labelNames(w, sc.pr);

        if (round === 1) {
          if (!ctx.begun) flag('begin', `fix-begin did not take the claim: ${ctx.beginOut ?? 'fix-procedure.mjs absent'}`);
          // Draft-only-on-withdrawal (operator ruling 2026-09-27): the DEFAULT fix-begin never drafts the PR —
          // it stays READY, and `review-status:fixing` (not the draft bit) is the visible signal.
          else if (view?.isDraft !== false) flag('drafted-by-default', `fix-begin (no --draft) held the claim but PR #${ctx.pr} is a draft — default must never touch the draft bit`);
          else if (!labels.includes('review-status:fixing')) flag('fixing-label-missing', `fix-begin held the claim on PR #${ctx.pr} but review-status:fixing was never applied`);
          const before = w.git.headOf('we', HEAD);
          const res = withCommitOnHead(w, HEAD, 'soak/worker.txt', (work) => (existsSync(TOOL(w))
            ? spawnSync(process.execPath, [TOOL(w), 'push', `--branch=${HEAD}`, '--repo=we'], { cwd: work, env: toolEnv(w, { CLAUDE_CODE_SESSION_ID: WORKER_SESSION }), encoding: 'utf8' })
            // pre-fix there is no push check at all: the worker's push is a plain `git push`.
            : spawnSync('git', ['push', 'origin', `HEAD:${HEAD}`], { cwd: work, encoding: 'utf8' })));
          const after = w.git.headOf('we', HEAD);
          ctx.workerRefused = res.status !== 0 && after === before;
          api.say(`r01 worker push → exit ${res.status}${ctx.workerRefused ? ' (refused)' : ' (LANDED)'}`);
          if (!ctx.workerRefused) flag('worker-push', `a worker's push to ${HEAD} landed while ${FIXER} held the fix claim on PR #${ctx.pr}`);

          // The scope-change PR's OTHER half: --draft DOES convert to draft, with its own label.
          if (!sc.begun) flag2('begin-2', `fix-begin --draft --reason=scope-change did not take the claim: ${sc.beginOut ?? 'fix-procedure.mjs absent'}`);
          else if (view2?.isDraft !== true) flag2('not-drafted', `fix-begin --draft --reason=scope-change held the claim but PR #${sc.pr} is not a draft`);
          else if (!labels2.includes('review-status:draft-scope-change')) flag2('draft-label-missing', `review-status:draft-scope-change was never applied to PR #${sc.pr}`);
        }

        if (round === 2 && ctx.begun) {
          if (sessionsFor(w, ctx.pr).length) flag('dispatch-while-claimed', `a review/fix session was dispatched for PR #${ctx.pr} while the fix claim was held`);
          if (view?.isDraft !== false) flag('drafted-while-claimed', `PR #${ctx.pr} was converted to draft while a NEVER-drafted fix claim was held`);
          if (!labels.includes('review-status:fixing')) flag('fixing-label', `review-status:fixing was stripped from PR #${ctx.pr} while the claim was held`);
          // The fixer finishes: push (allowed — it holds the claim), re-arm, fix-end.
          const res = withCommitOnHead(w, HEAD, 'soak/fix.txt', (work) => spawnSync(process.execPath, [TOOL(w), 'push', `--branch=${HEAD}`, '--repo=we'], {
            cwd: work, env: toolEnv(w, { CLAUDE_CODE_SESSION_ID: FIXER_SESSION }), encoding: 'utf8',
          }));
          if (res.status !== 0) flag('holder-push', `the claim holder's own push was refused: ${(res.stderr ?? '').trim()}`);
          w.gh.setChecks('we', ctx.pr, GREEN_ALL);
          w.gh.removeLabels('we', ctx.pr, ['review:changes']);
          w.gh.addLabels('we', ctx.pr, ['review:pending']);
          const end = spawnSync(process.execPath, [TOOL(w), 'fix-end', String(ctx.pr), `--repo=${WE_SLUG}`, `--who=${FIXER}`], {
            cwd: w.simCloneRoot, env: toolEnv(w, { CLAUDE_CODE_SESSION_ID: FIXER_SESSION }), encoding: 'utf8',
          });
          ctx.finished = end.status === 0;
          if (!ctx.finished) flag('fix-end', `fix-end failed: ${`${end.stdout ?? ''}${end.stderr ?? ''}`.trim()}`);
          // fix-end never relies on the draft-first promotion when the claim was never drafted (backlog 4302):
          // the PR must stay exactly as it was — ready — with `review-status:fixing` gone.
          else if (w.gh.pr('we', ctx.pr)?.isDraft !== false) flag('end-drafted', 'fix-end must NOT leave a never-drafted PR as draft');
          else if (labelNames(w, ctx.pr).includes('review-status:fixing')) flag('end-label-lingers', 'fix-end must drop review-status:fixing');

          // scope-change PR: fixer pushes its own repair, runs fix-end — DOES stay draft (relies on promotion).
          if (sc.begun) {
            const resSc = withCommitOnHead(w, sc.head, 'soak/fix-scope.txt', (work) => spawnSync(process.execPath, [TOOL(w), 'push', `--branch=${sc.head}`, '--repo=we'], {
              cwd: work, env: toolEnv(w, { CLAUDE_CODE_SESSION_ID: `${FIXER_SESSION}-2` }), encoding: 'utf8',
            }));
            if (resSc.status !== 0) flag2('holder-push-2', `the scope-change claim holder's own push was refused: ${(resSc.stderr ?? '').trim()}`);
            w.gh.setChecks('we', sc.pr, GREEN_ALL);
            const endSc = spawnSync(process.execPath, [TOOL(w), 'fix-end', String(sc.pr), `--repo=${WE_SLUG}`, `--who=${FIXER}-2`], {
              cwd: w.simCloneRoot, env: toolEnv(w, { CLAUDE_CODE_SESSION_ID: `${FIXER_SESSION}-2` }), encoding: 'utf8',
            });
            sc.finished = endSc.status === 0;
            if (!sc.finished) flag2('fix-end-2', `fix-end (scope-change) failed: ${`${endSc.stdout ?? ''}${endSc.stderr ?? ''}`.trim()}`);
            else if (w.gh.pr('we', sc.pr)?.isDraft !== true) flag2('end-undrafted-2', 'fix-end must leave a SCOPE-CHANGE-drafted PR draft for the promotion to mark it ready');
          }
        }

        if (round > 2 && ctx.finished) {
          if (ctx.reviewedAt === null && sessionsFor(w, ctx.pr).some((s) => String(s.name).startsWith('review-'))) ctx.reviewedAt = round;
          if (round >= REVIEW_BY_ROUND && ctx.reviewedAt === null) flag('not-reviewed', `PR #${ctx.pr} (never drafted) was not re-reviewed by round ${round} — draft-first promotion is not owed here`);
        }
        // The scope-change PR's promotion→re-review chain is PRE-EXISTING machinery (#2826's draft-first
        // promotion + the ordinary review daemon), not new logic this amendment adds — and it shares the SAME
        // single-dispatch-per-tick daemons as PR #1, whose own review/fix cycle can bounce indefinitely in this
        // sim world and starve PR #2 of a dispatch slot for many rounds (a resource-contention artifact of
        // running two PRs through one soak world, not a fix-procedure defect). So this scenario checks only the
        // NEW behavior fix-begin/fix-end own — drafted with the right label (round 1), fix-end leaves it draft
        // (round 2, checked above) — and leaves proving the promotion/re-review CHAIN itself to #2826's own
        // tests, which already cover it in isolation.
        if (round > 2 && sc.finished) {
          if (sc.promotedAt === null && view2?.isDraft === false) sc.promotedAt = round;
          if (round >= PROMOTE_BY_ROUND && sc.promotedAt === null) flag2('not-promoted-2', `PR #${sc.pr} (scope-change draft) was not promoted by round ${round} after fix-end on green CI`);
        }
      },
      log,
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => v.invariant === INVARIANT || v.invariant === 'crash' || v.invariant === 'isolation')
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
