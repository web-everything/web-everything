import { describe, it, expect, vi } from 'vitest';
import { planRedTeamNomination, planRedTeamOnSkip, runRedTeamOnSkip } from '../../lib/review-red-team-on-skip.mjs';
import { readPlannerRow } from '../../lib/red-team-planner-row.mjs';
import { redTeamRequestBody, redTeamRequestForHead } from '../../lib/red-team-request.mjs';
import { createRedTeamEnqueueSinks, RED_TEAM_ENQUEUE_EFFECT, redTeamEnqueueOperation } from '../red-team-enqueue.mjs';
import { resolveOperation } from '../run.mjs';
import { parseOperationArgv, runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { resolvePrOwnershipSettings } from '../../conveyor/pr-ownership-settings.mjs';
import { redTeamMarker } from '../../lib/red-team-gate.mjs';
import { REVIEW_TIMING_DEFAULTS } from '../../lib/review-timing.mjs';
import { createRedTeamDispatchQueue, runWithRedTeamQueue } from '../../lib/red-team-dispatch-queue.mjs';

const repo = 'web-everything/web-everything', pr = 6938, head = 'e905ff0b'.padEnd(40, '0'), oldHead = '50f67e993'.padEnd(40, '0');
const input = { repo, pr, actor: 'chalbert', reason: 'head moved after the last advisory' };
const trusted = body => ({ body, author: { login: 'web-everything' } });
const payload = (rev = head) => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev } } } });
const check = (name, conclusion = 'success', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });
const live = () => ({ number: pr, state: 'OPEN', isDraft: false, headRefOid: head, rowsHead: head, rowsComplete: true,
  files: [{ path: 'scripts/guard.mjs', additions: 5, deletions: 2 }], labels: ['review:human'], comments: [], reviews: [],
  statusCheckRollup: [check('test'), check('review-gate', 'failure'), ...REVIEW_TIMING_DEFAULTS.fastChecks.we.map(name => check(name))] });
const planning = () => ({ env: {}, readOwnership: resolvePrOwnershipSettings, log: vi.fn(), now: 2_000_000,
  setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(), readCarry: () => null,
  readWitness: () => ({ rawWriter: { parsed: null }, seats: [], newest: payload() }),
  readEvidence: () => ({ loopPayload: payload(), inFlight: false, recorded: false, seatRecorded: false, completedRecorded: false }),
  readStatus: () => null, readReviewRuns: () => [] });
function plan(raw = live(), refusal = { kind: 'review-ci', prNumber: pr, headSha: head }) {
  return { refusals: refusal ? [refusal] : [], enrichedPrs: [raw], plannerOptions: {
    requiredChecks: ['test', 'review-gate'], rosterSource: 'live', reviewTiming: { startAfter: 'ci-green' } } };
}
function stale(raw, opts) {
  raw.comments.push(trusted(`**Verdict:** 🚦 human review required\n**Advisory outcome:** \`accept\` — ready for human review.\nNet basis: \`${'a'.repeat(40)}..${oldHead}\` — 1 net changed file(s)`));
  opts.readWitness = () => ({ rawWriter: { parsed: null }, seats: [], newest: null });
  // Production drain lookup has no live-head payload. Only the old-head query finds the finished advisory.
  opts.readEvidence = ({ head: rev }) => ({ loopPayload: rev === oldHead ? payload(oldHead) : null,
    inFlight: false, recorded: false, seatRecorded: false, completedRecorded: false });
}
const request = () => ({ ...input, head });
function fixture(over = {}) {
  const deps = { planning: planning(), readLive: vi.fn(live), readComments: vi.fn(() => []),
    readReviews: vi.fn(() => []), readPlan: vi.fn(() => plan()), post: vi.fn(), ...over };
  return { ...deps, run: value => createRedTeamEnqueueSinks(deps)[RED_TEAM_ENQUEUE_EFFECT](value ?? input) };
}

describe('nomination / explicit request decision parity', () => {
  const cases = [
    ...['review-ci', 'ci-heal-escalated', 'owed-ci-rerun', 'already-reviewed-head'].map(kind => [kind, (_raw, row) => { row.kind = kind; }, true]),
    ['pass', raw => { raw.statusCheckRollup[1].conclusion = 'success'; }, true],
    ['held', () => {}, true],
    ['unknown: incomplete evidence containing required failure', raw => { raw.rowsComplete = false; }, false],
    ['unknown: incomplete evidence containing non-review required failure', raw => { raw.rowsComplete = false; raw.statusCheckRollup[0].conclusion = 'failure'; }, false],
    ['unknown: roster absent', (_raw, _row, p) => { p.plannerOptions.requiredChecks = null; }, false],
    ['pending', raw => { raw.statusCheckRollup[0] = check('test', null, { status: 'in_progress' }); }, false],
    ['fail', raw => { raw.statusCheckRollup[0].conclusion = 'failure'; }, false],
    ['optional failure', raw => { raw.statusCheckRollup.push(check('optional', 'failure')); }, false],
    ['scope-bloat', (_raw, row) => { row.kind = 'scope-bloat'; }, false],
    ['scope-bloat behind early review-ci', raw => { raw.scopeBloat = { stale: true, why: 'unrelated changes' }; }, false],
    ['folded reviewRefusal', (_raw, row) => { row.reviewRefusal = { kind: 'scope-bloat' }; }, false],
    ['referral hold', raw => { raw.referralHold = { why: 'ruling owed' }; }, false],
    ['folded referral hold', (_raw, row) => { row.reviewRefusal = { kind: 'review-referrals-pending' }; }, false],
    ['review:changes', raw => { raw.labels.push('review:changes'); }, false],
    ['formal CHANGES_REQUESTED', raw => { raw.reviews = [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }]; }, false],
    ['thread hold', raw => { raw.comments.push(trusted('🔁 review — changes requested\nFix the guard.')); }, false],
    ['absent row', (_raw, _row, p) => { p.refusals = []; }, false],
    ['non-human finished head', raw => { raw.labels = []; }, false],
    ['non-human pending finished head', raw => { raw.labels = ['review:pending']; }, false],
    ['live-head mismatch', (_raw, row) => { row.headSha = oldHead; }, false],
    ['draft', raw => { raw.isDraft = true; }, false],
    ['closed', raw => { raw.state = 'CLOSED'; }, false],
    ['unreadable scorecard', (_raw, _row, _p, opts) => { opts.readWitness = () => { throw Error('scorecard unreadable'); }; }, false],
    ...[undefined, null, {}, { rawWriter: {}, seats: [] }, { rawWriter: { parsed: 'invalid' }, seats: [], newest: null },
      { ok: false, reason: 'scorecard unreadable' }, { rawWriter: { parsed: null }, newest: payload() }]
      .map((w, i) => [`invalid or missing witness ${i}`, (_raw, _row, _p, opts) => { opts.readWitness = () => w; }, false]),
    ['unfinished review', (_raw, _row, _p, opts) => { opts.readWitness = () => ({ rawWriter: { parsed: null }, seats: [], newest: { ...payload(), pending: {} } }); }, false],
    ['unfinished review reader', (_raw, _row, _p, opts) => { opts.readEvidence = () => ({ ok: false, reason: 'review-unfinished' }); }, false],
    ['oversized scope', raw => { raw.files = Array.from({ length: 100 }, () => live().files[0]); }, false],
    ['unreadable files', raw => { raw.files = null; }, false],
    ['unreadable reviews', raw => { raw.reviews = null; }, false],
    ['unreadable comment', raw => { raw.comments = [{ body: null }]; }, false],
    ['unreadable labels', raw => { raw.labels = [null]; }, false],
  ];
  it.each(cases)('%s', (_name, mutate, allowed) => {
    const raw = live(), p = plan(raw), opts = planning();
    mutate(raw, p.refusals[0], p, opts);
    const common = { ...opts, repo, pr, plan: p, rawPrs: [raw] };
    const automatic = planRedTeamNomination(common);
    const explicit = planRedTeamNomination({ ...common, explicitRequest: request() });
    expect(explicit).toEqual({ ...automatic, ...(automatic.nomination ? { requested: true } : {}) });
    expect(['dispatch', 'review'].includes(automatic.action)).toBe(allowed);
    expect(automatic.action).not.toBe('review');
    if (allowed) expect(automatic).toMatchObject({ action: 'dispatch', expectedHead: head, mode: 'fresh' });
    if (_name.startsWith('unknown: incomplete')) {
      expect(readPlannerRow({ pr, plan: p }).checkEvidence.state).toBe('unknown');
      expect(planRedTeamOnSkip(common).some(d => d.action === 'dispatch')).toBe(false);
      expect(planRedTeamOnSkip({ ...common, explicitRequest: request() }).some(d => d.action === 'dispatch')).toBe(false);
    }
  });
  it('only an explicit request may turn a stale human advisory into a full review', () => {
    const raw = live(), opts = planning(); stale(raw, opts);
    const common = { ...opts, repo, pr, plan: plan(raw), rawPrs: [raw] };
    expect(planRedTeamNomination(common)).toMatchObject({ action: 'skip', why: expect.stringContaining('red-team-enqueue') });
    expect(planRedTeamNomination({ ...common, explicitRequest: request() })).toMatchObject({ action: 'review', expectedHead: head });
    expect(opts.log).toHaveBeenCalledWith(expect.stringContaining('(source: standard)'));
  });
  it.each(['off', 'throws', 'unreadable', 'ignored'])('fails closed for stale advisory setting %s', state => {
    const raw = live(), opts = planning(); stale(raw, opts);
    opts.readOwnership = () => { if (state === 'throws') throw Error('settings unreadable');
      return { advisoryReviewOnHumanHandoff: { value: state === 'off' ? 'off' : 'on', source: state === 'unreadable' ? state : 'fixture', ...(state === 'ignored' ? { ignored: [{}] } : {}) } }; };
    expect(planRedTeamNomination({ ...opts, repo, pr, plan: plan(raw), rawPrs: [raw], explicitRequest: request() }).action).toBe('skip');
  });
  it.each(['scope', 'referral', 'formal', 'label'])('stale advisory request preserves %s hold', kind => {
    const raw = live(), opts = planning(); stale(raw, opts);
    if (kind === 'scope') raw.scopeBloat = { stale: true, why: 'unrelated files' };
    if (kind === 'referral') raw.referralHold = { why: 'ruling owed' };
    if (kind === 'formal') raw.reviews = [{ state: 'CHANGES_REQUESTED' }];
    if (kind === 'label') raw.labels.push('review:changes');
    expect(planRedTeamNomination({ ...opts, repo, pr, plan: plan(raw), rawPrs: [raw], explicitRequest: request() }).action).toBe('skip');
  });
});

describe('registered red-team-enqueue', () => {
  it('derives the CLI, defaults repo and posts an audited head-bound marker', async () => {
    const f = fixture(), operation = resolveOperation('red-team-enqueue');
    const out = await runOperationCli({ ...operation, sinks: createRedTeamEnqueueSinks(f),
      store: createMemoryRunStore(), newRunId: () => 'red-team-enqueue-test',
      argv: [`--pr=${pr}`, `--actor=${input.actor}`, `--reason=${input.reason}`] });
    expect(out.code).toBe(0);
    const body = f.post.mock.calls[0][0].body;
    expect(redTeamRequestForHead([trusted(body)], { repo, pr, head })).toMatchObject({ ...input, head, time: expect.any(String) });
  });
  it.each(['pr', 'actor', 'reason'])('requires --%s in the generated CLI', field => {
    expect(parseOperationArgv(redTeamEnqueueOperation(), [`--pr=${pr}`, '--actor=chalbert', '--reason=please review']
      .filter(arg => !arg.startsWith(`--${field}=`))).errors.length).toBeGreaterThan(0);
  });
  it.each([{ actor: '' }, { actor: ' ' }, { reason: '' }, { reason: ' ' }, { actor: undefined }, { reason: undefined },
    { reason: 'x'.repeat(1001) }, { reason: 'bad\u001btext' }, { pr: -1 }, { repo: 'owner/$(touch bad)' }])('rejects invalid input before IO: %j', async patch => {
    const f = fixture(); await expect(f.run({ ...input, ...patch })).rejects.toThrow();
    expect(f.readLive).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
  });
  it.each([{ state: 'CLOSED' }, { state: 'MERGED' }, { isDraft: true }, { isDraft: undefined }, { headRefOid: null }])('refuses closed/draft/unreadable heads: %j', async patch => {
    const f = fixture({ readLive: () => ({ ...live(), ...patch }) });
    await expect(f.run()).rejects.toThrow(); expect(f.post).not.toHaveBeenCalled();
  });
  it('refuses a live-head result and an absent row', async () => {
    const result = fixture({ readComments: () => [trusted(`${redTeamMarker(pr, head)}\nRed team not required on this head: card-only diff (policy redTeam.skipCardOnly)`)] });
    await expect(result.run()).rejects.toThrow(/already has/);
    const absent = fixture({ readPlan: () => plan(live(), null) });
    await expect(absent.run()).rejects.toThrow(/absent/); expect(absent.post).not.toHaveBeenCalled();
  });
  it('refuses incomplete evidence containing a required failure without posting', async () => {
    const raw = { ...live(), rowsComplete: false }, f = fixture({ readLive: () => raw, readPlan: () => plan(raw) });
    await expect(f.run()).rejects.toThrow(/pass or held/); expect(f.post).not.toHaveBeenCalled();
  });
  it('requests a stale human advisory using production-shaped empty live-head evidence', async () => {
    const raw = live(), opts = planning(); stale(raw, opts);
    const f = fixture({ planning: opts, readLive: () => raw, readComments: () => raw.comments, readPlan: () => plan(raw) });
    expect(await f.run()).toMatchObject({ status: 'requested', head });
  });
  it.each(['off', 'unreadable'])('does not post a stale-advisory request when settings are %s', async state => {
    const raw = live(), opts = planning(); stale(raw, opts);
    opts.readOwnership = () => { if (state === 'unreadable') throw Error('settings unreadable');
      return { advisoryReviewOnHumanHandoff: { value: 'off', source: 'fixture' } }; };
    const f = fixture({ planning: opts, readLive: () => raw, readComments: () => raw.comments, readPlan: () => plan(raw) });
    await expect(f.run()).rejects.toThrow(); expect(f.post).not.toHaveBeenCalled();
  });
  it('refuses a move during enqueue and deduplicates a repeated request', async () => {
    const moved = fixture({ readLive: vi.fn().mockReturnValueOnce(live()).mockReturnValueOnce({ ...live(), headRefOid: oldHead }) });
    await expect(moved.run()).rejects.toThrow(/changed/); expect(moved.post).not.toHaveBeenCalled();
    const repeat = fixture({ readComments: () => [trusted(redTeamRequestBody(request()))] });
    expect(await repeat.run()).toEqual({ status: 'already-requested', head }); expect(repeat.post).not.toHaveBeenCalled();
  });
  it('bounds and escapes reasons, and rejects forged, malformed or wrong-head markers', async () => {
    const reason = '<'.repeat(1000), f = fixture(); await f.run({ ...input, reason });
    const body = f.post.mock.calls[0][0].body;
    expect(body.match(/<!--/g)).toHaveLength(1);
    expect(redTeamRequestForHead([trusted(body)], request()).reason).toBe(reason);
    for (const comment of [{ ...trusted(body), author: { login: 'stranger' } }, trusted('<!-- red-team-request: {} -->\n'), trusted(redTeamRequestBody({ ...input, head: oldHead }))])
      expect(redTeamRequestForHead([comment], request())).toBeNull();
  });
});

describe('nomination execution and queue', () => {
  function run(over = {}, requested = false) {
    const raw = live(); if (requested) raw.comments.push(trusted(redTeamRequestBody(request())));
    const opts = { ...planning(), repo, plan: plan(raw), rawPrs: [raw], now: () => 2_000_000,
      capacity: { lanes: 1, remainingStarts: 1, budget: { left: 1 } }, dispatch: vi.fn(() => ({ jobPid: 123 })), ...over };
    return { opts, out: runRedTeamOnSkip(opts) };
  }
  it.each([false, true])('dispatches only a red team with expectedHead (request=%s)', requested => {
    const { opts, out } = run({}, requested);
    expect(out.dispatched).toHaveLength(1);
    expect(opts.dispatch).toHaveBeenCalledWith({ repo, pr, expectedHead: head, redTeamOnly: true, redTeamMode: 'fresh' });
  });
  it.each([false, true])('refuses head movement between nomination and dispatch (request=%s)', requested => {
    const { opts, out } = run({ provider: { readPrState: () => ({ ...live(), headRefOid: oldHead }) } }, requested);
    expect(opts.dispatch).not.toHaveBeenCalled(); expect(opts.capacity.budget.left).toBe(1);
    expect(out.rows[0].why).toMatch(/head changed/);
  });
  it('compares the request marker with the live head at dispatch', () => {
    const { opts, out } = run({ readComments: () => [trusted(redTeamRequestBody({ ...input, head: oldHead }))] }, true);
    expect(opts.dispatch).not.toHaveBeenCalled(); expect(out.rows[0].why).toMatch(/request/);
  });
  it('queues allow-listed refusals under the existing capacity bound', () => {
    const raw = live(), p = plan(raw), writes = new Map();
    const queue = createRedTeamDispatchQueue({ file: 'queue.json', readFile: path => { if (!writes.has(path)) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return writes.get(path); },
      writeFile: (path, value) => writes.set(path, value), rename: (from, to) => { writes.set(to, writes.get(from)); }, unlink: path => writes.delete(path), now: () => 1 });
    const runner = vi.fn(() => ({ rows: [{ prNumber: pr, head, action: 'skip', why: 'no review capacity left' }], dispatched: [], notStarted: [] }));
    runWithRedTeamQueue({ queue, repo, plan: p, rawPrs: [raw], capacity: { lanes: 1, remainingStarts: 1 }, run: runner, readNetFiles: () => ({ ok: false }) });
    expect(runner.mock.calls[0][0].plan.refusals).toEqual(p.refusals);
    expect(queue.entries()).toEqual([expect.objectContaining({ repo, pr, head })]);
  });
});
