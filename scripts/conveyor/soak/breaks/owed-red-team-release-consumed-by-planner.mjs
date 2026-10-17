/** PR #5461 / #5510: a notes-only fix-daemon pass must not consume the review dispatcher's release. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const CHILD = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const src = process.env.SOAK_SOURCE_ROOT, dir = process.env.SOAK_CASE_DIR;
const load = p => import(pathToFileURL(join(src, p)).href);
const hold = await load('scripts/conveyor/review-referral-hold.mjs');
const { defaultReadNotesForRepo } = await load('skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
const { dispatchReviewByMode } = await load('scripts/operations/review-job.mjs');
const { runRedTeam } = await load('scripts/operations/review-extra-seats.mjs');
// Warm the old reader too: the incident is a long-lived notes daemon winning the receipt race.
await hold.loadRedTeamHoldReaders?.();
const repo = 'red-team-fixture/example', number = 5461;
const head = '3373a3326ef2b649303f7b26b69efabfdfe179a6';
const pr = { number, headRefOid: head, comments: [], labels: ['review:accepted'] };
const row = { repo, pr: number, rev: head, dispatchKind: 'review-seat', seat: 'red-team', status: 'ok',
  provider: 'codex', model: 'saved', callId: 'saved', findings: [] };
const runs = [{ repo, pr: number, head, startedAt: 1, completedAt: 2, rulings: [] }];
const settingsPath = join(dir, 'settings.json'), storePath = join(dir, 'store.json');
const platform = join(dir, 'platform.json'), stateDir = join(dir, 'rearms');
for (const [file, value] of [[settingsPath, {}], [platform, {}], [storePath, { version: 1, records: [row] }]])
  writeFileSync(file, JSON.stringify(value));
const opts = { repo, env: { WE_PLATFORM_PREFERENCES_FILE: platform }, readRuns: () => runs,
  redTeam: { settingsPath, storePath, stateDir, log: () => {} } };
let planned = [], spawned = 0, modelCalls = 0, posts = [];
for (let tick = 0; tick < 3; tick++) defaultReadNotesForRepo({ repo, readPrs: () => [pr],
  reconcile: ({ readPrs }) => {
    planned.push(hold.enrichPrsWithReferralHolds(readPrs(), opts)[0].referralHold);
    return { notes: [] };
  } });
const spentByPlanner = existsSync(stateDir);
const dispatch = allowed => dispatchReviewByMode({ repo, pr: number, mode: 'job', root: '/daemon',
  env: {}, dir: join(dir, 'jobs'), stackCheck: () => ({ base: null }),
  checkStaleness: () => ({ fresh: true, behind: 0 }), readCompletion: () => null,
  resolveSettingsEnv: () => ({}), ciGate: () => ({ allowed, headSha: head, reason: 'unreadable-ci' }),
  isAlive: () => false, beforeSpawn: () => hold.claimReviewDispatch(pr, opts),
  spawnJob: () => { spawned++; return 4242; },
});
dispatch(false);
const spentBySkipped = existsSync(stateDir);
const released = hold.decideSameHeadHold(pr, runs, opts) === null;
if (released) {
  dispatch(true);
  dispatch(true);
  if (spawned) await runRedTeam({ repo, pr: number, env: {}, record: false,
    loopPayload: { verdict: { verdict: 'accept' }, findings: { read: {
      title: 'saved pass', diffText: 'diff --git a/x.mjs b/x.mjs\\n+fixed',
      netChangedFiles: ['x.mjs'], netBasis: { rev: head },
    } } } }, { now: () => Date.now(), readRecords: () => [row], log: () => {},
      listComments: () => [], postComment: p => posts.push(p),
      runSeat: () => { modelCalls++; throw new Error('unexpected model'); } });
}
process.stdout.write(JSON.stringify({ planned, spentByPlanner, spentBySkipped, spawned, modelCalls,
  posted: posts.length === 1 && posts[0].body.includes('pr=5461 rev=' + head) }));
`;

export default {
  id: 'owed-red-team-release-consumed-by-planner',
  title: 'notes-only planning consumes the only release for a saved red-team result whose comment is missing',
  card: 'x9jlvy0; PR #5461 head 3373a33, review finding on PR #5510',
  fixedBy: { sha: 'working-tree', where: 'lane/redteam-comment-retry', paths: [
    'scripts/conveyor/review-referral-hold.mjs', 'scripts/operations/review-job.mjs',
    'scripts/operations/review-dispatch.mjs', 'skills-src/conveyor/review-daemon.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/review-referral-hold.mjs'), 'utf8')
      .includes('export function claimReviewDispatch(');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-owed-red-team-'));
    try {
      const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', CHILD], {
        cwd: sourceRoot, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, SOAK_SOURCE_ROOT: sourceRoot, SOAK_CASE_DIR: dir },
      }));
      log?.(JSON.stringify(result));
      return { violations: [
        ...(result.spentByPlanner || result.planned.some(Boolean) ? ['planning spent or blocked the release'] : []),
        ...(result.spentBySkipped ? ['CI refusal spent the release'] : []),
        ...(result.spawned !== 1 ? ['expected exactly one review dispatch'] : []),
        ...(!result.posted || result.modelCalls ? ['saved result did not post without a model call'] : []),
      ] };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
