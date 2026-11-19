/**
 * Merge-queue optimisation (R1070): the drain rebased every PR that was BEHIND main even when it was cleanly
 * mergeable, force-pushing a new head and restarting its checks, although the merge queue already tests PR + main.
 * A clean, manifest-free, check-green BEHIND head must be enqueued as is (no rebase); a conflicting one must still rebase.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = `
const m = await import(process.argv[1]);
const reason = m.unlandableStateReason('BEHIND');
const mk = (o = {}) => ({ decision: 'skip', reason, state: 'BEHIND', mergeable: 'MERGEABLE', hasManifest: false,
  certifyLabel: true, aiGenerated: false, testGreen: true, repo: 'o/r', ...o });
const rebase = () => 'REBASE';
const run = (v) => { const out = m.routeRebaseBeforeEnqueue(v, { setting: 'conflict-only', mergeStrategy: { queueOwnsFreshness: () => true },
  manifestFree: () => true, reclassifiesMerge: () => true, rebase }); return { out: out === null ? null : out === rebase ? 'REBASE' : 'OTHER', decision: v.decision }; };
console.log(JSON.stringify({ clean: run(mk()), conflicting: run(mk({ mergeable: 'CONFLICTING' })) }));
`;

function probe(root) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE, pathToFileURL(join(root, 'scripts/merge-ai-prs.mjs')).href],
    { encoding: 'utf8', timeout: 60000 });
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return null; }
}

export default {
  id: 'drain-rebases-clean-behind-pr',
  title: 'The drain rebases and force-pushes a cleanly mergeable BEHIND PR instead of enqueueing its existing head',
  card: 'drain skips the rebase for a clean BEHIND PR (R1070 merge-queue optimisation)',
  fixedBy: { sha: 'pending', where: 'lane/drain-skip-rebase-clean', paths: ['scripts/merge-ai-prs.mjs'] },
  fixPresent(root) { const p = probe(root); return !!p && p.clean?.out === null; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const p = probe(root);
    const violations = [];
    if (!p) violations.push('drain routing probe could not run');
    else {
      if (p.clean.out !== null || p.clean.decision !== 'merge') violations.push('a clean BEHIND PR was sent to rebase instead of being enqueued as is');
      if (p.conflicting.out !== 'REBASE') violations.push('a conflicting PR no longer rebases');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
