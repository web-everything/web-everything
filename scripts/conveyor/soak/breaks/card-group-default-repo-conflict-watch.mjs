/** PR #5762: the default sweep must resolve its repo before checking group ownership. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'card-group-default-repo-conflict-watch',
  title: 'default conflict sweeps leave grouped sources and combined PRs to reconciliation',
  card: 'PR #5762 / xym8nt4',
  // Pin the commit that introduced the fix so replay keeps targeting it after later commits land.
  fixedBy: { sha: 'e55ef4474f96748122b3afcd42ca6955afb631fd', where: 'lane/xym8nt4-card-group',
    paths: ['scripts/conveyor/parked-pr-conflict-watch.mjs'] },
  fixPresent(root) {
    // The original line, or its fail-closed successor (card-group-unresolved-repo-conflict-watch).
    const text = readFileSync(join(root, this.fixedBy.paths[0]), 'utf8');
    return text.includes('resolvedRepo ??= provider.currentRepo(); // group ownership')
      || text.includes('card-group membership unknown (fail closed)');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { watchParkedPrConflicts } = await import(pathToFileURL(join(root, 'scripts/conveyor/parked-pr-conflict-watch.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'group-conflict-soak-'));
    const previous = process.env.WE_DRAIN_CARD_GROUP_STATE;
    process.env.WE_DRAIN_CARD_GROUP_STATE = join(dir, 'groups.json');
    const violations = [];
    try {
      writeFileSync(process.env.WE_DRAIN_CARD_GROUP_STATE, JSON.stringify({ groups: [{ id: 'fixture',
        repo: 'o/r', pr: 2000, branch: 'lane/card-group-fixture', sources: [{ num: 1920 }] }] }));
      for (const repo of [null, 'o/r']) {
        for (const [number, headRefName] of [[1920, 'lane/source'], [2000, 'lane/card-group-fixture']]) {
          const effects = [];
          const record = (...args) => effects.push(args);
          let reads = 0;
          const result = watchParkedPrConflicts({ repo, sameLineConflict: 'stand-down',
            listPrs: () => [{ number, headRefName, mergeable: 'CONFLICTING', labels: ['review:pending'] }],
            provider: { currentRepo: () => { reads++; return 'o/r'; },
              ensureLabel: record, setLabels: record, postComment: record },
            postFinding: record, postStandDown: record, listPrComments: () => [] });
          if (result.length || effects.length) violations.push(`${repo ?? 'default'} #${number}: grouped PR was routed by conflict watch`);
          if (reads !== (repo === null ? 1 : 0)) violations.push(`${repo ?? 'default'} #${number}: repository resolution was not cached`);
        }
      }
    } finally {
      if (previous === undefined) delete process.env.WE_DRAIN_CARD_GROUP_STATE;
      else process.env.WE_DRAIN_CARD_GROUP_STATE = previous;
      rmSync(dir, { recursive: true, force: true });
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
