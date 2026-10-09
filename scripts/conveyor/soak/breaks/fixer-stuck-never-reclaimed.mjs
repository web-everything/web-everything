/**
 * @file breaks/fixer-stuck-never-reclaimed.mjs — live break, 2026-10-08 (PR #4453, card xccgzu5). The health watch
 * flagged `[high] fixer-stuck pr:we#4453` for 14+ minutes and nothing reclaimed it.
 *
 * LIVE INCIDENT: `ci-heal-4453` pushed its heal (299805a8), marked an await-verify wait for that same commit and sat
 * idle about an hour. It held the fix claim and a reserved ci-heal slot, which starved #4447/#4439 and scope-blocked
 * #4446. The session watchdog wrote a `session-watchdog.fixer-stuck` event, but no code read `fixer-escalations.jsonl`.
 *
 * FIX — `scripts/conveyor/fixer-stuck-reclaim.mjs`, run every fix-daemon tick: an unacked event whose session still
 * holds the claim, with no verify in flight for an UNPUSHED commit, is reclaimed (stop, fix-end, release, ack).
 *
 * SCENARIO: the recorded event, claim and await record replayed at 15:40Z. RED = the tree has no consumer, or it
 * does not decide `reclaim` for #4453. GREEN = it does, and a verify wait for an unpushed commit is still held.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const SID = '5536e97f-1795-4eb5-9bd1-be2de08cebdc';
const PUSHED = '299805a8e8b296093ca432a54f119fca437dc1ca';
const CLAIMED = '2a2d454d13be533b1bd72519d1984bfb8a704c1d';

export default {
  id: 'fixer-stuck-never-reclaimed',
  title: 'a fixer flagged fixer-stuck kept its PR fix claim and ci-heal slot for an hour because nothing consumed the escalation event',
  card: 'we:backlog/5450 (epic #3383)',
  fixedBy: { sha: '1f7995d55', where: 'lane/fixer-stuck-reclaim', paths: ['scripts/conveyor/fixer-stuck-reclaim.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'] },
  fixPresent(root) { return existsSync(join(root, 'scripts/conveyor/fixer-stuck-reclaim.mjs')); },
  async run({ log } = {}) {
    const file = join(REPO_ROOT, 'scripts/conveyor/fixer-stuck-reclaim.mjs');
    if (!existsSync(file)) return { violations: [{ invariant: 'no-consumer', detail: 'nothing reads fixer-escalations.jsonl — the #4453 event waits forever' }] };
    const { planFixerStuckReclaim } = await import(pathToFileURL(file).href);
    const event = {
      type: 'session-watchdog.fixer-stuck', v: 1, key: `we#4453|${SID}|stalled|${CLAIMED}`, at: '2026-10-08T15:06:53.789Z',
      repo: 'we', pr: 4453, session: { name: 'ci-heal-4453', id: '5536e97f', sessionId: SID }, classification: 'stalled', reason: 'idle', headSha: CLAIMED,
    };
    const claims = [{ owner: 'fixer:ci-heal-4453', meta: { kind: 'fixing', repo: 'we', pr: 4453, who: 'ci-heal-4453', sessionId: SID } }];
    const record = { v: 1, sessionId: SID, pr: 4453, sha: PUSHED, requestedAt: '2026-10-08T15:11:32.206Z', kind: 'ci-heal' };
    const common = { events: [event], acked: new Set(), claims, awaitFor: () => record, lastActivityMsFor: () => Date.parse('2026-10-08T14:31:02Z'), nowMs: Date.parse('2026-10-08T15:40:00Z') };
    const live = planFixerStuckReclaim({ ...common, prHeadFor: () => PUSHED })[0];
    const unpushed = planFixerStuckReclaim({ ...common, prHeadFor: () => CLAIMED })[0];
    // Review of #4468: a destructive reclaim must never rest on MISSING evidence (unreadable transcript), and an unbound
    // claim's name match must not reclaim a re-dispatched same-named session on the strength of an older event.
    const unknownActivity = planFixerStuckReclaim({ ...common, prHeadFor: () => PUSHED, lastActivityMsFor: () => null })[0];
    const unboundClaims = [{ owner: 'fixer:ci-heal-4453', meta: { kind: 'fixing', repo: 'we', pr: 4453, who: 'ci-heal-4453', claimedAt: '2026-10-08T15:20:00Z' } }];
    const staleEvent = planFixerStuckReclaim({ ...common, claims: unboundClaims, prHeadFor: () => PUSHED })[0];
    log?.(JSON.stringify({ live, unpushed, unknownActivity, staleEvent }));
    const violations = [];
    if (unknownActivity?.decision !== 'hold') violations.push({ invariant: 'reclaimed-on-unknown-activity', detail: `a stalled session with unreadable activity decided ${unknownActivity?.decision}` });
    if (staleEvent?.decision !== 'ack') violations.push({ invariant: 'stale-event-hit-redispatched-session', detail: `an event older than the unbound claim decided ${staleEvent?.decision}` });
    if (live?.decision !== 'reclaim') violations.push({ invariant: 'stuck-fixer-not-reclaimed', detail: `#4453 decided ${live?.decision ?? 'nothing'} (${live?.reason ?? ''})` });
    if (unpushed?.decision !== 'hold') violations.push({ invariant: 'unpushed-verify-reclaimed', detail: `a verify wait for an unpushed commit decided ${unpushed?.decision}` });
    return { violations };
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
