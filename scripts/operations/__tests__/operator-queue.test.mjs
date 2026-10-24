import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', async (original) => ({ ...await original(), execFileSync: vi.fn() }));
vi.mock('../../lib/gh-throttle.mjs', async (original) => ({
  ...await original(), execFileSyncThrottled: (...args) => execFileSync(...args),
}));
vi.mock('../../lib/settings-files.mjs', async (original) => ({ ...await original(), readSettings: vi.fn(() => ({})) }));
vi.mock('../../conveyor/health-watch-section.mjs', () => ({ healthSectionLines: () => ['HEALTH — healthy'] }));
const queue = await import('../operator-queue.mjs');
const { readSettings } = await import('../../lib/settings-files.mjs');
const { buildOperatorAnswer } = await import('../../conveyor/stand-down-answer-core.mjs');
const { STAND_DOWN_MARKER, buildStandDownComment } = await import('../../conveyor/stand-down.mjs');
const UNKNOWN = 'UNKNOWN — reads failed, re-run';
const originalExitCode = process.exitCode;
let log, stderr, sleep;
beforeEach(() => {
  process.exitCode = undefined;
  vi.stubEnv('OPERATOR_QUEUE_READ_ATTEMPTS', '2');
  execFileSync.mockReset();
  readSettings.mockReturnValue({});
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  sleep = vi.fn();
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const run = (args = []) => queue.main(['--repo=o/n', ...args], {
  sleep, unsupportedPath: '/nonexistent-operator-queue-test/unsupported-repo.json',
});
const stdout = () => log.mock.calls.map(([line]) => line).join('\n');
const standDown = { id: 'SD1', body: `${STAND_DOWN_MARKER}\nNeed a ruling`, author: { login: 'web-everything' }, createdAt: '2026-10-11T10:00:00Z' };
const answer = { id: 'A1', body: buildOperatorAnswer({ standDownId: 'SD1', reason: 'Proceed', actor: 'chalbert', channel: 'console' }), author: { login: 'web-everything' }, createdAt: '2026-10-11T11:00:00Z' };
const pr = (number, comments) => ({ number, title: `PR ${number}`, labels: [], comments, mergeable: 'MERGEABLE' });

it.each(['review:human', 'review:accepted'])('holds an unresolved operator send-back out of NEEDS YOU with %s', label => {
  const oldHead = 'e5ed9cb74', head = '245c40542' + 'b'.repeat(31);
  const comments = [{ id: 'SB1', author: { login: 'chalbert' }, createdAt: '2026-10-14T20:07:00Z',
    body: `🔁 review — changes requested\n\nRecorded by chalbert via console.\n\nOperator send-back at head ${oldHead}.\nRepair the original guard.` },
  { author: { login: 'web-everything' }, body: `**Verdict:** accept\n**Advisory outcome:** accept\nNet basis: \`${'a'.repeat(40)}..${head}\`` }];
  execFileSync.mockReturnValue(JSON.stringify([{ ...pr(5243, comments), headRefOid: head,
    labels: [{ name: label }, { name: 'advisory:accepted' }] }]));
  run(['--json']);
  const report = JSON.parse(stdout());
  expect(report.ready).toEqual([]);
  expect(report.notReady).toContainEqual(expect.objectContaining({ number: 5243,
    reasons: expect.arrayContaining(['operator send-back of 2026-10-14T20:07:00.000Z not yet addressed']) }));
});

it('does not surface an answered hold that lapsed on a new head', () => {
  vi.stubEnv('WE_STAND_DOWN_LAPSE_ON_NEW_HEAD', 'on');
  const held = { ...standDown, body: buildStandDownComment({ reason: 'needs-judgment', head: 'a'.repeat(40) }) };
  execFileSync.mockReturnValue(JSON.stringify([{ ...pr(1, [held, answer]), headRefOid: 'b'.repeat(40) }]));
  run(['--json']);
  const report = JSON.parse(stdout());
  expect(report.stoodDown).toEqual([]);
  expect(report.standDownAnswered ?? []).toEqual([]);
});

it.each([true, false])('omits stale stand-downs from the queue (recorded head: %s)', recorded => {
  const head = 'b'.repeat(40);
  const held = { ...standDown, body: buildStandDownComment({ reason: 'fix-loop-exhausted',
    ...(recorded ? { head: 'a'.repeat(40) } : {}) }) };
  execFileSync.mockReturnValue(JSON.stringify([{ ...pr(5195, [held]), headRefOid: head,
    commits: [{ oid: head, committedDate: '2026-10-15T13:00:00Z' }] }]));
  run(['--json']);
  expect(JSON.parse(stdout()).stoodDown).toEqual([]);
});

it('answers the latest live hold rather than a newer lapsed hold', () => {
  vi.stubEnv('WE_REVIEW_STAND_DOWN_QUEUE_SECTION', 'stood-down');
  vi.stubEnv('WE_STAND_DOWN_LAPSE_ON_NEW_HEAD', 'on');
  const head = 'b'.repeat(40);
  const live = { ...standDown, id: 'LIVE', createdAt: '2026-10-11T09:00:00Z',
    body: buildStandDownComment({ reason: 'needs-judgment', head }) };
  const stale = { ...standDown, body: buildStandDownComment({ reason: 'needs-judgment', head: 'a'.repeat(40) }) };
  execFileSync.mockReturnValue(JSON.stringify([{ ...pr(1, [live, stale, answer]), headRefOid: head }]));
  run(['--json']);
  const report = JSON.parse(stdout());
  expect(report.stoodDown).toEqual([expect.objectContaining({ number: 1, standDownAt: live.createdAt })]);
  expect(report.standDownAnswered ?? []).toEqual([]);
});

// Match gh api's @tsv output, including multiline bodies and the GraphQL comment id.
const commentTsv = (comments) => comments.map((comment, i) => [
  comment.body, comment.createdAt, comment.author?.login, comment.id ?? `IC_${i}`,
].map((field) => String(field ?? '').replaceAll('\\', '\\\\').replaceAll('\t', '\\t')
  .replaceAll('\n', '\\n').replaceAll('\r', '\\r')).join('\t')).join('\n');
const commentCount = (comments) => JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: comments.length } } } } });

describe('operator queue read safety', () => {
  it.each([
    'Could not resolve to a Repository with the name o/n', 'HTTP 404: Not Found',
    'HTTP 401: Unauthorized', 'Bad credentials', 'To get started, run: gh auth login',
    'Resource not accessible by integration',
  ])('does not retry or split a permanent failure: %s', (message) => {
    execFileSync.mockImplementation(() => { throw Object.assign(new Error('gh failed'), { stderr: message }); });
    run(['--json']);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toMatchObject({ incomplete: true, errors: [`o/n: ${message}`] });
    expect(process.exitCode).toBe(1);
  });

  it('stops on a non-string response and preserves the preceding transport error', () => {
    execFileSync.mockImplementationOnce(() => { throw new Error('spawnSync gh ENOBUFS'); });
    run();
    expect(log.mock.calls.slice(0, 2).map(([line]) => line)).toEqual([
      'ERRORS — the sections below are INCOMPLETE (these reads failed):', 'o/n: spawnSync gh ENOBUFS',
    ]);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[500]]);
    expect(process.exitCode).toBe(1);
  });

  it.each([undefined, null, 42])('rejects an initial invalid response %s without retry or fallback', (response) => {
    execFileSync.mockReturnValue(response);
    run(['--json']);
    expect(JSON.parse(stdout()).incomplete).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('bounds backoff even with a large configured attempt count', () => {
    vi.stubEnv('OPERATOR_QUEUE_READ_ATTEMPTS', '100');
    execFileSync.mockImplementation(() => { throw new Error('HTTP 502'); });
    run(['--json']);
    // Combined and split listings each have a four-second total backoff budget.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000, 2000, 500, 500, 1000, 2000, 500]);
    expect(JSON.parse(stdout()).incomplete).toBe(true);
  });

  it('prints health without a PR-read UNKNOWN suffix', () => {
    execFileSync.mockImplementation(() => { throw new Error('HTTP 404'); });
    run(['--with-health']);
    expect(stdout()).toContain('HEALTH — healthy\nNEEDS YOU');
    expect(stdout()).toContain(UNKNOWN);
  });

  it.each(['throw', 'truncated'])('fails safe after persistent %s failures', (kind) => {
    execFileSync.mockImplementation(() => { if (kind === 'throw') throw new Error('HTTP 502'); return '[{'; });
    run(['--with-backpressure', '--with-reconcile-notes']);
    expect(stdout().split('\n')[0]).toContain('INCOMPLETE');
    expect(stdout()).not.toContain('(none)');
    expect(stdout().split('\n').filter((line) => line === UNKNOWN)).toHaveLength(10);
    expect(stdout()).not.toContain('answered — waiting for the fixer to resume');
    expect(stdout()).toContain('ERRORS');
    expect(process.exitCode).toBe(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('retries truncated JSON and preserves the normal success call shape', () => {
    execFileSync.mockReturnValueOnce('[{').mockReturnValueOnce('[]');
    run();
    expect(stdout()).not.toContain('INCOMPLETE');
    expect(stdout()).toContain('(none)');
    expect(process.exitCode).toBeUndefined();
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(stderr).toHaveBeenCalledWith('operator-queue: read attempts=2 (source: env)');
  });

  it('uses declared settings and logs the source once', () => {
    vi.stubEnv('OPERATOR_QUEUE_READ_ATTEMPTS', '');
    readSettings.mockReturnValue({ operatorQueue: { readAttempts: 4 } });
    execFileSync.mockReturnValue('[]');
    run();
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(stderr).toHaveBeenCalledWith('operator-queue: read attempts=4 (source: settings)');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('marks JSON incomplete and preserves PRs from other repos', () => {
    execFileSync.mockImplementation((_cmd, args) => {
      if (args.includes('good/repo')) return JSON.stringify([pr(2, [standDown])]);
      throw new Error('HTTP 502');
    });
    run(['--repo=good/repo', '--json']);
    const report = JSON.parse(stdout());
    expect(report.incomplete).toBe(true);
    expect(report.stoodDown).toEqual([expect.objectContaining({ repo: 'good/repo', number: 2 })]);
    expect(report.errors).toEqual([expect.stringContaining('o/n:')]);
    expect(process.exitCode).toBe(1);
  });

  it('recovers through a split read after the combined listing is exhausted', () => {
    execFileSync.mockImplementation((_cmd, args) => {
      if (args.at(-1).endsWith(',comments')) throw new Error('heavy query failed');
      if (args[1] === 'list') return JSON.stringify([pr(1)]);
      if (args[1] === 'graphql') return commentCount([standDown]);
      return commentTsv([standDown]);
    });
    run(['--json']);
    const report = JSON.parse(stdout());
    expect(report.incomplete).not.toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.stoodDown[0].number).toBe(1);
    expect(execFileSync).toHaveBeenCalledTimes(5);
    expect(execFileSync).toHaveBeenNthCalledWith(4, 'gh', [
      'api', '--paginate', '--method', 'GET', '-F', 'per_page=100', 'repos/o/n/issues/1/comments',
      '--jq', '.[] | [.body, .created_at, .user.login, .node_id, .html_url] | @tsv',
    ], expect.objectContaining({ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    expect(process.exitCode).toBeUndefined();
  });

  it('retries the complete thread and sees an answer beyond the first 100 comments', () => {
    let commentAttempts = 0;
    const comments = [standDown, ...Array.from({ length: 99 }, () => ({
      body: 'discussion', createdAt: standDown.createdAt, author: { login: 'web-everything' },
    })), answer];
    execFileSync.mockImplementation((_cmd, args) => {
      if (args.at(-1).endsWith(',comments')) throw new Error('heavy query failed');
      if (args[1] === 'list') return JSON.stringify([pr(1)]);
      if (args[1] === 'graphql') return commentCount(comments);
      commentAttempts += 1;
      if (commentAttempts === 1) throw Object.assign(new Error('HTTP 502'), { stdout: commentTsv([standDown]) });
      return commentTsv(comments);
    });
    run(['--json']);
    const report = JSON.parse(stdout());
    expect(report.incomplete).not.toBe(true);
    expect(report.stoodDown).toEqual([]);
    expect(report.standDownAnswered).toEqual([expect.objectContaining({ number: 1, answeredAt: answer.createdAt })]);
    expect(commentAttempts).toBe(2);
    expect(sleep.mock.calls).toEqual([[500], [500]]);
    expect(process.exitCode).toBeUndefined();
  });

  it('completes a successful capped listing and sees the accepted advisory on the current head', () => {
    const advisory = (head, outcome, createdAt) => ({
      body: `**Verdict:** human review required\n**Advisory outcome:** \`${outcome}\`\nNet basis: \`aaaaaaaaa..${head}\``,
      author: { login: 'web-everything' }, createdAt,
    });
    const comments = [
      advisory('3956cb512', 'changes', '2026-10-11T09:00:00Z'),
      { body: '🔁 review — changes requested', author: { login: 'chalbert' }, createdAt: '2026-10-11T09:01:00Z' },
      ...Array.from({ length: 98 }, () => ({ body: 'discussion', author: { login: 'web-everything' } })),
    ];
    const listed = { ...pr(4631, comments), headRefOid: '572049b31',
      labels: [{ name: 'review:human' }, { name: 'advisory:accepted' }],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    };
    expect(queue.evaluatePr(listed)).toMatchObject({ ready: false, reasons: expect.arrayContaining(['changes requested']) });
    const fullComments = [
      ...comments, advisory('572049b31', 'accept', '2026-10-11T10:00:00Z'),
    ];
    execFileSync.mockReturnValueOnce(JSON.stringify([listed])).mockReturnValueOnce(commentTsv(fullComments))
      .mockReturnValueOnce(commentCount(fullComments));
    run(['--json']);
    const report = JSON.parse(stdout());
    expect(report.ready).toEqual([expect.objectContaining({ number: 4631 })]);
    expect(report.notReady).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(execFileSync).toHaveBeenCalledTimes(3);
    expect(execFileSync).toHaveBeenNthCalledWith(2, 'gh', expect.arrayContaining([
      'api', '--paginate', 'repos/o/n/issues/4631/comments',
    ]), expect.any(Object));
    expect(process.exitCode).toBeUndefined();
  });

  it('drops a capped successful listing when the complete thread permanently fails', () => {
    const comments = [standDown, ...Array.from({ length: 99 }, () => ({ body: 'discussion' }))];
    execFileSync.mockReturnValueOnce(JSON.stringify([pr(1, comments)]))
      .mockImplementationOnce(() => { throw new Error('HTTP 404: Not Found'); });
    run(['--json']);
    const report = JSON.parse(stdout());
    expect(report).toMatchObject({ incomplete: true, errors: ['o/n#1: HTTP 404: Not Found'] });
    for (const [section, rows] of Object.entries(report)) {
      if (section !== 'errors' && Array.isArray(rows)) expect(rows).toEqual([]);
    }
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('keeps a successful 99-comment listing without a complete read', () => {
    const comments = [standDown, ...Array.from({ length: 98 }, () => ({ body: 'discussion' }))];
    execFileSync.mockReturnValueOnce(JSON.stringify([pr(1, comments)]));
    run(['--json']);
    expect(JSON.parse(stdout())).toMatchObject({
      errors: [], stoodDown: [expect.objectContaining({ number: 1 })],
    });
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not retry a permanent comment failure and retains the next PR', () => {
    execFileSync.mockImplementation((_cmd, args) => {
      if (args.at(-1).endsWith(',comments')) throw new Error('heavy query failed');
      if (args[1] === 'list') return JSON.stringify([pr(1), pr(2)]);
      if (args.includes('repos/o/n/issues/1/comments')) throw new Error('HTTP 404: Not Found');
      if (args[1] === 'graphql') return commentCount([standDown]);
      return commentTsv([standDown]);
    });
    run(['--json']);
    expect(JSON.parse(stdout())).toMatchObject({
      incomplete: true, errors: ['o/n#1: HTTP 404: Not Found'],
      stoodDown: [expect.objectContaining({ number: 2 })],
    });
    expect(execFileSync.mock.calls.filter(([, args]) => args.includes('repos/o/n/issues/1/comments'))).toHaveLength(1);
    expect(sleep.mock.calls).toEqual([[500]]);
    expect(process.exitCode).toBe(1);
  });

  it('keeps other PR rows and appends UNKNOWN when one comment read fails', () => {
    execFileSync.mockImplementation((_cmd, args) => {
      if (args.at(-1).endsWith(',comments')) throw new Error('heavy query failed');
      if (args[1] === 'list') return JSON.stringify([pr(1), pr(2)]);
      if (args.includes('repos/o/n/issues/1/comments')) throw new Error('HTTP 502: later page failed');
      if (args[1] === 'graphql') return commentCount([standDown]);
      return commentTsv([standDown]);
    });
    run();
    expect(stdout().split('\n')[0]).toContain('INCOMPLETE');
    expect(stdout()).toContain('o/n#1: HTTP 502: later page failed');
    expect(execFileSync.mock.calls.filter(([, args]) => args.includes('repos/o/n/issues/1/comments'))).toHaveLength(2);
    expect(sleep.mock.calls).toEqual([[500], [500]]);
    expect(stdout()).toMatch(/o\/n#2  PR 2[^\n]*\nUNKNOWN — reads failed, re-run/);
    expect(stdout()).not.toContain('(none)');
    expect(process.exitCode).toBe(1);
  });
});

describe('read attempt cascade', () => {
  it.each([
    [{ env: { OPERATOR_QUEUE_READ_ATTEMPTS: '5' }, file: { operatorQueue: { readAttempts: 4 } } }, { value: 5, source: 'env' }],
    [{ env: {}, file: { operatorQueue: { readAttempts: 4 } } }, { value: 4, source: 'settings' }],
    [{ env: {}, file: {} }, { value: 3, source: 'default' }],
    [{ env: { OPERATOR_QUEUE_READ_ATTEMPTS: '1' }, file: {} }, { value: 2, source: 'env' }],
    [{ env: {}, file: { operatorQueue: { readAttempts: 0 } } }, { value: 2, source: 'settings' }],
    [{ env: { OPERATOR_QUEUE_READ_ATTEMPTS: 'bad' }, file: { operatorQueue: { readAttempts: 4 } } }, { value: 4, source: 'settings' }],
    [{ env: {}, file: { operatorQueue: { readAttempts: 2.5 } } }, { value: 3, source: 'default' }],
  ])('resolves %j', (input, expected) => expect(queue.resolveReadAttempts(input)).toEqual(expected));
});

it('separates answered stand-downs while a newer unanswered question still needs judgment', () => {
  execFileSync.mockReturnValue(JSON.stringify([
    pr(1, [answer, standDown]), // sort by time, not transport order
    pr(2, [standDown]),
    pr(3, [standDown, answer, { ...standDown, id: 'SD2', createdAt: '2026-10-11T12:00:00Z' }]),
  ]));
  run(['--json']);
  const report = JSON.parse(stdout());
  expect(report.standDownAnswered).toEqual([expect.objectContaining({ number: 1, answeredAt: answer.createdAt })]);
  expect(report.stoodDown.map((row) => row.number)).toEqual([2, 3]);
  log.mockClear();
  run();
  expect(stdout()).toContain(`answered — waiting for the fixer to resume\no/n#1  PR 1  [answered ${answer.createdAt}]`);
  expect(stdout().split('STOOD DOWN')[1].split('answered —')[0]).not.toContain('o/n#1');
});

describe('staged copies missing an optional reader', () => {
  const importWithout = async (missing, load) => {
    // Re-evaluate only the queue with a distinct module URL. Resetting the entire graph
    // reloads unrelated review/dispatch modules and can exhaust the unit-test timeout in CI.
    vi.doMock(missing, () => { throw new Error(`Cannot find module ${missing}`); });
    try { return await load(); }
    finally { vi.doUnmock(missing); }
  };

  it('missing answer reader leaves a stand-down visible as unanswered', async () => {
    const staged = await importWithout('../../conveyor/stand-down-answer-core.mjs',
      () => import('../operator-queue.mjs?missing-answer-reader'));
    execFileSync.mockReturnValue(JSON.stringify([pr(1, [standDown, answer])]));
    await staged.main(['--repo=o/n', '--json'], { sleep, unsupportedPath: '/nonexistent-operator-queue-test/unsupported-repo.json' });
    const report = JSON.parse(stdout());
    expect(report.stoodDown).toEqual([expect.objectContaining({ number: 1 })]);
    expect(report.standDownAnswered ?? []).toEqual([]);
    expect(report.incomplete).not.toBe(true);
  });

  it('missing complete reader marks the split read incomplete, never an empty thread', async () => {
    const staged = await importWithout('../../conveyor/pr-comments-complete.mjs',
      () => import('../operator-queue.mjs?missing-complete-reader'));
    execFileSync.mockImplementation((_cmd, args) => {
      if (args.at(-1).endsWith(',comments')) throw new Error('heavy query failed');
      return JSON.stringify([pr(1)]);
    });
    await staged.main(['--repo=o/n', '--json'], { sleep, unsupportedPath: '/nonexistent-operator-queue-test/unsupported-repo.json' });
    const report = JSON.parse(stdout());
    expect(report).toMatchObject({ incomplete: true, errors: [expect.stringContaining('o/n#1:')] });
    expect(report.stoodDown).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});

it('routes needs-judgment to NEEDS YOU with the fixer question', () => {
  vi.stubEnv('WE_REVIEW_STAND_DOWN_QUEUE_SECTION', 'needs-you');
  const held = { ...standDown, body: buildStandDownComment({ reason: 'needs-judgment', detail: 'Please rule not-real on this finding.' }) };
  execFileSync.mockReturnValue(JSON.stringify([pr(7, [held])]));
  run(['--json']);
  expect(JSON.parse(stdout())).toMatchObject({ stoodDown: [], needsYouStandDowns: [
    { number: 7, question: 'Please rule not-real on this finding', remaining: [] },
  ] });
});
it('prints the fixer question under NEEDS YOU without an empty placeholder', () => {
  vi.stubEnv('WE_REVIEW_STAND_DOWN_QUEUE_SECTION', 'needs-you');
  execFileSync.mockReturnValue(JSON.stringify([pr(7, [{ ...standDown,
    body: buildStandDownComment({ reason: 'needs-judgment', detail: 'Please rule.' }) }])]));
  run();
  const section = stdout().split('NEEDS YOU (')[1].split('RULING NEEDED')[0];
  expect(section).toContain('o/n#7  PR 7');
  expect(section).toContain('the fixer asks] Please rule');
  expect(section).not.toContain('(none)');
});
it('resolved needs-judgment drops off and the stood-down setting restores the old section', () => {
  vi.stubEnv('WE_REVIEW_STAND_DOWN_QUEUE_SECTION', 'stood-down');
  const held = { ...standDown, body: buildStandDownComment({ reason: 'needs-judgment', detail: 'Please rule.' }) };
  execFileSync.mockReturnValue(JSON.stringify([pr(7, [held]), pr(8, [held, answer])]));
  run(['--json']);
  const report = JSON.parse(stdout());
  expect(report.needsYouStandDowns ?? []).toEqual([]);
  expect(report).toMatchObject({ stoodDown: [{ number: 7 }] });
});
it.each([false, true])('shows outstanding findings with subsequent operator ruling=%s', async (ruled) => {
  vi.stubEnv('WE_REVIEW_STAND_DOWN_QUEUE_SECTION', 'needs-you');
  const { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } = await import('../../lib/jury-core.mjs');
  const repo = 'o/n', head = 'a'.repeat(40), runId = 'review-pr-7', seat = 'judgeCorrectnessAdvisory';
  const reviewer = mandatoryReferralReviewer(runId);
  const referrals = ['scripts/first.mjs', '', 'scripts/third.mjs'].map((file, i) => {
    const f = { file, line: i === 2 ? 12 : null, summary: `finding ${i}`, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    return { key: referralFindingKey(seat, f), seat, original: f, finding: normalizeFinding(f) };
  });
  const record = { version: 1, repo, pr: 7, head, runId, reviewer, authorBody: '<!-- authored-by-actor: author -->', attempted: true, referrals,
    rulings: referrals.map((f, i) => ({ id: `${runId}:${i}`, key: f.key, reviewerId: reviewer.id, lens: 'correctness', result: 'block', rationale: 'checked', evidence: ['diff'] })) };
  const ruling = { version: 1, repo, pr: 7, head, actor: 'chalbert', channel: 'chat', reason: 'Not real',
    at: '2026-10-11T11:00:00Z', clearerId: 'session-1', rulings: [{ runId, key: referrals[0].key, result: 'not-real' }] };
  const held = { ...standDown, body: buildStandDownComment({ reason: 'needs-judgment', detail: 'Please rule.' }) };
  const comments = [{ id: 'ref', body: renderReferralRecord(record), author: { login: 'web-everything' }, createdAt: '2026-10-11T09:00:00Z' },
    held, ...(ruled ? [{ id: 'ruling', body: buildOperatorRulingComment(ruling), author: { login: 'chalbert' }, createdAt: ruling.at }] : [])];
  execFileSync.mockReturnValue(JSON.stringify([{ ...pr(7, comments), headRefOid: head, body: record.authorBody }]));
  run();
  const section = stdout().split('NEEDS YOU (')[1].split('RULING NEEDED')[0];
  expect(section).toContain('still needs your ruling: (no file)  finding 1');
  expect(section).toContain('still needs your ruling: scripts/third.mjs:12  finding 2');
  if (!ruled) expect(section).toContain('still needs your ruling: scripts/first.mjs  finding 0');
});
