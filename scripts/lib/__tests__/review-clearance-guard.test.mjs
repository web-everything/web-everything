import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { REARM_COMMENT_MARKER } from '../../conveyor/rearm-review.mjs';
import { parseLatestHumanClearedSha } from '../review-escalation.mjs';
import {
  REVIEW_CLEARANCE_SETTINGS, REARM_MARKER, resolveReviewClearanceSetting, loadReviewClearanceSetting,
  classifyGateFailure, failingCiChecks, decideStaleGateRerun, decideRearmGuard,
  decideClearanceRestore, buildRestoreComment, createReviewClearanceGuard, readPrClearanceFacts,
} from '../review-clearance-guard.mjs';

const head = '9c72024172156f0f8b1b1c0c3f94b44d1031bdd3';
const repo = 'web-everything/web-everything';
const on = { value: 'on', source: 'standard' };
const off = { value: 'off', source: 'env' };
const comment = (body, time, login = 'chalbert') => ({ body, createdAt: `2026-10-13T${time}Z`, author: { login }, url: `https://github.com/${repo}/pull/5193#${time}` });
const acceptance = comment(`✅ review — \`review:human\` cleared via the sanctioned path\n<!-- reviewed-sha: ${head} -->\n<!-- cleared-human: chalbert -->`, '18:30:07');
const rearm = comment(REARM_COMMENT_MARKER, '19:02:59', 'web-everything[bot]');
const comments = [acceptance, comment(`<!-- approval-prevention-filed:${head} -->`, '18:30:14'), rearm];
const event = (type, label, time, login = 'web-everything[bot]') => ({ event: type, label: { name: label }, created_at: `2026-10-13T${time}Z`, actor: { login } });
const events = [event('unlabeled', 'review:human', '18:30:11', 'chalbert'), event('labeled', 'review:accepted', '18:30:11', 'chalbert'), event('unlabeled', 'review:accepted', '19:02:57'), event('labeled', 'review:pending', '19:02:57')];
const record = { sha: head, at: acceptance.createdAt, url: acceptance.url };
const verdict = { num: 5193, ok: false, head_sha: head, completed_at: '2026-10-13T16:55:51Z', results: [
  { status: 'queue', id: 'required-check-read', reason: 'drain: ...' },
  { status: 'skipped-by-policy', id: 'candidate-label', reason: 'candidacy hold deferred' },
  { status: 'pass', id: 'default-base', reason: 'base main vs main' },
  { status: 'hold', id: 'review-acceptance', reason: 'human-only: workflow files decide the required checks' },
  { status: 'pass', id: 'codeql', reason: 'no failed CodeQL run' },
] };
const row = { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: verdict.completed_at, detailsUrl: `https://github.com/${repo}/actions/runs/1/job/115424411010` };
const rows = [row, { name: 'review-gate', conclusion: 'SUCCESS' }, { name: 'test', conclusion: 'SUCCESS' }];
const restoreFacts = { setting: on, labels: ['review:pending', 'review-round:1', 'status:ready-to-merge'], comments, reviews: [], events, prHead: head, refHead: head };

describe('#5193 review clearance', () => {
  it('classifies only review holds as review work', () => {
    expect(classifyGateFailure({ name: 'merge-gate', verdict })).toMatchObject({ ciBreak: false, kind: 'review-hold' });
    for (const result of [{ status: 'hold', id: 'codeql' }, { status: 'fail-closed', id: 'review-acceptance' }]) {
      expect(classifyGateFailure({ name: 'merge-gate', verdict: { ...verdict, results: [...verdict.results, result] } })).toMatchObject({ ciBreak: true, kind: 'real' });
    }
    expect(classifyGateFailure({ name: 'merge-gate', verdict: { error: 'unreadable' } })).toMatchObject({ ciBreak: true, kind: 'unreadable' });
    expect(classifyGateFailure({ name: 'review-gate' })).toMatchObject({ ciBreak: false, kind: 'review-gate' });
  });
  it('requires a latest failing CI check', () => {
    const classify = list => failingCiChecks({ rows: list, verdictFor: () => verdict, setting: on });
    expect(classify(rows).failing).toEqual([]);
    const test = { name: 'test', conclusion: 'failure' };
    expect(classify([...rows, test]).failing).toEqual([test]);
    expect(classify([...rows, test, { name: 'test', conclusion: 'SUCCESS' }]).failing).toEqual([]);
    expect(failingCiChecks({ rows, verdictFor: () => verdict, setting: off }).failing).toEqual([row]);
  });
  it('reruns only a stale review-only job with live clearance', () => {
    const facts = { setting: on, labels: ['review:accepted', 'ready-to-merge'], record, row, verdict, rows };
    expect(decideStaleGateRerun(facts)).toMatchObject({ rerun: true, jobId: 115424411010 });
    for (const patch of [{ verdict: { ...verdict, completed_at: '2026-10-13T18:31:00Z' } }, { rows: [...rows, { name: 'merge-gate', status: 'IN_PROGRESS' }] }, { setting: off }, { labels: ['review:accepted', 'review:human'] }, { row: { ...row, id: 115424411010 }, rows: [{ name: 'merge-gate', status: 'IN_PROGRESS', id: 115424411009 }, { ...row, id: 115424411010 }] }]) {
      expect(decideStaleGateRerun({ ...facts, ...patch }).rerun).toBe(false);
    }
  });
  it('#5193 after the AI re-accept: re-runs a human-only HOLD the live human clearance covers, with a backoff', () => {
    const facts = { setting: on, labels: ['review:accepted'], record: { ...record, at: '2026-10-13T16:00:00Z' }, row, verdict, rows, head };
    expect(decideStaleGateRerun({ ...facts, humanClearedSha: head, now: Date.parse('2026-10-13T19:50:00Z') })).toMatchObject({ rerun: true, jobId: 115424411010 });
    expect(decideStaleGateRerun({ ...facts, humanClearedSha: head, now: Date.parse('2026-10-13T17:00:00Z') }).rerun).toBe(false);
    expect(decideStaleGateRerun({ ...facts, humanClearedSha: null, now: Date.parse('2026-10-13T19:50:00Z') }).rerun).toBe(false);
    expect(decideStaleGateRerun({ ...facts, humanClearedSha: 'a'.repeat(40), now: Date.parse('2026-10-13T19:50:00Z') }).rerun).toBe(false);
  });
  it('does not rerun while any merge-gate job is in flight', () => {
    const latest = { ...row, id: 115424411010 };
    expect(decideStaleGateRerun({ setting: on, labels: ['review:accepted'], record, row: latest, verdict, rows: [{ name: 'merge-gate', status: 'IN_PROGRESS', id: 115424411009 }, latest] }).rerun).toBe(false);
  });
  it('protects acceptance only with two agreeing head reads', () => {
    const facts = { setting: on, labels: ['review:accepted'], record, prHead: head, refHead: head };
    expect(decideRearmGuard(facts).refuse).toBe(true);
    for (const patch of [{ refHead: null }, { refHead: 'a'.repeat(40) }, { prHead: 'a'.repeat(40) }, { record: { ...record, sha: 'a'.repeat(40) } }, { setting: off }]) {
      expect(decideRearmGuard({ ...facts, ...patch }).refuse).toBe(false);
    }
  });
  it('restores the original clearance without fabricating markers', () => {
    const decision = decideClearanceRestore(restoreFacts);
    expect(decision.restore).toBe(true);
    const body = buildRestoreComment({ head, record: decision.record, rearm: decision.rearmComment, setting: on });
    expect(body).toContain(acceptance.url);
    expect(body).toContain(rearm.url);
    expect(body).toContain('reviewClearance.restoreNoPushRearm');
    expect(body).not.toMatch(/reviewed-sha|reviewed-diff|cleared-human/);
    expect(decideClearanceRestore({ ...restoreFacts, comments: [...comments, comment(body, '19:03:00')] }).restore).toBe(false);
  });
  it.each([
    { prHead: 'a'.repeat(40) }, { refHead: null }, { reviews: null },
    { comments: [...comments, comment('🔁 review — changes requested', '19:03:00')] },
    { comments: [...comments, comment('Please wait', '19:03:00')] },
    { events: [...events, event('labeled', 'review:pending', '19:03:00', 'chalbert')] },
    { reviews: [{ state: 'CHANGES_REQUESTED', submitted_at: '2026-10-13T19:03:00Z', user: { login: 'chalbert' } }] },
    { events: null }, { events: [] }, { setting: off },
  ])('does not restore with unproven or intervening evidence: %j', patch => {
    expect(decideClearanceRestore({ ...restoreFacts, ...patch }).restore).toBe(false);
  });
  it('pins the local marker', () => expect(REARM_MARKER).toBe(REARM_COMMENT_MARKER));
  it.each(['chalbert', 'mallory'])('never restores an acceptance removed by %s', login => {
    const revoked = events.map(e => e.label.name === 'review:accepted' && e.event === 'unlabeled'
      ? { ...e, actor: { login } } : e);
    expect(decideClearanceRestore({ ...restoreFacts, events: revoked }).restore).toBe(false);
  });
  it.each(['web-everything[bot]', 'chalbert'])('honours a later pending hold by %s', login => {
    expect(decideClearanceRestore({ ...restoreFacts, events: [...events,
      event('labeled', 'review:pending', '19:03:00', login)] }).restore).toBe(false);
  });
  it('honours a re-grant and second acceptance removal by the removal actor inside the swap second', () => {
    // The same actor that removed the acceptance re-granted it and removed it again: an explicit later hold,
    // even though every event shares the original swap's actor and timestamp.
    expect(decideClearanceRestore({ ...restoreFacts, events: [...events,
      event('labeled', 'review:accepted', '19:02:57'), event('unlabeled', 'review:accepted', '19:02:57')] }).restore).toBe(false);
  });
  it.each(['web-everything[bot]', 'chalbert'])('honours a re-grant by %s then a later removal by the removal actor', login => {
    expect(decideClearanceRestore({ ...restoreFacts, events: [...events,
      event('labeled', 'review:accepted', '19:03:30', login), event('unlabeled', 'review:accepted', '19:04:00')] }).restore).toBe(false);
  });
  it.each(['web-everything[bot]', 'chalbert'])('honours a pending release and re-hold by %s after the swap', login => {
    expect(decideClearanceRestore({ ...restoreFacts, events: [...events,
      event('unlabeled', 'review:pending', '19:03:30', login), event('labeled', 'review:pending', '19:03:31', login)] }).restore).toBe(false);
  });
  it('permits the original swap when its pending label lands just after the removal', () => {
    // Live shape: GitHub can stamp the re-arm's `labeled review:pending` a second after its `unlabeled review:accepted`.
    expect(decideClearanceRestore({ ...restoreFacts, events: [...events.slice(0, 3),
      event('labeled', 'review:pending', '19:02:58')] }).restore).toBe(true);
  });
  it('honours a second pending event even within the original swap timestamp', () => {
    expect(decideClearanceRestore({ ...restoreFacts, events: [...events,
      event('labeled', 'review:pending', '19:02:57')] }).restore).toBe(false);
  });
  it('rejects a forged re-arm comment', () => {
    expect(decideClearanceRestore({ ...restoreFacts, comments: [acceptance,
      { ...rearm, author: { login: 'mallory' } }] }).restore).toBe(false);
  });
  it('requires removal within 180 seconds of the trusted re-arm', () => {
    expect(decideClearanceRestore({ ...restoreFacts, comments: [acceptance,
      { ...rearm, createdAt: '2026-10-13T19:05:58Z' }] }).restore).toBe(false);
  });
});

describe('rearm-review CLI same-head clearance', () => {
  it.each([
    { explicitRepo: true, flagsFirst: false }, { explicitRepo: false, flagsFirst: false },
    { explicitRepo: true, flagsFirst: true }, { explicitRepo: false, flagsFirst: true },
  ])('refuses without label writes: %j', ({ explicitRepo, flagsFirst }) => {
    const dir = mkdtempSync(join(tmpdir(), 'rearm-clearance-'));
    const callsPath = join(dir, 'calls.jsonl');
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../conveyor/rearm-review.mjs');
    const fake = `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLEARANCE_CALLS, JSON.stringify(args) + '\\n');
let out;
if (args[0] === 'repo' && args[1] === 'view') out = ${JSON.stringify(repo)};
else if (args[0] === 'pr' && args[1] === 'view') out = JSON.stringify(${JSON.stringify({ headRefOid: head, headRefName: 'lane/5193', labels: ['review:accepted'], state: 'OPEN' })});
else if (args.some(a => a.includes('/comments'))) out = JSON.stringify([${JSON.stringify(rest([acceptance]))}]);
else if (args.some(a => a.includes('/git/ref/'))) out = JSON.stringify({object:{sha:${JSON.stringify(head)}}});
else if (args.some(a => a.includes('/reviews') || a.includes('/events'))) out = '[[]]';
else { console.error('unexpected gh: ' + JSON.stringify(args)); process.exit(91); }
process.stdout.write(out + '\\n');`;
    try {
      writeFileSync(join(dir, 'gh'), fake, { mode: 0o755 });
      const flags = explicitRepo ? [`--repo=${repo}`] : ['--actor=fixture'];
      const result = spawnSync(process.execPath, [script, ...(flagsFirst ? [...flags, '5193'] : ['5193', ...flags])], {
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, WE_UNDER_TEST: '1', CLEARANCE_CALLS: callsPath,
          WE_REVIEW_CLEARANCE_REARM_REQUIRES_HEAD_CHANGE: 'on' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, pr: 5193, rearmed: false, refused: 'same-head-clearance' });
      const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(s => JSON.parse(s));
      expect(calls.some(a => a[1] === 'edit' || a[1] === 'comment' || a.includes('POST'))).toBe(false);
      expect(calls.some(a => a.some(s => s.includes('/git/ref/')))).toBe(true);
      if (!explicitRepo) expect(calls.some(a => a[0] === 'repo' && a[1] === 'view')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('settings', () => {
  it.each(Object.keys(REVIEW_CLEARANCE_SETTINGS))('cascades %s and rejects any invalid layer', key => {
    const envKey = REVIEW_CLEARANCE_SETTINGS[key].envKey;
    expect(resolveReviewClearanceSetting({ key })).toEqual(on);
    expect(resolveReviewClearanceSetting({ key, env: { [envKey]: 'off' } })).toEqual(off);
    for (const layer of ['platform', 'repo']) {
      expect(resolveReviewClearanceSetting({ key, [layer]: { reviewClearance: { [key]: 'bad' } }, env: { [envKey]: 'on' } }).value).toBe('off');
    }
    expect(resolveReviewClearanceSetting({ key, env: { [envKey]: 'bad' } }).value).toBe('off');
  });
  it('reads declared settings and reports the source', () => {
    const logs = [];
    expect(loadReviewClearanceSetting({ key: 'restoreNoPushRearm', env: {}, readFile: () => '{}', readDeclared: () => ({ settings: { reviewClearance: { restoreNoPushRearm: 'on' } } }), log: s => logs.push(s) })).toEqual({ value: 'on', source: 'repo' });
    expect(logs[0]).toContain('review-clearance · reviewClearance.restoreNoPushRearm=on (source: repo)');
  });
});

const rest = list => list.map(c => ({ body: c.body, created_at: c.createdAt, user: { login: c.author.login }, html_url: c.url }));
function fakeGh(labels = ['review:accepted'], thread = comments) {
  const calls = [];
  const runGh = args => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: head, headRefName: 'lane/5193', labels, statusCheckRollup: rows });
    const path = args.find(a => a.startsWith('repos/')) ?? '';
    if (path.includes('/comments')) return JSON.stringify([rest(thread)]);
    if (path.includes('/reviews')) return '[[]]';
    if (path.includes('/events')) return JSON.stringify([events.slice(0, 2), events.slice(2)]);
    if (path.includes('/git/ref/')) return JSON.stringify({ object: { sha: head } });
    return '';
  };
  return { calls, runGh };
}
describe('I/O shell', () => {
  it.each(Object.keys(REVIEW_CLEARANCE_SETTINGS))('honours the %s off path', key => {
    const { calls, runGh } = fakeGh(key === 'restoreNoPushRearm' ? restoreFacts.labels : ['review:accepted']);
    const guard = createReviewClearanceGuard({ repo, runGh, readVerdict: () => verdict,
      loadSetting: ({ key: requested }) => requested === key ? off : on });
    switch (key) {
      case 'rerunStaleGateOnClearance':
        expect(guard.beforeCiHeal({ prNumber: 5193, reason: 'red-ci' })).toMatchObject({ rerun: false });
        expect(calls.some(a => a.includes('POST'))).toBe(false);
        break;
      case 'reviewHoldIsNotCiFailure':
      case 'ciHealRequiresFailingChecks':
        expect(guard.beforeCiHeal({ prNumber: 5193, reason: 'red-ci' })).toMatchObject({ launch: true, why: 'CI heal allowed' });
        break;
      case 'rearmRequiresHeadChange':
        expect(guard.guardRearm({ pr: 5193 })).toMatchObject({ refuse: false });
        break;
      case 'restoreNoPushRearm':
        expect(guard.beforeCiHeal({ prNumber: 5193, reason: 'red-ci' })).toMatchObject({ restored: false });
        expect(calls.some(a => a[1] === 'edit' || a[1] === 'comment')).toBe(false);
        break;
      case 'humanClearanceSurvivesSameShaAccept': {
        // This leaf setting belongs to the parser, rather than the I/O guard.
        const thread = [acceptance, comment(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`, '19:26:00')];
        expect(parseLatestHumanClearedSha(thread, { sameShaCarries: true })).toBe(head);
        expect(parseLatestHumanClearedSha(thread, { sameShaCarries: false })).toBeNull();
        break;
      }
      default: throw new Error(`No off-path assertion for ${key}`);
    }
  });
  describe.each(['beforeCiHeal', 'sweep'])('%s restoration revalidation', entryPoint => {
    it.each(['pr-head', 'ref-head', 'label-hold'])('checks live %s after the refreshed evidence lists', change => {
      const fake = fakeGh(restoreFacts.labels);
      let eventReads = 0;
      const runGh = args => {
        const result = fake.runGh(args);
        const path = args.find(a => a.startsWith('repos/')) ?? '';
        if (path.includes('/events')) eventReads++;
        if (eventReads >= 2) {
          if (change === 'ref-head' && path.includes('/git/ref/')) return JSON.stringify({ object: { sha: 'a'.repeat(40) } });
          if (args[0] === 'pr' && args[1] === 'view') {
            if (change === 'pr-head') return JSON.stringify({ ...JSON.parse(result), headRefOid: 'a'.repeat(40) });
            if (change === 'label-hold') return JSON.stringify({ ...JSON.parse(result), labels: [...restoreFacts.labels, 'review:human'] });
          }
        }
        return result;
      };
      const guard = createReviewClearanceGuard({ repo, runGh, readVerdict: () => verdict, loadSetting: () => on, log: () => {} });
      const result = entryPoint === 'beforeCiHeal' ? guard.beforeCiHeal({ prNumber: 5193, reason: 'red-ci' })
        : guard.sweep([{ prNumber: 5193, labels: restoreFacts.labels }])[0];
      expect(eventReads).toBe(2);
      expect(result).toMatchObject({ restored: false });
      expect(fake.calls.filter(a => a[1] === 'edit' || a[1] === 'comment' || a.includes('POST'))).toEqual([]);
    });
    it.each(['pr-head', 'ref-head', 'label-hold', 'comment-hold', 'formal-review', 'event-hold',
      'unreadable-view', 'unreadable-ref', 'unreadable-comments', 'unreadable-reviews', 'unreadable-events'])
    ('does not restore when the head changes after evidence collection or a hold appears: %s', change => {
      const fake = fakeGh(restoreFacts.labels);
      let collected = false;
      const runGh = args => {
        const result = fake.runGh(args);
        const path = args.find(a => a.startsWith('repos/')) ?? '';
        const view = args[0] === 'pr' && args[1] === 'view';
        if (collected) {
          if (change === 'unreadable-view' && view || change === 'unreadable-ref' && path.includes('/git/ref/')
            || change === 'unreadable-comments' && path.includes('/comments')
            || change === 'unreadable-reviews' && path.includes('/reviews')
            || change === 'unreadable-events' && path.includes('/events')) throw new Error('read failed');
          if (change === 'pr-head' && view) return JSON.stringify({ ...JSON.parse(result), headRefOid: 'a'.repeat(40) });
          if (change === 'ref-head' && path.includes('/git/ref/')) return JSON.stringify({ object: { sha: 'a'.repeat(40) } });
          if (change === 'label-hold' && view) return JSON.stringify({ ...JSON.parse(result), labels: [...restoreFacts.labels, 'review:human'] });
          if (change === 'comment-hold' && path.includes('/comments')) return JSON.stringify([rest([...comments, comment('🔁 review — changes requested', '19:03:00')])]);
          if (change === 'formal-review' && path.includes('/reviews')) return JSON.stringify([[{ state: 'CHANGES_REQUESTED', submitted_at: '2026-10-13T19:03:00Z', user: { login: 'chalbert' } }]]);
          if (change === 'event-hold' && path.includes('/events')) return JSON.stringify([[...events, event('labeled', 'review:pending', '19:03:00')]]);
        }
        // The first evidence snapshot is stale by the time its final list returns.
        if (path.includes('/events')) collected = true;
        return result;
      };
      const guard = createReviewClearanceGuard({ repo, runGh, readVerdict: () => verdict, loadSetting: () => on, log: () => {} });
      const result = entryPoint === 'beforeCiHeal' ? guard.beforeCiHeal({ prNumber: 5193, reason: 'red-ci' })
        : guard.sweep([{ prNumber: 5193, labels: restoreFacts.labels }])[0];
      expect(result).toMatchObject({ restored: false });
      expect(fake.calls.filter(a => a[1] === 'edit' || a[1] === 'comment' || a.includes('POST'))).toEqual([]);
    });
  });
  describe.each(['beforeCiHeal', 'sweep'])('%s approval-write revalidation', entryPoint => {
    it.each(['pr-head', 'ref-head', 'unreadable-view', 'unreadable-ref'])
    ('does not restore when the head changes between the final read and the approval write: %s', change => {
      const fake = fakeGh(restoreFacts.labels);
      let written = false;
      const runGh = args => {
        if (args[0] === 'pr' && args[1] === 'edit') { written = true; return fake.runGh(args); }
        const result = fake.runGh(args);
        const path = args.find(a => a.startsWith('repos/')) ?? '';
        const view = args[0] === 'pr' && args[1] === 'view';
        if (written) {
          if (change === 'unreadable-view' && view || change === 'unreadable-ref' && path.includes('/git/ref/')) throw new Error('read failed');
          if (change === 'pr-head' && view) return JSON.stringify({ ...JSON.parse(result), headRefOid: 'a'.repeat(40) });
          if (change === 'ref-head' && path.includes('/git/ref/')) return JSON.stringify({ object: { sha: 'a'.repeat(40) } });
        }
        return result;
      };
      const guard = createReviewClearanceGuard({ repo, runGh, readVerdict: () => verdict, loadSetting: () => on, log: () => {} });
      const result = entryPoint === 'beforeCiHeal' ? guard.beforeCiHeal({ prNumber: 5193, reason: 'red-ci' })
        : guard.sweep([{ prNumber: 5193, labels: restoreFacts.labels }])[0];
      expect(result).toMatchObject({ restored: false });
      // The approval write is undone at once: pending back on, acceptance off. No restore record, no gate re-run.
      expect(fake.calls.filter(a => a[1] === 'edit')).toEqual([
        ['pr', 'edit', '5193', '--repo', repo, '--add-label', 'review:accepted', '--remove-label', 'review:pending'],
        ['pr', 'edit', '5193', '--repo', repo, '--add-label', 'review:pending', '--remove-label', 'review:accepted'],
      ]);
      expect(fake.calls.filter(a => a[1] === 'comment' || a.includes('POST'))).toEqual([]);
    });
  });
  it('refuses a heal and requests the stale job rerun', async () => {
    const { calls, runGh } = fakeGh();
    const guard = createReviewClearanceGuard({ repo, runGh, readVerdict: () => verdict, loadSetting: () => on });
    expect(await guard.beforeCiHeal({ prNumber: 5193, reason: 'red-ci' })).toMatchObject({ launch: false, why: expect.stringContaining('no failing CI') });
    expect(calls.filter(a => a.includes('POST'))).toEqual([['api', '-X', 'POST', `repos/${repo}/actions/jobs/115424411010/rerun`]]);
    expect(await guard.guardRearm({ pr: 5193 })).toMatchObject({ refuse: true });
  });
  it('restores then reruns, but preserves CodeQL launches', async () => {
    const { calls, runGh } = fakeGh(restoreFacts.labels);
    const guard = createReviewClearanceGuard({ repo, runGh, readVerdict: () => verdict, loadSetting: () => on });
    expect(await guard.beforeCiHeal({ prNumber: 5193, reason: 'codeql' })).toMatchObject({ launch: true, restored: true });
    expect(calls.filter(a => a[1] === 'edit')).toHaveLength(1);
    expect(calls.filter(a => a[1] === 'comment')).toHaveLength(1);
    expect(calls.filter(a => a.includes('POST'))).toHaveLength(1);
  });
  it('does not record a deferred write as restoration or rerun', async () => {
    const fake = fakeGh(restoreFacts.labels);
    const runGh = args => args[1] === 'edit' ? JSON.stringify({ outcome: 'deferred-low-budget' }) : fake.runGh(args);
    const guard = createReviewClearanceGuard({ repo, runGh, readVerdict: () => verdict, loadSetting: () => on });
    expect(await guard.beforeCiHeal({ prNumber: 5193 })).toMatchObject({ launch: true, why: expect.stringContaining('guard error:') });
    expect(fake.calls.filter(a => a[1] === 'comment' || a.includes('POST'))).toEqual([]);
  });
  it('preserves current behavior when reads fail', async () => {
    const runGh = () => { throw new Error('offline'); };
    expect(readPrClearanceFacts({ repo, pr: 5193, runGh }).prHead).toBeNull();
    const guard = createReviewClearanceGuard({ repo, runGh, loadSetting: () => on });
    expect(await guard.beforeCiHeal({ prNumber: 5193 })).toMatchObject({ launch: true });
    expect(await guard.guardRearm({ pr: 5193 })).toMatchObject({ refuse: false });
  });
});

describe('sweep (fix daemon tick)', () => {
  it('restores #5193 from the reconcile rows and re-runs the stale merge-gate', () => {
    const { calls, runGh } = fakeGh(restoreFacts.labels);
    const guard = createReviewClearanceGuard({ repo, runGh, readVerdict: () => verdict, loadSetting: () => on, log: () => {} });
    const out = guard.sweep([{ prNumber: 5193, labels: restoreFacts.labels }, { prNumber: 7, labels: ['review:human', 'review:pending'] }]);
    expect(out).toEqual([expect.objectContaining({ pr: 5193, restored: true, rerun: true })]);
    expect(calls.filter(a => a[1] === 'edit')).toEqual([['pr', 'edit', '5193', '--repo', repo, '--add-label', 'review:accepted', '--remove-label', 'review:pending']]);
  });
  it('pays only the view and comment reads for a review:pending PR with no no-push re-arm', () => {
    const { calls, runGh } = fakeGh(['review:pending'], [acceptance]);
    const guard = createReviewClearanceGuard({ repo, runGh, readVerdict: () => verdict, loadSetting: () => on, log: () => {} });
    expect(guard.sweep([{ prNumber: 9, labels: ['review:pending'] }])).toEqual([expect.objectContaining({ pr: 9, restored: false, rerun: false })]);
    expect(calls).toHaveLength(2);
  });
  it('reads every page of comments, reviews and events', () => {
    const { calls, runGh } = fakeGh(restoreFacts.labels);
    const facts = readPrClearanceFacts({ repo, pr: 5193, runGh });
    expect(facts.events).toHaveLength(events.length);
    expect(facts.comments.map(c => c.url)).toEqual(comments.map(c => c.url));
    expect(calls.filter(a => a.includes('--paginate')).every(a => a.includes('--slurp'))).toBe(true);
  });
});
