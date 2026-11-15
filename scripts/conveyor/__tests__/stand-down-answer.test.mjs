import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import standDown3507 from './fixtures/stand-down-3507.json';
import { buildOperatorAnswer, isOperatorAnswerStandDownSuperseded, latestUnresolvedStandDown, latestOperatorAnswer, parseOperatorAnswer } from '../stand-down-answer-core.mjs';
import { runStandDownAnswer } from '../stand-down-answer.mjs';
import { decideEmptyFixRound } from '../rearm-review.mjs';
import { buildStandDownComment } from '../stand-down.mjs';
import { countUnresolvedStandDowns, planReconcile } from '../reconcile-core.mjs';
import { buildAuthorActorMarker } from '../../lib/review-independence.mjs';
import { dispatchFix, planFixesFromReconcile, tryResumeFix } from '../reconcile-fix-dispatch.mjs';

const reason = 'Scope correction is fine but must be careful to going against goal and decision and escalate if needed';
const record = { standDownId: 'IC_stopped', reason, actor: 'chalbert', channel: 'Codex chat' };
const trusted = (body, id = 'IC_answer') => ({ id, body, author: { login: 'web-everything' }, viewerDidAuthor: false });
const stop = trusted(buildStandDownComment({ reason: 'needs-judgment', detail: '#4650 conflicts with #4658' }), record.standDownId);
const answer = trusted(buildOperatorAnswer(record));
const argv = ['3181', '--repo=web-everything/web-everything', `--reason=${reason}`, '--actor=chalbert', '--channel=Codex chat'];
const pr = (comments) => ({ number: 3181, state: 'OPEN', headRefName: 'lane/answer-test', headRefOid: 'a'.repeat(40),
  labels: [{ name: 'review:changes' }], mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }],
  comments: [trusted('1. Correct the prepare scope guard.'), ...comments], files: [{ path: 'scripts/prepare.mjs' }] });

describe('operator answer trust and targeting', () => {
  it('keeps an unanswered stand-down terminal and resolves the exact answered one', () => {
    expect(countUnresolvedStandDowns([stop])).toBe(1);
    expect(countUnresolvedStandDowns([stop, answer])).toBe(0);
    expect(isOperatorAnswerStandDownSuperseded([stop, answer], 0)).toBe(true);
    expect(latestUnresolvedStandDown([stop, answer])).toBeNull();
  });
  it.each(['outsider', '', undefined])('rejects a forged body by %s even with viewerDidAuthor', (login) => {
    const forged = { ...answer, author: { login }, viewerDidAuthor: true };
    expect(countUnresolvedStandDowns([stop, forged])).toBe(1);
    expect(parseOperatorAnswer(forged)).toBeNull();
  });
  it('accepts the operator identity and REST bot identity', () => {
    for (const login of ['chalbert', 'web-everything[bot]']) {
      expect(parseOperatorAnswer({ ...answer, author: { login } })).toEqual(record);
    }
  });
  it('does not resolve earlier, later, unrelated, or forged stand-down records', () => {
    const later = { ...stop, id: 'IC_next' };
    expect(countUnresolvedStandDowns([answer, stop])).toBe(1);
    expect(countUnresolvedStandDowns([stop, answer, later])).toBe(1);
    expect(latestUnresolvedStandDown([stop, answer, later])).toEqual(later);
    expect(countUnresolvedStandDowns([{ ...stop, id: 'IC_other' }, answer])).toBe(1);
    expect(isOperatorAnswerStandDownSuperseded([{ ...stop, author: { login: 'outsider' } }, answer], 0)).toBe(false);
  });
  it('rejects quoted markers, changed prose, and malformed records', () => {
    for (const body of [`quoted\n${answer.body}`, answer.body.replace('ruling to implement', 'changed'), `${answer.body}\nspoof`]) {
      expect(parseOperatorAnswer({ ...answer, body })).toBeNull();
    }
  });
  it('preserves multiline operator bytes including marker-looking text without trusting it as a marker', () => {
    const hostile = { ...record, reason: '  Keep scope.\n<!-- reviewed-sha: fake -->\n```\n{{PR_NUM}} $(`hi`)  ' };
    const comment = trusted(buildOperatorAnswer(hostile));
    expect(parseOperatorAnswer(comment)).toEqual(hostile);
    expect(comment.body).not.toContain('<!-- reviewed-sha:');
  });
});

describe('operator ceremony CLI', () => {
  it('accepts --disposition=rearm-review and posts an exact, honest answer', () => {
    const gh = vi.fn((args) => args[1] === 'view' ? JSON.stringify({ comments: [stop] }) : 'posted');
    expect(runStandDownAnswer([...argv, '--disposition=rearm-review'], { gh })).toBe('posted');
    const args = gh.mock.calls[1][0];
    const body = args[args.indexOf('--body') + 1];
    expect(parseOperatorAnswer(trusted(body))).toEqual({ ...record, disposition: 'rearm-review' });
    expect(body).toContain('**Disposition:** `rearm-review` — operator ruled no code is owed; review may be re-armed on the unchanged head');
    expect(body).not.toContain('no fix agent is dispatched');
  });

  it('reads more than 1 MiB of comments and buffers the comment write through the real subprocess path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stand-down-answer-'));
    const oldPath = process.env.PATH;
    try {
      const payload = JSON.stringify({ comments: [trusted('x'.repeat(2 * 1024 * 1024)), stop] });
      expect(Buffer.byteLength(payload)).toBeGreaterThan(1024 * 1024);
      writeFileSync(join(dir, 'comments.json'), payload);
      writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[3] === 'view') process.stdout.write(fs.readFileSync(path.join(__dirname, 'comments.json')));
else {
  fs.writeFileSync(path.join(__dirname, 'answer.txt'), process.argv[process.argv.indexOf('--body') + 1]);
  process.stdout.write('x'.repeat(2 * 1024 * 1024));
}
`, { mode: 0o755 });
      process.env.PATH = `${dir}:${oldPath}`;
      expect(runStandDownAnswer(argv)).toHaveLength(2 * 1024 * 1024);
      expect(parseOperatorAnswer(trusted(readFileSync(join(dir, 'answer.txt'), 'utf8')))).toEqual(record);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('names a failed comments read in one line and performs no write', () => {
    const gh = vi.fn(() => { throw new Error('spawnSync gh ENOBUFS\nlarge subprocess diagnostics'); });
    expect(() => runStandDownAnswer(argv, { gh })).toThrow(
      /^Could not read comments for web-everything\/web-everything PR #3181: spawnSync gh ENOBUFS$/,
    );
    expect(gh).toHaveBeenCalledTimes(1);
  });
  it('keeps #3507’s later-cycle stand-down unresolved and posts an answer to that exact comment', () => {
    const { comments } = structuredClone(standDown3507);
    const target = comments.at(-1);
    expect(latestUnresolvedStandDown(comments)).toEqual(target);
    expect(countUnresolvedStandDowns(comments)).toBe(1);
    const gh = vi.fn((args) => {
      if (args[1] === 'view') return JSON.stringify({ comments });
      comments.push(trusted(args[args.indexOf('--body') + 1]));
      return 'posted';
    });
    expect(runStandDownAnswer(['3507', ...argv.slice(1)], { gh })).toBe('posted');
    expect(parseOperatorAnswer(comments.at(-1))).toEqual({ ...record, standDownId: target.id });
    expect(countUnresolvedStandDowns(comments)).toBe(0);
    expect(latestUnresolvedStandDown(comments)).toBeNull();
    expect(gh).toHaveBeenCalledTimes(2);
  });
  it.each(['reason', 'actor', 'channel', 'repo'])('refuses missing/blank --%s before IO', (key) => {
    for (const replacement of [null, `--${key}=   `]) {
      const args = argv.filter((a) => !a.startsWith(`--${key}=`));
      if (replacement) args.push(replacement);
      const gh = vi.fn();
      expect(() => runStandDownAnswer(args, { gh })).toThrow(`--${key}`);
      expect(gh).not.toHaveBeenCalled();
    }
  });
  it.each([[[]], [[stop, answer]]])('refuses with no unresolved stand-down', (comments) => {
    const gh = vi.fn(() => JSON.stringify({ comments }));
    expect(() => runStandDownAnswer(argv, { gh })).toThrow('no unresolved stand-down');
    expect(gh).toHaveBeenCalledTimes(1);
  });
  it('posts ONE comment against the latest unresolved stop; a rerun refuses', () => {
    const comments = [stop, { ...stop, id: 'IC_latest' }];
    const gh = vi.fn((args) => {
      if (args[1] === 'view') return JSON.stringify({ comments });
      const body = args[args.indexOf('--body') + 1];
      comments.push(trusted(body));
      return 'posted';
    });
    expect(runStandDownAnswer(argv, { gh })).toBe('posted');
    expect(gh.mock.calls.filter(([args]) => args[1] === 'comment')).toHaveLength(1);
    expect(parseOperatorAnswer(comments.at(-1))).toEqual({ ...record, standDownId: 'IC_latest' });
    // NEWEST WINS (live plateau #220, 2026-10-10): answering the latest stop also clears every older one — an
    // older record left standing refused the PR `stood-down` forever after the operator had answered.
    expect(countUnresolvedStandDowns(comments)).toBe(0);
    const single = [stop];
    const once = (args) => {
      if (args[1] === 'view') return JSON.stringify({ comments: single });
      single.push(trusted(args.at(-1))); return '';
    };
    runStandDownAnswer(argv, { gh: once });
    expect(() => runStandDownAnswer(argv, { gh: once })).toThrow('no unresolved');
  });
  it('fails closed on missing comments, missing ids, failed reads, and failed writes', () => {
    for (const snapshot of [{}, { comments: [{ ...stop, id: undefined }] }]) {
      const gh = vi.fn(() => JSON.stringify(snapshot));
      expect(() => runStandDownAnswer(argv, { gh })).toThrow();
      expect(gh).toHaveBeenCalledTimes(1);
    }
    const gh = vi.fn(() => { throw new Error('read failed'); });
    expect(() => runStandDownAnswer(argv, { gh })).toThrow('read failed');
    const writeFailure = vi.fn((args) => {
      if (args[1] === 'view') return JSON.stringify({ comments: [stop] });
      throw new Error('ambiguous write');
    });
    expect(() => runStandDownAnswer(argv, { gh: writeFailure })).toThrow('ambiguous write');
    expect(writeFailure).toHaveBeenCalledTimes(2);
  });
});

it('reconciles the answered PR into a fix and carries the verbatim ruling through planning into the spawned brief', () => {
  const plan = (comments) => planReconcile({ prs: [pr(comments)], agents: [], durableCounts: {}, now: Date.now() });
  expect(plan([stop]).refusals[0].kind).toBe('stood-down');
  const result = plan([stop, answer]);
  expect(result.refusals).toEqual([]);
  expect(result.dispatch).toHaveLength(1);
  expect(result.dispatch[0]).toMatchObject({ kind: 'fix', operatorAnswer: record });
  const { planned } = planFixesFromReconcile(result.dispatch, () => null, () => [], () => [], 'we', () => ['scripts/prepare.mjs']);
  expect(planned[0].operatorAnswer).toEqual(record);
  const spawnAgent = vi.fn(() => '');
  dispatchFix({ ...planned[0], lane: 9 }, {
    root: '/repo', readBrief: () => 'Fix PR {{PR_NUM}}', mintSessionId: () => 'answer-test', spawnAgent,
    acquireClaim: () => ({ ok: true }), releaseClaim: () => {},
    ensureSessionCwd: (cwd) => cwd, sessionCwdFor: () => '/tmp/answer-test',
    resolveSettingsEnv: () => ({}), isolateSession: () => ({ worktreeSettings: {} }),
  });
  const prompt = spawnAgent.mock.calls[0][0].at(-1);
  expect(prompt).toContain(reason);
  expect(prompt.indexOf(reason)).toBeLessThan(prompt.indexOf('Fix PR 3181'));
  expect(prompt).toContain('lifecycle fields');
});


it('carries the ruling into an ownership-confirmed resumed fix as well', () => {
  const candidate = 'cand-0000-0000-0000-000000000000';
  const head = 'deadbeef'.repeat(5);
  // This prompt fixture uses a synthetic lane; real permission migration is covered in reconcile-fix-dispatch.test.mjs.
  const grantConflictHelper = vi.fn(() => ({ ok: true }));
  const spawnAgent = vi.fn(() => 'backgrounded · candxxxx\n');
  const result = tryResumeFix({ pr: 3181, itemNum: null, laneRef: 'lane/answer-test', scope: ['we:scripts/prepare.mjs'],
    isConflict: true, body: buildAuthorActorMarker(candidate), headRefOid: head, operatorAnswer: record }, {
    root: '/repo', spawnAgent, grantConflictHelper,
    listAgentsAll: () => [{ sessionId: candidate, id: 'candxxxx', cwd: '/lanes/lane-4', name: 'fix-3181' }],
    resolveHead: () => head, acquireClaim: () => ({ ok: true }), releaseClaim: () => {},
    ensureSessionCwd: (cwd) => cwd, sessionCwdFor: () => '/tmp/answer-resume',
  });
  expect(result.resumed).toBe(true);
  expect(grantConflictHelper).toHaveBeenCalledTimes(1);
  expect(grantConflictHelper).toHaveBeenCalledWith('/lanes/lane-4');
  expect(spawnAgent).toHaveBeenCalledTimes(1);
  expect(spawnAgent.mock.calls[0][0].at(-1)).toContain(reason);
});

it('passes the most recently posted valid answer even when older holds are answered last', () => {
  const newerStop = { ...stop, id: 'IC_newer' };
  const newerAnswer = trusted(buildOperatorAnswer({ ...record, standDownId: newerStop.id, reason: 'Second question answered first.' }));
  expect(latestOperatorAnswer([stop, newerStop, newerAnswer, answer])).toEqual(record);
});

import { buildLoadFlakeResolvedComment } from '../stand-down.mjs';
it('exhausted load retries are terminal until the operator answers', () => {
  const exhausted = trusted(buildLoadFlakeResolvedComment({ altSha: '9202eee8a', result: 'exhausted' }), record.standDownId);
  expect(countUnresolvedStandDowns([exhausted])).toBe(1);
  expect(latestUnresolvedStandDown([exhausted])).toEqual(exhausted);
  expect(countUnresolvedStandDowns([exhausted, answer])).toBe(0);
});

describe('rearm-review re-answer supersedes an answered stand-down (#6748 deadlock)', () => {
  const fixBegin = trusted(`🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${'b'.repeat(9)}\`\n<!-- fix-claim who=fix-1 -->`, 'IC_begin');
  const dated = (c, createdAt) => ({ ...c, createdAt });
  const view = (over = {}) => ({
    comments: [dated(fixBegin, '2026-11-14T09:30:00Z'), dated(stop, '2026-11-14T10:00:00Z'), dated(answer, '2026-11-14T10:05:00Z')],
    labels: [{ name: 'status:answered-waiting-fixer' }],
    commits: [{ committedDate: '2026-11-14T09:00:00Z', oid: 'b'.repeat(40) }],
    headRefOid: 'b'.repeat(40),
    ...over,
  });
  const run = (snapshot, extra = ['--disposition=rearm-review']) => {
    const gh = vi.fn((args) => args[1] === 'view' ? JSON.stringify(snapshot) : 'posted');
    return { gh, call: () => runStandDownAnswer([...argv, ...extra], { gh }) };
  };
  it.each([
    ['an unresolved stand-down', false],
    ['an already answered stand-down', true],
  ])('the operator relay posts an answer the guard accepts for %s', (_name, alreadyAnswered) => {
    const snapshot = view();
    if (!alreadyAnswered) snapshot.comments.pop();
    const gh = vi.fn((args) => {
      if (args[1] === 'view') return JSON.stringify(snapshot);
      // The documented relay inherits automation credentials; --actor names the operator, not the poster.
      snapshot.comments.push(trusted(args[args.indexOf('--body') + 1], 'IC_relay'));
      return 'posted';
    });
    expect(runStandDownAnswer([...argv, '--disposition=rearm-review'], { gh })).toBe('posted');
    expect(parseOperatorAnswer(snapshot.comments.at(-1))).toMatchObject({ actor: 'chalbert', disposition: 'rearm-review' });
    expect(latestUnresolvedStandDown(snapshot.comments)).toBeNull();
    // Consume the same posted record in the REST shape used by the production rearm CLI.
    const restComments = snapshot.comments.map(({ author, id, ...c }, i) => ({ ...c, user: author, id: i + 1, node_id: id }));
    expect(decideEmptyFixRound({ comments: restComments, liveHead: snapshot.headRefOid }).empty).toBe(false);
    expect(() => runStandDownAnswer([...argv, '--disposition=rearm-review'], { gh })).toThrow('no unresolved stand-down');
    expect(gh.mock.calls.filter(([args]) => args[1] === 'comment')).toHaveLength(1);
    // A later fix-begin still owes a change; the relay cannot be reused to waive that new round.
    expect(decideEmptyFixRound({ comments: [...snapshot.comments, fixBegin], liveHead: snapshot.headRefOid }).empty).toBe(true);
  });
  it('succeeds on an answered stand-down at answered-waiting-fixer on the same head and records the supersede', () => {
    const { gh, call } = run(view());
    expect(call()).toBe('posted');
    const args = gh.mock.calls[1][0];
    const body = args[args.indexOf('--body') + 1];
    expect(parseOperatorAnswer(trusted(body))).toMatchObject({ standDownId: record.standDownId, disposition: 'rearm-review', supersedes: 'IC_answer' });
    expect(body).toContain('IC_answer');
  });
  it.each([
    ['no label', { labels: [{ name: 'review:changes' }] }],
    ['head moved after the stand-down', { commits: [{ committedDate: '2026-11-14T10:30:00Z' }] }],
    ['commit date unreadable', { commits: [] }],
    ['the stand-down is outside the guard window (no fix-begin before it)', { comments: [dated(stop, '2026-11-14T10:00:00Z'), dated(answer, '2026-11-14T10:05:00Z')] }],
    ['a newer changes-requested verdict closed the window', { comments: [dated(fixBegin, '2026-11-14T09:30:00Z'), dated(stop, '2026-11-14T10:00:00Z'), dated(answer, '2026-11-14T10:05:00Z'), dated(trusted('🔁 review — changes requested\n\nx', 'IC_v'), '2026-11-14T10:06:00Z')] }],
    ['last commit is not the live head', { headRefOid: 'c'.repeat(40) }],
    ['a rearm-review answer already stands (replay)', { comments: [dated(stop, '2026-11-14T10:00:00Z'),
      dated(trusted(buildOperatorAnswer({ ...record, disposition: 'rearm-review' }), 'IC_r'), '2026-11-14T10:06:00Z')] }],
    ['the stand-down names a different head', { comments: [dated({ ...stop, body: stop.body.replace(/ -->$/, ` head=${'d'.repeat(40)} -->`) }, '2026-11-14T10:00:00Z'), dated(answer, '2026-11-14T10:05:00Z')] }],
  ])('refuses when %s', (_n, over) => {
    const { gh, call } = run(view(over));
    expect(call).toThrow('no unresolved stand-down');
    expect(gh).toHaveBeenCalledTimes(1);
  });
  it.each([[[]], [['--disposition=close-superseded']]])('any other disposition (%j) still needs an unresolved stand-down', (extra) => {
    const { gh, call } = run(view(), extra.length ? extra : []);
    expect(call).toThrow('no unresolved stand-down');
    expect(gh).toHaveBeenCalledTimes(1);
  });
});

describe('#6748 real sequence at the CLI: 106 -> answer 108 -> fix-begin 110 -> fix-begin 113 (same head)', () => {
  const HEAD = '4'.repeat(9) + 'e'.repeat(31);
  const begin = (id, at) => ({ ...trusted(`🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${HEAD.slice(0, 9)}\`\n<!-- fix-claim who=fix-6748 -->`, id), createdAt: at });
  const s106 = { ...trusted(buildStandDownComment({ reason: 'needs-judgment', detail: 'Is code owed?' }), 'IC_106'), createdAt: '2026-11-14T19:47:47Z' };
  const a108 = { ...trusted(buildOperatorAnswer({ ...record, standDownId: 'IC_106' }), 'IC_108'), createdAt: '2026-11-14T19:54:00Z' };
  const snap = (extra = []) => ({
    comments: [begin('IC_105', '2026-11-14T19:47:37Z'), s106, a108, begin('IC_110', '2026-11-14T22:49:59Z'), begin('IC_113', '2026-11-14T23:35:29Z'), ...extra],
    labels: [{ name: 'status:answered-waiting-fixer' }], headRefOid: HEAD,
    commits: [{ oid: HEAD, committedDate: '2026-11-14T17:41:22Z' }],
  });
  const post = (snapshot) => {
    const gh = vi.fn((args) => args[1] === 'view' ? JSON.stringify(snapshot) : 'posted');
    return { gh, call: () => runStandDownAnswer([...argv, '--disposition=rearm-review'], { gh }) };
  };
  it('posts a rearm-review answer that targets 106 and supersedes 108', () => {
    const { gh, call } = post(snap());
    expect(call()).toBe('posted');
    const args = gh.mock.calls[1][0];
    expect(parseOperatorAnswer(trusted(args[args.indexOf('--body') + 1]))).toMatchObject({ standDownId: 'IC_106', supersedes: 'IC_108', disposition: 'rearm-review' });
  });
  it('the guard accepts exactly the answer the CLI posts', () => {
    const { gh, call } = post(snap());
    call();
    const args = gh.mock.calls[1][0];
    const posted = { ...trusted(args[args.indexOf('--body') + 1], 'IC_new'), author: { login: 'chalbert' } };
    expect(decideEmptyFixRound({ comments: [...snap().comments, posted], liveHead: HEAD }).empty).toBe(false);
  });
  it('refuses a second rearm-review in the same window', () => {
    const posted = { ...trusted(buildOperatorAnswer({ ...record, standDownId: 'IC_106', disposition: 'rearm-review', supersedes: 'IC_108' }), 'IC_new'), author: { login: 'chalbert' }, createdAt: '2026-11-14T23:50:00Z' };
    const { gh, call } = post(snap([posted, begin('IC_120', '2026-11-14T23:55:00Z')]));
    expect(call).toThrow('no unresolved stand-down');
    expect(gh).toHaveBeenCalledTimes(1);
  });
});
