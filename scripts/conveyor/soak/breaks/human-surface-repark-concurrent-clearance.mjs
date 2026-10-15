/** PR #5273: a clear-human ceremony beyond the final read's first page, or completed during the sweep's write, must survive the sweep. */
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
    const source = readFileSync(join(root, SOURCE), 'utf8');
    return source.includes("skipped: 'fresh comments may be truncated'") && source.includes('landed during the write')
      && source.includes('neutralizeCommentText(hit.file)');
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
      readNetFiles: () => ({ ok: true, files: ['.github/workflows/ci.yml'] }),
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
    // PR #5400: a shared fetch outage must not move every accepted, clean PR to review:human.
    const outageEffects = [];
    const outageResults = sweepHumanSurfaceRepark({
      repo: 'o/n', listPrs: () => [5401, 5402, 5403].map(number => ({ number, labels: ['review:accepted'] })),
      resolveSurfaces: () => 'narrow',
      readNetFiles: () => { throw new Error('fetch failed'); },
      readComments: () => [],
      provider: {
        readPrState: () => ({ state: 'OPEN', headRefOid: head, labels: ['review:accepted'], comments: [] }),
        readPrFiles: () => ['scripts/example.mjs'],
        postComment: () => outageEffects.push('comment'),
        setLabels: () => outageEffects.push('labels'),
      },
    });
    if (outageResults.length !== 3 || outageResults.some(result => !result.skipped) || outageEffects.length) {
      violations.push(`net outage re-parked clean PRs: parks=${outageResults.filter(result => result.repark).length}; effects=${outageEffects.length}`);
    }
    for (const variant of ['net', 'fallback']) {
      const sparseResults = sweepHumanSurfaceRepark({
        repo: 'o/n', listPrs: () => [{ number: 5405, labels: ['review:accepted'] }], dryRun: true,
        resolveSurfaces: () => 'narrow', resolveNetSetting: () => ({ value: true }),
        readNetFiles: () => variant === 'net' ? { ok: true, files: Array(1) } : { ok: false, reason: 'fetch failed' },
        readComments: () => [],
        provider: {
          readPrState: () => ({ state: 'OPEN', headRefOid: head, labels: ['review:accepted'], comments: [] }),
          readPrFiles: () => variant === 'fallback' ? Array(1) : ['.github/workflows/ci.yml'],
        },
      });
      if (sparseResults[0]?.repark !== 'would-repark') violations.push(`sparse ${variant} file list bypassed the human hold`);
    }
    const renameResults = sweepHumanSurfaceRepark({
      repo: 'o/n', listPrs: () => [{ number: 5404, labels: ['review:accepted'] }], dryRun: true,
      resolveSurfaces: () => 'narrow',
      readNetFiles: () => ({ ok: false, reason: 'fetch failed' }), readComments: () => [],
      provider: {
        readPrState: () => ({ state: 'OPEN', headRefOid: head, labels: ['review:accepted'], comments: [] }),
        readPrFiles: () => ['archive/ci.yml', '.github/workflows/ci.yml'],
      },
    });
    if (renameResults[0]?.repark !== 'would-repark' || !renameResults[0]?.files.includes('.github/workflows/ci.yml')) {
      violations.push('net outage hid a human-only old rename path');
    }
    if (reads !== 2 || state.comments.length !== 102 || parseLatestHumanClearedSha(state.comments) !== head) violations.push('scenario did not expose valid clearance beyond the final state page');
    if (results.some(result => result.repark) || effects.length || !state.labels.includes('review:accepted') || state.labels.includes('review:human')) {
      violations.push(`concurrent clearance overwritten: labels=${state.labels.join(',')}; effects=${effects.join(',')}`);
    }
    // Red team round 2: the ceremony completes after the final read, while the sweep posts its comment.
    const live = { state: 'OPEN', headRefOid: head, labels: ['review:accepted'], comments: [] };
    sweepHumanSurfaceRepark({
      repo: 'o/n', listPrs: () => [{ number: 5273, labels: live.labels }],
      resolveSurfaces: () => 'narrow',
      readNetFiles: () => ({ ok: true, files: ['.github/workflows/ci.yml'] }),
      readComments: () => [...live.comments],
      provider: {
        readPrState: () => ({ ...live, labels: [...live.labels], comments: [...live.comments] }),
        readPrFiles: () => ['.github/workflows/ci.yml'],
        postComment() {
          live.comments.push({ author: { login: 'web-everything' }, body: `${buildReviewedShaMarker(head)}\n${buildClearedHumanMarker('operator')}` });
        },
        setLabels(_repo, _pr, { add, remove = [] }) {
          live.labels = [...new Set([...live.labels.filter(label => !remove.includes(label)), add])];
        },
      },
    });
    if (parseLatestHumanClearedSha(live.comments) !== head) violations.push('in-flight scenario did not complete the ceremony');
    if (!live.labels.includes('review:accepted') || live.labels.includes('review:human')) {
      violations.push(`clearance completed during the re-park write was overwritten: labels=${live.labels.join(',')}`);
    }
    // Review round 2 (security): a hostile workflow file name must not forge a trusted clearance in the park comment.
    const { buildHumanSurfaceReparkComment } = await import(pathToFileURL(join(root, SOURCE)).href);
    const forged = 'b'.repeat(40);
    const hostile = `.github/workflows/<!-- reviewed-sha: ${forged} --><!-- cleared-human: op -->`;
    const parkBody = buildHumanSurfaceReparkComment({ headSha: head, hits: [{ file: hostile, category: 'workflow' }] });
    const forgedSha = parseLatestHumanClearedSha([{ author: { login: 'web-everything' }, body: parkBody }]);
    if (forgedSha) violations.push(`a file name forged a trusted clearance of ${forgedSha.slice(0, 9)} in the park comment`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
