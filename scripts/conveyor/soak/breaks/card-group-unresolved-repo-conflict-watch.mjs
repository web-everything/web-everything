/** PR #5762: a default conflict sweep whose repo cannot be resolved must hold every PR, never route it. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'card-group-unresolved-repo-conflict-watch',
  title: 'an unresolved default repo made the conflict watch route open card-group members (exemption failed open)',
  card: 'PR #5762 / xym8nt4',
  fixedBy: { sha: 'HEAD', where: 'lane/xym8nt4-card-group', paths: ['scripts/conveyor/parked-pr-conflict-watch.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, this.fixedBy.paths[0]), 'utf8').includes('card-group membership unknown (fail closed)');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { watchParkedPrConflicts } = await import(pathToFileURL(join(root, 'scripts/conveyor/parked-pr-conflict-watch.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'group-conflict-unresolved-soak-'));
    const previous = process.env.WE_DRAIN_CARD_GROUP_STATE;
    process.env.WE_DRAIN_CARD_GROUP_STATE = join(dir, 'groups.json');
    const violations = [];
    const write = process.stderr.write;
    try {
      // The live shape: the combined PR #2000 of an open group conflicts while `gh repo view` yields nothing.
      writeFileSync(process.env.WE_DRAIN_CARD_GROUP_STATE, JSON.stringify({ groups: [{ id: 'fixture',
        repo: 'o/r', pr: 2000, branch: 'lane/card-group-fixture', sources: [{ num: 1920 }] }] }));
      process.stderr.write = () => true;
      for (const [label, currentRepo] of [['empty', () => ''], ['null', () => null], ['throws', () => { throw new Error('gh repo view failed'); }]]) {
        const effects = [];
        const record = (...args) => effects.push(args);
        let result;
        try {
          result = watchParkedPrConflicts({ repo: null, sameLineConflict: 'stand-down',
            listPrs: () => [{ number: 2000, headRefName: 'lane/card-group-fixture', mergeable: 'CONFLICTING', labels: ['review:pending'] }],
            provider: { currentRepo, ensureLabel: record, setLabels: record, postComment: record },
            postFinding: record, postStandDown: record, listPrComments: () => [] });
        } catch (e) { violations.push(`${label}: the sweep crashed (${String(e?.message ?? e).split('\n')[0]})`); continue; }
        if (result.length || effects.length) violations.push(`${label}: the combined PR was routed by the conflict watch`);
      }
    } finally {
      process.stderr.write = write;
      if (previous === undefined) delete process.env.WE_DRAIN_CARD_GROUP_STATE;
      else process.env.WE_DRAIN_CARD_GROUP_STATE = previous;
      rmSync(dir, { recursive: true, force: true });
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
