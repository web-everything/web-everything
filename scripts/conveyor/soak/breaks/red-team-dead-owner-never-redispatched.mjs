/** #7537: real raw queued writer, daemon abandonment, argv parser, CAS admission and publication. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'red-team-dead-owner-never-redispatched', title: 'a dead queued red-team owner recovers once and settles',
  card: '#7537', fixedBy: { sha: '7537', where: 'raw-witness recovery' },
  fixPresent: root => readFileSync(join(root, 'scripts/operations/review-job.mjs'), 'utf8').includes('planRedTeamRecovery(witness'),
  async run({ sourceRoot = ROOT, staleClaim = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-dead-red-team-'));
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const e = await load('scripts/lib/drain-red-team-evidence.mjs'), r = await load('scripts/lib/review-red-team-on-skip.mjs');
      const j = await load('scripts/operations/review-job.mjs'), runs = await load('scripts/operations/run-store.mjs');
      const { redTeamMarker } = await load('scripts/lib/red-team-gate.mjs');
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const repo = CONSTELLATION_REPOS.we.slug, pr = 6039, head = 'a'.repeat(40), comments = [], events = [];
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_RED_TEAM_STALE_RUN_MS: '1000', WE_RED_TEAM_STATUS_LABELS: '0' };
      const key = { repo, pr, head, env }, loopPayload = { verdict: { verdict: 'accept' },
        findings: { read: { netBasis: { rev: head }, diffText: '+code', netChangedFiles: ['scripts/example.mjs'] } } };
      runs.writeRun({ ...runs.newRunRecord({ id: 'review-pr-soak', op: 'review-pr', input: { repo, pr } }), ...loopPayload }, env.WE_SHARED_RUNS_DIR);
      mkdirSync(e.redTeamStatusDir(env), { recursive: true });
      const statusPath = join(e.redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
      writeFileSync(statusPath, JSON.stringify({ repo, pr, head,
        status: 'queued', result: null, pid: 99999999, host: 'foreign', pidStart: new Date(Date.now() - 2000).toISOString(), loopPayload: {} }));
      if (staleClaim) {
        writeFileSync(`${statusPath}.retry-claim`, '99999999\n');
        const old = new Date(Date.now() - 60_000); utimesSync(`${statusPath}.retry-claim`, old, old);
      }
      const readWitness = () => e.readRecoveryWitness({ ...key, readScorecards: () => [] });
      const production = j.createReviewJobIo({ root: dir, env, readWitness, readEvidence: () => ({}) });
      let calls = 0, out;
      const arc = { root: dir, now: Date.now, newActorId: () => 'soak', readPrevCompletion: () => null,
        claim: () => ({ ok: true }), updateRecord: () => {}, unclaim: () => {}, acquireLane: () => ({ lanePath: dir }),
        releaseLane: () => {}, report: () => {}, log: () => {}, prepareLane: () => ({ head }), fetchRedTeamHead: () => ({ head }),
        readRedTeamOnlyPayload: production.readRedTeamOnlyPayload, redTeamStatus: production.redTeamStatus,
        runRedTeam: () => { calls++; comments.push({ body: redTeamMarker(pr, head), author: { login: 'web-everything' } }); return { status: 'ran', findings: [], comment: { status: 'posted' } }; } };
      const tick = () => r.runRedTeamOnSkip({ repo, env, readWitness, readEvidence: () => ({}), readStatus: () => e.readRedTeamStatus(key),
        plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
        rawPrs: [{ number: pr, headRefOid: head, comments }], capacity: { lanes: 1 },
        setting: { enabled: true, retryCooldownMin: 0 }, lastDispatch: new Map(),
        abandon: () => { const result = r.abandonStaleRedTeamRun(key, { readWitness }); events.push('abandon'); return result; },
        dispatch: options => j.dispatchReviewJob({ ...options, root: dir, dir: join(dir, 'jobs'),
          checkStaleness: () => ({ stale: false }), readCompletion: () => null, resolveSettingsEnv: () => ({}), checkoutExists: () => true,
          spawnJob: ({ argv }) => { events.push('spawn'); j.runReviewJobCli(argv.slice(1), { runJob: input => (out = j.runReviewJob(input, arc)) }); return 123; } }) });
      const first = tick(), second = tick();
      return { violations: first.dispatched.length === 1 && second.dispatched.length === 0 && calls === 1
        && comments.length === 1 && out?.redTeam?.status === 'ran' && readWitness().rawWriter.parsed.status === 'finished'
        && events.join(',') === 'abandon,spawn' ? [] : ['dead queued owner did not abandon, dispatch and publish exactly once'] };
    } catch (error) { return { violations: [error.message] }; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
