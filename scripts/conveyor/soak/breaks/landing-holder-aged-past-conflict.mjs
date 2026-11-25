import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export default {
  id: 'landing-holder-aged-past-conflict',
  title: 'aging retains and escalates a confirmed landing-holder conflict',
  card: 'LANDING-HOLDER-TIMEOUT v2',
  fixedBy: { sha: 'uncommitted', where: 'landing holder aging protection', paths: ['scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  fixPresent() { return true; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { filterFixesByInFlightScope, recordLandingHolderEscalation } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs')).href);
    const { createLiveRegionOverlap, resolveFixScopePolicy } = await import(pathToFileURL(join(root, 'scripts/conveyor/fix-scope-policy.mjs')).href);
    const now = Date.parse('2026-11-25T12:00:00Z'), since = new Date(now - 120 * 60000).toISOString();
    const scope = ['we:scripts/conveyor/reconcile-fix-dispatch.mjs'];
    const out = filterFixesByInFlightScope([{ pr: 80, scope, waitingSince: since }], [], [], {
      now, rebaseExempt: null,
      policy: resolveFixScopePolicy({ env: {}, platform: {}, readTool: () => ({ fixScope: { priorityBypass: false } }) }),
      regionOverlap: () => ({ overlap: true, conflict: true, why: 'confirmed trial merge conflict' }),
      holderState: () => ({ labels: ['review:accepted'] }), landingHolders: [{ pr: 90, scope, headRefOid: 'head' }],
      landingBlockedSince: new Map([['80:90', since]]),
    });
    const violations = [];
    if (out.planned.length || out.refusals[0]?.kind !== 'scope-overlap') violations.push('waiter admitted past confirmed landing conflict');
    if (out.landingEscalations?.length !== 1 || out.landingEscalations[0].holder !== 90) violations.push('stuck holder was not escalated');
    // Live send-back: holder state is unreadable and only a running claim names the holder.
    // Cover both the acquisition head and the final fallback to the current region observation.
    for (const headSha of ['claim-head', null]) {
      const policy = resolveFixScopePolicy({ env: {}, platform: {}, readTool: () => ({ fixScope: { priorityBypass: false } }) });
      const since = new Date(now - 720 * 60000).toISOString();
      const regionOverlap = createLiveRegionOverlap({
        readPrHeads: () => new Map([[90, 'observed-head']]), policy,
        regionReader: { hunksFor: () => new Map([[scope[0].replace(/^we:/, ''), [[1, 2]]]]), mergeConflicts: () => true },
      });
      const held = filterFixesByInFlightScope([{ pr: 80, scope, headRefOid: 'waiter-head', waitingSince: since }], [],
        [{ meta: { pr: 90, scope, ...(headSha ? { headSha } : {}) } }], {
          now, rebaseExempt: null, policy, regionOverlap, holderState: () => null,
          landingBlockedSince: new Map([['80:90', since]]),
        });
      if (held.planned.length || held.landingEscalations?.length !== 1
        || held.landingEscalations[0].holderHead !== (headSha || 'observed-head')) {
        violations.push(`720-minute live claim lost its holder head (${headSha || 'observed only'})`);
      }
      const comments = [];
      let posts = 0, notifications = 0;
      const record = () => recordLandingHolderEscalation({
        escalation: held.landingEscalations?.[0], repo: 'owner/repo', readPrComments: () => comments,
        postComment: ({ body }) => { posts++; comments.push({ body, viewerDidAuthor: true }); return { ok: true }; },
        notify: () => { notifications++; },
      });
      record(); record();
      if (posts !== 1 || notifications !== 1) violations.push(`720-minute live claim stayed silent or repeated its note (${headSha || 'observed only'})`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
