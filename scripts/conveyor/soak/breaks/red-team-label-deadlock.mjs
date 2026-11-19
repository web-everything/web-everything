/** R707 #2: a clean red-team result, an unfinished same-head re-review and an operator accept must settle red-team:clear. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'red-team-label-deadlock', title: 'sweep skipped the operator-accept settle, so red-team:pending stayed forever',
  card: 'R707 #2', fixedBy: { sha: '01016c5187', where: 'lane/red-team-label-deadlock', paths: ['scripts/conveyor/advisory-label-sweep.mjs'] },
  fixPresent: root => readFileSync(join(root, 'scripts/conveyor/advisory-label-sweep.mjs'), 'utf8').includes('pr.number, live.headRefOid, live.reviews'),
  async run({ sourceRoot = ROOT } = {}) {
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { sweepAdvisoryLabels } = await load('scripts/conveyor/advisory-label-sweep.mjs');
      const { renderRedTeamComment } = await load('scripts/operations/review-extra-seats.mjs');
      const T = Date.parse('2026-11-06T14:42:13Z'), head = 'b'.repeat(40), iso = ms => new Date(ms).toISOString();
      const comments = [
        { author: { login: 'web-everything' }, createdAt: iso(T), body: renderRedTeamComment({ pr: 42, rev: head, findings: [], provider: 'codex', model: 'm', foldedVerdict: 'accept' }) },
        { author: { login: 'web-everything' }, createdAt: iso(T + 14 * 60e3), body: `Cleared by operator.\n<!-- reviewed-sha: ${head} -->\n<!-- cleared-human: chalbert -->` },
      ];
      const live = { number: 42, state: 'OPEN', headRefOid: head, labels: [{ name: 'red-team:pending' }], comments, reviews: [] };
      const writes = [];
      const evidence = { ok: false, reason: 'review-unfinished', settleBounds: { unfinishedStartedAt: T + 6 * 60e3, unfinishedActiveAt: T + 16 * 60e3,
        evaluatedAt: T + 2 * 3600e3, unfinishedUndecided: true, completeHeadRead: () => ({ complete: true, blocked: false }) } };
      sweepAdvisoryLabels({ repo: 'o/n', listPrs: () => [{ ...live, comments: [] }], readPr: () => live, readStatusEvidence: () => evidence,
        listUnpublishedStatuses: () => [], log: () => {},
        provider: { ensureLabel() {}, setLabels: (repo, number, spec) => writes.push(spec), currentRepo: () => 'o/n' } });
      return { violations: writes.some(w => w.add === 'red-team:clear') ? [] : ['deadlock input did not settle to red-team:clear'] };
    } catch (error) { return { violations: [error.message] }; }
  },
  judge: report => report.violations,
};
