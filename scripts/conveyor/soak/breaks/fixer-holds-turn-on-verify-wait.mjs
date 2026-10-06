/**
 * @file breaks/fixer-holds-turn-on-verify-wait.mjs — live break, 2026-10-05/06 (card we:backlog/5137). Fixers held
 * their turn open on `verify-lane check --wait=540000`, re-running it on every 9-minute timeout: 54 timeouts / ~486
 * min on 2026-10-05, 15 / ~135 min 12:00–15:30 ET on 2026-10-06. fix-4115 (session 0c5f3830) hit 4 in one run and
 * pushed b9657499, a sha no verdict ever named (it verified a dirty tree on 65a382e8, then committed).
 *
 * FIX — `scripts/conveyor/await-verify-pass.mjs` in the fix daemon's tick: the fixer commits, requests, records the
 * wait and ends its turn; the daemon pushes only an exact-sha green and resumes the SAME session otherwise.
 *
 * SCENARIO: fix-4115's three real verify requests (timestamps from its transcript) replayed tick by tick (120 s)
 * through the tree's own pass with in-memory IO. RED = the tree has no harness pass (the model owns the wait), or
 * the pass re-requests a merely-running verify, pushes any sha but a green verdict's own, or misses a resume.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const PASS = 'scripts/conveyor/await-verify-pass.mjs';
const at = (hms) => Date.parse(`2026-10-06T${hms}Z`);
const C1 = '65a382e81413952ab11e5448e36f01bb7ce4c332';
const C2 = 'c'.repeat(40); // R2's tree had no commit of its own in the real run; under the fix it must be one
const C3 = 'b96574995e22b8d8087d4a28b7ba7615d4ec8c73';
const REQUESTS = [
  { sha: C1, requested: at('19:55:10'), settled: at('20:21:41'), status: 'green' }, // real: 2 timeouts first
  { sha: C2, requested: at('20:22:48'), settled: at('20:37:05'), status: 'red' }, // real: 1 timeout first
  { sha: C3, requested: at('20:37:14'), settled: at('20:54:55'), status: 'green' }, // real: 1 timeout first
];

export async function replay(root = REPO_ROOT) {
  if (!existsSync(join(root, PASS))) return { harness: false };
  const { runAwaitVerifyPass } = await import(pathToFileURL(join(root, PASS)).href);
  const store = new Map();
  const pushes = []; const resumes = []; const rerequests = [];
  const state = {};
  const base = { v: 1, sessionId: '0c5f3830-1522-49ab-8f20-e4108ccc926b', who: 'fix-4115', repo: CONSTELLATION_REPOS.we.slug,
    pr: 4115, lane: '/lanes/lane-5', ref: 'lane/item-68b', kind: 'fix' };
  const io = {
    listRecords: () => [...store.entries()].map(([key, record]) => ({ key, record })),
    writeRecord: (r) => { store.set(r.sessionId, r); return { ok: true }; },
    clearRecord: (key) => { store.delete(key); },
    laneState: () => state.lane,
    readMarker: () => state.marker,
    rerequest: (lane) => { rerequests.push(lane); return { ok: true, status: 'requested' }; },
    push: (a) => { pushes.push(a.sha); return { ok: true }; },
    listSessions: () => [{ sessionId: base.sessionId, name: 'fix-4115', cwd: '/scratch', state: 'done' }],
    resume: (a) => { resumes.push((a.prompt.match(/GREEN|RED/) ?? ['?'])[0]); return { resumed: true }; },
  };
  let current = -1;
  for (let t = at('19:55:00'); t <= at('21:05:00'); t += 120_000) {
    const next = REQUESTS[current + 1];
    if (next && t >= next.requested && store.size === 0) {
      current += 1;
      store.set(base.sessionId, { ...base, sha: next.sha, attempt: current === 2 ? 2 : 1, requestedAt: new Date(next.requested).toISOString() });
    }
    const r = REQUESTS[current];
    if (!r) continue;
    state.lane = { head: r.sha, dirty: false, treeHash: 'f'.repeat(64) };
    state.marker = { sha: r.sha, status: t >= r.settled ? r.status : 'running', startedAt: new Date(r.requested).toISOString(),
      treeHash: 'f'.repeat(64), exitCode: t >= r.settled ? (r.status === 'green' ? 0 : 1) : null };
    await runAwaitVerifyPass({ io, nowMs: t, ttlMs: 150 * 60_000 });
  }
  return { harness: true, pushes, resumes, rerequests: rerequests.length, leftover: store.size };
}

export default {
  id: 'fixer-holds-turn-on-verify-wait',
  title: 'fixers held their turn on 9-minute verify-lane waits (54 timeouts / ~486 min in a day) and pushed shas no verdict named',
  card: 'we:backlog/5137 (slices 2+3)',
  fixedBy: { sha: '6b21b40a8,262ee8d7d', where: 'lane/5137-s2-s3', paths: [PASS, 'scripts/conveyor/await-verify.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'] },
  fixPresent(root) { return existsSync(join(root, PASS)); },
  async run({ log } = {}) {
    try {
      const report = await replay();
      log?.(JSON.stringify(report));
      const violations = [];
      if (!report.harness) violations.push({ invariant: 'model-owns-wait', detail: 'no harness verdict pass: the fixer must hold its turn on check --wait' });
      else {
        if (report.rerequests) violations.push({ invariant: 'timeout-loop', detail: `${report.rerequests} re-request(s) of a merely-running verify` });
        if (JSON.stringify(report.pushes) !== JSON.stringify([C1, C3])) violations.push({ invariant: 'unverified-push', detail: `pushed ${JSON.stringify(report.pushes)}; only the green verdicts' own shas may be pushed` });
        if (JSON.stringify(report.resumes) !== JSON.stringify(['GREEN', 'RED', 'GREEN'])) violations.push({ invariant: 'missed-resume', detail: `resumes ${JSON.stringify(report.resumes)}` });
        if (report.leftover) violations.push({ invariant: 'stranded-record', detail: `${report.leftover} await record(s) left` });
      }
      return { violations, report };
    } catch (e) {
      return { violations: [{ invariant: 'crash', detail: String(e?.stack || e).split('\n').slice(0, 3).join(' ') }] };
    }
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
