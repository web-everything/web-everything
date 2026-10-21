import { describe, it, expect } from 'vitest';
import { guessFalseFindingCause, falseFindingsForPr, summarizeFalseFindings, collectFalseFindings, runFalseFindings } from '../coroner-false-findings.mjs';
import { buildOperatorRulingComment } from '../../lib/jury-core.mjs';
import { deriveFromCoroner } from '../perf-snapshot.mjs';
const window = { since: '2026-10-09T00:00:00Z', until: '2026-10-16T00:00:00Z' };
const at = '2026-10-12T00:00:00Z';
const ruling = (over = {}) => ({ version: 1, repo: 'o/r', pr: 5242, head: 'a'.repeat(40),
  rulings: [{ runId: 'r1', key: JSON.stringify(['judgeSecurity', 'scripts/settings/operator-task.json', 8, 'edge-load still ON by default']), result: 'not-real' }],
  actor: 'chalbert', channel: 'chat', reason: 'Prose was read instead of behaviour; edgeLoad and liveProof are false', at, clearerId: 's', ...over });
const comment = r => ({ body: buildOperatorRulingComment(r), createdAt: r.at, author: { login: 'chalbert' } });
const extract = comments => falseFindingsForPr({ repo: 'o/r', pr: 5242, prType: 'code', comments, window });
describe('false-finding cause fixtures', () => {
  it.each([
    ['config-prose', { pr: 5242, file: 'scripts/settings/operator-task.json', reason: 'Description says ON, resolved values false' }],
    ['stale-head-reraise', { pr: 5399, reason: 'stale re-raise: forged-author controls already present at 1445599' }],
    ['auto-policy-over-not-real', { pr: 4715, policyOverNotReal: true }],
    ['diff-only-recheck', { source: 'red-team', reason: 'The readers are not in the diff' }],
    ['card-only-probe', { source: 'red-team', prType: 'card-only', reason: 'Runtime implementation not in the diff' }],
    ['test-nit', { reason: 'No explicit planned test for truncated lease data' }],
    ['other', { reason: 'A deliberate design choice' }],
  ])('%s', (cause, fixture) => expect(guessFalseFindingCause(fixture)).toBe(cause));
  it('prefers a recorded cause and retains lens', () => {
    const r = ruling(); r.rulings[0].cause = 'other'; r.rulings[0].lens = 'judgeSecurity';
    expect(extract([comment(r)])[0]).toMatchObject({ cause: 'other', causeBasis: 'recorded', lens: 'judgeSecurity' });
  });
  it('recognizes policy re-blocks without counting the block as a new false finding', () => {
    const r = ruling(); const block = ruling({ actor: 'auto-policy', at: '2026-10-13T00:00:00Z' }); block.rulings[0].result = 'block';
    expect(extract([comment(r), comment(block)])).toMatchObject([{ cause: 'auto-policy-over-not-real' }]);
  });
  it('uses earlier heads as context, excludes outsiders and events outside the window', () => {
    const old = ruling({ at: '2026-10-01T00:00:00Z', head: 'b'.repeat(40) });
    expect(extract([comment(old), comment(ruling())])[0].cause).toBe('stale-head-reraise');
    expect(extract([{ ...comment(ruling()), author: { login: 'outsider' } }])).toEqual([]);
  });
  it('parses real red-team numbered items and keeps each recheck separate', () => {
    const body = '### Post-accept red team — 2 possible break(s)\n· red team codex/gpt-6.1-sol · re-check ok\n\n1. [not confirmed] (correctness, broken) `scripts/a.mjs:58` — Reads detached sidecars\n   - Scenario: detached snapshot\n   - Re-check: readers not in the diff\n2. [not confirmed] (security, degraded) `scripts/b.mjs:8` — Claim\n   - Re-check: design choice';
    expect(extract([{ body, createdAt: at, author: { login: 'web-everything' } }])).toMatchObject([
      { cause: 'diff-only-recheck', file: 'scripts/a.mjs', line: 58, seat: 'codex/gpt-6.1-sol' }, { cause: 'other', file: 'scripts/b.mjs' },
    ]);
  });
  it('includes stand-downs only with the explicit reproduction statement', () => {
    const c = body => ({ body, createdAt: at, author: { login: 'web-everything' } });
    expect(extract([c('conveyor fix — stood down: does not reproduce; already fixed on dbf2a9956'), c('conveyor fix — stood down: review hold')])).toMatchObject([{ source: 'fixer', cause: 'stale-head-reraise' }]);
  });
  it('caps examples per group and separates unmatched shadow findings', () => {
    const report = summarizeFalseFindings(Array.from({ length: 7 }, () => ({ cause: 'other', source: 'operator', prType: 'code' })), [{ cause: 'other' }]);
    expect(report.count).toBe(7); expect(report.byCause.other.examples).toHaveLength(3); expect(report.unconfirmed.count).toBe(1);
    expect(deriveFromCoroner({ errorRates: { falseFindings: report } })['falseFindings.count']).toMatchObject({ v: 7 });
  });
  it('uses updated PRs, complete comment reader, and marks failed/capped reads', () => {
    const gh = args => args.at(-1).includes('/files?') ? [[{ filename: 'backlog/a.md' }]] : [{ number: 5242, updated_at: at }];
    const report = collectFalseFindings(window, { repo: 'o/r', gh, readComments: () => [comment(ruling())], shadowRows: [
      { repo: 'o/r', pr: 5242, at, status: 'ok', lens: 'security', model: 'gemini', agyFindings: [{ matched: false }, { matched: true }] },
      { repo: 'o/r', at, status: 'voided', agyFindings: [{ matched: false }] },
    ] });
    expect(report).toMatchObject({ count: 1, byPrType: { 'card-only': { count: 1 } }, unconfirmed: { count: 1 } });
    expect(collectFalseFindings(window, { gh: () => { throw Error(); }, shadowRows: [] }).reads.failed).toBe(1);
  });
  it('supports arbitrary lens and seat strings without inherited object keys', () => {
    const report = summarizeFalseFindings([{ cause: 'other', lens: '__proto__', seat: 'constructor' }]);
    expect(report.byLens.__proto__.count).toBe(1);
    expect(report.bySeat.constructor.count).toBe(1);
  });
  it('marks capped discovery and unreadable complete threads explicitly', () => {
    const report = collectFalseFindings(window, { maxPages: 1, shadowRows: [],
      gh: args => args.at(-1).includes('/files?') ? [] : Array.from({ length: 100 }, (_, i) => ({ number: i + 1, updated_at: at })),
      readComments: () => { throw Error('unreadable'); },
    });
    expect(report.reads).toEqual({ prs: 100, failed: 100, truncated: true });
  });
  it('--since=last reads state without writing and passes the exact window', () => {
    let seen;
    const io = { readFileSync: () => JSON.stringify({ lastEnd: window.since }) };
    const result = runFalseFindings(['--since=last', '--json'], { io, now: window.until, collect: w => { seen = w; return { count: 0 }; } });
    expect(seen).toEqual({ ...window, since: new Date(window.since).toISOString() }); expect(JSON.parse(result.output).count).toBe(0);
    expect(() => runFalseFindings(['--since=nonsense'], { io })).toThrow(/ISO/);
  });
  it('--until bounds the window and is validated (ISO, since <= until <= now)', () => {
    let seen;
    const collect = w => { seen = w; return { count: 0 }; };
    const now = '2026-10-20T03:00:00.000Z';
    runFalseFindings(['--since', '2026-10-19T02:18:30.239Z', '--until', '2026-10-20T02:18:17.742Z', '--json'], { now, collect });
    expect(seen).toEqual({ since: '2026-10-19T02:18:30.239Z', until: '2026-10-20T02:18:17.742Z' });
    expect(() => runFalseFindings(['--since', window.since, '--until', 'nonsense'], { now, collect })).toThrow(/--until/);
    expect(() => runFalseFindings(['--since', '2026-10-19T00:00:00Z', '--until', '2026-10-18T00:00:00Z'], { now, collect })).toThrow(/--until/);
    expect(() => runFalseFindings(['--since', '2026-10-19T00:00:00Z', '--until', '2026-10-21T00:00:00Z'], { now, collect })).toThrow(/--until/);
  });
});
