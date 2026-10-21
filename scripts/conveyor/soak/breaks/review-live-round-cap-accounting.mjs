/** PR #5769 red team: declined starts starved healthy repos and command parsing undercounted live rounds. */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = 'skills-src/conveyor/review-daemon.mjs';
const DECLINING_REPO = 'review-cap-fixture/declining';
const HEALTHY_REPO = 'review-cap-fixture/healthy';

export default {
  id: 'review-live-round-cap-accounting',
  title: 'PR #5769: review cap refunds non-starts and counts independent rounds in spaced checkout paths',
  card: 'PR #5769 post-accept red team',
  fixedBy: { sha: 'HEAD', where: 'lane/review-live-round-count-argv', paths: [SOURCE] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    return source.includes('remainingReviewCapacity') && source.includes('jobAncestorOf');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const { runReviewTickAllRepos, liveReviewRoundBudget } = await import(pathToFileURL(join(root, SOURCE)).href);
    const violations = [];
    // A relative verifier's changed-file arguments must leave all three seats available.
    // Exercise the actual budget -> multi-repository dispatch wiring, with ample free lanes.
    for (const command of [
      'node scripts/verify-lane.mjs run --files=scripts/operations/review-job.mjs',
      'node ./scripts/verify-lane.mjs --files=scripts/operations/review-loop-cli.mjs',
      'node scripts/verify-lane.mjs run --files scripts/operations/review-loop-cli.mjs',
      'node scripts/verify-lane.mjs run --files=skills-src/Review Work/review-job.mjs',
      'node -r ./package.json scripts/verify-lane.mjs run --files=scripts/operations/review-job.mjs',
      'node -r ./package.json -r ./boot.cjs scripts/verify-lane.mjs run --files=scripts/operations/review-job.mjs',
      'node -r ./package.json --no-warnings scripts/verify-lane.mjs run --files=scripts/operations/review-job.mjs',
      'node -r ./package.json -- scripts/verify-lane.mjs run --files=scripts/operations/review-loop-cli.mjs',
      'node --title worker scripts/verify-lane.mjs run --files=scripts/operations/review-job.mjs',
      'nodejs scripts/verify-lane.mjs run --files=scripts/operations/review-job.mjs',
      'bun scripts/verify-lane.mjs run --files=scripts/operations/review-loop-cli.mjs',
    ]) {
      const budget = liveReviewRoundBudget({ env: { WE_REVIEW_MAX_LIVE_ROUNDS: '3' },
        listCommands: () => `101 1 ${command}` });
      const before = { live: budget.live, left: budget.left };
      let dispatchCalls = 0;
      const result = runReviewTickAllRepos({
        repos: [HEALTHY_REPO], liveReviewBudget: budget,
        authGateOverride: () => ({ paused: false, reason: null }),
        reconcile: () => ({ dispatch: [1, 2, 3].map(prNumber => ({ kind: 'review', prNumber })), refusals: [] }),
        dispatch: () => ({ agentId: `review-${++dispatchCalls}` }),
        holdReconcile: () => [], tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [], acquirableLanes: () => 40,
      });
      if (before.live !== 0 || before.left !== 3 || dispatchCalls !== 3 || result.dispatched.length !== 3
        || result.deferredForCap !== 0) {
        violations.push(`relative verifier ${command}: live=${before.live}, left=${before.left}, dispatchCalls=${dispatchCalls}, deferred=${result.deferredForCap}`);
      }
    }
    // ps loses the argv boundary after an extension-like directory fragment. Exercise the budget
    // through the all-repository tick so an undercount cannot silently admit three more rounds.
    for (const argv of ['./Review -Work/scripts/operations/review-loop-cli.mjs',
      '../Review --Work/scripts/operations/review-job.mjs',
      './Review ./Work/scripts/operations/review-loop-cli.mjs',
      './Review.mjs Work/scripts/operations/review-loop-cli.mjs',
      '../Review.cjs Work/scripts/operations/review-job.mjs',
      'Review.js Work/scripts/operations/review-loop-cli.mjs',
      './Review.mjs\rWork/scripts/operations/review-loop-cli.mjs',
      './Review.mjs\u2028Work/scripts/operations/review-loop-cli.mjs',
      './Review.mjs -Work/scripts/operations/review-loop-cli.mjs',
      './Review.mjs --files=Work/scripts/operations/review-loop-cli.mjs',
      './Review.mjs ./Work/scripts/operations/review-loop-cli.mjs',
      '-r ./Boot.json Work/boot.cjs scripts/operations/review-loop-cli.mjs',
      '--require=../Boot.node Work/boot.cjs scripts/operations/review-loop-cli.mjs',
      '--import=./Boot.mjs Work/boot.mjs scripts/operations/review-loop-cli.mjs',
      '-r ./Boot.json -Work/boot.cjs scripts/operations/review-loop-cli.mjs',
      '-r Boot.json Work/boot.hook ./scripts/operations/review-loop-cli.mjs'].map(argv => `node ${argv}`).concat([
      '/Applications/Node Tools/bin/node scripts/operations/review-loop-cli.mjs',
      '/Applications/node -e Tools/bin/node scripts/operations/review-loop-cli.mjs',
      './Node Tools/bin/nodejs scripts/operations/review-loop-cli.mjs',
      '../Bun Tools/bin/bun scripts/operations/review-job.mjs',
    ])) {
      const budget = liveReviewRoundBudget({ env: { WE_REVIEW_MAX_LIVE_ROUNDS: '3' }, listCommands: () =>
        [1, 2, 3].map(pr => `${100 + pr} 1 ${argv} --pr=${pr}`).join('\n') });
      const held = runReviewTickAllRepos({
        repos: [HEALTHY_REPO], liveReviewBudget: budget,
        authGateOverride: () => ({ paused: false, reason: null }),
        reconcile: () => ({ dispatch: [1, 2, 3].map(prNumber => ({ kind: 'review', prNumber })), refusals: [] }),
        dispatch: () => ({ agentId: 'unexpected-review' }),
        holdReconcile: () => [], tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [], acquirableLanes: () => 40,
      });
      if (held.dispatched.length !== 0 || held.deferredForCap !== 3) {
        violations.push(`flattened relative argv ${argv}: dispatched=${held.dispatched.length}, deferred=${held.deferredForCap}`);
      }
    }
    const independent = [
      'node /a/review-job.mjs run --pr=1',
      'node /a/review-job.mjs run --pr=2',
      'node /a/review-loop-cli.mjs --pr=3',
    ];
    const spaced = [
      '101 1 node /Users/user/Review Work/scripts/operations/review-job.mjs run --pr=1',
      '102 101 node /Users/user/Review Work/scripts/operations/review-loop-cli.mjs --pr=1',
    ];
    const jsonPreloads = [1, 2, 3].map(pr =>
      `node -r ./package.json scripts/operations/review-loop-cli.mjs --pr=${pr} --repo=${HEALTHY_REPO}`);
    for (const [name, commands, expected] of [['independent rounds', independent, 3], ['spaced parent/child paths', spaced, 1],
      ['relative JSON preloads', jsonPreloads, 3]]) {
      const budget = liveReviewRoundBudget({ env: { WE_REVIEW_MAX_LIVE_ROUNDS: '3' }, listCommands: () => commands.join('\n') });
      if (budget.live !== expected || budget.left !== 3 - expected) violations.push(`${name}: ${JSON.stringify(budget)}`);
    }
    for (const preload of ['-r ./package', '--require=./package', '-r ./Boot.v1 Work/boot.cjs']) {
      const budget = liveReviewRoundBudget({ env: { WE_REVIEW_MAX_LIVE_ROUNDS: '3' }, listCommands: () =>
        [1, 2, 3].map(pr => `node ${preload} scripts/operations/review-loop-cli.mjs --pr=${pr}`).join('\n') });
      if (budget.left !== 0) violations.push(`preload ${preload}: ${JSON.stringify(budget)}`);
    }
    const spacedExtensionless = liveReviewRoundBudget({ env: { WE_REVIEW_MAX_LIVE_ROUNDS: '3' }, listCommands: () =>
      'node -r ./package scripts/Review Work/review-loop-cli.mjs --pr=1' });
    if (spacedExtensionless.left !== 0) violations.push(`spaced extensionless preload: ${JSON.stringify(spacedExtensionless)}`);
    const rootDir = mkdtempSync(join(tmpdir(), 'review-cap-paths-'));
    try {
      const opensslConfig = join(rootDir, 'openssl.cnf');
      writeFileSync(opensslConfig, '');
      const configured = liveReviewRoundBudget({ env: { WE_REVIEW_MAX_LIVE_ROUNDS: '3' }, listCommands: () =>
        [1, 2, 3].map(pr => `${100 + pr} 1 node --openssl-config ${opensslConfig} scripts/operations/review-loop-cli.mjs --pr=${pr}`).join('\n') });
      if (configured.live !== 3 || configured.left !== 0) violations.push(`OpenSSL config rounds: ${JSON.stringify(configured)}`);
      const held = runReviewTickAllRepos({
        repos: [HEALTHY_REPO], liveReviewBudget: configured,
        authGateOverride: () => ({ paused: false, reason: null }),
        reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 999 }], refusals: [] }),
        dispatch: () => ({ agentId: 'unexpected-fourth-review' }),
        holdReconcile: () => [], tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [], acquirableLanes: () => 40,
      });
      if (held.dispatched.length !== 0 || held.deferredForCap !== 1) violations.push('OpenSSL-configured rounds admitted an additional review');
      const spacedConfig = join(rootDir, 'config dir', 'openssl.js');
      mkdirSync(join(rootDir, 'config dir'));
      writeFileSync(spacedConfig, '');
      const spacedOptions = liveReviewRoundBudget({ env: { WE_REVIEW_MAX_LIVE_ROUNDS: '3' }, listCommands: () =>
        [1, 2, 3].map(pr => `${100 + pr} 1 node --openssl-config ${spacedConfig} scripts/operations/review-loop-cli.mjs --pr=${pr}`).join('\n') });
      if (spacedOptions.live !== 3 || spacedOptions.left !== 0) violations.push(`spaced OpenSSL config rounds: ${JSON.stringify(spacedOptions)}`);
      const prefix = join(rootDir, 'Review.mjs');
      const job = join(`${prefix} Work`, 'review-job.mjs');
      mkdirSync(`${prefix} Work`);
      writeFileSync(job, '');
      const tool = join(rootDir, 'tool');
      writeFileSync(tool, '');
      const runtime = join(rootDir, 'Node Tools', 'bin', 'node');
      mkdirSync(join(rootDir, 'Node Tools', 'bin'), { recursive: true });
      writeFileSync(runtime, '');
      const cases = [
        ['resolved spaced runtime', `${runtime} scripts/operations/review-loop-cli.mjs`, 1],
        ['verifier behind spaced runtime', `${runtime} "scripts/verify-lane.mjs" --files=scripts/operations/review-loop-cli.mjs`, 0],
        ['extension-like checkout name', `node ${job} run --pr=1`, 1],
        ['dash in checkout name', 'node /a/Review - Work/review-job.mjs run --pr=1', 1],
        ['equals preload', 'node --import=/a/Boot Work/boot.mjs /a/review-job.mjs', 1],
        ['extensionless tool argument', `node ${tool} inspect scripts/operations/review-job.mjs`, 0],
        ['long verifier arguments', `node ${tool} --files=${'x'.repeat(1500)} scripts/operations/review-job.mjs`, 0],
        ['many verifier arguments', `node ${tool} --files=${Array(150).fill('scripts/some-file.mjs').join(' ')} scripts/operations/review-job.mjs`, 0],
      ];
      for (const [name, command, expected] of cases) {
        const budget = liveReviewRoundBudget({ env: { WE_REVIEW_MAX_LIVE_ROUNDS: '3' }, listCommands: () => command });
        if (budget.live !== expected) violations.push(`${name}: ${JSON.stringify(budget)}`);
      }
      writeFileSync(prefix, '');
      const ambiguous = liveReviewRoundBudget({ env: { WE_REVIEW_MAX_LIVE_ROUNDS: '3' }, listCommands: () => `node ${job} run --pr=1` });
      if (ambiguous.left !== 0) violations.push('ambiguous process argv admitted new review rounds');
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
    for (let tick = 1; tick <= 2; tick++) {
      const budget = { left: 3 };
      const result = runReviewTickAllRepos({
        repos: [DECLINING_REPO, HEALTHY_REPO], liveReviewBudget: budget,
        authGateOverride: () => ({ paused: false, reason: null }),
        reconcile: ({ repo }) => ({ dispatch: Array.from({ length: repo === DECLINING_REPO ? 3 : 1 },
          (_, i) => ({ kind: 'review', prNumber: 100 + i })), refusals: [] }),
        dispatch: ({ repo }) => repo === DECLINING_REPO
          ? { skipped: 'review-ci: unreadable-ci' } : { agentId: 'healthy-review' },
        holdReconcile: () => [], tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [], acquirableLanes: () => 40,
      });
      if (result.dispatched.length !== 1 || result.dispatched[0]?.repo !== HEALTHY_REPO
        || result.deferredForCap !== 0 || budget.left !== 2) {
        violations.push(`tick ${tick}: healthy repo starved; dispatched=${result.dispatched.length}, deferred=${result.deferredForCap}, left=${budget.left}`);
      }
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
