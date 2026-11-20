import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const CATCHUP = 'scripts/lib/red-team-gate-catchup.mjs';

export default {
  id: 'red-team-mixed-gate-capability-off',
  title: 'mixed catch-up preserves safety send-backs when review capability is off',
  card: 'PR #7097: mixed send-back/card capability ruling',
  fixedBy: { sha: 'HEAD', where: 'HEAD', paths: [CATCHUP, 'scripts/operations/red-team-gate-apply.mjs'] },
  fixPresent() { return true; },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    try {
      const { runGateCatchUp } = await import(pathToFileURL(join(sourceRoot, CATCHUP)).href);
      const { applyRedTeamGate, createRedTeamGateIo } = await import(pathToFileURL(join(sourceRoot, 'scripts/operations/red-team-gate-apply.mjs')).href);
      const { CONFIRMED_BREAKS_DEFAULTS } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/red-team-gate.mjs')).href);
      const { repoProfile } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/repo-profile.mjs')).href);
      const fileCard = createRedTeamGateIo().fileCard;
      for (const repo of [repoProfile('longshore').slug, 'unknown/repo']) {
        for (const kind of ['send-only', 'mixed', 'card-only']) {
          const pr = 7097, head = 'a'.repeat(40), label = `${repo} ${kind}`;
          const findings = kind === 'card-only'
            ? '1. [**confirmed**] (edge-case, degraded) `scripts/y.mjs:1` — degradation'
            : '1. [**confirmed**] (edge-case, broken) `scripts/x.mjs:1` — safety break'
              + (kind === 'mixed' ? '\n2. [**confirmed**] (edge-case, degraded) `scripts/y.mjs:1` — degradation' : '');
          const comments = [{ author: { login: 'web-everything' }, createdAt: '2026-11-14T15:50:00Z',
            body: `<!-- we:red-team-advisory pr=${pr} rev=${head} -->\n${findings}` }];
          let sends = 0, cards = 0, nominated;
          const io = {
            readPr: () => ({ headRefOid: head, comments, labels: [] }),
            readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), readRound: () => 1,
            readHead: () => head, appendSendBackEvent: () => {}, dequeueSentBack: () => {},
            sendBack: () => { sends++; return { ok: true }; },
            fileCard: input => {
              cards++;
              if (input.repo !== repo) violations.push(`${label}: card admission lost the repo identity`);
              return fileCard(input);
            },
            postComment: ({ body }) => comments.push({ body, author: { login: 'web-everything' }, createdAt: '2026-11-14T16:10:00Z' }),
            log: () => {},
          };
          const tick = { repo, now: Date.parse('2026-11-14T16:10:00Z'), history: new Map(),
            setting: CONFIRMED_BREAKS_DEFAULTS, readGrantScope: () => null,
            refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
            rawPrs: [{ number: pr, headRefOid: head, comments }] };
          // The production callback is synchronous; replay its nomination through the real async gate.
          runGateCatchUp({ ...tick, runGate: input => { nominated = input; return { status: 'applied' }; } });
          if (kind === 'card-only') {
            if (nominated) violations.push(`${label}: catch-up nominated new card work`);
            continue;
          }
          if (!nominated) { violations.push(`${label}: safety send-back suppressed`); continue; }
          const applied = await applyRedTeamGate(nominated, io);
          if (sends !== 1 || !comments.some(c => c.body.includes('outcome=sent-back'))) {
            violations.push(`${label}: send-back was not recorded`);
          }
          if (kind === 'mixed') {
            if (applied.status !== 'card-failed' || !applied.error?.includes('capability unavailable') || cards !== 1) {
              violations.push(`${label}: live card admission did not refuse prevention work`);
            }
            // A direct gate retry may revisit the refused card, but cannot repeat the safety action.
            await applyRedTeamGate(nominated, io);
            if (sends !== 1) violations.push(`${label}: card retry repeated the send-back`);
          } else if (applied.status !== 'applied' || cards !== 0) {
            violations.push(`${label}: pure safety maintenance changed`);
          }
          let duplicate = false;
          runGateCatchUp({ ...tick, history: new Map(), now: tick.now + 11 * 60_000,
            runGate: () => { duplicate = true; } });
          if (duplicate) violations.push(`${label}: persisted send-back was nominated again`);
        }
      }
    } catch (error) { violations.push(`scenario failed: ${error.message}`); }
    return { violations };
  },
  judge: report => report.violations,
};
