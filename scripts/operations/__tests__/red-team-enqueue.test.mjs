import { describe, expect, it, vi } from 'vitest';
import { redTeamEnqueueOperation, createRedTeamEnqueueSinks, RED_TEAM_ENQUEUE_EFFECT } from '../red-team-enqueue.mjs';
import { redTeamRequestBody, redTeamRequestForHead } from '../../lib/red-team-request.mjs';
import { parseOperationArgv, runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { resolveOperation } from '../run.mjs';
import { planRedTeamOnSkip, planRedTeamNomination, runRedTeamOnSkip } from '../../lib/review-red-team-on-skip.mjs';
import { readPlannerRows } from '../../lib/red-team-planner-row.mjs';
import { createRedTeamDispatchQueue, runWithRedTeamQueue } from '../../lib/red-team-dispatch-queue.mjs';
import { redTeamMarker } from '../../lib/red-team-gate.mjs';
import { planReconcile } from '../../conveyor/reconcile-core.mjs';
import { buildClearedHumanMarker, buildReviewedShaMarker } from '../../lib/review-escalation.mjs';
import { REARM_COMMENT_MARKER } from '../../conveyor/rearm-review.mjs';
import { REVIEW_TIMING_DEFAULTS } from '../../lib/review-timing.mjs';

const repo = 'web-everything/web-everything', pr = 6938, head = 'e'.repeat(40);
const input = { repo, pr, reason: 'head moved after the last red team' };
const trusted = body => ({ body, author: { login: 'web-everything' } });
const check = (name, conclusion = 'failure', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });
const live = () => ({ number: pr, state: 'OPEN', isDraft: false, headRefOid: head,
  files: [{ path: 'scripts/guard.mjs', additions: 5, deletions: 2 }],
  labels: ['review:human'], comments: [], reviews: [],
  statusCheckRollup: [check('test', 'success'), check('review-gate'), ...REVIEW_TIMING_DEFAULTS.fastChecks.we.map(name => check(name, 'success'))] });
const planning = () => ({ env: {}, now: 2_000_000, setting: { enabled: true, retryCooldownMin: 30 },
  lastDispatch: new Map(), readWitness: null, readCarry: () => null, readReviewRuns: () => [],
  readStatus: () => null, readEvidence: () => ({ inFlight: false, queued: false, recorded: false,
    seatRecorded: false, completedRecorded: false, cleanRecorded: false }) });
const plan = (raw = live(), refusal = { kind: 'review-ci', prNumber: pr, headSha: head }, requiredChecks = ['test', 'review-gate']) => {
  const result = { refusals: refusal ? [refusal] : [], plannerOptions: { requiredChecks } };
  return { ...result, plannerRows: readPlannerRows({ repo, plan: result, rawPrs: [raw] }) };
};
function fixture(over = {}) {
  const deps = { readLive: vi.fn(live), readComments: vi.fn(() => []), readReviews: vi.fn(() => []),
    readPlan: vi.fn(() => plan()), planning: planning(), post: vi.fn(), ...over };
  return { ...deps, run: request => createRedTeamEnqueueSinks(deps)[RED_TEAM_ENQUEUE_EFFECT](request ?? input) };
}

describe('registered red-team-enqueue', () => {
  it('derives the CLI, defaults repo, and records a live-head request through the effect', async () => {
    const f = fixture();
    const operation = resolveOperation('red-team-enqueue');
    expect(operation.declaration.name).toBe('red-team-enqueue');
    const out = await runOperationCli({ ...operation,
      sinks: createRedTeamEnqueueSinks(f), store: createMemoryRunStore(),
      newRunId: () => 'red-team-enqueue-test', argv: [`--pr=${pr}`, `--reason=${input.reason}`] });
    expect(out.code).toBe(0);
    expect(f.post).toHaveBeenCalledOnce();
    const request = f.post.mock.calls[0][0];
    expect(request).toMatchObject({ ...input, head });
    expect(redTeamRequestForHead([trusted(request.body)], { repo, pr, head })).toMatchObject({ ...input, head });
  });
  it.each(['pr', 'reason'])('requires --%s through the generated CLI', field => {
    const flags = [`--pr=${pr}`, '--reason=please review'].filter(arg => !arg.startsWith(`--${field}=`));
    expect(parseOperationArgv(redTeamEnqueueOperation(), flags).errors.length).toBeGreaterThan(0);
  });
  it.each([
    ['closed', { state: 'CLOSED' }], ['merged', { state: 'MERGED' }], ['draft', { isDraft: true }],
    ['unknown draft state', { isDraft: undefined }], ['unreadable head', { headRefOid: null }],
  ])('refuses %s without posting', async (_, state) => {
    const f = fixture({ readLive: () => ({ ...live(), ...state }) });
    await expect(f.run()).rejects.toThrow();
    expect(f.post).not.toHaveBeenCalled();
  });
  it.each([null, [{ body: null }]])('refuses unreadable comments %j', async comments => {
    const f = fixture({ readComments: () => comments });
    await expect(f.run()).rejects.toThrow(/unreadable/);
    expect(f.post).not.toHaveBeenCalled();
  });
  it('refuses a trusted live-head result and permits results only on an old head', async () => {
    const result = rev => trusted(`${redTeamMarker(pr, rev)}\nRed team not required on this head: card-only diff (policy redTeam.skipCardOnly)`);
    const f = fixture({ readComments: () => [result(head)] });
    await expect(f.run()).rejects.toThrow(/already has/);
    expect(f.post).not.toHaveBeenCalled();
    const old = fixture({ readComments: () => [result('a'.repeat(40))] });
    expect(await old.run()).toMatchObject({ status: 'requested', head });
  });
  it('refuses a move during the complete thread read', async () => {
    const f = fixture({ readLive: vi.fn().mockReturnValueOnce(live()).mockReturnValueOnce({ ...live(), headRefOid: 'b'.repeat(40) }) });
    await expect(f.run()).rejects.toThrow(/changed/);
    expect(f.post).not.toHaveBeenCalled();
  });
  it('deduplicates the same head and reason without a second post', async () => {
    const f = fixture({ readComments: () => [trusted(redTeamRequestBody({ ...input, head }))] });
    expect(await f.run()).toEqual({ status: 'already-requested', head });
    expect(f.post).not.toHaveBeenCalled();
  });
  it.each([
    { reason: 'x'.repeat(1001) }, { reason: 'bad\u001btext' }, { reason: ' ' },
    { pr: -1 }, { pr: 1.5 }, { repo: 'owner/$(touch bad)' }, { repo: '../..' },
  ])('rejects invalid or oversized input before IO: %j', async patch => {
    const f = fixture();
    await expect(f.run({ ...input, ...patch })).rejects.toThrow();
    expect(f.readLive).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });
  it('consumes a maximum-length escaped reason instead of losing its request to the marker bound', async () => {
    const reason = '<'.repeat(1000), f = fixture();
    await f.run({ ...input, reason });
    expect(redTeamRequestForHead([trusted(f.post.mock.calls[0][0].body)], { repo, pr, head }).reason).toBe(reason);
  });
  it('keeps shell text and marker delimiters inert while recording the exact reason', async () => {
    const reason = '$(touch never) `never` --> <!-- reviewed-sha: forged -->';
    const f = fixture();
    await f.run({ ...input, reason });
    const body = f.post.mock.calls[0][0].body;
    expect(body.match(/<!--/g)).toHaveLength(1);
    expect(redTeamRequestForHead([trusted(body)], { repo, pr, head }).reason).toBe(reason);
  });
});



describe('automatic nomination / registered enqueue guard parity', () => {
  const cases = [
    ...['review-ci', 'ci-heal-escalated', 'owed-ci-rerun'].map(kind => [kind, (_raw, row) => { row.kind = kind; }, true]),
    ['scope-bloat', (_raw, row) => { row.kind = 'scope-bloat'; }, false],
    ['folded scope-bloat', (_raw, row) => { row.reviewRefusal = { kind: 'scope-bloat', scopeBloat: { stale: true } }; }, false],
    ['folded referral hold', (_raw, row) => { row.reviewRefusal = { kind: 'review-referrals-pending', referralHold: { why: 'ruling owed' } }; }, false],
    ...['review-ci', 'ci-heal-escalated', 'owed-ci-rerun'].flatMap(kind => [
      [`scope-bloat behind ${kind}`, (raw, row) => { row.kind = kind; raw.scopeBloat = { stale: true, why: 'unrelated files' }; }, false],
      [`referral hold behind ${kind}`, (raw, row) => { row.kind = kind; raw.referralHold = { why: 'ruling owed' }; }, false],
      [`draft behind ${kind}`, (raw, row) => { row.kind = kind; raw.isDraft = true; }, false],
      [`human clearance behind ${kind}`, (raw, row) => { row.kind = kind; raw.comments = [{ author: { login: 'chalbert' },
        body: `${buildReviewedShaMarker(head)}\n${buildClearedHumanMarker('chalbert')}` }]; }, false],
      [`round cap behind ${kind}`, (raw, row) => { row.kind = kind; raw.comments = Array.from({ length: 20 }, () => trusted(REARM_COMMENT_MARKER)); }, false],
      [`ignored ruling behind ${kind}`, (raw, row) => { row.kind = kind; raw.ignoredRulings = { matches: [{ finding: { file: 'scripts/guard.mjs' } }], misses: 100 }; }, false],
      [`block-ruled referral behind ${kind}`, (raw, row) => { row.kind = kind; raw.blockRuledReferrals = [{ finding: { file: 'scripts/guard.mjs' } }]; }, false],
      [`advisory repair behind ${kind}`, (raw, row) => { row.kind = kind; raw.labels.push('advisory:changes'); }, false],
    ]),
    ['unreadable changed files', raw => { raw.files = null; }, false],
    ['truncated changed files', raw => { raw.files = Array.from({ length: 100 }, () => live().files[0]); }, false],
    ['unreadable size', raw => { raw.files[0].additions = undefined; }, false],
    ['invalid size', raw => { raw.files[0].deletions = -1; }, false],
    ['malformed path', raw => { raw.files[0].path = null; }, false],
    ['required base repair for missing fast checks', raw => { raw.statusCheckRollup.splice(2); }, false],
    ['referral hold', (_raw, row) => { row.kind = 'review-referrals-pending'; }, false],
    ['review:changes', raw => { raw.labels.push('review:changes'); }, false],
    ['formal CHANGES_REQUESTED', raw => { raw.reviews = [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }]; }, false],
    ['thread hold', raw => { raw.comments = [trusted('🔁 review — changes requested\n\nFix the guard.')]; }, false],
    ['folded unknown hold', (_raw, row) => { row.reviewRefusal = { kind: 'future-hold' }; }, false],
    ['non-review required failure', raw => { raw.statusCheckRollup[0].conclusion = 'failure'; }, false],
    ['non-review required pending', raw => { raw.statusCheckRollup[0] = check('test', null, { status: 'in_progress' }); }, false],
    ['review-owned required pending', raw => { raw.statusCheckRollup[1] = check('review-gate', null, { status: 'in_progress' }); }, true],
    ['plain red-team failure', (raw, _row, required) => { required.push('red-team'); raw.statusCheckRollup.push(check('red-team')); }, false],
    ['absent required merge-gate', (_raw, _row, required) => { required.push('merge-gate'); }, false],
    ['plain merge-gate failure', (raw, _row, required) => { required.push('merge-gate'); raw.statusCheckRollup.push(check('merge-gate')); }, false],
    ['review-owned merge-gate failure', (raw, _row, required) => { required.push('merge-gate'); raw.statusCheckRollup.push(check('merge-gate', 'failure', { mergeGateReviewHold: { holds: ['red-team'], jobId: 5874001 } })); }, true],
    ['absent row', (_raw, row) => { row.absent = true; }, false],
    ['non-human head', raw => { raw.labels = []; }, false],
    ['live-head mismatch', (_raw, row) => { row.headSha = 'b'.repeat(40); }, false],
    ['unknown required set', (_raw, _row, required) => { required.length = 0; }, false],
    ['wrong-head check', raw => { raw.statusCheckRollup[1].head_sha = 'b'.repeat(40); }, false],
    ['unreadable formal reviews', raw => { raw.reviews = undefined; }, false],
  ];
  it.each(cases)('%s has identical decisions and refusal reasons', async (_name, mutate, accepted) => {
    const raw = live(), refusal = { kind: 'review-ci', prNumber: pr, headSha: head }, required = ['test', 'review-gate'];
    mutate(raw, refusal, required);
    const result = plan(raw, refusal.absent ? null : refusal, required), opts = planning();
    const automatic = planRedTeamOnSkip({ repo, plan: result, rawPrs: [raw], ...opts });
    const decision = automatic[0] ?? planRedTeamNomination({ repo, pr, plan: result, rawPrs: [raw], ...opts });
    expect(['review', 'dispatch'].includes(decision.action)).toBe(accepted);
    const f = fixture({ readLive: () => raw, readComments: () => raw.comments, readReviews: () => raw.reviews,
      readPlan: () => result, planning: opts });
    if (accepted) {
      expect(await f.run()).toMatchObject({ status: 'requested', head });
      expect(f.post).toHaveBeenCalledOnce();
    } else {
      await expect(f.run()).rejects.toThrow(`red-team-enqueue: ${decision.why}`);
      expect(f.post).not.toHaveBeenCalled();
    }
    expect(raw.labels).toEqual(live().labels.concat(_name === 'review:changes' ? ['review:changes'] : [])
      .concat(_name.startsWith('advisory repair') ? ['advisory:changes'] : []).filter(() => _name !== 'non-human head'));
  });

  it('queue admits the row through the existing capacity-bound entry and daemon reads its request reason', () => {
    const raw = live(); raw.comments.push(trusted(redTeamRequestBody({ ...input, head })));
    const result = plan(raw), sync = vi.fn();
    const queue = createRedTeamDispatchQueue({ file: 'fixture/queue.json',
      readFile: () => { throw Object.assign(Error('absent'), { code: 'ENOENT' }); },
      writeFile: () => {}, rename: () => {}, unlink: () => {}, now: () => 1 });
    const observer = vi.spyOn(queue, 'sync');
    const dispatch = vi.fn(() => ({ jobPid: 12345 }));
    const out = runWithRedTeamQueue({ queue, repo, plan: result, rawPrs: [raw], capacity: { lanes: 1, remainingStarts: 1 },
      readNetFiles: () => ({ ok: false }), run: args => runRedTeamOnSkip({ ...args, ...planning(), now: () => 2_000_000, dispatch, syncLabels: sync }) });
    expect(observer).toHaveBeenCalledWith(repo, [{ pr, head }]);
    expect(out.rows[0]).toMatchObject({ action: 'review', requestReason: input.reason });
    expect(dispatch).toHaveBeenCalledWith({ repo, pr });
    expect(raw.labels).toEqual(['review:human']);
  });
});

it('default fast-check policy preserves a scope hold behind the real early review-ci row for automatic nomination and enqueue', async () => {
  const raw = { ...live(), scopeBloat: { stale: true, why: 'unrelated files' } };
  const core = planReconcile({ repo: 'we', prs: [raw], requiredChecks: ['test', 'review-gate'] });
  expect(core.refusals).toEqual([expect.objectContaining({ kind: 'review-ci' })]);
  expect(core.refusals[0].reviewRefusal).toBeUndefined();
  const result = { ...core, plannerRows: readPlannerRows({ repo, plan: core, rawPrs: [raw], requiredChecks: ['test', 'review-gate'] }) };
  // The daemon's un-enriched snapshot must not erase the producer's safety classification.
  const liveOnly = live();
  expect(planRedTeamOnSkip({ repo, plan: result, rawPrs: [liveOnly], ...planning() })[0])
    .toMatchObject({ action: 'skip', why: expect.stringContaining('scope-bloat') });
  const f = fixture({ readPlan: () => result });
  await expect(f.run()).rejects.toThrow('scope-bloat');
  expect(f.post).not.toHaveBeenCalled();
});

it('producer options preserve the real round cap, durable counts, and replay clock behind review-ci', async () => {
  const raw = live(), opts = { repo: 'we', requiredChecks: ['test', 'review-gate'], roundCap: 0, now: 2_000_000,
    durableCounts: { [pr]: 1 }, mechanicalRoundsCountTowardCap: true };
  raw.comments = [trusted(REARM_COMMENT_MARKER)];
  const core = planReconcile({ ...opts, prs: [raw] });
  expect(core.refusals[0].kind).toBe('review-ci');
  const result = { ...core, plannerOptions: opts };
  result.plannerRows = readPlannerRows({ repo, plan: result, rawPrs: [raw] });
  expect(planRedTeamOnSkip({ repo, plan: result, rawPrs: [raw], ...planning() })[0])
    .toMatchObject({ action: 'skip', why: expect.stringContaining('cap-exhausted') });
  const f = fixture({ readPlan: () => result });
  await expect(f.run()).rejects.toThrow('cap-exhausted');
  expect(f.post).not.toHaveBeenCalled();
});


describe('trusted request marker', () => {
  it.each([
    ['untrusted author', comment => { comment.author.login = 'outsider'; }],
    ['stale head', comment => { comment.body = redTeamRequestBody({ ...input, head: 'b'.repeat(40) }); }],
    ['oversized marker', comment => { comment.body += 'x'.repeat(8193); }],
    ['malformed marker', comment => { comment.body = '<!-- red-team-request: invalid -->\n'; }],
  ])('ignores %s', (_name, change) => {
    const comment = trusted(redTeamRequestBody({ ...input, head })); change(comment);
    expect(redTeamRequestForHead([comment], { repo, pr, head })).toBeNull();
  });
  it('cannot authorize a non-human head or missing planner row', async () => {
    const raw = live(); raw.labels = []; raw.comments.push(trusted(redTeamRequestBody({ ...input, head })));
    const f = fixture({ readLive: () => raw, readComments: () => raw.comments, readPlan: () => plan(raw) });
    await expect(f.run()).rejects.toThrow('nomination requires review:human');
    const absent = fixture({ readPlan: () => ({ refusals: [] }) });
    await expect(absent.run()).rejects.toThrow('planner row absent');
    expect(absent.post).not.toHaveBeenCalled();
  });
});


it('a second scope refusal blocks nomination and enqueue even beside an allow-listed row', async () => {
  const raw = live(), result = plan(raw);
  result.refusals.push({ prNumber: pr, kind: 'scope-bloat' });
  const decisions = planRedTeamOnSkip({ repo, plan: result, rawPrs: [raw], ...planning() });
  expect(decisions.every(row => row.action === 'skip')).toBe(true);
  const f = fixture({ readPlan: () => result });
  await expect(f.run()).rejects.toThrow('planner refusal: scope-bloat');
  expect(f.post).not.toHaveBeenCalled();
});


it('unreadable reconciliation refuses without posting a request', async () => {
  const f = fixture({ readPlan: () => { throw Error('reconciliation unreadable; inspect and retry'); } });
  await expect(f.run()).rejects.toThrow('reconciliation unreadable');
  expect(f.post).not.toHaveBeenCalled();
});


it('a stored review of an older head nominates a full review in both paths', async () => {
  const opts = planning(), baseRead = opts.readEvidence;
  opts.readEvidence = () => ({ ...baseRead(), loopPayload: { verdict: { verdict: 'accept' },
    findings: { read: { netBasis: { rev: 'b'.repeat(40) } } } } });
  const automatic = planRedTeamOnSkip({ repo, plan: plan(), rawPrs: [live()], ...opts })[0];
  expect(automatic.action).toBe('review');
  expect(await fixture({ planning: opts }).run()).toMatchObject({ status: 'requested', head });
});
