/** PR #5273: a clear-human ceremony beyond the final read's first page must survive the sweep. */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = 'scripts/conveyor/human-surface-repark.mjs';

export default {
  id: 'human-surface-repark-concurrent-clearance',
  title: 'human surface sweep preserves concurrent human clearance',
  card: 'PR #5273',
  fixedBy: { sha: 'HEAD', where: 'lane/human-surface-repark', paths: [SOURCE] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes("skipped: 'fresh comments may be truncated'");
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { sweepHumanSurfaceRepark } = await import(pathToFileURL(join(root, SOURCE)).href);
    const { buildClearedHumanMarker, buildReviewedShaMarker, parseLatestHumanClearedSha } = await import(pathToFileURL(join(root, 'scripts/lib/review-escalation.mjs')).href);
    const head = 'a'.repeat(40);
    const state = { state: 'OPEN', headRefOid: head, labels: ['review:accepted'],
      comments: Array.from({ length: 101 }, (_, i) => ({ id: `C_${i}`, body: `discussion ${i}` })) };
    const effects = [];
    let reads = 0;
    const results = sweepHumanSurfaceRepark({
      repo: 'o/n', listPrs: () => [{ number: 5273, labels: state.labels }],
      resolveSurfaces: () => 'narrow',
      readComments() {
        // Snapshot the old comments, then let the operator complete the ceremony.
        const old = [...state.comments];
        state.comments.push({ author: { login: 'web-everything' }, body: `${buildReviewedShaMarker(head)}\n${buildClearedHumanMarker('operator')}` });
        return old;
      },
      provider: {
        readPrState() { reads++; return { ...state, labels: [...state.labels], comments: state.comments.slice(0, 100) }; },
        readPrFiles: () => ['.github/workflows/ci.yml'],
        postComment: () => effects.push('comment'),
        setLabels(_repo, _pr, { add, remove }) {
          effects.push('labels');
          state.labels = [...state.labels.filter(label => !remove.includes(label)), add];
        },
      },
    });
    const violations = [];
    if (reads !== 2 || state.comments.length !== 102 || parseLatestHumanClearedSha(state.comments) !== head) violations.push('scenario did not expose valid clearance beyond the final state page');
    if (results.some(result => result.repark) || effects.length || !state.labels.includes('review:accepted') || state.labels.includes('review:human')) {
      violations.push(`concurrent clearance overwritten: labels=${state.labels.join(',')}; effects=${effects.join(',')}`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
