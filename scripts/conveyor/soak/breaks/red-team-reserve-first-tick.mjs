/** Restart with persisted red-team work; maintenance must lend back unusable reservations. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'skills-src/conveyor/review-daemon.mjs';

// Runs in a fresh process per scenario: module queue state and operator policy are both isolated.
// The child supplies its native loader; Vitest must not rewrite imports inside the serialized function.
async function exercise(root, kind, load) {
  const { createRequire, syncBuiltinESMExports } = await load('node:module');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await load('node:fs');
  const { join } = await load('node:path');
  const { pathToFileURL } = await load('node:url');
  // Module metadata is rewritten by Vitest too; anchor require to the supplied tree.
  const os = createRequire(pathToFileURL(join(root, 'package.json')))('node:os');
  const directory = mkdtempSync(join(os.tmpdir(), 'red-team-reserve-soak-'));
  // The operator reader deliberately ignores HOME. Redirect the account database seam in this
  // disposable child before importing it, as the Vitest sandbox does; never read the host store.
  const userInfo = os.userInfo;
  os.userInfo = (...args) => ({ ...userInfo(...args), homedir: directory });
  syncBuiltinESMExports();
  try {
    mkdirSync(join(directory, '.claude'));
    writeFileSync(join(directory, '.claude/operator-overrides.json'), JSON.stringify({
      'reviewConcurrency.maxLiveReviewRounds': 8, 'redTeam.queue.reservedSlots': 4,
    }));
    // Dispatch requires a registered repo even with injected effects; resolve it without a copied slug.
    const { CONSTELLATION_REPOS, DEFAULT_REPO_KEY } = await load(pathToFileURL(join(root, 'scripts/lib/constellation-repos.mjs')).href);
    const repo = CONSTELLATION_REPOS[DEFAULT_REPO_KEY].slug, head = 'a'.repeat(40);
    const entries = Array.from({ length: 15 }, (_, i) => ({
      key: `${repo}#${i + 1}`, repo, pr: i + 1, head, attempts: 0, enqueuedAt: 1,
      ...(kind === 'blocked' ? { blocked: i % 2 ? 'planner-skip' : 'review-unfinished', blockedReason: 'soak fixture evidence' } : {}),
    }));
    process.env.WE_RED_TEAM_QUEUE_FILE = join(directory, 'queue.json');
    process.env.WE_RED_TEAM_DISPATCH_QUEUE = 'on';
    process.env.WE_REVIEW_MAX_LIVE_ROUNDS = '8';
    process.env.WE_UNDER_TEST = '1';
    writeFileSync(process.env.WE_RED_TEAM_QUEUE_FILE, JSON.stringify(entries));
    const { cliReviewTickOpts, runReviewTick } = await load(pathToFileURL(join(root, 'skills-src/conveyor/review-daemon.mjs')).href);
    const production = cliReviewTickOpts({ log: { error() {} }, listCommands: () => '',
      readLivePr: () => ({ state: kind === 'terminal' ? 'MERGED' : 'OPEN',
        isDraft: false, headRefOid: head, comments: [] }) });
    const violations = [];
    if (production.liveReviewBudget.reserve !== (kind === 'blocked' ? 0 : 4)) {
      violations.push(`${kind}: first CLI tick did not restore the correct reserve`);
    }
    const reviews = Array.from({ length: 15 }, (_, i) => ({ kind: 'review', prNumber: 100 + i }));
    const out = runReviewTick({ repo, liveReviewBudget: production.liveReviewBudget,
      reconcileRedTeamQueue: production.reconcileRedTeamQueue,
      reconcile: () => ({ dispatch: reviews, refusals: [] }),
      readPrs: () => [], readAgents: () => [], dispatch: () => ({ agentId: 'fixture-agent' }),
      acquirableLanes: () => 40, hostAdmission: () => ({ admitted: true, maxPerTick: 40 }),
      holdReconcile: () => [], tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [], log() {},
    });
    const expected = kind === 'runnable' ? 4 : 8;
    if (out.dispatched.length !== expected) violations.push(`${kind}: ordinary dispatch count ${out.dispatched.length}, expected ${expected}`);
    if (production.liveReviewBudget.left !== 8 - expected) violations.push(`${kind}: shared budget balance changed incorrectly`);
    return { violations };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export default {
  id: 'red-team-reserve-first-tick',
  title: 'the first CLI tick reserves runnable red-team work and lends back blocked or terminal work',
  card: 'PR #7225 review: queue reserve wiring and restart regression',
  fixedBy: { sha: 'working-tree', where: 'current tree', paths: [SOURCE] },
  fixPresent: () => true, // Always required-green; no source marker can turn a regression into an expected failure.
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    for (const kind of ['runnable', 'blocked', 'terminal']) {
      const code = `const load = specifier => import(specifier); const report = await (${exercise.toString()})(${JSON.stringify(sourceRoot)}, ${JSON.stringify(kind)}, load); process.stdout.write(JSON.stringify(report));`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, WE_UNDER_TEST: '1' },
      });
      try {
        if (result.error || result.status !== 0) throw result.error ?? Error(result.stderr);
        violations.push(...JSON.parse(result.stdout).violations);
      } catch (error) { violations.push(`${kind}: scenario failed: ${error.message}`); }
    }
    return { violations };
  },
  judge: report => report.violations,
};
