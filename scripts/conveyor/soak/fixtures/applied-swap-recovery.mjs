/** Hermetic applied-swap fixture: real store, witness, abandonment and job admission. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { pidNamespace } from '../../../lib/pid-alive.mjs';
import { newRunRecord, writeRun } from '../../../operations/run-store.mjs';
import { readRecoveryWitness, readDrainRedTeamEvidence, redTeamStatusDir, ABANDONED_REVIEW_AFTER_MS } from '../../../lib/drain-red-team-evidence.mjs';
import { abandonStaleRedTeamRun, planRedTeamOnSkip, recoveryProbe } from '../../../lib/review-red-team-on-skip.mjs';
import { createReviewJobIo, runReviewJob } from '../../../operations/review-job.mjs';

export function appliedSwapFixture() {
  const root = mkdtempSync(join(tmpdir(), 'applied-swap-'));
  const now = Date.now(), horizon = ABANDONED_REVIEW_AFTER_MS;
  const env = { WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_UNDER_TEST: '1' };
  const key = { repo: 'web-everything/web-everything', pr: 7493, head: 'b'.repeat(40), env, runsDir: env.WE_SHARED_RUNS_DIR };
  const run = { ...newRunRecord({ id: 'review-pr-applied-swap', op: 'review-pr', input: { repo: key.repo, pr: key.pr } }),
    verdict: { verdict: 'accept', findings: [] }, findings: { confirm: 'accept',
      read: { netBasis: { rev: key.head }, diffText: '+code', netChangedFiles: ['scripts/example.mjs'] } },
    pending: { kind: 'effect', step: 'record', stepIndex: 12 },
    effects: [{ key: 'swap', type: 'review.label-swap', stepIndex: 12, index: 0, status: 'pending',
      unknownAttempts: 1, error: null, idempotent: false,
      payload: { repo: key.repo, pr: key.pr, reviewedHead: key.head, to: 'accepted',
        addLabel: 'review:accepted', removeLabels: ['review:pending'] } },
      { key: 'ledger', type: 'verdict-ledger.append', stepIndex: 12, index: 1, status: 'declared' }],
    stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(now - 4 * horizon).toISOString() }] };
  const save = (value = run, age = horizon + 1000) => {
    writeRun(value, key.runsDir);
    const at = new Date(now - age);
    utimesSync(join(key.runsDir, `${value.id}.json`), at, at);
  };
  save();
  mkdirSync(redTeamStatusDir(env), { recursive: true });
  const statusPath = join(redTeamStatusDir(env), `${encodeURIComponent(key.repo)}-${key.pr}-${key.head}.json`);
  writeFileSync(statusPath, JSON.stringify({ repo: key.repo, pr: key.pr, head: key.head, status: 'running', result: null,
    pid: 99999999, pidStart: 'dead-birth', host: hostname(), pidNamespace: pidNamespace(), loopPayload: run }));
  const old = new Date(now - 8 * horizon);
  utimesSync(statusPath, old, old);
  let labels = ['review:accepted'], labelFailure = null, reads = 0;
  const readLiveLabels = () => { reads++; if (labelFailure) throw labelFailure; return labels; };
  const witness = (options = {}) => readRecoveryWitness({ ...key, now, readScorecards: () => [], readLiveLabels, ...options });
  const probe = recoveryProbe();
  const setting = { enabled: true, retryCooldownMin: 30 };
  const decide = (options = {}) => planRedTeamOnSkip({ repo: key.repo,
    refusals: [{ kind: 'already-reviewed-head', prNumber: key.pr, headSha: key.head }],
    rawPrs: [{ number: key.pr, headRefOid: key.head, labels: ['review:accepted'], comments: [], reviews: [] }],
    readWitness: witness, readEvidence: () => readDrainRedTeamEvidence({ ...key, now, readScorecards: () => [] }),
    readReviewRuns: () => [], headNeverReviewed: () => false, setting, now, lastDispatch: new Map(),
    recoveryOptions: { now, deadlineMs: 7200000, probe }, ...options })[0];
  const abandon = (options = {}) => abandonStaleRedTeamRun(key, { readWitness: witness, now: () => now, probe, setting, ...options });
  const makeJobIo = (options = {}) => createReviewJobIo({ env, readLiveLabels, readSeatRecords: () => [], recoveryProbe: probe,
    readEvidence: () => readDrainRedTeamEvidence({ ...key, readScorecards: () => [] }),
    // Status labels have their own IO boundary; use the fixture's live-label probe here too.
    statusLabelProvider: {
      readPrState: (repo, pr) => ({ headRefOid: key.head, labels: readLiveLabels({ repo, pr }) }), readComments: () => [],
      ensureLabel: () => {}, setLabels: (_repo, _pr, { add, remove = [] }) => {
        labels = labels.filter(label => !remove.includes(label));
        if (add && !labels.includes(add)) labels.push(add);
      },
    },
    exec: () => { throw Error('external command forbidden'); }, log: () => {}, ...options });
  const attempts = { spawns: 0 };
  const attempt = (production = makeJobIo(), onSpawn = () => {}) => runReviewJob({ pr: key.pr, repo: key.repo,
    redTeamOnly: true, redTeamMode: 'fresh' }, {
    ...production, root, now: () => now, newActorId: () => 'fixture-actor', liveHead: () => key.head,
    readPrevCompletion: () => null, claim: () => ({ ok: true }), updateRecord: () => {}, unclaim: () => {},
    acquireLane: () => ({ lanePath: root }), releaseLane: () => {}, log: () => {}, report: () => {},
    prepareLane: () => ({ head: key.head }), fetchRedTeamHead: () => ({ head: key.head }),
    runRedTeam: () => { attempts.spawns++; onSpawn(); return { status: 'ran', findings: [], comment: { status: 'posted' } }; },
    runRedTeamGate: () => ({ status: 'ok', outcome: 'advisory' }),
  });
  return { root, key, now, horizon, run, save, statusPath, witness, probe, setting, decide, abandon, makeJobIo, attempt, attempts,
    get reads() { return reads; }, set labels(value) { labels = value; }, set labelFailure(value) { labelFailure = value; },
    runBytes: () => readFileSync(join(key.runsDir, `${run.id}.json`), 'utf8'),
    close: () => rmSync(root, { recursive: true, force: true }) };
}
