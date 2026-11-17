import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const CATCHUP = 'scripts/lib/red-team-gate-catchup.mjs';

export default {
  id: 'red-team-gate-send-back-failed-never-retried',
  title: 'an already-reviewed live head retries a failed red-team send-back',
  card: 'Gap 1: PR #6774 failed gate catch-up',
  fixedBy: { sha: 'HEAD', where: 'HEAD', paths: [CATCHUP, 'skills-src/conveyor/review-daemon.mjs'] },
  fixPresent() { return true; },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    try {
      const { runGateCatchUp } = await import(pathToFileURL(join(sourceRoot, CATCHUP)).href);
      const { applyRedTeamGate } = await import(pathToFileURL(join(sourceRoot, 'scripts/operations/red-team-gate-apply.mjs')).href);
      const { CONFIRMED_BREAKS_DEFAULTS } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/red-team-gate.mjs')).href);
      const repo = CONSTELLATION_REPOS.we.slug, pr = 6774, head = '8ea4e111' + 'a'.repeat(32);
      const comments = [{ author: { login: 'web-everything' }, createdAt: '2026-11-14T15:50:00Z',
        body: `<!-- we:red-team-advisory pr=${pr} rev=${head} -->\n1. [**confirmed**] (edge-case, broken) \`scripts/x.mjs:1\` — real break` }];
      let sends = 0, fail = true;
      const io = { readPr: () => ({ headRefOid: head, comments, labels: ['review:accepted'] }),
        readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), readRound: () => 1,
        readHead: () => head, appendSendBackEvent: () => {},
        sendBack: () => { sends++; return { ok: !fail, error: 'transport failed' }; },
        postComment: ({ body }) => comments.push({ author: { login: 'web-everything' }, createdAt: '2026-11-14T16:10:00Z', body }),
        dequeueSentBack: () => {}, signalFix: () => {}, log: () => {} };
      const first = await applyRedTeamGate({ repo, pr }, io);
      if (first.status !== 'send-back-failed' || comments.length !== 1) violations.push('failed send-back did not leave an unrecorded retry');
      const tick = { repo, now: Date.parse('2026-11-14T16:10:00Z'), history: new Map(), setting: CONFIRMED_BREAKS_DEFAULTS,
        refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }], rawPrs: [{ number: pr, headRefOid: head, comments }] };
      fail = false;
      // The production runner is synchronous; capture its nomination, then replay the real async apply seam.
      let nominated;
      runGateCatchUp({ ...tick, runGate: input => { nominated = input; return { status: 'applied' }; } });
      if (!nominated) violations.push('already-reviewed head never retried the owed gate');
      else {
        const retried = await applyRedTeamGate(nominated, io);
        if (retried.status !== 'applied' || sends !== 2) violations.push('catch-up did not complete the send-back');
        let duplicate = false;
        runGateCatchUp({ ...tick, now: tick.now + 11 * 60_000, runGate: () => { duplicate = true; } });
        if (duplicate) violations.push('completed send-back was retried');
      }
    } catch (error) { violations.push(`scenario failed: ${error.message}`); }
    return { violations };
  },
  judge: report => report.violations,
};
