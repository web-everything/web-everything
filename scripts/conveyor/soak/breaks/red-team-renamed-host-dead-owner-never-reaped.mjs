/** A renamed Mac left a dead red-team owner unknown to the stall sweep before 931d230. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'red-team-renamed-host-dead-owner-never-reaped', title: 'a stale renamed-host red-team owner with a dead local pid restarts',
  card: 'stall-sweep renamed-host recovery', fixedBy: { sha: '931d230', where: 'stall-sweep foreign-owner probe' },
  fixPresent: root => readFileSync(join(root, 'scripts/conveyor/pr-stall-sweep.mjs'), 'utf8').includes('foreignStaleOwnerDead(status,'),
  async run({ sourceRoot = ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-renamed-red-team-'));
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { runStallSweep, STALL_SWEEP_DEFAULTS } = await load('scripts/conveyor/pr-stall-sweep.mjs');
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const repo = CONSTELLATION_REPOS.we.slug, pr = 6039, head = 'a'.repeat(40);
      const now = Date.parse('2026-10-21T18:00:00Z'), old = new Date(now - 180 * 60_000).toISOString();
      const pid = 99999999, probes = [];
      const out = await runStallSweep({ now, env: {}, dir: join(dir, 'pr-stall-sweep'), log: () => {},
        settings: { value: { ...STALL_SWEEP_DEFAULTS, mode: 'shadow' }, sources: { mode: 'soak' }, errors: [] },
        gh: () => { throw Error('unexpected GitHub call'); },
        read: () => ({ now, unreadable: [], liveJobs: [], drainSkips: [], prs: [{ repo, number: pr,
          title: 'pending red team after Mac rename', state: 'OPEN', isDraft: false, headRefOid: head,
          updatedAt: old, createdAt: old, headCommittedAt: old, body: '', labels: [{ name: 'red-team:pending' }],
          statusCheckRollup: [], labelEvents: [], comments: [] }] }),
        readRedTeamStatus: () => ({ repo, pr, head, status: 'running', result: null,
          host: 'mac-before-rename', pidNamespace: 'soak-ns', pid, pidStart: 'unreadable', startedAt: 'unreadable' }),
        readStatusAt: () => now - 121 * 60_000,
        probe: { host: 'mac-after-rename', namespace: 'soak-ns', isAlive: owner => { probes.push(owner); return false; },
          readPidStart: () => { throw Error('dead pid has no birth time'); } } });
      return { violations: !out.incomplete && out.errors.length === 0 && probes.length === 1 && probes[0] === pid
        && out.act.length === 1 && out.act[0].action === 'restart-red-team'
        && out.act[0].prHead === `${repo}#${pr}@${head}`
        && !out.items.some(item => item.action === 'red-team-owner-unknown')
        ? [] : ['stale renamed-host dead owner was not probed and planned for restart-red-team'] };
    } catch (error) { return { violations: [error.message] }; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
