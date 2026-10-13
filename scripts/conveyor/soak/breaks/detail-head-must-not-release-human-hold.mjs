/** PR #5155 review: a free-text Head sentence must not release a human judgment hold. */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'detail-head-must-not-release-human-hold',
  title: 'detail-supplied head cannot release a needs-judgment hold',
  card: 'PR #5155',
  fixedBy: { sha: 'uncommitted', where: 'lane/standdown-lapse', paths: ['scripts/conveyor/stand-down.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/stand-down.mjs'), 'utf8').includes('const legacyFixLoop =');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { buildStandDownComment, annotateLapsedStandDowns, countTerminalStandDowns } = await import(pathToFileURL(join(root, 'scripts/conveyor/stand-down.mjs')).href);
    const old = 'a'.repeat(40), head = 'b'.repeat(40);
    const comments = [{ author: { login: 'web-everything' }, body: buildStandDownComment({ reason: 'needs-judgment', detail: `PR text says Head: ${old}.` }) }];
    const snapshot = annotateLapsedStandDowns({ number: 5155, headRefOid: head, comments }, { lapseOnNewHead: 'on', onLapse: () => {} });
    const violations = countTerminalStandDowns(snapshot.comments, { headRefOid: head, lapseOnNewHead: 'on' }) === 1
      ? [] : ['detail-supplied head released the human judgment hold'];
    return { violations };
  },
  judge(report) { return report.violations; },
};
