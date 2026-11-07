/**
 * The smoke child is ordinary Node, so the test-runner-only tryResumeRound default does not protect it.
 * Exercise the actual embedded script with hermetic modules: a missing override reaches a sentinel
 * standing in for the production resume default. No real session, GitHub, ledger or lane is touched.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { DISPATCH_DRY_RUN_SCRIPT } from '../../../lib/daemon-live-smoke.mjs';

export async function probeDryRun(script = DISPATCH_DRY_RUN_SCRIPT, only = 'reconcile-fix-pass') {
  const resumeAttempts = [];
  const fixCalls = [];
  const directCalls = [];
  let stdout = '';
  const emptyPass = () => ({ dispatched: [], refusals: [] });
  const modules = {
    'scripts/operations/review-dispatch.mjs': {
      dispatchReview: ({ spawnAgent }) => { directCalls.push('review'); spawnAgent(['fixture prompt']); },
      REVIEW_BRIEF_PLACEHOLDERS: [], canonicalReviewPlaceholder: s => s,
    },
    'scripts/conveyor/reconcile-fix-dispatch.mjs': {
      dispatchFix: (_, { spawnAgent }) => { directCalls.push('fix'); spawnAgent(['fixture prompt']); },
      runReconcileFixDispatch: (options) => {
        fixCalls.push(options);
        const resume = options.tryResumeRound ?? (() => {
          resumeAttempts.push({ sessionSlug: 'existing-live-session' });
          return { resumed: true, resumeAttempt: 'existing-live-session' };
        });
        resume({ pr: 900002, round: 2 }, { repo: 'fixture/repo' });
        return emptyPass();
      },
    },
    'scripts/operations/ci-heal-pr-dispatch.mjs': {
      dispatchCiHeal: async (_, { sinks }) => {
        directCalls.push('ci-heal');
        await sinks.fixture({ prompt: 'fixture prompt' });
      },
      runReconcileCiHealDispatch: emptyPass,
    },
    'scripts/operations/dispatch-lane.mjs': {
      DISPATCH_EFFECT: 'fixture', BRIEF_REQUIRED_BY_KIND: { fix: [], 'ci-heal': [] },
      canonicalPlaceholder: s => s,
    },
    'skills-src/conveyor/review-daemon.mjs': { runReviewTick: () => ({ dispatched: [], failed: [] }) },
    'scripts/lib/constellation-repos.mjs': { CONSTELLATION_REPOS: { we: { slug: 'fixture/repo' } } },
  };
  // Replace only the loader declaration; run every other byte of the exported child script unchanged.
  const body = script.replace(/^const load = [^\n]+;\n/, '');
  if (body === script) throw new Error('dry-run loader not recognized; refusing to import production modules');
  await runInNewContext(`(async () => {\n${body}\n})()`, {
    load: async path => {
      if (!Object.hasOwn(modules, path)) throw new Error(`unexpected dry-run module: ${path}`);
      return modules[path];
    },
    process: { env: { WE_SMOKE_DRYRUN_ONLY: only }, stdout: { write: s => { stdout += s; } } },
  }, { timeout: 1000 });
  const rows = JSON.parse(stdout);
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !row.ok)) {
    throw new Error(`dry-run fixture incomplete: ${stdout}`);
  }
  return { resumeAttempts, fixCalls, directCalls, rows };
}

export default {
  id: 'smoke-dryrun-resumes-real-session',
  title: 'dispatch dry-run never resumes an existing real fix session',
  card: 'red-first smoke regression',
  fixedBy: { sha: 'pending', where: 'pending smoke isolation fix', paths: ['scripts/lib/daemon-live-smoke.mjs'] },
  fixPresent(root) {
    try {
      return /tryResumeRound\s*:\s*\(\)\s*=>\s*\(\{\s*resumed:\s*false,\s*resumeAttempt:\s*null\s*\}\)/
        .test(readFileSync(join(root, 'scripts/lib/daemon-live-smoke.mjs'), 'utf8'));
    } catch { return false; }
  },
  async run() {
    try {
      const report = await probeDryRun();
      const violations = [];
      if (report.fixCalls.length !== 1) {
        violations.push({ invariant: 'fix-pass-not-exercised', detail: `expected one fix pass, got ${report.fixCalls.length}` });
      }
      if (report.resumeAttempts.length) {
        violations.push({ invariant: 'dryrun-resumed-real-session', detail: 'missing tryResumeRound stub reached the live-session resume default' });
      }
      return { violations, report };
    } catch (error) {
      return { violations: [{ invariant: 'fixture-incomplete', detail: String(error.message) }] };
    }
  },
  judge(report) {
    return report.violations.map(v => `[${v.invariant}] ${v.detail}`);
  },
};
