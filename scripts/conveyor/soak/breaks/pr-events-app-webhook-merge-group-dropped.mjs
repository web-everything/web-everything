/**
 * GH-WEBHOOK-PR-EVENTS (2026-11-24): the pr-events receiver only knew the repo hook's secret and dropped
 * merge_group deliveries, and daemons read events through GitHub shapes with no gap flag on a skipped seq, so an
 * app-webhook feed could not wake them and a lost event was silent. Fixed: app secret binding, merge_group kept,
 * seq-gap detection behind the forge.change-events port.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FIX_SHA = '061d000719befb220bc2b509c2b0749880515f0b';

export default {
  id: 'pr-events-app-webhook-merge-group-dropped',
  title: 'GH-WEBHOOK-PR-EVENTS: an app-signed merge_group delivery is rejected or dropped, and a skipped feed seq is not flagged as a gap',
  card: 'GH-WEBHOOK-PR-EVENTS (forge.change-events)',
  fixedBy: { sha: FIX_SHA, where: 'lane/gh-webhook-pr-events', paths: ['scripts/conveyor/pr-events-worker/core.mjs', 'scripts/lib/forge-adapter/change-events.mjs'] },
  fixPresent(root) {
    // Git ancestry first; a squash merge rewrites the sha, so fall back to the port module existing in the tree.
    const anc = spawnSync('git', ['merge-base', '--is-ancestor', FIX_SHA, 'HEAD'], { cwd: root, stdio: 'ignore' });
    return anc.status === 0 || existsSync(join(root, 'scripts/lib/forge-adapter/change-events.mjs'));
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const violations = [];
    const core = await import(pathToFileURL(join(root, 'scripts/conveyor/pr-events-worker/core.mjs')).href);
    const body = JSON.stringify({ action: 'checks_requested', repository: { full_name: 'o/r' }, merge_group: { head_sha: 'c'.repeat(40), head_ref: 'refs/heads/gh-readonly-queue/main/pr-7-x' } });
    const log = core.createEventLog(core.createMemoryStorage());
    const sig = await core.signBody('appsec', body);
    const res = await core.handleRequest(new Request('https://x/github/webhook', { method: 'POST', body,
      headers: { 'x-github-event': 'merge_group', 'x-github-delivery': 'soak-1', 'x-hub-signature-256': sig } }),
    { GITHUB_APP_WEBHOOK_SECRET: 'appsec' }, { getLog: () => log });
    if (res.status !== 202) violations.splice(0, 0, `app-signed merge_group answered ${res.status}, not 202`);
    try {
      const { detectSeqGap } = await import(pathToFileURL(join(root, 'scripts/lib/forge-adapter/change-events.mjs')).href);
      if (!detectSeqGap(2, [{ seq: 4 }])) violations.splice(0, 0, 'a skipped seq was not flagged as a gap');
    } catch { violations.splice(0, 0, 'forge.change-events port missing'); }
    return { violations };
  },
  judge: (report) => report.violations,
};
