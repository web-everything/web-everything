/**
 * PR #7188 (2026-11-20 12:36-12:37 ET): the red team confirmed a break and the stall classifier, one minute later, raised
 * ruling-needed "findings missing or malformed" because the findings were not readable yet. Unreadable findings must be
 * pending (no action) for a bounded time, then escalate as findings-stuck.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = 'web-everything/web-everything';
const HEAD = 'c'.repeat(40);

export default {
  id: 'stall-classify-unpublished-findings-ruling-needed',
  title: 'PR #7188: the stall classifier rules "findings missing or malformed" on a red-team confirm whose findings are not yet readable',
  card: 'PR #7188 stall-classify findings race (parked item 26)',
  fixedBy: { sha: '7ea7720c7874f49c183b8379c004f39445b03403', where: 'lane/stall-findings-race', paths: ['scripts/conveyor/pr-stall-classify.mjs'] },
  // The break lands with its fix, so the scenario is always required green (a regression must fail, never read as expected-fail).
  fixPresent() { return true; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    await import(pathToFileURL(join(root, 'scripts/conveyor/pr-stall-settings.mjs')).href); // load order: settings first breaks the import cycle
    const { classifyStall } = await import(pathToFileURL(join(root, 'scripts/conveyor/pr-stall-classify.mjs')).href);
    const violations = [];
    const verdict = { verdict: 'send-back', reasons: ['no-parseable-findings-for-trigger'],
      evidence: { trigger: 'red-team-cap', head: HEAD.slice(0, 12), filesKnown: true, crossBroken: 0, grantsSoFar: 0, guardFiles: [], latest: [], latestCount: 0, classes: { broken: 0, degraded: 0, unconfirmed: 0 } } };
    const at = (ageMinutes) => classifyStall({ head: HEAD, verdict, files: ['scripts/foo.mjs'], row: { repo: REPO, number: 7188,
      waitingOn: 'ruling-needed:red-team-round-cap', actor: 'operator', stalled: true, liveJob: null, why: 'x', evidence: [], next: { summary: 's', command: 'c' }, ageMinutes } });
    const fresh = at(2);
    if (fresh !== null) violations.push(`unreadable findings one minute after the confirm were ruled on (${fresh.action})`);
    const stuck = at(500);
    if (stuck?.action !== 'findings-stuck') violations.push(`findings unreadable for hours did not escalate as findings-stuck (${stuck?.action ?? 'null'})`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
