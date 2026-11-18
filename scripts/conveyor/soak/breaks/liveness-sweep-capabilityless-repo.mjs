import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatherSnapshot } from '../../liveness-sweep.mjs';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const expected = ['we', 'frontierui', 'plateau-app'].map(key => CONSTELLATION_REPOS[key].slug);

// Live case (PR #6911 red team, head 281c3e416): the liveness sweep listed open PRs for the cards-only
// `longshore` repo, got a 404 from the private repo, and reported false stalls.
export default {
  id: 'liveness-sweep-capabilityless-repo',
  title: 'The liveness sweep reads PRs of a cards-only repo and reports false stalls',
  card: '8418',
  fixedBy: { sha: 'HEAD', where: 'lane/longshore-locus-s1', paths: ['scripts/conveyor/liveness-sweep.mjs'] },
  fixPresent(root) {
    return /capableRepos\(undefined, deps\.repos/.test(readFileSync(join(root, 'scripts/conveyor/liveness-sweep.mjs'), 'utf8'));
  },
  async run({ log } = {}) {
    const seen = [];
    const out = await gatherSnapshot({ now: '2026-11-17T20:00:00Z', ledger: '/tmp/none', noMovementStore: true }, {
      homedir: () => '/tmp/home', env: {},
      readSharedOpenPrs: () => null,
      execFileSync: (cmd, args) => {
        if (cmd !== 'gh') throw new Error(`unexpected ${cmd}`);
        const repo = args[args.indexOf('--repo') + 1];
        seen.push(repo);
        if (repo === CONSTELLATION_REPOS.longshore.slug) throw new Error('HTTP 404: private cards-only repo');
        return '[]';
      },
      cachedClaudeAgents: () => '[]', daemonCloneRoots: () => [], readTail: () => '',
      readFile: () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }, writeMovementStore: () => {},
    });
    const violations = [];
    if (JSON.stringify(seen) !== JSON.stringify(expected)) violations.push(`queried ${seen.join(',')}`);
    const repoErrors = out.errors.filter(e => String(e.source).startsWith('prs:'));
    if (repoErrors.length) violations.push(`repo read errors: ${repoErrors.map(e => e.source).join(',')}`);
    log?.(`liveness: ${seen.join(',')}`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
