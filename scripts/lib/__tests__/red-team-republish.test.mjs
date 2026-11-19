// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from '../atomic-json-file.mjs';
import { recordRedTeamStatus, redTeamStatusDir, republishPublicationStatus } from '../drain-red-team-evidence.mjs';
import { readStatusHistory, readRedTeamCheckFact, postRedTeamPublicationHold, resolveRedTeamWriter, redTeamWriterEnv,
  LIVE_CHECK_TITLE_PREFIX, POLICY_CLEAR_TITLE_PREFIX } from '../red-team-check-run.mjs';
import { OPERATOR_LOGINS } from '../marker-authorship.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { main } from '../../operations/red-team-republish.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const SYNTHETIC_APP = 7;
const head = 'a'.repeat(40), repo = 'example/widgets', pr = 6945, context = `red-team/publication #${pr}`;
const bot = { login: 'web-everything[bot]' };
const status = (id, state = 'failure', over = {}) => ({ id, state, context, creator: bot,
  description: state === 'success' ? 'red-team publication confirmed' : 'held: finished round not confirmed published', ...over });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rt-republish-')); roots.push(root);
  const env = { WE_APP_ID: String(SYNTHETIC_APP), WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_CHECK_LOCK_DIR: join(root, 'locks'),
    WE_GH_READ_MEMO_DIR: 'must-be-stripped', GH_TOKEN: 'personal-must-be-stripped' };
  const path = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
  mkdirSync(redTeamStatusDir(env), { recursive: true });
  const local = { repo, pr, head, status: 'finished', result: 'ran', sealedBreaks: [], pid: 99999999 };
  writeJsonAtomic(path, local); writeJsonAtomic(`${path}.unpublished`, { status: 'finished', remoteHold: true });
  const state = { history: [status(10), status(1, 'success')], posts: [], checks: 0, reads: 0, runId: 50,
    comments: [{ author: bot, body: renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'fixture',
      findings: [], recheckStatus: 'not-needed', foldedVerdict: 'accept' }) }],
    live: { headRefOid: head, labels: [] }, checkRun: { output: { title: 'Red-team round clear' } }, extraRuns: [], local, path, env };
  const gh = vi.fn((args, options = {}) => {
    if (args[0] === 'auth') {
      expect(options.env.GH_TOKEN).toBeUndefined();
      expect(options.env.WE_GITHUB_APP_ROLE).toBe('legacy');
      return state.token ?? 'ghs_synthetic_fixture_only';
    }
    if (args.includes('POST')) {
      expect(options.env.GH_TOKEN).toBe('ghs_synthetic_fixture_only');
      const body = JSON.parse(options.input); state.posts.push(body.state ? body : { ...body, state: body.status });
      if (!body.state) return JSON.stringify({ id: 100 });
      const next = status(20 + state.posts.length, body.state, { description: body.description });
      state.history.unshift(next);
      state.afterPost?.(next);
      return JSON.stringify(state.response ? state.response(next) : next);
    }
    expect(options.env.WE_GH_READ_MEMO_DIR).toBeUndefined();
    expect(options.throttle.env.WE_GH_READ_MEMO_DIR).toBeUndefined();
    if ((state.unreadablePr && args[0] === 'pr') || (state.unreadableComments && args[1]?.includes('/comments?')))
      throw Error('live evidence unreadable');
    if (args[0] === 'pr') return JSON.stringify(state.live);
    if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: state.comments.length } } } } });
    if (args[1].includes('/comments?')) return JSON.stringify(state.comments.map((c, i) => ({ ...c, node_id: `IC_${i}`, user: c.author })));
    if (args[1].includes('/check-runs?')) {
      state.checks++; state.beforeCheck?.();
      const run = { id: state.runId, name: 'red-team', app: { id: SYNTHETIC_APP },
        external_id: `${repo}#${pr}`, head_sha: head, status: 'completed', conclusion: 'success', ...state.checkRun };
      return JSON.stringify({ total_count: 1 + state.extraRuns.length, check_runs: [run, ...state.extraRuns.map(over => ({ ...run, ...over }))] });
    }
    if (args[1].includes('/statuses?')) {
      state.reads++; state.beforeHistory?.();
      return JSON.stringify(state.history);
    }
    throw Error(`unexpected fixture call: ${args.join(' ')}`);
  });
  const options = { repo, pr, head, env, gh, isAlive: () => false, readComments: () => state.comments };
  return { ...state, state, gh, options, run: over => republishPublicationStatus({ ...options, ...over }) };
}
const expectRestored = (f, options) => {
  expect(f.run(options)).toMatchObject({ ok: false });
  expect(f.state.posts.map(s => s.state)).toEqual(['success', 'failure']);
  expect(existsSync(`${f.path}.unpublished`)).toBe(true);
};

describe('publication republish id-based race verification', () => {
  it.each([15, 30])('restores an S1-absent hold with id %s below or above our id', id => {
    const f = fixture(); f.state.afterPost = next => { if (next.state === 'success') f.state.history.push(status(id)); };
    expectRestored(f);
  });
  it('restores when a new check run appears between observations', () => {
    const f = fixture(); f.state.afterPost = () => { f.state.runId = 51; }; expectRestored(f);
  });
  it('restores when the same check changes its round binding between observations', () => {
    const f = fixture(); f.state.checkRun.output.summary = 'Result\nRed-team round: recovered-round';
    f.state.afterPost = next => { if (next.state === 'success') f.state.checkRun.output.summary = 'Result\nRed-team round: other-round'; };
    expectRestored(f);
    expect(f.state.posts[1].description).toBe('held: finished round recovered-round not confirmed published');
  });
  it('a restored hold keeps its binding and remains recoverable after an ambiguous POST', () => {
    const f = fixture(); f.state.checkRun.output.summary = 'Result\nRed-team round: recovered-round';
    f.state.response = next => { if (next.state === 'success') throw Error('timeout'); return next; };
    expectRestored(f);
    expect(f.state.posts[1].description).toBe('held: finished round recovered-round not confirmed published');
    delete f.state.response;
    expect(f.run()).toMatchObject({ ok: true, runId: 50 });
  });
  it.each([
    ['blocking label', f => { f.state.live.labels = [{ name: 'review:human' }]; }],
    ['nonblocking label change', f => { f.state.live.labels = ['new-label']; }],
    ['unreadable labels', f => { f.state.live.labels = [null]; }],
    ['head change', f => { f.state.live.headRefOid = 'b'.repeat(40); }],
    ['untrusted result author', f => { f.state.comments[0].author = { login: 'outsider' }; }],
    ['changed trusted result author', f => { f.state.comments[0].author = { login: OPERATOR_LOGINS[0] }; }],
    ['result comment change', f => { f.state.comments[0].body += '\nEdited after publication'; }],
    ['result comment removed', f => { f.state.comments = []; }],
    ['unreadable result comment', f => { f.state.comments[0].body = null; }],
    ['unreadable PR evidence', f => { f.state.unreadablePr = true; }],
    ['unreadable comment evidence', f => { f.state.unreadableComments = true; }],
    ['same check becomes live-helper success', f => { f.state.checkRun.output.title = `${LIVE_CHECK_TITLE_PREFIX}clear`; }],
    ['same check becomes policy-clear success', f => { f.state.checkRun.output.title = `${POLICY_CLEAR_TITLE_PREFIX}clear`; }],
    ['same check becomes failed', f => { f.state.checkRun.conclusion = 'failure'; }],
  ])('restores when %s appears between POST and S2', (_name, change) => {
    const f = fixture(); f.state.afterPost = next => { if (next.state === 'success') change(f); };
    expectRestored(f, { readComments: undefined });
  });
  it.each(['new enqueue hold', 'unreadable enqueue hold'])('restores for %s between POST and S2', name => {
    const f = fixture();
    const enqueueHold = vi.fn(() => f.state.posts.length ? (name === 'new enqueue hold' ? 'unsealed result' : undefined) : null);
    expectRestored(f, { enqueueHold, readComments: undefined });
    expect(enqueueHold).toHaveBeenCalledTimes(2);
  });
  it('restores when S2 is missing our id', () => {
    const f = fixture(); f.state.afterPost = next => { if (next.state === 'success') f.state.history.shift(); }; expectRestored(f);
  });
  it('restores when S2 is missing any S1 id including an old success', () => {
    const f = fixture(); f.state.afterPost = next => { if (next.state === 'success') f.state.history.pop(); }; expectRestored(f);
  });
  it('restores when S2 history is incomplete', () => {
    const f = fixture(); let reads = 0;
    expect(f.run({ readHistory: () => ({ statuses: f.state.history, complete: ++reads === 1 }) })).toMatchObject({ ok: false });
    expect(f.state.posts.map(s => s.state)).toEqual(['success', 'failure']);
  });
  it('restores when POST returns no id', () => {
    const f = fixture(); f.state.response = next => ({ ...next, id: undefined }); expectRestored(f);
  });
  it('restores when POST creator is an operator rather than automation', () => {
    const f = fixture(); f.state.response = next => ({ ...next, creator: { login: OPERATOR_LOGINS[0] } }); expectRestored(f);
  });
  it('restores on an ambiguous POST error', () => {
    const f = fixture(); f.state.response = next => { if (next.state === 'success') throw Error('timeout'); return next; }; expectRestored(f);
  });
  it('names operator inspection when hold restoration also fails', () => {
    const f = fixture(); f.state.response = () => { throw Error('timeout'); };
    expect(f.run()).toMatchObject({ ok: false, reason: expect.stringContaining('hold restore unconfirmed; operator must inspect') });
  });
  it.each([undefined, '2026-01-01T00:00:00Z'])('orders stripped or equal timestamps by id only (%s)', created_at => {
    const f = fixture(); f.state.history = [status(1, 'success', { created_at }), status(10, 'failure', { created_at })];
    expect(f.run()).toMatchObject({ ok: true, runId: 50, statusId: 21 });
    expect(existsSync(`${f.path}.unpublished`)).toBe(false);
    expect(f.state.posts[0].description).toBe('red-team publication confirmed (check 50)');
  });
  it('a successful no-op rerun publishes nothing', () => {
    const f = fixture(); expect(f.run().ok).toBe(true);
    expect(f.run()).toEqual({ ok: true, noop: true }); expect(f.state.posts).toHaveLength(1);
  });
});

describe('publication republish closed paths', () => {
  it.each(['queued', 'running', 'pending'].flatMap(state =>
    ['publication in progress', 'not confirmed published'].map(reason => [state, reason])))
  ('refuses an unbound %s hold already present in S1 (%s), naming it before any POST', (state, reason) => {
    const f = fixture();
    const description = `held: ${state} round ${reason}`;
    f.state.history[0].description = description;
    expect(f.run()).toMatchObject({ ok: false, reason: expect.stringContaining(`publication hold 10 (${description})`) });
    expect(f.state.posts).toEqual([]);
    expect(existsSync(`${f.path}.unpublished`)).toBe(true);
  });
  it('accepts the exact legacy unbound finished hold', () => {
    const f = fixture();
    expect(f.run()).toMatchObject({ ok: true, runId: 50 });
    expect(f.state.posts.map(s => s.state)).toEqual(['success']);
  });
  it.each(['pending', 'queued', 'running', 'finished'].flatMap(state =>
    ['publication in progress', 'not confirmed published'].map(reason => [state, reason])))
  ('accepts a %s hold bound to the recovered check id (%s)', (state, reason) => {
    const f = fixture(); f.state.history[0].description = `held: ${state} round 50 ${reason}`;
    expect(f.run()).toMatchObject({ ok: true, runId: 50 });
  });
  it.each(['pending', 'queued', 'running', 'finished'])('refuses a %s hold bound to a different check, even when the successful check is unchanged', state => {
    const f = fixture(); f.state.history[0].description = `held: ${state} round 51 not confirmed published`;
    expect(f.run()).toMatchObject({ ok: false, reason: expect.stringContaining('publication hold 10') });
    expect(f.state.posts).toEqual([]); expect(existsSync(`${f.path}.unpublished`)).toBe(true);
    expect(f.state.runId).toBe(50);
  });
  it('requires every unsettled hold to match, including a foreign hold below our finished hold', () => {
    const f = fixture(); f.state.history.splice(1, 0, status(9, 'failure', { description: 'held: queued round 51 publication in progress' }));
    expect(f.run()).toMatchObject({ ok: false, reason: expect.stringContaining('publication hold 9') });
    expect(f.state.posts).toEqual([]);
  });
  it('binds a new round id from the successful check summary rather than inferring it from local state', () => {
    const f = fixture(), roundId = '9c59c9f9-29a2-4c1f-9a14-f8c867a15542';
    f.state.checkRun.output.summary = `Round result\nRed-team round: ${roundId}`;
    f.state.history[0].description = `held: running round ${roundId} publication in progress`;
    expect(f.run()).toMatchObject({ ok: true, runId: 50 });
  });
  it('refuses a different round id even when the check run id still matches', () => {
    const f = fixture(); f.state.checkRun.output.summary = 'Round result\nRed-team round: recovered-round';
    f.state.history[0].description = 'held: running round 50 publication in progress';
    expect(f.run()).toMatchObject({ ok: false, reason: expect.stringContaining('recovered round recovered-round') });
    expect(f.state.posts).toEqual([]);
  });
  it.each([
    'held: finished round publication in progress',
    'held: red-team round not confirmed published',
    'held: publication republish unconfirmed; operator must inspect',
    'held: finished round 50 unknown state',
    'held: queued round 050 not confirmed published',
    `held: running round ${'x'.repeat(65)} not confirmed published`,
  ])('refuses unknown, malformed or nonmatching hold descriptions: %s', description => {
    const f = fixture(); f.state.history[0].description = description;
    expect(f.run()).toMatchObject({ ok: false, reason: expect.stringContaining('operator must inspect') });
    expect(f.state.posts).toEqual([]);
  });
  it.each([
    ['foreign-host pid', f => { f.state.local.host = 'foreign-fixture-host'; }],
    ['not finished', f => { f.state.local.status = 'running'; }],
    ['not ran/resumed', f => { f.state.local.result = 'not-owed'; }],
    ['sendBack', f => { f.state.local.sendBack = true; }],
    ['head moved', f => { f.state.live.headRefOid = 'b'.repeat(40); }],
    ['blocking label', f => { f.state.live.labels = [{ name: 'review:human' }]; }],
    ['unreadable labels', f => { f.state.live.labels = [null]; }],
    ['untrusted result author', f => { f.state.comments[0].author = { login: 'outsider' }; }],
    ['unknown writer description', f => { f.state.history[0].description = 'held: unknown writer'; }],
    ['live-helper hold description', f => { f.state.history[0].description = 'held: live red-team check not clear: awaiting post-publication validation'; }],
    ['policy-clear hold description', f => { f.state.history[0].description = 'held: live red-team check not clear: policy-clear awaiting post-publication validation'; }],
    ['untrusted hold author', f => { f.state.history[0].creator = { login: 'outsider' }; }],
    ['App token missing', f => { f.state.token = 'ghp_personal'; }],
  ])('refuses %s before any POST', (_name, change) => {
    const f = fixture(); change(f); writeJsonAtomic(f.path, f.state.local);
    expect(f.run().ok).toBe(false); expect(f.state.posts).toEqual([]); expect(existsSync(`${f.path}.unpublished`)).toBe(true);
  });
  it('refuses a live pid', () => { const f = fixture(); expect(f.run({ isAlive: () => true }).ok).toBe(false); expect(f.state.posts).toEqual([]); });
  it('refuses an enqueue hold', () => { const f = fixture(); expect(f.run({ enqueueHold: () => 'unsealed result' }).ok).toBe(false); expect(f.state.posts).toEqual([]); });
  it('refuses incomplete S1 even with a trusted success on the first page', () => {
    const f = fixture(); expect(f.run({ readHistory: () => ({ statuses: [status(40, 'success')], complete: false }) })).toMatchObject({ ok: false });
    expect(f.state.posts).toEqual([]);
  });
  it('refuses a failed latest App check', () => { const f = fixture(); expect(f.run({ readCheck: () => ({ ok: false, reason: 'failed' }) }).ok).toBe(false); expect(f.state.posts).toEqual([]); });
  it('accepts trusted operator results at gate parity', () => { const f = fixture(); f.state.comments[0].author = { login: OPERATOR_LOGINS[0] }; expect(f.run().ok).toBe(true); });
  it.each([
    ['live-check success hiding a failed round', LIVE_CHECK_TITLE_PREFIX, 'failure'],
    ['live-check success over a successful round', LIVE_CHECK_TITLE_PREFIX, 'success'],
    ['policy-clear success hiding a failed round', POLICY_CLEAR_TITLE_PREFIX, 'failure'],
    ['policy-clear success over a successful round', POLICY_CLEAR_TITLE_PREFIX, 'success'],
  ])('refuses %s before any POST', (_name, prefix, conclusion) => {
    const f = fixture(); f.state.checkRun.output.title = `${prefix}clear`;
    f.state.extraRuns = [{ id: 49, output: { title: 'Red-team round' }, conclusion }];
    expect(f.run()).toMatchObject({ ok: false, reason: expect.stringContaining('not a round run') });
    expect(f.state.posts).toEqual([]); expect(existsSync(`${f.path}.unpublished`)).toBe(true);
  });
  it.each([
    ['incomplete', { status: 'in_progress' }],
    ['failed', { conclusion: 'failure' }],
    ['unreadable title', { output: null }],
    ['wrong App', { app: { id: SYNTHETIC_APP + 1 } }],
  ])('refuses %s round check evidence before any POST', (_name, change) => {
    const f = fixture(); Object.assign(f.state.checkRun, change);
    expect(f.run().ok).toBe(false); expect(f.state.posts).toEqual([]);
    expect(existsSync(`${f.path}.unpublished`)).toBe(true);
  });
  it('accepts resumed round successes without timestamps', () => {
    const f = fixture(); f.state.local.result = 'resumed'; writeJsonAtomic(f.path, f.state.local);
    expect(f.run()).toMatchObject({ ok: true, runId: 50 });
  });
  it('keeps dry-run read-only while returning before history and decision', () => {
    const f = fixture(); const marker = readFileSync(`${f.path}.unpublished`, 'utf8');
    expect(f.run({ dryRun: true })).toMatchObject({ ok: true, decision: 'republish', before: f.state.history, runId: 50 });
    expect(f.state.posts).toEqual([]); expect(f.state.reads).toBe(1); expect(f.state.checks).toBe(1);
    expect(readFileSync(`${f.path}.unpublished`, 'utf8')).toBe(marker);
  });
  it('prints dry-run refusal context as JSON through the CLI', () => {
    const f = fixture(), print = vi.fn(); f.state.live.labels = ['red-team:blocked'];
    expect(main(['--repo', repo, '--pr', String(pr), '--head', head, '--dry-run'], {
      env: f.env, gh: f.gh, republish: args => f.run(args), print })).toBe(1);
    expect(print).toHaveBeenCalledWith(expect.objectContaining({ decision: 'refuse', before: f.state.history })); expect(f.state.posts).toEqual([]);
  });
  it('the CLI refuses an unresolved App token even when the operation would be a no-op', () => {
    const f = fixture(), print = vi.fn(), republish = vi.fn(() => ({ ok: true, noop: true }));
    f.state.token = 'ghp_synthetic_personal';
    expect(main(['--repo', repo, '--pr', String(pr), '--head', head], { env: f.env, gh: f.gh, republish, print })).toBe(1);
    expect(republish).not.toHaveBeenCalled();
    expect(print).toHaveBeenCalledWith(expect.objectContaining({ ok: false, decision: 'refuse' }));
  });
  it('the default complete comments reader uses bounded pages and fresh count proof', () => {
    const f = fixture(); expect(f.run({ readComments: undefined }).ok).toBe(true);
    expect(f.gh.mock.calls.some(([args]) => args[1]?.includes('/comments?per_page=100&page=1'))).toBe(true);
    expect(f.gh.mock.calls.some(([args]) => args[1] === 'graphql')).toBe(true);
  });
  it('refuses unreadable complete-comment evidence before posting', () => {
    const f = fixture(); f.state.comments[0].body = null;
    expect(f.run({ readComments: undefined }).ok).toBe(false); expect(f.state.posts).toEqual([]);
  });
  it('the CLI resolves an omitted head and runs the same dry-run decisions', () => {
    const f = fixture(), print = vi.fn();
    const gh = (args, options) => args[0] === 'pr' ? JSON.stringify(f.state.live) : f.gh(args, options);
    expect(main(['--repo', repo, '--pr', String(pr), '--dry-run'], { env: f.env, gh, print,
      republish: args => f.run(args) })).toBe(0);
    expect(print).toHaveBeenCalledWith(expect.objectContaining({ decision: 'republish' })); expect(f.state.posts).toEqual([]);
  });
  it('refuses malformed history ids', () => { const f = fixture(); f.state.history[0].id = undefined; expect(f.run().ok).toBe(false); expect(f.state.posts).toEqual([]); });
  it('reads every full page past a prior success and exposes the cap fallback', () => {
    const gh = vi.fn((_args) => JSON.stringify(Array.from({ length: 100 }, (_, i) => status(10000 - gh.mock.calls.length * 100 - i, 'success'))));
    const value = readStatusHistory({ repo, headSha: head, gh }); expect(value.complete).toBe(false); expect(gh).toHaveBeenCalledTimes(10);
    const f = fixture(); expect(f.run({ readHistory: () => value })).toMatchObject({ ok: false, reason: expect.stringContaining('operator must inspect') });
  });
  it('the check fact carries the latest App run id despite equal or missing timestamps', () => {
    const base = { name: 'red-team', app: { id: SYNTHETIC_APP }, external_id: `${repo}#${pr}`, head_sha: head, status: 'completed', conclusion: 'success' };
    expect(readRedTeamCheckFact({ repo, pr, headSha: head, appId: SYNTHETIC_APP,
      gh: () => JSON.stringify({ total_count: 2, check_runs: [{ ...base, id: 5 }, { ...base, id: 9 }] }) })).toMatchObject({ ok: true, runId: 9, completedAt: null, liveCheck: false });
  });
});

describe('round writers require App authentication and publish nothing for not-owed', () => {
  it('unresolved App token refuses before any hold or check POST', () => {
    const f = fixture(), gh = vi.fn(() => 'ghp_synthetic_personal'), postCheckRun = vi.fn(), postPublicationHold = vi.fn();
    const result = recordRedTeamStatus({ repo, pr, loopPayload: { findings: { read: { netBasis: { rev: head } } } }, status: 'running' },
      { env: f.env, gh, postCheckRun, postPublicationHold, log: () => {} });
    expect(result).toMatchObject({ published: false, reason: expect.stringContaining('App token unavailable') });
    expect(postCheckRun).not.toHaveBeenCalled(); expect(postPublicationHold).not.toHaveBeenCalled();
    expect(gh.mock.calls.map(([args]) => args[0])).toEqual(['auth']);
  });
  it('not-owed persists locally and neither resolves credentials nor publishes anything', () => {
    const f = fixture(), gh = vi.fn(), postCheckRun = vi.fn(), postPublicationHold = vi.fn();
    const marker = readFileSync(`${f.path}.unpublished`, 'utf8');
    recordRedTeamStatus({ repo, pr, loopPayload: { findings: { read: { netBasis: { rev: head } } } }, status: 'finished', result: 'not-owed' },
      { env: f.env, gh, postCheckRun, postPublicationHold });
    expect(gh).not.toHaveBeenCalled(); expect(postCheckRun).not.toHaveBeenCalled(); expect(postPublicationHold).not.toHaveBeenCalled();
    expect(readFileSync(`${f.path}.unpublished`, 'utf8')).toBe(marker);
    expect(JSON.parse(readFileSync(f.path, 'utf8')).result).toBe('not-owed');
  });
  it('a fresh not-owed transition creates no outbox and publishes nothing', () => {
    const f = fixture(); rmSync(`${f.path}.unpublished`);
    const gh = vi.fn();
    recordRedTeamStatus({ repo, pr, loopPayload: { findings: { read: { netBasis: { rev: head } } } }, status: 'finished', result: { status: 'not-owed' } },
      { env: f.env, gh });
    expect(gh).not.toHaveBeenCalled(); expect(existsSync(`${f.path}.unpublished`)).toBe(false);
  });
  it('persists sendBack for the republisher to refuse after the process exits', () => {
    const f = fixture();
    recordRedTeamStatus({ repo, pr, loopPayload: { findings: { read: { netBasis: { rev: head } } } }, status: 'finished', result: 'ran', sendBack: true },
      { env: f.env });
    expect(JSON.parse(readFileSync(f.path, 'utf8')).sendBack).toBe(true);
    expect(f.run().ok).toBe(false); expect(f.state.posts).toEqual([]);
  });
  it.each(['pending', 'queued', 'running', 'finished'])('the %s writer includes the same round id in its actual hold description and check POST', state => {
    const f = fixture(); rmSync(`${f.path}.unpublished`);
    expect(recordRedTeamStatus({ repo, pr, loopPayload: { findings: { read: { netBasis: { rev: head } } } }, status: state },
      { env: f.env, gh: f.gh })).toEqual({ published: true });
    expect(f.state.posts.map(s => s.state)).toEqual(['failure', state === 'finished' ? 'completed' : 'in_progress', 'success']);
    const roundId = /\nRed-team round: ([\w-]+)$/.exec(f.state.posts[1].output.summary)?.[1];
    expect(roundId).toMatch(/^[a-f0-9-]{36}$/);
    expect(f.state.posts[0].description).toBe(`held: ${state} round ${roundId} publication in progress`);
    expect(f.state.posts[0].description.length).toBeLessThanOrEqual(140);
  });
  it('the fallback hold and failure supersede retain the original round id after publication fails', () => {
    const f = fixture(), checks = []; rmSync(`${f.path}.unpublished`);
    let attempts = 0;
    expect(recordRedTeamStatus({ repo, pr, loopPayload: { findings: { read: { netBasis: { rev: head } } } }, status: 'running' },
      { env: f.env, gh: f.gh, log: () => {},
        postPublicationHold: args => ++attempts === 1 ? { ok: false, reason: 'HTTP 502' } : postRedTeamPublicationHold(args),
        postCheckRun: ({ payload }) => { checks.push(payload); return { ok: false, reason: 'HTTP 502' }; } }))
      .toMatchObject({ published: false });
    const roundId = /\nRed-team round: ([\w-]+)$/.exec(checks[0].output.summary)?.[1];
    expect(roundId).toMatch(/^[a-f0-9-]{36}$/);
    expect(checks.every(check => check.output.summary.endsWith(`\nRed-team round: ${roundId}`))).toBe(true);
    expect(f.state.posts[0].description).toBe(`held: running round ${roundId} not confirmed published`);
    expect(f.state.posts[0].description.length).toBeLessThanOrEqual(140);
  });
  it('a new attempt with an inherited hold posts its own distinct binding before its check', () => {
    const f = fixture(), checks = [], holds = []; rmSync(`${f.path}.unpublished`);
    const input = { repo, pr, loopPayload: { findings: { read: { netBasis: { rev: head } } } } };
    const options = { env: f.env, gh: f.gh, log: () => {},
      postPublicationHold: hold => { holds.push(hold); return hold.held ? { ok: true } : { ok: false, reason: 'HTTP 502' }; },
      postCheckRun: ({ payload }) => { checks.push(payload); return { ok: false, reason: 'HTTP 502' }; } };
    expect(recordRedTeamStatus({ ...input, status: 'running' }, options)).toMatchObject({ published: false });
    const firstRound = /\nRed-team round: ([\w-]+)$/.exec(checks[0].output.summary)?.[1];
    expect(firstRound).toMatch(/^[a-f0-9-]{36}$/);
    expect(recordRedTeamStatus({ ...input, status: 'finished' }, { ...options,
      postCheckRun: ({ payload }) => {
        expect(holds.at(-1).held).toBe(true);
        checks.push(payload); return { ok: true };
      } })).toMatchObject({ published: false });
    const secondRound = /\nRed-team round: ([\w-]+)$/.exec(checks.at(-1).output.summary)?.[1];
    expect(secondRound).toMatch(/^[a-f0-9-]{36}$/);
    expect(secondRound).not.toBe(firstRound);
    expect(holds.filter(h => h.held).map(h => h.reason)).toEqual([
      `running round ${firstRound} publication in progress`, `finished round ${secondRound} publication in progress`,
    ]);
  });
  it('token resolution strips inherited credentials and never exposes a token in its result', () => {
    const gh = vi.fn(() => 'ghs_synthetic_fixture_only');
    const writer = resolveRedTeamWriter({ env: { GH_TOKEN: 'ghp_personal', GITHUB_TOKEN: 'old' }, gh });
    expect(writer.ok).toBe(true); expect(JSON.stringify(writer)).not.toContain('ghs_');
    expect(gh.mock.calls[0][1].env).toEqual(redTeamWriterEnv({ GH_TOKEN: 'ghp_personal', GITHUB_TOKEN: 'old' }));
  });
  it('POST returns the actual status object', () => {
    expect(postRedTeamPublicationHold({ repo, pr, headSha: head, held: false,
      gh: () => JSON.stringify(status(88, 'success')) })).toEqual({ ok: true, status: status(88, 'success') });
  });
});
