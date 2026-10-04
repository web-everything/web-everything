/**
 * @file scripts/conveyor/__tests__/session-verdicts-io.test.mjs
 * @description The evidence resolver's IO shell, driven with injected fs / completion / gh ports.
 */
import { describe, it, expect } from 'vitest';
import { makeEvidenceResolver, prSignalFromGh, slugForRepoKey, ledgerRepoKeyFor, sessionOwnsEntry, MAX_PR_SIGNAL_LOOKUPS_PER_TICK } from '../session-verdicts-io.mjs';

const session = { id: '9eff9f54', sessionId: '9eff9f54-d1d3-44ff-883d-91d4072f17ca', cwd: '/w/wev-conflict-2130', name: 'review-148' };
const statMap = (m) => (p) => { if (p in m) return { mtimeMs: m[p] }; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

describe('makeEvidenceResolver', () => {
  it('finds the convention result file, the ledger expectedResultPath and the transcript mtime', () => {
    const followUps = [{ session: '9eff9f54', kind: 'review', target: 'plateau-app#148', expectedResultPath: '/ops/completions/review-148.json' }];
    const ev = makeEvidenceResolver({
      jobsDir: '/jobs', home: '/h', followUps, readCompletionFn: () => null,
      statFn: statMap({ '/jobs/review-148.result.md': 10, '/ops/completions/review-148.json': 20, '/h/.claude/projects/-w-wev-conflict-2130/9eff9f54-d1d3-44ff-883d-91d4072f17ca.jsonl': 30 }),
    })(session);
    expect(ev.resultFiles).toEqual([{ path: '/jobs/review-148.result.md', mtimeMs: 10 }, { path: '/ops/completions/review-148.json', mtimeMs: 20 }]);
    expect(ev.transcriptMtimeMs).toBe(30);
  });
  it('a missing file is simply absent, never an error', () => {
    const ev = makeEvidenceResolver({ jobsDir: '/jobs', home: '/h', statFn: statMap({}), readCompletionFn: () => null })(session);
    expect(ev.resultFiles).toEqual([]);
    expect(ev.transcriptMtimeMs).toBeNull();
  });
  it('reads the completion record, and a corrupt one is unknown', () => {
    const rec = { status: 'done', startedAt: 'a', updatedAt: 'b' };
    // #4306 — `sessionId` rides through (null when the record carries none) so the classifier can bind a
    // record to the row it belongs to; see `session-verdicts.mjs#finishedEvidence`'s own foreign-record check.
    expect(makeEvidenceResolver({ statFn: statMap({}), readCompletionFn: () => rec })(session).completion).toEqual({ ...rec, sessionId: null });
    expect(makeEvidenceResolver({ statFn: statMap({}), readCompletionFn: () => { throw new Error('corrupt'); } })(session).completion).toBeUndefined();
  });
  it('#4306 — a record that DOES carry a sessionId rides it through unchanged', () => {
    const rec = { status: 'done', startedAt: 'a', updatedAt: 'b', sessionId: 'sess-A' };
    expect(makeEvidenceResolver({ statFn: statMap({}), readCompletionFn: () => rec })(session).completion).toEqual(rec);
  });
  it('redispatchAttempts counts prior launches for the same target+kind in the ledger', () => {
    const followUps = [
      { session: 'aaaa1111', kind: 'review', target: 'plateau-app#148' },
      { session: '9eff9f54', kind: 'review', target: 'plateau-app#148' },
      { session: 'bbbb2222', kind: 'fix', target: 'plateau-app#148' },
    ];
    const ev = makeEvidenceResolver({ followUps, statFn: statMap({}), readCompletionFn: () => null })(session);
    expect(ev.redispatchAttempts).toBe(1);
  });
  it('no ledger entry → no attempt count (the classifier treats it as 0)', () => {
    expect(makeEvidenceResolver({ statFn: statMap({}), readCompletionFn: () => null })(session).redispatchAttempts).toBeUndefined();
  });
  it('asks the PR only for a review/fix session with a ledger target and no cheaper proof, and the repo comes from the ledger', () => {
    const calls = [];
    const prSignalFor = (pr, slug) => { calls.push([pr, slug]); return { reviewSignalAtMs: 5, what: 'label review:accepted' }; };
    const followUps = [{ session: '9eff9f54', kind: 'review', target: 'plateau-app#148' }];
    const evidenceFor = makeEvidenceResolver({ followUps, statFn: statMap({}), readCompletionFn: () => null, prSignalFor });
    expect(evidenceFor(session).prSignal).toEqual({ reviewSignalAtMs: 5, what: 'label review:accepted' });
    expect(calls).toEqual([['148', 'plateauapp/plateau-app']]);
    // no ledger target → repo is ambiguous → never guessed
    expect(evidenceFor({ ...session, id: 'zzzz', sessionId: 'zzzz-1' }).prSignal).toBeUndefined();
    // cheaper proof present → no gh call
    calls.length = 0;
    const withResult = makeEvidenceResolver({ followUps, jobsDir: '/j', statFn: statMap({ '/j/review-148.result.md': 1 }), readCompletionFn: () => null, prSignalFor });
    withResult(session);
    expect(calls).toEqual([]);
    // a conveyor session is never asked
    expect(makeEvidenceResolver({ followUps: [{ session: 'c1', kind: 'build', target: 'we#1' }], statFn: statMap({}), readCompletionFn: () => null, prSignalFor })({ id: 'c1', name: 'conveyor-1' }).prSignal).toBeUndefined();
    expect(calls).toEqual([]);
  });
  it('bounds PR lookups per pass', () => {
    let n = 0;
    const followUps = Array.from({ length: MAX_PR_SIGNAL_LOOKUPS_PER_TICK + 5 }, (_, i) => ({ session: `s${i}`, kind: 'review', target: `we#${i}` }));
    const evidenceFor = makeEvidenceResolver({ followUps, statFn: statMap({}), readCompletionFn: () => null, prSignalFor: () => { n++; return { reviewSignalAtMs: null }; } });
    followUps.forEach((e, i) => evidenceFor({ id: e.session, name: `review-${i}` }));
    expect(n).toBe(MAX_PR_SIGNAL_LOOKUPS_PER_TICK);
  });
});

describe('prSignalFromGh', () => {
  const exec = (labels, comments) => (_p, args) => (args[1].endsWith('/events') ? labels : comments);
  it('takes the newest review:* label or verdict comment', () => {
    const r = prSignalFromGh('148', 'plateauapp/plateau-app', { exec: exec('2026-09-20T12:00:00Z review:pending\n2026-09-20T13:00:00Z review:accepted\n', '2026-09-20T13:30:00Z\n') });
    expect(r).toEqual({ reviewSignalAtMs: Date.parse('2026-09-20T13:30:00Z'), what: 'verdict comment' });
  });
  it('none found → null signal; gh failure → null (unknown)', () => {
    expect(prSignalFromGh('1', 's', { exec: exec('', '') })).toEqual({ reviewSignalAtMs: null });
    expect(prSignalFromGh('1', 's', { exec: () => { throw new Error('gh: 404'); } })).toBeNull();
  });
});

describe('slugForRepoKey', () => {
  it('maps the constellation keys to owner/repo slugs and refuses unknown ones', () => {
    expect(slugForRepoKey('we')).toBe('web-everything/web-everything');
    expect(slugForRepoKey('plateau-app')).toBe('plateauapp/plateau-app');
    expect(slugForRepoKey('nope')).toBeNull();
    expect(slugForRepoKey('__proto__')).toBeNull();
  });
});

describe('ledgerRepoKeyFor — the repo a repo-less `review-<PR>` session was dispatched for', () => {
  const entry = (over = {}) => ({ session: '9eff9f54', kind: 'review', target: 'plateau-app#148', ...over });

  it('returns the repo key from the session\'s own ledger entry (matched on short id or full sessionId)', () => {
    expect(ledgerRepoKeyFor(session, [entry()], '148')).toBe('plateau-app');
    expect(ledgerRepoKeyFor(session, [entry({ session: session.sessionId })], 148)).toBe('plateau-app');
  });
  it('is null for no ledger, another session, another PR number, a target with no `#`, or an unknown repo key', () => {
    expect(ledgerRepoKeyFor(session, [], '148')).toBeNull();
    expect(ledgerRepoKeyFor(session, undefined, '148')).toBeNull();
    expect(ledgerRepoKeyFor(session, [entry({ session: 'other' })], '148')).toBeNull();
    expect(ledgerRepoKeyFor(session, [entry()], '149')).toBeNull();
    expect(ledgerRepoKeyFor(session, [entry({ target: 'plateau-app' })], '148')).toBeNull();
    expect(ledgerRepoKeyFor(session, [entry({ target: 'nope#148' })], '148')).toBeNull();
  });
  it('sessionOwnsEntry never matches an entry with no session', () => {
    expect(sessionOwnsEntry({ target: 'we#1' }, { id: undefined })).toBe(false);
  });
});
