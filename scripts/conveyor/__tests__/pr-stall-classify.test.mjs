/** @file pr-stall-classify.test.mjs
 * @description The stall sweep's pure classifier: every waiting state x every judge verdict, fail-closed paths, guard
 *   paths, the round ceiling, and the never-automatic actions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyStall, JUDGED_STATES, NEVER_AUTOMATIC, POLICY_ACTOR } from '../pr-stall-classify.mjs';
import { MAX_TOTAL_ROUND_EXTENSIONS } from '../round-extension-mark.mjs';

const REPO = 'web-everything/web-everything';
const HEAD = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
const ACTOR = { 'system:ledger-write-miss': 'system', 'system:stale-hold': 'system', 'red-team-sent-back-cleared': 'nobody',
  'awaiting-review': 'reviewer', 'human-review-pending-advisory': 'reviewer', 'red-team-pending': 'red-team', 'drain-skip:red-team-pending': 'red-team',
  fixing: 'fixer', 'sent-back-red-team': 'fixer', draft: 'fixer', 'ci-failed': 'fixer', 'awaiting-ci': 'ci', 'ready-to-merge': 'drain',
  'in-merge-queue': 'drain', 'drain-skip:queue-file-overlap': 'drain', 'drain-skip:overlap-yield': 'drain', 'drain-skip:ready-not-reached': 'drain' };
const row = (waitingOn, o = {}) => ({ repo: REPO, number: 77, waitingOn, actor: ACTOR[waitingOn] ?? 'operator', stalled: true, liveJob: null,
  why: 'x', evidence: ['e1', 'e2', 'e3', 'e4'], next: { summary: 's', command: `next-for ${waitingOn}` }, ...o });
const finding = (cls, file = 'scripts/foo.mjs') => ({ file, line: 3, summary: `${cls}: the claim must be released before the push`, cls, priorAppearances: 0 });
const TRIGGER = { 'ruling-needed:referral-hold': 'referral-hold', 'ruling-needed:red-team-round-cap': 'red-team-cap', 'at-round-limit': 'review-cap' };
const counts = (latest) => ({ latestCount: latest.length, classes: Object.fromEntries(['broken', 'degraded', 'unconfirmed'].map((c) => [c, latest.filter((f) => f?.cls === c).length])) });
const verdict = (v, trigger = 'red-team-cap', o = {}) => {
  const latest = [finding(v === 'card-the-rest' ? 'degraded' : 'broken')];
  return { verdict: v, reasons: [`why-${v}`], ...(v === 'grant' ? { k: 1 } : {}), ...(v === 'not-real-verified' ? { proof: ['scripts/foo.mjs:3 -> absent'] } : {}),
    evidence: { trigger, head: HEAD.slice(0, 12).toLowerCase(), filesKnown: true, crossBroken: 0, grantsSoFar: 0, guardFiles: [], latest, ...counts(latest) }, ...o };
};
const hold = 'referral-hold';
/** Patch the evidence; a patched `latest` keeps the judge's tallies in step unless the patch sets them itself. */
const ev = (v, trigger, patch = {}) => {
  const x = verdict(v, trigger); const tallies = Array.isArray(patch.latest) ? counts([...patch.latest]) : {};
  return { ...x, evidence: { ...x.evidence, ...tallies, ...patch } };
};
const VERDICT_NAMES = [null, 'grant', 'send-back', 'card-the-rest', 'suggest-split', 'escalate', 'not-real-verified'];
const card = { id: 'we:backlog/xabc123-coverage.md', readable: true };
const run = (state, v, o = {}) => classifyStall({ row: row(state, o.row), head: HEAD, verdict: v === null ? null : verdict(v, TRIGGER[state] ?? 'red-team-cap'), files: ['scripts/foo.mjs'], card, ...o.ctx });
const at = (state, o = {}) => classifyStall({ head: HEAD, files: ['scripts/foo.mjs'], ...o, row: row(state, o.row) });

// Non-judged states: the verdict never changes the answer.
const FIXED = {
  'system:ledger-write-miss': ['system', 'await-ledger-outbox'],
  'system:stale-hold': ['operator', 'stale-hold'],
  'red-team-sent-back-cleared': ['system', 'rerun-red-team-gate'],
  'awaiting-review': ['system', 'ask-review-daemon'],
  'human-review-pending-advisory': ['system', 'ask-review-daemon'],
  'red-team-pending': ['system', 'ask-review-daemon'],
  'drain-skip:red-team-pending': ['system', 'ask-review-daemon'],
  fixing: ['system', 'tooling-card'], 'sent-back-red-team': ['system', 'tooling-card'], draft: ['system', 'tooling-card'],
  'ci-failed': ['system', 'tooling-card'], 'awaiting-ci': ['system', 'tooling-card'], 'ready-to-merge': ['system', 'tooling-card'],
  'in-merge-queue': ['system', 'tooling-card'], 'drain-skip:queue-file-overlap': ['system', 'tooling-card'],
  'drain-skip:ready-not-reached': ['system', 'tooling-card'], 'drain-skip:overlap-yield': ['system', 'tooling-card'],
  'drain-skip:escalated': ['operator', 'unclassified'], 'drain-skip:unknown': ['operator', 'unclassified'],
  'ruling-needed:dispute': ['operator', 'ruling-needed:dispute'], 'needs-decision:note': ['operator', 'needs-decision:note'],
  'draft-withdrawn': ['operator', 'draft-withdrawn'], 'needs-you': ['operator', 'needs-you'], 'human-review': ['operator', 'human-review'],
  'drain-skip:not-certified': ['operator', 'drain-skip:not-certified'], unclassified: ['operator', 'unclassified'],
  'some-future-state': ['operator', 'unclassified'],
};
// Judged states: [lane, action] per verdict, in VERDICT_NAMES order.
const JUDGED = {
  'ruling-needed:referral-hold': [['operator', 'no-verdict'], ['operator', 'no-verdict'], ['policy', 'block'], ['policy', 'card'],
    ['operator', 'suggest-split'], ['operator', 'escalate'], ['operator', 'suggest-not-real']],
  'ruling-needed:red-team-round-cap': [['operator', 'no-verdict'], ['policy', 'grant'], ['policy', 'block'], ['operator', 'card-the-rest'],
    ['operator', 'suggest-split'], ['operator', 'escalate'], ['operator', 'suggest-not-real']],
  'at-round-limit': [['operator', 'no-verdict'], ['policy', 'grant'], ['operator', 'send-back-at-round-limit'], ['operator', 'card-the-rest'],
    ['operator', 'suggest-split'], ['operator', 'escalate'], ['operator', 'suggest-not-real']],
};

describe('every state x every verdict', () => {
  const cases = [];
  for (const [state, want] of Object.entries(FIXED)) for (const v of VERDICT_NAMES) cases.push([state, v, ...want]);
  for (const [state, wants] of Object.entries(JUDGED)) VERDICT_NAMES.forEach((v, i) => cases.push([state, v, ...wants[i]]));
  it.each(cases)('%s with verdict %s -> %s / %s', (state, v, lane, action) => {
    const r = run(state, v);
    expect([r.lane, r.action]).toEqual([lane, action]);
    expect(r.key).toBe(`${REPO}#77@${HEAD.toLowerCase()}:${state}`);
    expect(r.evidence.length).toBeLessThanOrEqual(3);
    if (lane === 'operator') expect(typeof r.command).toBe('string');
    if (lane === 'policy') expect(r.actor).toBe(POLICY_ACTOR);
    expect(NEVER_AUTOMATIC.includes(r.action) && lane !== 'operator').toBe(false);
  });
  it('covers every judged state the module declares', () => expect(Object.keys(JUDGED).sort()).toEqual(Object.keys(JUDGED_STATES).sort()));
  it('covers every waiting state pr-sweep-core can emit', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/operations/pr-sweep-core.mjs'), 'utf8');
    const emitted = [...src.matchAll(/done\(([^,]+),/g)].flatMap(([, arg]) => [...arg.replace(/has\('[^']*'\)/g, '').matchAll(/'([^']+)'/g)].map((m) => m[1]));
    expect(emitted.length).toBeGreaterThan(15);
    for (const s of emitted) expect(Object.keys(FIXED).includes(s) || Object.keys(JUDGED).includes(s), s).toBe(true);
    const drainKinds = /DRAIN_SKIP_ACTOR = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(src)[1].match(/'([a-z-]+)':/g).map((k) => `drain-skip:${k.slice(1, -2)}`);
    for (const s of drainKinds) expect(Object.keys(FIXED), s).toContain(s);
  });
});

describe('not stalled / live job', () => {
  it('a row that is not stalled is nothing to do', () => expect(at('fixing', { row: { stalled: false } })).toBeNull());
  it('an automation wait with a live job is nothing to do', () => {
    expect(at('fixing', { row: { liveJob: 'fix' } })).toBeNull();
    expect(at('awaiting-review', { row: { liveJob: 'review-job' } })).toBeNull();
  });
  it('the review daemon is asked once per head, whichever review wait it is', () => {
    expect(at('awaiting-review').onceKey).toBe(at('red-team-pending').onceKey);
    expect(at('awaiting-review').onceKey).toBe(`${REPO}#77@${HEAD.toLowerCase()}:ask-review-daemon`);
  });
  it('a tooling card names the existing health smell', () => {
    expect(run('ci-failed', null).smell).toBe('red-pr-unattended');
    expect(run('drain-skip:overlap-yield', null).smell).toBe('pr-stage-stall');
  });
});

describe('stale hold setting', () => {
  it('goes to the operator until auto-resume is turned on', () => {
    expect(run('system:stale-hold', null).lane).toBe('operator');
    const on = at('system:stale-hold', { settings: { staleHoldAutoResume: true } });
    expect([on.lane, on.action]).toEqual(['system', 'resume-stale-hold']);
    for (const files of [['.github/workflows/test.yml'], [], undefined, ['./a.mjs']]) {
      expect(at('system:stale-hold', { settings: { staleHoldAutoResume: true }, files }).lane).toBe('operator');
    }
  });
});

describe('fail closed', () => {
  it.each([
    ['null-prototype object', () => Object.create(null)],
    ['throwing message getter', () => ({ get message() { throw new Error('unreadable message'); } })],
    ['throwing conversion', () => ({ [Symbol.toPrimitive]() { throw new Error('unreadable value'); } })],
    ['unreadable message value', () => ({ message: Object.create(null) })],
    ['revoked proxy', () => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; }],
  ])('an unreadable thrown %s still returns an operator item', (_name, makeError) => {
    const error = makeError();
    const r = classifyStall({ row: row('fixing'), head: HEAD, get settings() { throw error; } });
    expect(r).toEqual({ lane: 'operator', action: 'unclassified', reason: 'fail-closed: classifier error (unreadable error)',
      key: `${REPO}#77@${HEAD.toLowerCase()}:fixing`, command: null, evidence: [] });
    const fallback = classifyStall({ get settings() { throw error; }, get row() { throw error; } });
    expect(fallback).toEqual({ ...r, key: '?#0@:unknown' });
  });
  it.each([
    ['error', new Error('readable error'), 'readable error'],
    ['string', 'readable string', 'readable string'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['symbol', Symbol('failure'), 'Symbol(failure)'],
    ['long message', new Error('x'.repeat(200)), 'x'.repeat(120)],
  ])('a thrown %s retains its bounded diagnostic', (_name, error, message) => {
    const r = classifyStall({ get settings() { throw error; } });
    expect([r.lane, r.action]).toEqual(['operator', 'unclassified']);
    expect(r.reason).toBe(`fail-closed: classifier error (${message})`);
  });
  it.each([[null], [{}], [{ repo: REPO, number: '77', waitingOn: 'x', stalled: true }], [{ repo: REPO, number: 77, stalled: true }],
    [row('fixing', { stalled: 'false' })], [{ ...row('fixing'), stalled: undefined }], [row('fixing', { repo: '' })], [row('fixing', { repo: '../..' })], [row('fixing', { repo: 'someone/else' })], [row('fixing', { number: -3 })],
    [row('fixing', { liveJob: undefined })], [row('fixing', { liveJob: 0 })], [row('fixing', { why: { unreadable: true } })],
    [row('fixing', { evidence: { unreadable: true } })], [row('fixing', { evidence: [1] })], [row('fixing', { next: 'unreadable' })], [row('fixing', { evidence: Object.assign(new Array(2), { 1: 'e', '-1': 'e' }) })], [Object.assign([], row('fixing'))]])('an unreadable row %# is an operator item', (bad) => {
    const r = classifyStall({ row: bad, head: HEAD });
    expect([r.lane, r.action]).toEqual(['operator', 'unclassified']);
    expect(r.reason).toMatch(/fail-closed/);
  });
  it('unreadable referral evidence goes to the operator before anything else', () => {
    const r = run('ruling-needed:referral-hold', 'send-back', { row: { why: 'review paused (evidence unreadable: the referral thread is malformed)' } });
    expect([r.lane, r.action]).toEqual(['operator', 'unreadable-evidence']);
  });
  it.each([
    ['an unknown verdict', { ...verdict('send-back'), verdict: 'approve' }],
    ['findings the tallies disagree with', ev('card-the-rest', hold, { latestCount: 2, classes: { broken: 1, degraded: 1, unconfirmed: 0 } })],
    ['no tallies', ev('send-back', 'red-team-cap', { classes: undefined })],
    ['a verdict with no reasons', { verdict: 'send-back', body: 'a.mjs:1 - do the thing', evidence: verdict('send-back').evidence }],
    ['a fail-closed verdict', ev('send-back', 'red-team-cap', { failClosed: true })],
    ['a verdict for another trigger', ev('send-back', 'review-cap')],
    ['a verdict with no trigger', ev('send-back', 'red-team-cap', { trigger: undefined })],
    ['a verdict on another head', ev('grant', 'red-team-cap', { head: 'ffffffffffff' })],
    ['a verdict with no head', ev('grant', 'red-team-cap', { head: undefined })],
    ['a grant with no round count', { ...verdict('grant'), k: 0 }],
    ['a grant with an unknown spend', ev('grant', 'red-team-cap', { grantsSoFar: undefined })],
    ['a grant with a fractional spend', ev('grant', 'red-team-cap', { grantsSoFar: 0.5 })],
    ['a send-back with no fix list', ev('send-back', 'red-team-cap', { latest: [] })],
    ['a send-back with an empty finding', ev('send-back', 'red-team-cap', { latest: [{}] })],
    ['a card with a broken finding', ev('card-the-rest', hold, { latest: [finding('degraded'), finding('broken')] })],
    ['a card with a sparse finding list', ev('card-the-rest', hold, { latest: new Array(1) })],
    ['a card with a break open in another source', ev('card-the-rest', hold, { crossBroken: 1 })],
    ['a card with an unknown cross-source count', ev('card-the-rest', hold, { crossBroken: undefined })],
    ['a verdict on a 7-char head prefix', ev('grant', 'red-team-cap', { head: HEAD.slice(0, 7).toLowerCase() })],
    ['a verdict that is an array', Object.assign([], verdict('grant'))],
    ['a finding that is an array', ev('send-back', 'red-team-cap', { latest: [Object.assign([], finding('broken'))] })],
    ['evidence that is an array', { ...verdict('grant'), evidence: Object.assign([], verdict('grant').evidence) }],
    ['malformed judge guard files', ev('grant', 'red-team-cap', { guardFiles: 'scripts/lib/red-team-gate.mjs' })],
    ['a finding with unreadable prior appearances', ev('grant', 'red-team-cap', { latest: [{ ...finding('broken'), priorAppearances: 'unreadable' }] })],
    ['a sparse guard list with an extra key', ev('grant', 'red-team-cap', { guardFiles: Object.assign(new Array(1), { extra: 'x' }) })],
    ['files the judge marks unknown', ev('grant', 'red-team-cap', { filesKnown: false })],
    ['a non-boolean filesKnown', ev('grant', 'red-team-cap', { filesKnown: 'false' })],
    ['no judge guard list', ev('grant', 'red-team-cap', { guardFiles: undefined })],
    ['no judge findings list', ev('grant', 'red-team-cap', { latest: undefined })],
    ['sparse reasons', { ...verdict('grant'), reasons: new Array(1) }],
    ['a grant reporting an empty finding', ev('grant', 'red-team-cap', { latest: [{}] })],
    ['a finding of an unknown class', ev('send-back', 'red-team-cap', { latest: [{ ...finding('broken'), cls: 'unknown' }] })],
    ['a finding with a bad line', ev('send-back', 'red-team-cap', { latest: [{ ...finding('broken'), line: { bad: true } }] })],
  ])('%s is an operator item', (_n, v) => {
    const state = v.evidence?.trigger === hold || v.verdict === 'card-the-rest' ? 'ruling-needed:referral-hold' : 'ruling-needed:red-team-round-cap';
    expect(at(state, { verdict: v, card }).lane).toBe('operator');
  });
  it('a verdict getter is refused outright, so it cannot pass the ceiling then change', () => {
    let n = 0; const v = verdict('grant', 'review-cap');
    Object.defineProperty(v, 'k', { get: () => (n++ === 0 ? 1 : 100), enumerable: true });
    expect(at('at-round-limit', { verdict: v })).toMatchObject({ lane: 'operator', action: 'unclassified' });
    expect(n).toBe(0);
  });
  it('a caller count can never lower the judge\'s count below the ceiling', () => {
    expect(at('at-round-limit', { verdict: ev('grant', 'review-cap', { grantsSoFar: MAX_TOTAL_ROUND_EXTENSIONS }), grantsSoFar: 0 }).action).toBe('past-ceiling');
  });
  it.each([['Infinity', Infinity], ['fraction', 0.5], ['negative', -1], ['string', '0']])('an explicit %s grant count is not a fallback to the judge', (_n, g) => {
    expect(at('at-round-limit', { verdict: verdict('grant', 'review-cap'), grantsSoFar: g })).toMatchObject({ lane: 'operator', action: 'no-verdict' });
  });
  it('a guard path named only by a finding blocks policy', () => {
    expect(at('ruling-needed:red-team-round-cap', { verdict: ev('grant', 'red-team-cap', { latest: [finding('broken', 'scripts/lib/red-team-gate.mjs')] }) }).action).toBe('guard-file-touched');
  });
  it.each([['./.github/workflows/test.yml'], ['/scripts/lib/red-team-gate.mjs'], ['scripts/../.github/workflows/x.yml'], ['scripts//lib/x.mjs'], [' a.mjs'], ['a\\b.mjs'], ['scripts/lib/red-team-gate.mjs/'], ['a\0.mjs'], ['we:./.github/workflows/test.yml'], ['we:scripts/lib/red-team-gate.mjs']])('a non-canonical path %s is unreadable, never normalised past the guard', (path) => {
    expect(at('ruling-needed:red-team-round-cap', { verdict: verdict('grant'), files: ['a.mjs', path] })).toMatchObject({ lane: 'operator', action: 'no-verdict' });
  });
  it.each([['a string', 'scripts/lib/red-team-gate.mjs'], ['null', null], ['a list with a number', ['a.mjs', 3]], ['empty', []], ['omitted', undefined]])('a PR file list that is %s blocks policy', (_n, files) => {
    expect(at('ruling-needed:red-team-round-cap', { verdict: verdict('grant'), files }).lane).toBe('operator');
  });
  it.each([[''], ['not-a-sha'], [undefined], ['abcdef0'], ['abcdef012345']])('an unreadable head %# is an operator item', (head) => {
    expect(classifyStall({ row: row('fixing'), head }).lane).toBe('operator');
  });
  it.each([[undefined], ['person-must-decide'], ['operator'], ['drain'], [{ bad: true }]])('an automatic state with the wrong actor %s is an operator item', (actor) => {
    for (const state of ['fixing', 'awaiting-review', 'system:ledger-write-miss', 'red-team-sent-back-cleared']) {
      if (actor === ACTOR[state]) continue;
      expect(at(state, { row: { actor } }).lane, state).toBe('operator');
    }
  });
  it.each([[undefined], ['fixer'], [{ bad: true }]])('a judged state with actor %s never reaches policy', (actor) => {
    expect(at('ruling-needed:red-team-round-cap', { verdict: verdict('grant'), row: { actor } })).toMatchObject({ lane: 'operator', action: 'unclassified' });
  });
  it.each([[0], ['true'], [null]])('a malformed failClosed flag %s is an operator item', (flag) => {
    expect(at('ruling-needed:red-team-round-cap', { verdict: ev('grant', 'red-team-cap', { failClosed: flag }) }).lane).toBe('operator');
  });
  it.each([['a hidden failClosed', (v) => Object.defineProperty(v.evidence, 'failClosed', { value: true })],
    ['an inherited failClosed', (v) => { v.evidence = Object.assign(Object.create({ failClosed: true }), v.evidence); }]])('%s is never dropped by the copy', (_n, mutate) => {
    const v = verdict('grant'); mutate(v);
    expect(at('ruling-needed:red-team-round-cap', { verdict: v }).lane).toBe('operator');
  });
  it.each([['send-back', hold], ['card-the-rest', hold]])('an unreadable grant count blocks a %s too', (v, trig) => {
    expect(at('ruling-needed:referral-hold', { verdict: ev(v, trig, { grantsSoFar: 'unreadable' }), card }).lane).toBe('operator');
    expect(at('ruling-needed:referral-hold', { verdict: verdict(v, trig), grantsSoFar: 'unreadable', card }).lane).toBe('operator');
  });
  it('an array-wrapped input is unreadable', () => {
    expect(classifyStall(Object.assign([], { row: row('ruling-needed:red-team-round-cap'), head: HEAD, verdict: verdict('grant'), files: ['a.mjs'] })).lane).toBe('operator');
  });
  it('settings are read once', () => {
    let n = 0; const o = { row: row('ruling-needed:red-team-round-cap'), head: HEAD, verdict: verdict('grant'), files: ['scripts/foo.mjs'] };
    Object.defineProperty(o, 'settings', { get: () => (n++ === 0 ? { policyActions: { grant: false } } : {}), enumerable: true });
    expect(classifyStall(o).lane).toBe('operator');
  });
  it('null settings fail closed for a policy row too', () => {
    expect(at('ruling-needed:red-team-round-cap', { verdict: verdict('grant'), settings: null }).lane).toBe('operator');
  });
  it('a non-boolean stale-hold setting is unreadable', () => {
    expect(at('ruling-needed:red-team-round-cap', { verdict: verdict('grant'), settings: { staleHoldAutoResume: 'true' } }).lane).toBe('operator');
  });
  it('a send-back with an unreadable cross-source count is an operator item', () => {
    expect(at('ruling-needed:red-team-round-cap', { verdict: ev('send-back', 'red-team-cap', { crossBroken: 'unreadable' }) }).lane).toBe('operator');
  });
  it('an array card or settings is unreadable', () => {
    expect(at('ruling-needed:referral-hold', { verdict: verdict('card-the-rest', hold), card: Object.assign([], card) }).lane).toBe('operator');
    expect(at('fixing', { settings: [] }).lane).toBe('operator');
  });
  it('a getter that throws inside the row is caught, not thrown', () => {
    const bad = row('fixing'); Object.defineProperty(bad, 'waitingOn', { get() { throw new Error('boom'); } });
    expect(classifyStall({ row: bad, head: HEAD }).reason).toMatch(/fail-closed: classifier error/);
  });
});

describe('policy guardrails', () => {
  it.each(['scripts/operations/pr-sweep-core.mjs', 'scripts/lib/red-team-gate.mjs', '.github/workflows/test.yml', 'scripts/lib/merge-gate-ci.mjs', 'scripts/conveyor/pr-stall-classify.mjs',
    'scripts/lib/round-judge.mjs', 'scripts/conveyor/round-extension-mark.mjs', 'scripts/operations/extend-rounds-io.mjs', 'scripts/operations/record-referral-ruling.mjs'])('a guard path %s blocks every policy action', (path) => {
    for (const v of ['grant', 'send-back']) {
      const r = at('ruling-needed:red-team-round-cap', { verdict: verdict(v), files: ['scripts/foo.mjs', path] });
      expect([r.lane, r.action]).toEqual(['operator', 'guard-file-touched']);
    }
    expect(at('ruling-needed:referral-hold', { verdict: ev('card-the-rest', hold, { guardFiles: [path] }), card }).action).toBe('guard-file-touched');
  });
  it('a grant stays inside the round ceiling', () => {
    const g = (spent, k) => at('at-round-limit', { verdict: { ...verdict('grant', 'review-cap'), k }, files: ['a.mjs'], grantsSoFar: spent });
    expect(g(MAX_TOTAL_ROUND_EXTENSIONS - 2, 2)).toMatchObject({ lane: 'policy', action: 'grant', k: 2 });
    expect(g(MAX_TOTAL_ROUND_EXTENSIONS - 1, 2)).toMatchObject({ lane: 'operator', action: 'past-ceiling' });
    expect(g(MAX_TOTAL_ROUND_EXTENSIONS, 1)).toMatchObject({ lane: 'operator', action: 'past-ceiling' });
  });
  it.each([[undefined], ['unreadable'], [1]])('a grant with crossBroken %s is an operator item', (x) => {
    expect(at('ruling-needed:red-team-round-cap', { verdict: ev('grant', 'red-team-cap', { crossBroken: x }) }).lane).toBe('operator');
  });
  it('a grant never answers a referral hold', () => expect(run('ruling-needed:referral-hold', 'grant').lane).toBe('operator'));
  it('card needs an EXISTING readable card', () => {
    for (const c of [null, { id: card.id, readable: false }, { id: '', readable: true }, { readable: true }, { id: '\0', readable: true }, { id: 'xabc123', readable: true }]) {
      const r = at('ruling-needed:referral-hold', { verdict: verdict('card-the-rest', hold), card: c });
      expect([r.lane, r.action]).toEqual(['operator', 'card-the-rest']);
    }
    expect(run('ruling-needed:referral-hold', 'card-the-rest')).toMatchObject({ lane: 'policy', action: 'card', card: 'we:backlog/xabc123-coverage.md' });
  });
  it('a block carries the judge\'s concrete fix list, else the open findings', () => {
    const withBody = at('ruling-needed:referral-hold', { verdict: { ...verdict('send-back', hold), body: 'a.mjs:1 - release the claim before the push\n\nb.mjs:2 - count the retry inside the budget' } });
    expect(withBody.fixList).toEqual(['a.mjs:1 - release the claim before the push', 'b.mjs:2 - count the retry inside the budget']);
    const fix = (i) => `a${i}.mjs:1 - release the claim before the push`;
    expect(at('ruling-needed:referral-hold', { verdict: { ...verdict('send-back', hold), body: Array.from({ length: 20 }, (_, i) => fix(i)).join('\n') } }).fixList).toHaveLength(20);
    expect(at('ruling-needed:referral-hold', { verdict: { ...verdict('send-back', hold), body: Array.from({ length: 21 }, (_, i) => fix(i)).join('\n') } }).lane).toBe('operator');
    expect(at('ruling-needed:referral-hold', { verdict: { ...verdict('send-back', hold), body: 'scripts/lib/red-team-gate.mjs:4 - release the claim before the push' } }).action).toBe('guard-file-touched');
    for (const body of ['a.mjs:1 - The output is incorrect in production', '\u0000', 'x', 'a.mjs:1 - short', 'a.mjs:0 - release the claim before the push', 'a.mjs:99999999 - release the claim before the push', 'no path here at all, just words', 'a.mjs:1 - release the claim before the push\nx']) {
      expect(at('ruling-needed:referral-hold', { verdict: { ...verdict('send-back', hold), body } }).lane, JSON.stringify(body)).toBe('operator');
    }
    expect(run('ruling-needed:red-team-round-cap', 'send-back').fixList).toEqual(['scripts/foo.mjs:3 - broken: the claim must be released before the push']);
    const diagnosis = ev('send-back', 'red-team-cap', { latest: [{ ...finding('broken'), summary: 'The output is incorrect in production' }] });
    expect(at('ruling-needed:red-team-round-cap', { verdict: diagnosis }).lane).toBe('operator');
  });
  it('not-real-verified is only ever a suggestion with a command', () => {
    const r = run('ruling-needed:referral-hold', 'not-real-verified');
    expect(r).toMatchObject({ lane: 'operator', action: 'suggest-not-real' });
    expect(r.command).toMatch(/record-referral-ruling/);
  });
});

describe('every policy is a setting, and settings only make it stricter', () => {
  it('a state forced to the operator never reaches an automatic lane', () => {
    expect(at('fixing', { settings: { stateLanes: { fixing: 'operator' } } })).toMatchObject({ lane: 'operator', action: 'tooling-card' });
    expect(at('ruling-needed:red-team-round-cap', { verdict: verdict('grant'), settings: { stateLanes: { 'ruling-needed:red-team-round-cap': 'operator' } } }).lane).toBe('operator');
    expect(at('fixing', { settings: { stateLanes: { fixing: 'auto' } } }).lane).toBe('system');
  });
  it.each([['systemActions', 'tooling-card', 'fixing', null], ['systemActions', 'ask-review-daemon', 'awaiting-review', null],
    ['policyActions', 'grant', 'ruling-needed:red-team-round-cap', 'grant'], ['policyActions', 'block', 'ruling-needed:red-team-round-cap', 'send-back'],
    ['policyActions', 'card', 'ruling-needed:referral-hold', 'card-the-rest']])('%s.%s off sends it to the operator', (group, action, state, v) => {
    const o = { settings: { [group]: { [action]: false } }, card, ...(v ? { verdict: verdict(v, TRIGGER[state]) } : {}) };
    const r = at(state, o);
    expect([r.lane, r.action]).toEqual(['operator', action]);
    expect(r.reason).toMatch(/setting/);
    expect(typeof r.command).toBe('string');
  });
  it('the grant ceiling is a setting that can only lower the shared one', () => {
    expect(at('at-round-limit', { verdict: verdict('grant', 'review-cap'), grantsSoFar: 2, settings: { grantCeiling: 2 } }).action).toBe('past-ceiling');
    expect(at('at-round-limit', { verdict: verdict('grant', 'review-cap'), settings: { grantCeiling: MAX_TOTAL_ROUND_EXTENSIONS + 1 } }).lane).toBe('operator');
  });
  it('the fix-list length is a setting', () => {
    const body = ['a.mjs:1 - release the claim before the push', 'b.mjs:1 - release the claim before the push'].join('\n');
    expect(at('ruling-needed:referral-hold', { verdict: { ...verdict('send-back', hold), body }, settings: { maxFixListLines: 1 } }).lane).toBe('operator');
  });
  it.each([[{ stateLanes: { fixing: 'system' } }], [{ systemActions: { 'tooling-card': 'yes' } }], [{ policyActions: { 'not-real': true } }],
    [{ grantCeiling: 0 }], [{ maxFixListLines: 21 }], [{ policyActions: [] }], [{ systemAction: { 'tooling-card': false } }], [{ garbage: null }],
    [new Date()], [Object.create({ systemActions: { 'tooling-card': false } })], [{ systemActions: Object.create({ 'tooling-card': false }) }], [{ stateLanes: { fixng: 'operator' } }],
    [{ systemActions: Object.defineProperty({}, 'tooling-card', { value: false, enumerable: false }) }],
    [{ stateLanes: Object.defineProperty({}, 'fixing', { get: () => 'operator', enumerable: true }) }],
[null], [JSON.parse('{"__proto__":null}')], [JSON.parse('{"stateLanes":{"__proto__":"operator"}}')]])('an unreadable setting %# fails closed', (settings) => {
    expect(at('fixing', { settings })).toMatchObject({ lane: 'operator', action: 'unclassified' });
  });
});
