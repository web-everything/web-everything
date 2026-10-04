/**
 * @file breaks/watcher-stand-down-git-clean-github-conflicting.mjs — live case web-everything/web-everything#3771
 * (2026-10-03): a parked `review:human` PR that GitHub reports CONFLICTING while `git merge-tree` finds NO
 * conflict (main resolved a card rename cleanly) sat on `stand-down (unchanged)` forever.
 *
 * ROOT CAUSE: the watch's recheck read the empty git conflict-path list as "cannot narrow", fell back to the whole
 * diff, and a statute file merely SITTING in the diff (`docs/agent/platform-decisions.md`) read as a judgment
 * call. It also never read the operator's later stand-down answer, so even an explicit "resume and re-sync" did not
 * lift the stand-down. FIX: `parked-pr-conflict-watch.mjs#isWatcherStandDownOperatorAnswered` + the git-clean
 * `resync` route in the recheck.
 *
 * This replays both halves against the REAL watch (`watchParkedPrConflicts`) with its own injectable inputs: the
 * PR carries the watcher's stand-down (with the GraphQL id the real comment read now projects), a statute file in
 * its diff, a clean git probe; then (a) no answer yet — it must be re-synced; (b) a stranger's answer must not
 * count, but the operator's must lift a stand-down even on a real-looking conflict.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildStandDownComment, WATCHER_STAND_DOWN_ACTOR } from '../../stand-down.mjs';
import { buildOperatorAnswer } from '../../stand-down-answer-core.mjs';

const STAND_DOWN_ID = 'IC_kwDORBt1-c8AAAABY-kEBg';

export default {
  id: 'watcher-stand-down-git-clean-github-conflicting',
  title: 'a watcher stand-down on a PR that is git-clean but GitHub-conflicting is never lifted, even after the operator answers (#3771)',
  card: 'PR #3771; PR #3807',
  fixedBy: { sha: '749afb495', where: 'lane/fix-conflict-watch-standdown', paths: ['scripts/conveyor/parked-pr-conflict-watch.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/parked-pr-conflict-watch.mjs'), 'utf8').includes('isWatcherStandDownOperatorAnswered');
  },
  async run({ log, sourceRoot } = {}) {
    const root = sourceRoot ?? join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..');
    const { watchParkedPrConflicts, CONFLICT_LABEL } = await import(pathToFileURL(join(root, 'scripts/conveyor/parked-pr-conflict-watch.mjs')).href);
    const violations = [];
    const stoodDown = { id: STAND_DOWN_ID, author: { login: 'web-everything' },
      body: buildStandDownComment({ actor: WATCHER_STAND_DOWN_ACTOR, reason: 'conflict' }) };
    const answer = (login) => ({ author: { login },
      body: buildOperatorAnswer({ standDownId: STAND_DOWN_ID, reason: 'Resume and re-sync with main', actor: 'chalbert', channel: 'claude-code-chat' }) });
    const sweep = (comments, disposition) => {
      const dispatched = [];
      const results = watchParkedPrConflicts({
        repo: 'o/n',
        listPrs: () => [{ number: 3771, mergeable: 'CONFLICTING', headRefName: 'lane/judge-decision-2026-10-03',
          labels: [{ name: 'review:human' }, { name: CONFLICT_LABEL }] }],
        provider: { currentRepo: () => 'o/n', ensureLabel() {}, setLabels() {}, postComment() {} },
        listPrComments: () => comments,
        listPrFiles: () => ['docs/agent/platform-decisions.md', 'backlog/xne1udi-decision.md'],
        listPrPatches: () => ({ 'docs/agent/platform-decisions.md': '@@ -10,3 +10,4 @@\n a\n+b\n c\n d\n' }),
        listMainStatutePatches: () => ({ 'docs/agent/platform-decisions.md': '@@ -10,3 +10,4 @@\n a\n+x\n c\n d\n' }),
        computeConflictingPaths: () => [], // git merge-tree: no conflict path
        computeConflictDisposition: () => disposition,
        postFinding: (o) => dispatched.push(o), postStandDown: () => dispatched.push({ standDown: true }),
      });
      return { routedTo: results[0]?.routedTo, dispatched };
    };

    const clean = sweep([stoodDown], 'clean');
    log?.(`git-clean, no answer -> ${clean.routedTo}`);
    if (!clean.dispatched.length) violations.push({ invariant: 'git-clean-resynced', detail: `git sees no conflict but the PR stayed stood down: ${clean.routedTo}` });

    const stranger = sweep([stoodDown, answer('mallory')], 'real');
    log?.(`stranger answer, real conflict -> ${stranger.routedTo}`);
    if (stranger.dispatched.length) violations.push({ invariant: 'stranger-answer-ignored', detail: 'a non-operator answer lifted the stand-down' });

    const operator = sweep([stoodDown, answer('chalbert')], 'real');
    log?.(`operator answer -> ${operator.routedTo}`);
    if (!operator.dispatched.length) violations.push({ invariant: 'operator-answer-lifts', detail: `the operator answered but the PR stayed stood down: ${operator.routedTo}` });
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
