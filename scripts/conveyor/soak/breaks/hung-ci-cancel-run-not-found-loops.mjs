/**
 * @file breaks/hung-ci-cancel-run-not-found-loops.mjs — hung recovery must bypass the CLI's workflow
 * lookup 404, and a genuinely missing REST run must trigger the current head only once across ticks.
 * The real sweep and cancel/rerun helpers use stubbed GitHub IO and production-built durable comments.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const REPO = ['web-everything', 'web-everything'].join('/');
const TICKS = 6;
const NOW = Date.parse('2026-09-25T20:10:00Z');
const LIVE_RUN = 36161558017;
const MISSING_RUN = 36161558018;

export default {
  id: 'hung-ci-cancel-run-not-found-loops',
  title: 'hung CI uses REST cancellation and retriggers a missing run only once across six ticks',
  card: 'we:backlog/4075 (hung-CI recovery; run-not-found retrigger)',
  fixedBy: { sha: 'HEAD', where: 'lane/ci-recovery-retrigger', paths: ['scripts/conveyor/ci-red-recovery-watch.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/ci-red-recovery-watch.mjs');
    return existsSync(p) && readFileSync(p, 'utf8').includes('actions/runs/');
  },
  async run() {
    const { sweepHungCiRecovery, cancelAndRerunHungRun, cancelHungRun, buildHungCiComment } =
      await import(join(REPO_ROOT, 'scripts/conveyor/ci-red-recovery-watch.mjs'));
    // Copy of PR_2636_HUNG in __tests__/ci-red-recovery-watch.test.mjs.
    const live = {
      number: 2636, headRefName: 'lane/batch-...-3915', headRefOid: 'deadbeef2636',
      statusCheckRollup: [{
        __typename: 'CheckRun', name: 'test-shard (1)', workflowName: 'CI', status: 'IN_PROGRESS',
        conclusion: '', startedAt: '2026-09-25T16:34:28Z',
        detailsUrl: `https://github.com/${REPO}/actions/runs/${LIVE_RUN}/job/108159093983`,
      }],
    };
    const missing = {
      ...live, number: 2637, headRefName: 'lane/missing-run', headRefOid: 'deadbeef2637',
      statusCheckRollup: [{ ...live.statusCheckRollup[0],
        detailsUrl: `https://github.com/${REPO}/actions/runs/${MISSING_RUN}/job/108159093984` }],
    };
    const prs = [live, missing];
    const comments = new Map(prs.map((pr) => [pr.number, []]));
    const calls = [];
    const triggers = [];
    let liveCancels = 0;
    const exec = (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      if (cmd !== 'gh') throw new Error(`Unexpected executable: ${cmd}`);
      if (args[0] === 'run' && ['cancel', 'rerun'].includes(args[1])) {
        throw new Error(`Could not find any workflow run with ID ${args[2]}`);
      }
      if (args.length !== 4 || args[0] !== 'api' || args[1] !== '-X' || args[2] !== 'POST') {
        throw new Error(`Unexpected GitHub arguments: ${JSON.stringify(args)}`);
      }
      if (args[3] === `repos/${REPO}/actions/runs/${MISSING_RUN}/cancel`) {
        throw new Error('gh: Not Found (HTTP 404)');
      }
      if (args[3] === `repos/${REPO}/actions/runs/${LIVE_RUN}/cancel`) {
        liveCancels++;
        return '';
      }
      if (args[3] === `repos/${REPO}/actions/runs/${LIVE_RUN}/rerun`) {
        // GitHub starts a fresh attempt; it is no longer hung on the subsequent ticks.
        live.statusCheckRollup[0].startedAt = new Date(NOW).toISOString();
        return '';
      }
      throw new Error(`Unexpected GitHub endpoint: ${args[3]}`);
    };
    for (let tick = 0; tick < TICKS; tick++) {
      sweepHungCiRecovery({
        apply: true, repo: REPO, now: NOW + tick * 60_000, maxRetriesPerSha: 2,
        readOpenPrs: () => prs,
        readComments: (n) => [...comments.get(n)],
        cancelAndRerun: (id, options) => cancelAndRerunHungRun(id, { ...options, exec, sleepSync: () => {} }),
        cancelOnly: (id, options) => cancelHungRun(id, { ...options, exec }),
        trigger: (d) => {
          triggers.push({ prNumber: d.prNumber, headSha: d.headSha, runId: d.runId });
          return { ok: true, action: 'workflow-dispatch' };
        },
        postComment: (n, options) => comments.get(n).push({
          body: buildHungCiComment(options), author: { login: 'web-everything' },
        }),
      });
    }
    const violations = [];
    if (calls.some(({ args }) => args[0] === 'run')) {
      violations.push({ invariant: 'cli-cancel-used', detail: 'Recovery used gh run and its failing workflow lookup' });
    }
    if (liveCancels === 0) {
      violations.push({ invariant: 'live-run-never-cancelled', detail: `PR #${live.number} got no REST cancel` });
    }
    if (!triggers.some((t) => t.prNumber === missing.number)) {
      violations.push({ invariant: 'no-retrigger', detail: `PR #${missing.number} got no trigger after its REST cancel 404` });
    }
    const triggerCounts = new Map();
    for (const t of triggers) {
      const key = `${t.headSha}:${t.runId}`;
      triggerCounts.set(key, (triggerCounts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of triggerCounts) {
      if (count > 1) violations.push({ invariant: 'retrigger-repeated', detail: `${key} triggered ${count} times in ${TICKS} ticks` });
    }
    for (const pr of prs) {
      const count = comments.get(pr.number).length;
      if (count > 2) violations.push({ invariant: 'comment-spam', detail: `Head ${pr.headRefOid} got ${count} markers in ${TICKS} ticks` });
    }
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
