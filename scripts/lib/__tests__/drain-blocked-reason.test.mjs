import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeBlockedChecks, decideGateSendBack, sendBackBlockedGate, sendBackBlockedGates } from '../drain-blocked-reason.mjs';
import { readMainCiRuns } from '../main-ci-reader.mjs';
import { buildVerdictComment } from '../../review-set-label.mjs';
import { FAILED_CHECK_CONCLUSIONS } from '../rollup-collapse.mjs';
import { classifyPr, unlandableStateReason } from '../../merge-ai-prs.mjs';
import { classifySkipReason } from '../drain-skip-reasons.mjs';
import { deriveWaitingOn } from '../../operations/pr-sweep-core.mjs';
import { classifyStall } from '../../conveyor/pr-stall-classify.mjs';
import soakBreak from '../../conveyor/soak/breaks/drain-blocked-reason-names-failed-check.mjs';
import { VERDICT_HEADINGS } from '../review-log-claims.mjs';
import { readCompletePrComments } from '../../conveyor/pr-comments-complete.mjs';
vi.mock('../../conveyor/pr-comments-complete.mjs', () => ({ readCompletePrComments: vi.fn(() => [{ id: 'IC_1', body: '✅ review — accepted', createdAt: '2026-11-25T15:00:00Z', author: { login: 'web-everything' } }]) }));
const head = 'a'.repeat(40), repo = 'web-everything/web-everything', requiredChecks = ['test', 'merge-gate'];
const at = n => new Date(Date.UTC(2026, 10, 25, 15, n)).toISOString();
const row = (name, conclusion = 'SUCCESS', extra = {}) => ({ id: 100, name, status: 'COMPLETED', conclusion, ...extra });
const comment = (createdAt = at(0), body = '✅ review — accepted') => ({ id: 'IC_1', createdAt, body, author: { login: 'web-everything' } });
const mainRun = (extra = {}) => ({ databaseId: 1, status: 'completed', conclusion: 'success', createdAt: at(0), updatedAt: at(7), event: 'push', attempt: 1, ...extra });
const green = () => ({ runs: [mainRun()], settledAt: at(7) });
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'drain-rerun-')), ledgerPath = join(dir, 'ledger.json');
  const pr = { number: 7483, headRefOid: head, rowsHead: head, rowsComplete: true, labels: ['ready-to-merge'],
    statusCheckRollup: [row('test'), row('merge-gate', 'FAILURE', { completedAt: at(5), detailsUrl: `https://github.com/${repo}/actions/runs/45635463327/job/1` })] };
  const run = { id: 45635463327, repository: { full_name: repo }, name: 'Merge gate', path: '.github/workflows/merge-gate.yml',
    event: 'pull_request_target', head_sha: head, run_attempt: 1, status: 'completed', conclusion: 'failure', updated_at: at(5) };
  const statePath = (r = repo, n = pr.number, id = run.id) => `${ledgerPath}.${r.replace('/', '~')}.${n}.${head}.${id}.rerun.json`;
  const writes = [], posts = [], bindings = [];
  let post = () => ({ status: 0 });
  const exec = vi.fn((cmd, args, options) => {
    expect(options.timeout).toBeGreaterThan(0); expect(options.maxBuffer).toBeGreaterThan(0);
    if (cmd !== 'gh') { writes.push(args); return { status: 0 }; }
    if (args[0] === 'pr') return { status: 0, stdout: JSON.stringify({ headRefOid: head }) };
    if (args.includes('POST')) { posts.push(args); return post(options); }
    bindings.push(args); return { status: 0, stdout: JSON.stringify(run) };
  });
  const options = { pr, headSha: head, requiredChecks, repo, ledgerPath, exec, readMain: green,
    readFreeze: () => ({ frozen: false, publishedAt: at(0) }), readComments: () => [comment()] };
  const go = extra => sendBackBlockedGate({ ...options, ...extra });
  const state = () => JSON.parse(readFileSync(statePath(), 'utf8'));
  try { return fn({ pr, run, go, options, statePath, state, writes, posts, bindings, exec, ledgerPath, dir, setPost: fn => { post = fn; } }); }
  finally { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); }
}
const held = (f, extra, reason) => { expect(f.go(extra)).toMatchObject({ sent: false, reason: expect.stringMatching(reason) }); expect(f.writes).toHaveLength(0); expect(f.posts).toHaveLength(0); };
describe('required-check diagnostics and existing writer safeguards', () => {
  it.each(FAILED_CHECK_CONCLUSIONS)('names failed required check %s and first summary', conclusion => fixture(f => {
    f.pr.statusCheckRollup[1] = row('merge-gate', conclusion, { output: { summary: '\n test-gaming\nmore' } });
    expect(describeBlockedChecks(f.pr, requiredChecks).text).toContain(`required check "merge-gate" ${conclusion}: test-gaming`);
  }));
  it('missing and queued checks wait; malformed evidence keeps original reason', () => {
    expect(describeBlockedChecks({ statusCheckRollup: [] }, requiredChecks).waiting).toHaveLength(2);
    expect(describeBlockedChecks({ statusCheckRollup: [null] }, requiredChecks)).toBeNull();
    expect(describeBlockedChecks({ statusCheckRollup: [row('test', null, { status: 'QUEUED' })] }, ['test']).failed).toEqual([]);
  });
  it('requires ready label, matching full head, complete rows and readable ledger', () => fixture(f => {
    for (const extra of [{ labels: [] }, { rowsComplete: false }, { rowsHead: 'b'.repeat(40) }])
      expect(decideGateSendBack({ ...f.options, pr: { ...f.pr, ...extra }, ledger: {} }).send).toBe(false);
    expect(decideGateSendBack({ ...f.options, ledger: null }).send).toBe(false);
    expect(decideGateSendBack({ ...f.options, headSha: 'short', ledger: {} }).send).toBe(false);
  }));
  it('mixed failures use changes only, durable ledger and once-per-head deduplication', () => fixture(f => {
    f.pr.statusCheckRollup[0].conclusion = 'FAILURE'; expect(f.go().sent).toBe(true);
    expect(f.writes[0]).toContain('--to=changes'); expect(f.go().sent).toBe(false); expect(f.writes).toHaveLength(1);
    expect(JSON.parse(readFileSync(f.ledgerPath))).toEqual({ [`${repo}#7483`]: { [head]: true } });
  }));
  it('corrupt ledger, refusal marker and lock contention refuse external writes', () => fixture(f => {
    writeFileSync(f.ledgerPath, 'bad'); held(f, {}, /unreadable/); rmSync(f.ledgerPath);
    writeFileSync(`${f.ledgerPath}.${head}.refused`, ''); held(f, {}, /refusal/); rmSync(`${f.ledgerPath}.${head}.refused`);
    writeFileSync(`${f.ledgerPath}.lock`, ''); held(f, {}, /locked/);
    utimesSync(`${f.ledgerPath}.lock`, new Date(0), new Date(0)); held(f, {}, /locked/); expect(existsSync(`${f.ledgerPath}.lock`)).toBe(false);
  }));
  it.each(['nonzero', 'throw', 'timeout'])('failed writer %s retains refusal reservation and never records the head', mode => fixture(f => {
    f.pr.statusCheckRollup[0].conclusion = 'FAILURE';
    let mutations = 0;
    const exec = (cmd, args, opts) => { if (cmd === 'gh') return f.exec(cmd, args, opts); mutations++;
      if (mode === 'throw') throw Error('failed'); return mode === 'timeout' ? { status: null, signal: 'SIGTERM', error: Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }) } : { status: 1 }; };
    expect(f.go({ exec }).reason).toMatch(/uncertain|unreadable/); expect(existsSync(f.ledgerPath)).toBe(false);
    held(f, {}, /refusal/); expect(mutations).toBe(1);
  }));
});
describe('retained diagnostics and ledger regressions', () => {
  it('newer queued replacement wins by run ID regardless of ordering or timestamps', () => fixture(f => {
    const older = row('merge-gate', 'FAILURE', { id: 100, completedAt: at(8) }), newer = row('merge-gate', null, { id: 101, status: 'QUEUED' });
    for (const rows of [[older, newer], [newer, older]]) { f.pr.statusCheckRollup = rows; expect(describeBlockedChecks(f.pr, ['merge-gate']).failed).toEqual([]); expect(f.go().sent).toBe(false); }
    expect(f.exec).not.toHaveBeenCalled();
  }));
  it.each([undefined, null, '', 0, -1, 'opaque-id'])('falls back from unusable id %s to paged checkRunId', id => fixture(f => {
    f.pr.statusCheckRollup = [row('merge-gate', 'FAILURE', { id, checkRunId: 101 }), row('merge-gate', null, { id: 100, checkRunId: 100, status: 'QUEUED' })];
    expect(describeBlockedChecks(f.pr, ['merge-gate']).failed).toHaveLength(1);
  }));
  it('extracts REST title and legacy description; malformed requirements and hostile accessors fail closed', () => {
    for (const r of [{ name: 'merge-gate', status: 'completed', conclusion: 'failure', output: { summary: ' ', title: 'title\nmore' } }, { context: 'merge-gate', state: 'FAILURE', description: 'title' }])
      expect(describeBlockedChecks({ statusCheckRollup: [r] }, ['merge-gate']).text).toContain(': title');
    for (const required of [null, [], [42], ['']]) expect(describeBlockedChecks({ statusCheckRollup: [] }, required)).toBeNull();
    expect(describeBlockedChecks({ get statusCheckRollup() { throw Error('unreadable'); } }, requiredChecks)).toBeNull();
  });
  it('acquisition guard serializes stale reapers and protects a replacement writer', () => fixture(f => {
    writeFileSync(`${f.ledgerPath}.lock`, ''); utimesSync(`${f.ledgerPath}.lock`, new Date(0), new Date(0));
    const statLock = () => { expect(f.go().reason).toContain('guard busy'); return { mtimeMs: 0 }; };
    expect(f.go({ statLock }).reason).toContain('locked'); expect(f.exec).not.toHaveBeenCalled();
    const exec = (cmd, args, opts) => { expect(f.go().reason).toContain('locked'); return f.exec(cmd, args, opts); };
    f.pr.statusCheckRollup[0].conclusion = 'FAILURE'; expect(f.go({ exec }).sent).toBe(true);
    expect(existsSync(`${f.ledgerPath}.lock`)).toBe(false); expect(existsSync(`${f.ledgerPath}.lock.guard`)).toBe(false);
  }));
  it('an abandoned guard and an unreadable refusal marker require operator repair', () => fixture(f => {
    writeFileSync(`${f.ledgerPath}.lock.guard`, ''); held(f, {}, /operator must repair/); rmSync(`${f.ledgerPath}.lock.guard`);
    mkdirSync(`${f.ledgerPath}.${head}.refused`); held(f, {}, /unreadable/); expect(f.exec).not.toHaveBeenCalled();
  }));
  it('ledger write failure after successful writer retains a durable refusal marker', () => fixture(f => {
    f.pr.statusCheckRollup[0].conclusion = 'FAILURE';
    const exec = (cmd, args, opts) => { if (cmd !== 'gh') mkdirSync(f.ledgerPath); return f.exec(cmd, args, opts); };
    expect(f.go({ exec })).toMatchObject({ sent: true, recorded: false, reason: expect.stringContaining('operator must repair') });
    expect(readFileSync(`${f.ledgerPath}.${head}.refused`, 'utf8')).toContain('reconcile');
  }));
  it('different PRs preserve each other in the locked ledger; head move/CLI failure/malformed live read never writes', () => {
    fixture(f => { f.pr.statusCheckRollup[0].conclusion = 'FAILURE'; f.go(); f.pr.number++; f.go(); expect(Object.keys(JSON.parse(readFileSync(f.ledgerPath)))).toHaveLength(2); });
    for (const r of [{ status: 1 }, { status: 0, stdout: '?' }, { status: 0, stdout: JSON.stringify({ headRefOid: 'b'.repeat(40) }) }]) fixture(f => held(f, { exec: () => r }, /head|unreadable/));
  });
  it('bounded main reads refresh the active ledger lock before it can be reaped', () => fixture(f => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const exec = (c, a, o) => { const r = f.exec(c, a, o); now += 61000; return r; };
    const readMain = ({ exec: read }) => {
      for (let i = 0; i < 5; i++) read('gh', ['api', 'fixture'], { timeout: 60000, maxBuffer: 1024 });
      expect(f.go().reason).toContain('locked'); expect(existsSync(`${f.ledgerPath}.lock`)).toBe(true); return green();
    };
    expect(f.go({ exec, readMain }).reason).toContain('requested'); expect(f.posts).toHaveLength(1);
  }));
  it('uses the actual shared reader through bounded gh exec with injected branch and cwd', () => fixture(f => {
    const exec = vi.fn((cmd, args, opts) => {
      if (args[0] !== 'run') return f.exec(cmd, args, opts);
      expect(args).toEqual(['run', 'list', '--repo', repo, '--workflow', 'ci.yml', '--branch', 'trunk', '--event', 'push', '--limit', '30', '--json', 'databaseId,conclusion,status,createdAt,updatedAt,headSha,event,attempt']);
      expect(opts).toMatchObject({ cwd: '/checkout', timeout: 60000, maxBuffer: 8 * 1024 * 1024 }); return { status: 0, stdout: JSON.stringify([mainRun()]) };
    });
    expect(f.go({ readMain: readMainCiRuns, exec, defaultBranch: 'trunk', cwd: '/checkout' }).reason).toContain('requested'); expect(f.posts).toHaveLength(1);
  }));
  it('rechecks the live head after binding and before spending a POST', () => fixture(f => {
    let views = 0;
    const exec = (c, a, o) => a[0] === 'pr' && ++views > 1 ? { status: 0, stdout: JSON.stringify({ headRefOid: 'b'.repeat(40) }) } : f.exec(c, a, o);
    held(f, { exec }, /head changed/); expect(existsSync(f.statePath())).toBe(false);
  }));
});
describe('Required-gate send-back R1–R3', () => {
  it('T1 #7483 replay: gate older than main settle is re-run once via REST, never sent back', () => fixture(f => {
    f.run.updated_at = f.pr.statusCheckRollup[1].completedAt = '2026-11-25T14:35:06Z';
    f.go({ readComments: () => [comment('2026-11-25T14:00:00Z')], readMain: () => ({ ...green(), settledAt: '2026-11-25T15:07:20Z' }) }); expect(f.writes).toHaveLength(0);
    expect(f.posts).toEqual([['api', '-X', 'POST', `repos/${repo}/actions/runs/45635463327/rerun`]]);
    expect(f.writes).toHaveLength(0); f.go(); expect(f.posts).toHaveLength(1);
  }));
  it('T2 #7452 replay: ledgered head, rendered clear-human, stale then in-progress then green', () => fixture(f => {
    f.pr.number = 7452; writeFileSync(f.ledgerPath, JSON.stringify({ [`${repo}#7452`]: { [head]: true } }));
    const readComments = () => [comment(at(9), buildVerdictComment({ to: 'clear-human', actor: 'nicolas', headSha: head }))];
    expect(f.go({ readComments }).reason).toContain('requested'); f.run.run_attempt++; f.run.status = 'in_progress';
    expect(f.go({ readComments }).reason).toContain('in progress'); f.run.status = 'completed'; f.run.conclusion = 'success';
    expect(f.go({ readComments }).sent).toBe(false); expect(f.posts).toHaveLength(1); expect(f.writes).toHaveLength(0);
  }));
  it.each(['red', 'pending', 'unknown', 'frozen', 'unreadable', 'throw'])('T3 main/freeze %s holds without writes', mode => fixture(f => {
    const extra = mode === 'red' ? { readMain: () => ({ runs: [mainRun({ conclusion: 'failure' })], settledAt: at(7) }) }
      : mode === 'pending' ? { readMain: () => ({ runs: [mainRun({ status: 'in_progress', attempt: 2 })], settledAt: at(7) }) }
      : mode === 'unknown' ? { readMain: () => ({ runs: [] }) }
      : { readFreeze: () => { if (mode === 'throw') throw Error('offline'); return mode === 'frozen' ? { frozen: true } : { error: 'offline' }; } };
    held(f, extra, /main|freeze/);
  }));
  it('T4 matches the PR head case-insensitively without an association', () => fixture(f => {
    f.run.head_sha = head.toUpperCase(); expect(f.go().reason).toContain('requested'); expect(f.posts).toHaveLength(1); expect(f.writes).toHaveLength(0);
  }));
  it.each([{ name: 'Fake' }, { path: 'evil.yml' }, { event: 'pull_request' }, { head_sha: 'c'.repeat(40) },
    { repository: { full_name: 'other/repo' } }, { id: 2 }, { run_attempt: undefined }, { run_attempt: 1.5 }, { run_attempt: Number.MAX_SAFE_INTEGER + 1 }, { status: 'alien' }])('T4 unbound run %j holds', bad => fixture(f => {
    Object.assign(f.run, bad); held(f, {}, /binding|status/);
  }));
  it('T4 missing/foreign URL, failed GET and moved live head hold; optional @ref binds', () => {
    for (const detailsUrl of [undefined, 'https://github.com/evil/x/actions/runs/1']) fixture(f => { f.pr.statusCheckRollup[1].detailsUrl = detailsUrl; held(f, {}, /binding/); });
    fixture(f => held(f, { exec: () => ({ status: 1 }) }, /head/));
    fixture(f => held(f, { exec: (c, a, o) => a[0] === 'api' ? { status: 1 } : f.exec(c, a, o) }, /binding/));
    fixture(f => { f.run.path += '@refs/heads/main'; expect(f.go().reason).toContain('requested'); });
  });
  it.each(['nonzero', 'throw'])('T5 refused REST %s spends count, keeps skipped', mode => fixture(f => {
    f.setPost(() => { if (mode === 'throw') throw Error('missing token'); return { status: 1 }; });
    expect(f.go()).toMatchObject({ sent: false, reason: expect.stringMatching(/refused|unreadable/) });
    expect(f.state()).toMatchObject({ count: 1, confirmed: false }); expect(f.writes).toHaveLength(0);
  }));
  it('one logical rerun request issues at most one POST with per-call attempt override', () => fixture(f => {
    const before = process.env.WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS;
    f.setPost(options => { expect(options.env.WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS).toBe('1'); expect(f.state()).toMatchObject({ count: 1, confirmed: false }); expect(existsSync(`${f.ledgerPath}.lock`)).toBe(true); return { status: 0 }; });
    f.go(); expect(f.posts).toHaveLength(1); expect(f.state().confirmed).toBe(true); expect(process.env.WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS).toBe(before);
  }));
  it('T6 A+1 active waits, success holds, fresh red sends once, stale red reruns', () => {
    for (const [status, conclusion, time, count, sent] of [['in_progress', null, at(8), 1, false], ['completed', 'success', at(8), 1, false], ['completed', 'failure', at(8), 1, true], ['completed', 'failure', at(6), 2, false]]) fixture(f => {
      f.go(); Object.assign(f.run, { run_attempt: 2, status, conclusion, updated_at: time });
      expect(f.go().sent).toBe(sent); expect(f.posts).toHaveLength(count); expect(f.writes).toHaveLength(sent ? 1 : 0);
    });
  });
  it('T7 fourth clearing input exhausts with hand re-run or ruling, never bounces', () => fixture(f => {
    for (let attempt = 1; attempt <= 3; attempt++) { f.run.run_attempt = attempt; f.go(); }
    f.run.run_attempt = 4; expect(f.go().reason).toMatch(/exhausted.*(?:hand re-run|ruling)/); expect(f.posts).toHaveLength(3); expect(f.writes).toHaveLength(0);
  }));
  it('T8 crash accounting: before POST, lost response, failed confirm each spend budget; at most 3', () => fixture(f => {
    let now = Date.parse(at(10)); vi.spyOn(Date, 'now').mockImplementation(() => now);
    writeFileSync(f.statePath(), JSON.stringify({ count: 1, attempt: 1, at: new Date(now).toISOString(), confirmed: false }));
    expect(f.go().reason).toMatch(/unconfirmed|in flight/); expect(f.posts).toHaveLength(0);
    now += 300000; f.setPost(() => { throw Error('lost response'); }); f.go(); expect(f.state().count).toBe(2);
    now += 300000; f.setPost(() => { mkdirSync(`${f.statePath()}.pending`); return { status: 0 }; });
    expect(f.go().sent).toBe(false); expect(f.state()).toMatchObject({ count: 3, confirmed: false });
    rmSync(`${f.statePath()}.pending`, { recursive: true }); now += 300000;
    expect(f.go().reason).toContain('exhausted'); expect(f.posts).toHaveLength(2); expect(f.writes).toHaveLength(0);
  }));
  it('T9 freeze-lift replay re-runs once with green main and newer lift', () => fixture(f => {
    expect(f.go({ readMain: () => ({ runs: [mainRun()], settledAt: at(0) }), readFreeze: () => ({ frozen: false, publishedAt: at(9) }) }).reason).toContain('requested');
    expect(f.posts).toHaveLength(1); expect(f.writes).toHaveLength(0);
  }));
  it('T10 accepted, never started at 30 minutes names an operator reason', () => fixture(f => {
    let now = Date.parse(at(10)); vi.spyOn(Date, 'now').mockImplementation(() => now); f.go(); now += 1800000;
    expect(f.go().reason).toMatch(/accepted, never started.*operator/); expect(f.posts).toHaveLength(1);
  }));
  it('T11 shared reader: max completed updatedAt includes older late completion; ignores cancelled and infra-only', async () => {
    const runs = [mainRun({ databaseId: 4, conclusion: 'failure', createdAt: at(4), updatedAt: at(30) }), mainRun({ databaseId: 3, conclusion: 'cancelled', createdAt: at(3), updatedAt: at(25) }), mainRun({ databaseId: 2, createdAt: at(2), updatedAt: at(7) }), mainRun({ updatedAt: at(9) })];
    const exec = vi.fn((_c, args) => JSON.stringify(args[0] === 'run' ? runs : { total_count: 1, jobs: [{ status: 'completed', conclusion: 'cancelled', run_attempt: 1 }] }));
    const result = readMainCiRuns({ repo, exec }); expect(result.settledAt).toBe(at(9)); expect(result.runs[0].infraOnly).toBe(true);
    expect(exec.mock.calls[0][1]).toEqual(['run', 'list', '--repo', repo, '--workflow', 'ci.yml', '--branch', 'main', '--event', 'push', '--limit', '30', '--json', 'databaseId,conclusion,status,createdAt,updatedAt,headSha,event,attempt']);
    const pending = readMainCiRuns({ repo, exec: () => JSON.stringify([mainRun({ status: 'in_progress', attempt: 2 })]) }); expect(pending.error).toContain('being re-run');
  });
  it.each([undefined, 'bad', ''])('T12 invalid main/freeze timestamps %s hold', time => {
    fixture(f => held(f, { readMain: () => ({ ...green(), settledAt: time }) }, /main/));
    fixture(f => held(f, { readFreeze: () => ({ frozen: false, publishedAt: time }) }, /freeze/));
  });
  it('T13 mixed failures send back; incomplete/head-mismatched rows keep skipped', () => {
    fixture(f => { f.pr.statusCheckRollup[0].conclusion = 'FAILURE'; expect(f.go().sent).toBe(true); expect(f.posts).toHaveLength(0); });
    for (const extra of [{ rowsComplete: false }, { rowsHead: 'b'.repeat(40) }]) fixture(f => { Object.assign(f.pr, extra); expect(f.go().sent).toBe(false); expect(f.exec).not.toHaveBeenCalled(); });
  });
  it('T14 cached main per repo uses defaultBranchOf/cwdOf; repo B red cannot hold A; freeze once via API', () => fixture(f => {
    const readMain = vi.fn(({ repo: r }) => r === repo ? green() : { runs: [mainRun({ conclusion: 'failure' })], settledAt: at(7) });
    const readFreeze = vi.fn(f.options.readFreeze), cwdOf = vi.fn(r => r ? '/repo-b' : '/repo-a'), defaultBranchOf = vi.fn(r => r ? 'trunk' : 'main');
    const verdicts = [null, null, 'other/repo'].map((r, i) => ({ num: 7483 + i, repo: r, listedHeadSha: head, decision: 'skip', reason: 'merge state BLOCKED; required check "merge-gate" FAILURE' }));
    const prsByRepo = new Map([[null, [f.pr, { ...f.pr, number: 7484 }]], ['other/repo', [{ ...f.pr, number: 7485 }]]]);

    const result = sendBackBlockedGates({ ...f.options, prsByRepo, verdicts, requiredChecksOf: () => requiredChecks, localSlug: repo, cwdOf, defaultBranchOf, readMain, readFreeze });
    expect(readMain).toHaveBeenCalledTimes(2); expect(readMain).toHaveBeenCalledWith(expect.objectContaining({ repo, defaultBranch: 'main', cwd: '/repo-a' }));
    expect(readMain).toHaveBeenCalledWith(expect.objectContaining({ repo: 'other/repo', defaultBranch: 'trunk', cwd: '/repo-b' }));
    expect(readFreeze).toHaveBeenCalledTimes(1); expect(readFreeze).toHaveBeenCalledWith({ readsSource: 'api', slug: repo }); expect(f.posts).toHaveLength(2); expect(f.writes).toHaveLength(0); expect(result.at(-1).reason).toContain('main');
  }));
  it.each(['throw', 'bad-time', 'no-verdict', 'untrusted'])('unreadable verdict evidence %s keeps skipped (flipped)', mode => fixture(f => {
    const readComments = () => { if (mode === 'throw') throw Error('offline'); return mode === 'bad-time' ? [comment('bad')]
      : mode === 'no-verdict' ? [] : [{ ...comment(), author: { login: 'rando' } }]; };
    held(f, { readComments }, /verdict/);
  }));
  it('unreadable completion keeps skipped (flipped)', () => fixture(f => { f.run.updated_at = 'bad'; held(f, {}, /completion/); }));
  it('unreadable rollup completion keeps skipped (flipped)', () => fixture(f => { delete f.pr.statusCheckRollup[1].completedAt; held(f, {}, /completion/); }));
  it('equal clearing time is fresh; ledgered fresh-red head stays skipped', () => fixture(f => {
    f.run.updated_at = at(7); expect(f.go().sent).toBe(true); f.writes.length = 0; held(f, {}, /already|ledger/);
  }));
  it.each(['🔁 review — changes requested', '🔁 human review — changes requested', '🔁 human review - changes requested'])('newest trusted bounce %s overrides acceptance; untrusted newer clearance has no authority', heading => fixture(f => {
    const readComments = () => [comment(at(4)), comment(at(9), heading), { ...comment(at(20)), author: { login: 'rando' } }];
    f.run.updated_at = at(8); expect(f.go({ readComments }).sent).toBe(true); expect(f.posts).toHaveLength(0);
  }));
  it('unreadable/invalid rerun state holds; legacy markers are inert; distinct runs have distinct state', () => {
    for (const raw of ['bad', 'null', 'false', JSON.stringify({ count: 4, attempt: 1, at: at(0), confirmed: true }), JSON.stringify({ count: 1, attempt: 99, at: at(0), confirmed: true })]) fixture(f => { writeFileSync(f.statePath(), raw); held(f, {}, /state/); });
    fixture(f => { writeFileSync(`${f.ledgerPath}.${head}.IC_1.rerun`, 'requested'); f.go(); f.run.id++; f.pr.statusCheckRollup[1].detailsUrl = `https://github.com/${repo}/actions/runs/${f.run.id}`; f.go(); expect(f.posts).toHaveLength(2); expect(readdirSync(f.dir).filter(n => n.endsWith('.rerun.json'))).toHaveLength(2); });
  });
});
describe('restored HEAD coverage', () => {
  it.each(['IN_PROGRESS', 'QUEUED', 'PENDING'])('reports %s and absent required checks as waiting', status => {
    expect(describeBlockedChecks({ statusCheckRollup: [row('merge-gate', null, { status })] }, ['merge-gate']).text).toBe(`waiting on required check "merge-gate" (${status})`);
    expect(describeBlockedChecks({ statusCheckRollup: [] }, ['merge-gate']).text).toBe('waiting on required check "merge-gate" (absent)');
  });
  it('latest timestamp wins without IDs; untimestamped queued replacement also waits', () => fixture(f => {
    f.pr.statusCheckRollup = [row('merge-gate', 'FAILURE', { id: undefined, completedAt: at(0) }), row('merge-gate', 'SUCCESS', { id: undefined, completedAt: at(1) })];
    expect(describeBlockedChecks(f.pr, ['merge-gate']).failed).toEqual([]);
    Object.assign(f.pr.statusCheckRollup[1], { conclusion: null, status: 'QUEUED', startedAt: '0001-01-01T00:00:00Z', completedAt: '0001-01-01T00:00:00Z' });
    expect(describeBlockedChecks(f.pr, ['merge-gate']).text).toContain('(QUEUED)'); expect(f.go().sent).toBe(false); expect(f.exec).not.toHaveBeenCalled();
  }));
  it.each(['IN_PROGRESS', 'QUEUED'])('newer paged failure beats older %s without mutating frozen rows', status => fixture(f => {
    const newer = Object.freeze(row('merge-gate', 'FAILURE', { id: undefined, checkRunId: 101 }));
    const older = Object.freeze(row('merge-gate', null, { id: undefined, checkRunId: 100, status, completedAt: '0001-01-01T00:00:00Z' }));
    f.pr.statusCheckRollup = Object.freeze([newer, older]);
    expect(describeBlockedChecks(f.pr, ['merge-gate'])).toEqual({ failed: ['required check "merge-gate" FAILURE'], waiting: [], text: 'required check "merge-gate" FAILURE' });
    expect(decideGateSendBack({ ...f.options, ledger: {} })).toEqual({ send: true, body: 'required check "merge-gate" FAILURE' }); expect(newer.id).toBeUndefined(); expect(older.id).toBeUndefined();
  }));
  it('preserves usable IDs over conflicting checkRunIds', () => {
    expect(describeBlockedChecks({ statusCheckRollup: [row('merge-gate', 'FAILURE', { id: 101, checkRunId: 100 }), row('merge-gate', null, { id: 100, checkRunId: 101, status: 'QUEUED' })] }, ['merge-gate']).text).toBe('required check "merge-gate" FAILURE');
  });
  it.each([null, {}, { statusCheckRollup: 'bad' }, { statusCheckRollup: [null] }, { statusCheckRollup: [{ name: 'merge-gate', status: 'ALIEN' }] }])('retains the original reason for odd evidence %j', pr => {
    expect(describeBlockedChecks(pr, requiredChecks)).toBeNull();
  });
  it('refuses all incomplete rows, invalid heads, moved heads and unreadable ledgers', () => fixture(f => {
    for (const extra of [{ rowsComplete: undefined }, { rowsComplete: 'true' }, { rowsHead: undefined }]) expect(decideGateSendBack({ ...f.options, pr: { ...f.pr, ...extra }, ledger: {} }).send).toBe(false);
    for (const headSha of ['abc', '', 'z'.repeat(40), 'b'.repeat(40)]) expect(decideGateSendBack({ ...f.options, headSha, ledger: {} }).send).toBe(false);
  }));
  it('never merges or enqueues failed checks in prestage mode; waiting remains checks-pending', () => fixture(f => {
    Object.assign(f.pr, { baseRefName: 'main', title: 'Gate', body: 'Fix the gate.', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' });
    const opts = { defaultBranch: 'main', queueRequiredChecks: requiredChecks };
    for (const preparePendingCi of [false, true]) { const result = classifyPr(f.pr, { ...opts, preparePendingCi });
      expect(result.decision).toBe('skip'); expect(result.queueBlockedRelief).toBeUndefined(); expect(result.reason).toContain(unlandableStateReason('BLOCKED') + '; required check "merge-gate" FAILURE'); expect(classifySkipReason(result.reason)).toBe('checks-failed'); }
    f.pr.statusCheckRollup[1] = row('merge-gate', null, { status: 'IN_PROGRESS' });
    expect(classifyPr(f.pr, opts).reason).toContain('(IN_PROGRESS)'); expect(classifySkipReason(classifyPr(f.pr, opts).reason)).toBe('checks-pending');
  }));
  it('writer preserves holds, uses a body file, records after success and permits a new head', () => fixture(f => {
    f.pr.labels.push('review:human', 'review:changes', 'review:held-mechanical');
    const requiredChecks = ['merge-gate'], readMain = () => ({ ...green(), settledAt: at(0) }); f.run.updated_at = at(8);
    const exec = (cmd, args, options) => { if (cmd !== 'gh') {
      expect(cmd).toBe(process.execPath); expect(args.filter(a => a.startsWith('--to='))).toEqual(['--to=changes']); expect(args).toContain(`--repo=${repo}`);
      expect(args.some(a => /--(?:remove|add)-label/.test(a))).toBe(false); expect(readFileSync(args.find(a => a.startsWith('--body-file=')).slice(12), 'utf8')).toBe('required check "merge-gate" FAILURE'); expect(existsSync(f.ledgerPath)).toBe(false);
    } return f.exec(cmd, args, options); };
    expect(f.go({ exec, readMain, requiredChecks }).recorded).toBe(true); expect(f.go({ readMain, requiredChecks }).sent).toBe(false);
    const next = 'b'.repeat(40); Object.assign(f.pr, { headRefOid: next, rowsHead: next }); f.pr.statusCheckRollup[0].conclusion = 'FAILURE';
    const movedExec = (c, a, o) => a[0] === 'pr' ? { status: 0, stdout: JSON.stringify({ headRefOid: next }) } : f.exec(c, a, o);
    expect(f.go({ headSha: next, exec: movedExec }).sent).toBe(true); expect(JSON.parse(readFileSync(f.ledgerPath))[`${repo}#7483`]).toEqual({ [head]: true, [next]: true });
  }));
  it('BLOCKED skip pass sends fresh failure back and leaves the PR skipped', () => fixture(f => {
    f.run.updated_at = at(8); const verdicts = [{ num: f.pr.number, repo: null, decision: 'skip', listedHeadSha: head, reason: 'merge state BLOCKED; required check "merge-gate" FAILURE' }];
    const result = sendBackBlockedGates({ ...f.options, verdicts, prsByRepo: new Map([[null, [f.pr]]]), localSlug: repo, cwdOf: () => process.cwd(), requiredChecksOf: () => requiredChecks });
    expect(f.writes).toHaveLength(1); expect(result[0]).toMatchObject({ sent: true, recorded: true }); expect(verdicts[0].decision).toBe('skip');
  }));
  it.each([0o300, 0o500])('refuses inaccessible ledger directory %s without external calls', mode => fixture(f => {
    try { chmodSync(f.dir, mode); expect(f.go().sent).toBe(false); expect(f.exec).not.toHaveBeenCalled(); } finally { chmodSync(f.dir, 0o700); }
  }));
  it('soak fix signal is independent of a failing diagnostic scenario', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drain-soak-')), previous = process.env.SOAK_TREE_ROOT;
    try { mkdirSync(join(root, 'scripts/lib'), { recursive: true }); writeFileSync(join(root, 'scripts/lib/drain-skip-reasons.mjs'), readFileSync('scripts/lib/drain-skip-reasons.mjs')); writeFileSync(join(root, 'scripts/lib/drain-blocked-reason.mjs'), 'export const describeBlockedChecks = () => null;'); process.env.SOAK_TREE_ROOT = root;
      expect(soakBreak.fixPresent(root)).toBe(true); expect(soakBreak.judge(await soakBreak.run())).toHaveLength(1);
    } finally { if (previous === undefined) delete process.env.SOAK_TREE_ROOT; else process.env.SOAK_TREE_ROOT = previous; rmSync(root, { recursive: true, force: true }); }
  });
  it('maps failed checks to the CI actor and stalled recovery', () => fixture(f => {
    const row = { repo, number: f.pr.number, waitingOn: 'drain-skip:checks-failed', actor: 'ci', stalled: true, liveJob: null, why: 'required check failed', evidence: [], next: null };
    expect(deriveWaitingOn({ ...f.pr, repo, comments: [], statusCheckRollup: [] }, { now: Date.now(), drainSkips: [{ num: f.pr.number, repo, kind: 'checks-failed', reason: row.why }] })).toMatchObject({ state: row.waitingOn, actor: 'ci' });
    expect(classifyStall({ row, head })).toMatchObject({ lane: 'system', action: 'tooling-card', smell: 'ci-job-hung' });
    expect(classifyStall({ row: { ...row, stalled: false }, head })).toBeNull(); expect(classifyStall({ row: { ...row, liveJob: 'ci' }, head })).toBeNull(); expect(classifyStall({ row: { ...row, actor: 'operator' }, head }).reason).toContain('does not fit');
  }));
  it.each([...VERDICT_HEADINGS.filter(h => ['accepted', 'clear-human'].includes(h.kind)).map(h => h.prefix), '✅ human review — accepted'])('counts clearing heading %s', heading => fixture(f => {
    expect(f.go({ readComments: () => [comment(at(9), heading)] }).reason).toContain('requested'); expect(f.writes).toHaveLength(0);
  }));
  it('default complete comment reader receives this PR/repo and paged rows use checkRunId ordering', () => fixture(f => {
    vi.mocked(readCompletePrComments).mockClear(); vi.mocked(readCompletePrComments).mockReturnValueOnce([comment(at(9))]);
    f.pr.statusCheckRollup = [row('test'), ...[101, 100].map(checkRunId => row('merge-gate', 'FAILURE', { id: undefined, checkRunId, completedAt: checkRunId === 101 ? at(5) : at(10), detailsUrl: f.pr.statusCheckRollup[1].detailsUrl }))];
    expect(f.go({ readComments: undefined }).reason).toContain('requested'); expect(readCompletePrComments).toHaveBeenCalledWith(f.pr.number, { repo }); expect(f.writes).toHaveLength(0);
  }));
  it('#7472 stale merge-gate replay requests run 45545719563 via REST', () => fixture(f => {
    f.pr.number = 7472; f.run.id = 45545719563; f.pr.statusCheckRollup[1].detailsUrl = `https://github.com/${repo}/actions/runs/45545719563/job/138974726864`;
    f.run.updated_at = f.pr.statusCheckRollup[1].completedAt = '2026-11-25T04:18:05Z';
    expect(f.go({ readComments: () => [comment('2026-11-25T03:43:10Z', '🔁 review — changes requested'), comment('2026-11-25T07:19:09Z')], readMain: () => ({ ...green(), settledAt: '2026-11-25T03:00:00Z' }), readFreeze: () => ({ frozen: false, publishedAt: '2026-11-25T03:00:00Z' }) }).reason).toContain('requested');
    expect(f.posts).toEqual([['api', '-X', 'POST', `repos/${repo}/actions/runs/45545719563/rerun`]]); expect(f.writes).toHaveLength(0);
  }));
  it('equal verdict time is fresh; a malformed trusted bounce time holds', () => {
    fixture(f => { f.run.updated_at = at(9); expect(f.go({ readComments: () => [comment(at(9))] }).sent).toBe(true); expect(f.posts).toHaveLength(0); });
    fixture(f => held(f, { readComments: () => [comment(), comment('bad', '🔁 review — changes requested')] }, /verdict/));
  });
  it('merge-gate first among required checks still sends mixed failures back', () => fixture(f => {
    f.pr.statusCheckRollup[0].conclusion = 'FAILURE'; expect(f.go({ requiredChecks: ['merge-gate', 'test'] }).sent).toBe(true); expect(f.posts).toHaveLength(0);
  }));
});
