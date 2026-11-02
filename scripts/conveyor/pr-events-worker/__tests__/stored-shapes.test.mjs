import { describe, it, expect } from 'vitest';
import { createEventLog, createMemoryStorage, validateStored } from '../core.mjs';
import { seedMirror, lookupInMirror, mirrorRows, applyDelta, refreshMirror } from '../../../lib/pr-facts.mjs';

const repo = 'o/r', now = 1_000_000;
const key = JSON.stringify([repo, 1]);
const check = { repo, prs: [1], sha: 'head', type: 'check_run', action: 'completed',
  id: 'delivery', at: new Date(now).toISOString(), seq: 0, name: 'ci', app: 'app', conclusion: 'success' };
const review = { sha: 'head', state: 'approved', action: 'submitted', seq: 0 };
const cases = [];
const bad = [null, {}, [], '1', -1, NaN];
function fieldCases(bucket, base, fields) {
  for (const [field, invalid] of Object.entries(fields)) for (const value of invalid)
    cases.push([`${bucket}.${field}=${JSON.stringify(value)}`, bucket, { ...base, [field]: value }]);
}
const row = { repo, number: 1, sha: 'head', draft: false, labels: [], labelChanges: {}, state: 'open',
  merged: false, review, checks: [check], suites: [], seq: 0, fields: { state: 0 }, updatedAt: now, evidenceLost: [] };
fieldCases('prs', row, {
  repo: bad, number: [...bad, 1.5], sha: [{}, [], 1], draft: [{}, [], 'false', 1],
  labels: [{}, 'labels', [1]], labelChanges: [null, [], 'changes', { hold: 'true' }],
  state: [{}, [], 1, 'unknown'], merged: [{}, [], 'false', 1], review: [{}, [], 'review', { ...review, seq: -1 }],
  checks: [null, {}, 'checks', [null], [{ ...check, prs: ['1'] }]], suites: [null, {}, 'suites', [check]],
  seq: [null, {}, [], -1, NaN, 'NaN', 1.5], fields: [null, [], 'fields', { state: -1 }, { state: 'NaN' }],
  updatedAt: bad, evidenceLost: [null, {}, 'lost', [null], [{}], [{ kind: 'unknown' }], [{ kind: 'checks', id: 1 }]],
});
fieldCases('checks', check, {
  repo: bad, prs: [null, {}, '1', ['1'], [0], [-1], [NaN], [Number.MAX_SAFE_INTEGER + 1]],
  sha: [{}, [], 1], type: [null, {}, [], 'unknown'], action: [null, {}, [], 1], id: [{}, [], 1],
  at: [null, {}, [], 'NaN', -1], seq: [null, {}, [], -1, NaN, 'NaN'],
  name: [{}, [], 1], app: [{}, [], 1], conclusion: [{}, [], 1],
});
const marker = { repo, number: 1, evidenceLost: [] };
fieldCases('evidenceLoss', { repo, sha: 'head', evidenceLost: [] }, { sha: [null, {}, [], '', -1, NaN] });
fieldCases('evidenceLoss', marker, { repo: bad, number: bad,
  evidenceLost: [null, {}, [], 'lost', [null], [{}], [{ kind: 'unknown' }], [{ kind: 'labels', id: {} }]].filter((v) => !Array.isArray(v) || v.length) });
const tombstone = { repo, number: 1, state: 'closed', merged: false, closedSeq: 0, prunedAt: now };
fieldCases('tombstones', tombstone, { repo: bad, number: bad, state: [null, {}, [], 'open'],
  merged: [{}, [], 'false'], closedSeq: [null, {}, [], -1, NaN, 'NaN'], prunedAt: bad, evidenceLost: [null, {}, [{}]] });
for (const value of [null, {}, '1', ['1'], [0], [-1], [NaN]]) cases.push(['shas value', 'shas', value]);
fieldCases('repoEvents', { repo, lastEventAt: now }, { repo: bad, lastEventAt: bad });
fieldCases('repoImports', { repo, listed: [1], others: [0] }, { repo: bad,
  listed: [null, {}, '1', ['1'], [-1]], others: [null, {}, '1', [-1], ['NaN']] });
const boot = { repo, status: 'complete', baseCursor: 0, cursor: 0, importId: 'seed', at: now };
fieldCases('bootstrap', boot, { repo: bad, status: bad, baseCursor: [null, {}, [], -1, 'NaN'],
  cursor: [null, {}, [], -1, 'NaN'], importId: [null, {}, [], 1, -1, NaN, 'bad id'], at: bad });
fieldCases('imports', { input: JSON.stringify({ repo, importId: 'seed', baseCursor: 0, status: 'complete', prs: [] }), result: boot },
  { input: bad, result: [null, {}, [], 'result', { ...boot, status: 'unknown' }] });
const coverage = { partial: true, historyComplete: false, observedSince: 1, retainedReplayBoundary: null };
fieldCases('coverage', coverage, { partial: bad, historyComplete: bad,
  observedSince: [null, {}, [], -1, NaN, 'NaN'], retainedReplayBoundary: [{}, [], -1, 'NaN'] });
for (const bucket of ['prs', 'checks', 'evidenceLoss', 'tombstones', 'repoEvents', 'repoImports', 'bootstrap', 'imports', 'coverage']) {
  for (const value of [null, {}, [], '1', -1, NaN]) cases.push([`${bucket} missing required keys`, bucket, value]);
}

for (const [bucket, base, required] of [
  ['prs', row, ['repo', 'number']], ['checks', check, ['repo', 'prs', 'type']],
  ['evidenceLoss', marker, ['repo', 'evidenceLost', 'number']],
  ['tombstones', tombstone, ['repo', 'number', 'closedSeq', 'prunedAt']],
  ['repoEvents', { repo, lastEventAt: now }, ['repo', 'lastEventAt']],
  ['repoImports', { repo, listed: [1], others: [] }, ['repo', 'listed', 'others']],
  ['bootstrap', boot, ['repo', 'status', 'baseCursor']],
  ['imports', { input: '{}', result: boot }, ['input', 'result']],
  ['coverage', coverage, Object.keys(coverage)],
]) for (const field of required) {
  const value = { ...base }; delete value[field];
  cases.push([`${bucket} missing ${field}`, bucket, value]);
}
for (const field of Object.keys(review)) for (const invalid of [{}, [], -1])
  cases.push([`review.${field}`, 'prs', { ...row, review: { ...review, [field]: invalid } }]);

describe('stored shapes fail closed through the Worker and seeded mirror', () => {
  it.each(cases)('%s', (_name, bucket, value) => {
    const storage = createMemoryStorage(), log = createEventLog(storage);
    log.bootstrap({ repo, importId: 'seed', baseCursor: 0, status: 'complete', prs: [
      { number: 1, sha: 'head', draft: false, labels: [], state: 'open' },
    ] }, now);
    log.touch(now);
    const projectionKey = bucket === 'shas' ? JSON.stringify([repo, 'head'])
      : ['repoEvents', 'repoImports', 'bootstrap'].includes(bucket) ? repo
      : bucket === 'imports' ? JSON.stringify([repo, 'seed']) : key;
    if (bucket === 'coverage') storage.setMeta('coverage', JSON.stringify(value));
    else storage.putProjection(bucket, projectionKey, value);
    const body = log.readPrs(null, 100, now);
    expect(body.repos[repo]?.coverage).toBe(false);
    expect(body.truncated.malformed).toBeGreaterThan(0);
    const mirror = seedMirror({ repo, body, nowMs: now });
    expect(lookupInMirror(mirror, { number: 1, nowMs: now }).facts).toBeNull();
  });
});


it('keeps nullable observations and canonical sequence strings valid', () => {
  expect(validateStored('prs', { ...row, sha: null, draft: null, labels: null, merged: null,
    review: null, state: null, seq: '1', fields: { state: '0' } })).toBe(true);
  expect(validateStored('shas', [])).toBe(true);
  expect(validateStored('sequence', '1')).toBe(true);
});

it.each(cases.filter(([, bucket]) => !['coverage', 'bootstrap', 'imports'].includes(bucket)))(
  'persisted mirror refuses %s before and after delta folding', (_name, bucket, value) => {
    const storage = createMemoryStorage(), log = createEventLog(storage);
    log.bootstrap({ repo, importId: 'seed', baseCursor: 0, status: 'complete', prs: [
      { number: 1, sha: 'head', draft: false, labels: [], state: 'open' },
    ] }, now);
    log.touch(now);
    const mirror = seedMirror({ repo, body: log.readPrs(null, 100, now), nowMs: now });
    mirror.buckets[bucket] ||= {};
    mirror.buckets[bucket][bucket === 'shas' ? JSON.stringify([repo, 'head']) : key] = value;
    expect(() => mirrorRows(mirror)).toThrow(/malformed/);
    expect(lookupInMirror(mirror, { number: 1, nowMs: now }).facts).toBeNull();
    expect(() => applyDelta(mirror, [])).toThrow(/malformed/);
  });

it.each(['full', 'delta'])('refuses a malformed PR draft during %s refresh', async (mode) => {
  const storage = createMemoryStorage(), log = createEventLog(storage);
  log.bootstrap({ repo, importId: 'seed', baseCursor: 0, status: 'complete', prs: [
    { number: 1, sha: 'head', draft: false, labels: [], state: 'open' },
  ] }, now);
  log.touch(now);
  const body = log.readPrs(null, 100, now);
  const previous = mode === 'delta' ? seedMirror({ repo, body, nowMs: now }) : null;
  const response = mode === 'full' ? { ...body, prs: [{ ...body.prs[0], draft: 'false' }] }
    : { cursor: 1, events: [{ repo, prs: [1], seq: 1, type: 'pull_request', action: 'synchronize', draft: 'false' }] };
  const result = await refreshMirror(previous, { repo, url: 'https://worker.test', token: 'read', nowMs: now,
    fetchImpl: async () => new Response(JSON.stringify(response)) });
  expect(result.mode).toBe('failed');
  expect(lookupInMirror(result.mirror, { number: 1, nowMs: now }).facts).toBeNull();
});
