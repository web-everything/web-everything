/**
 * #7103 / #7028 (2026-11-18): an accepted, red-team-clear PR kept a stale `status:sent-back-review` /
 * `status:at-round-limit` and never got `ready-to-merge`, because the standalone status tagger left any `status:*`
 * label alone and nothing re-derived readiness from the current decision labels. The tagger must lift such a PR from
 * its labels on the live head, and must not when the head moved.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HEAD = 'c'.repeat(40);
const bot = { login: 'web-everything' };
const prState = (head) => ({ number: 7103, headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [],
  comments: [
    { author: bot, createdAt: '2026-11-18T20:00:00Z', body: `**Verdict:** accept\n**Advisory outcome:** accept\nNet basis: \`${'a'.repeat(12)}..${HEAD}\`` },
    { author: bot, createdAt: '2026-11-18T20:01:00Z', body: `<!-- we:red-team-gate pr=7103 rev=${HEAD} outcome=clear -->` },
  ] });

export default {
  id: 'accepted-clear-stale-status-never-ready',
  title: '#7103/#7028: an accepted red-team-clear PR keeps a stale status label and never gets ready-to-merge',
  card: 'status tagger derives ready-to-merge from current decision labels',
  fixedBy: { sha: '0'.repeat(40), where: 'lane/status-from-decision-labels', paths: ['scripts/conveyor/review-status-tag.mjs', 'scripts/conveyor/pr-status-label.mjs'] },
  // Behaviour, not a marker: run this very break against the tree in a child process; it passes only when fixed.
  fixPresent(root) {
    const code = `import b from ${JSON.stringify(import.meta.url)}; const r = await b.run(); process.exit(b.judge(r).length ? 1 : 0);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code],
      { env: { ...process.env, SOAK_TREE_ROOT: root }, stdio: 'ignore', timeout: 60000 });
    return child.status === 0;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { tagReviewStatus } = await import(pathToFileURL(join(root, 'scripts/conveyor/review-status-tag.mjs')).href);
    const violations = [];
    const tag = (labels, head) => {
      const adds = []; const removes = [];
      const provider = { readLabels: () => labels, ensureLabel() {}, setLabels: (_r, _p, d) => { if (d.add) adds.push(d.add); removes.push(...(d.remove ?? [])); } };
      try {
        tagReviewStatus({ pr: 7103, repo: 'web-everything/web-everything', provider, agents: [], prState: prState(head), signalFix: () => {},
          readRequiredChecks: () => ({ source: 'live', checks: [] }), loadStatusSettings: () => { throw new Error('x'); } });
      } catch (e) { violations.push(`tagger threw: ${e?.message}`); }
      return { adds, removes };
    };
    for (const stale of ['status:sent-back-review', 'status:at-round-limit']) {
      const { adds, removes } = tag(['review:accepted', 'red-team:clear', stale], HEAD);
      if (!adds.includes('status:ready-to-merge') || !adds.includes('ready-to-merge') || !removes.includes(stale)) {
        violations.push(`${stale} survived an accepted red-team-clear head (adds=${adds}, removes=${removes})`);
      }
    }
    const moved = tag(['review:accepted', 'red-team:clear', 'status:sent-back-review'], 'd'.repeat(40));
    if (moved.adds.length) violations.push('a moved head was lifted to ready-to-merge');
    return { violations };
  },
  judge(report) { return report.violations; },
};
