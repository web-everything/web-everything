/**
 * PR #6056: an accepted head stays red-team:pending after its running owner dies.
 * Replay the production recovery planner/dispatcher with injected status, owner
 * probes and effects. A pre-fix planner keeps treating the dead writer as in flight.
 * Live and unreadable owners must remain blocked. No processes or network are used.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const RECOVERY = 'scripts/lib/review-red-team-on-skip.mjs';
const JOB = 'scripts/operations/review-job.mjs';
const HEAD = 'c'.repeat(40);
const PR = 6056;
const NOW = Date.parse('2026-10-30T12:00:00Z');

export default {
  id: 'red-team-dead-owner-never-redispatched',
  title: 'an accepted pending red team with a dead running owner is re-dispatched',
  card: 'PR #6056 — stale red-team run recovery',
  fixedBy: {
    sha: 'HEAD', where: 'PR #6056', paths: [RECOVERY, JOB],
  },
  fixPresent(root) {
    try {
      const recovery = readFileSync(join(root, RECOVERY), 'utf8');
      const job = readFileSync(join(root, JOB), 'utf8');
      return recovery.includes('export function staleRedTeamRun(')
        && recovery.includes('abandonStale: true')
        && recovery.includes('redTeamStaleRecovery: true')
        && job.includes('planRedTeamRecovery(')
        && job.includes('redTeamStaleRecovery === true');
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const { runRedTeamOnSkip } = await load(RECOVERY);
      const repo = CONSTELLATION_REPOS.we.slug;
      const payload = { verdict: { verdict: 'accept' }, findings: { read: {
        netBasis: { rev: HEAD }, netChangedFiles: ['scripts/example.mjs'],
        diffText: '+export const value = true;',
      } } };
      for (const owner of ['dead', 'live', 'unreadable']) {
        const status = { repo, pr: PR, head: HEAD, status: 'running', result: null,
          pid: 6056, host: 'soak-host', pidNamespace: 'soak-namespace',
          pidStart: new Date(NOW - 60_000).toISOString() };
        const starts = [], abandoned = [];
        const history = new Map();
        const tick = () => runRedTeamOnSkip({
          repo, env: {}, now: () => NOW, lastDispatch: history,
          setting: { enabled: true, retryCooldownMin: 30 }, capacity: { lanes: 1 },
          plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: PR, headSha: HEAD }] },
          rawPrs: [{ number: PR, headRefOid: HEAD, state: 'OPEN',
            labels: ['review:accepted', 'ready-to-merge', 'red-team:pending'], reviews: [],
            comments: [{ author: { login: 'web-everything' },
              body: `✅ review — accepted\n<!-- reviewed-sha: ${HEAD} -->` }] }],
          readEvidence: () => ({ loopPayload: payload, status, inFlight: true,
            queued: false, recorded: false, seatRecorded: false, completedRecorded: false }),
          readStatus: () => status, readCarry: () => null, readReviews: () => [],
          probe: { host: status.host, namespace: status.pidNamespace,
            isAlive: () => {
              if (owner === 'unreadable') throw Error('injected unreadable owner');
              return owner === 'live';
            }, readPidStart: () => status.pidStart },
          staleSpent: () => false,
          staleRedispatch: () => ({ count: 0, nextOrdinal: 1, firstMarkerMtimeMs: null }),
          recoverPayload: () => payload,
          abandonStale: input => {
            abandoned.push(input);
            return { ok: true, release: () => {} };
          },
          dispatch: input => { starts.push(input); return { jobPid: 42 }; },
          log: line => log?.(line),
        });
        const first = tick();
        if (owner === 'dead') {
          check(starts.length === 1 && first.dispatched.length === 1,
            `#${PR}: stuck at red-team:pending — dead running owner was never re-dispatched`);
          check(abandoned.length === 1 && abandoned[0].status === status,
            'dead owner: recovery did not abandon the stored running pass before dispatch');
          check(starts[0]?.repo === repo && starts[0]?.pr === PR
            && starts[0]?.redTeamOnly === true && starts[0]?.redTeamMode === 'fresh'
            && starts[0]?.redTeamStaleRecovery === true,
          'dead owner: dispatch did not carry fresh stale-run recovery to the review job');
          tick();
          check(starts.length === 1 && abandoned.length === 1,
            'dead owner: next tick bypassed the retry cooldown');
        } else {
          check(starts.length === 0 && abandoned.length === 0 && first.dispatched.length === 0,
            `${owner} owner: recovery must refuse abandonment and dispatch`);
        }
      }
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
