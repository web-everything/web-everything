/** PR #5148: watcher recovery must not swallow later unresolved fixer retries or expired grace. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'superseded-watcher-conflict-retry',
  title: 'a superseded watcher marker leaves an unresolved conflict with no fixer dispatched',
  card: 'PR #5148; PR #5017',
  fixedBy: { sha: 'HEAD', where: 'lane/conflict-watch-fixer-first', paths: ['scripts/conveyor/parked-pr-conflict-watch.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/parked-pr-conflict-watch.mjs'), 'utf8')
      .includes('A historical supersede finishes recovery only');
  },
  async run({ log, sourceRoot } = {}) {
    const root = sourceRoot ?? new URL('../../../../', import.meta.url).pathname;
    const { watchParkedPrConflicts, buildSupersedeStandDownComment, CONFLICT_LABEL } =
      await import(pathToFileURL(join(root, 'scripts/conveyor/parked-pr-conflict-watch.mjs')).href);
    const { buildStandDownComment, WATCHER_STAND_DOWN_ACTOR } =
      await import(pathToFileURL(join(root, 'scripts/conveyor/stand-down.mjs')).href);
    const violations = [];
    for (const state of ['idle', 'grace']) {
      const comments = [{ author: { login: 'web-everything' },
        body: buildStandDownComment({ actor: WATCHER_STAND_DOWN_ACTOR, reason: 'conflict' }) }];
      let labels = ['review:changes', CONFLICT_LABEL];
      let findings = 0;
      let supersedes = 0;
      const options = {
        repo: 'o/n', sameLineConflict: 'fixer',
        listPrs: () => [{ number: 5017, headRefName: 'lane/builder-priority', baseRefName: 'main',
          mergeable: 'CONFLICTING', labels: labels.map(name => ({ name })) }],
        provider: { ensureLabel() {}, setLabels() {}, postComment() {} },
        listPrComments: () => comments,
        listPrFiles: () => ['docs/agent/platform-decisions.md'],
        listPrPatches: () => ({}), computeConflictingPaths: () => ['docs/agent/platform-decisions.md'],
        computeConflictDisposition: () => 'real', labelRemovedAtMs: () => null, labelAgeMs: () => Infinity,
        postFinding: () => { findings++; },
        postSupersedeComment: () => { supersedes++; comments.push({ author: { login: 'web-everything' },
          body: buildSupersedeStandDownComment({ number: 5017 }, { sameLineConflict: true }) }); },
      };
      watchParkedPrConflicts(options);
      labels = state === 'idle' ? ['review:pending', CONFLICT_LABEL]
        : ['review:accepted', 'ready-to-merge', CONFLICT_LABEL];
      const result = watchParkedPrConflicts(options);
      log?.(`${state} after watcher recovery: findings=${findings}, supersedes=${supersedes}, route=${result[0]?.routedTo}`);
      if (findings !== 2 || supersedes !== 1) violations.push({ invariant: `${state}-retry-owned`,
        detail: `expected recovery plus retry and one supersede, got findings=${findings}, supersedes=${supersedes}` });
    }
    return { violations };
  },
  judge(report) { return report.violations.map(v => `[${v.invariant}] ${v.detail}`); },
};
