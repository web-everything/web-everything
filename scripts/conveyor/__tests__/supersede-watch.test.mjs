import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSupersededStandDownComment } from '../stand-down.mjs';
import { setMarkdownLoader } from '../supersede-rule.mjs';
import { runSupersedeWatch, formatSupersedeLines, defaultReadMergedPrs, defaultReadOpenNumbers, defaultReadBodyEdit } from '../supersede-watch.mjs';
import { runTickAllRepos, runSupersedeAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/supersede/pr4522-2026-10-09.json'), 'utf8'));
const repo = 'web-everything/web-everything';
const legacyNow = Date.parse('2026-10-10T00:00:00Z');
const sourceSnapshot = (m = fixture.merged) => ({ ...m, id: `PR_${m.number}`,
  author: { login: 'web-everything' }, headRefOid: 'a'.repeat(40), updatedAt: '2026-10-09T06:00:00Z',
  lastEditedAt: null, editor: null });
const targetSnapshot = (p = fixture.open) => ({ ...p, id: `PR_${p.number}`, headRefOid: 'b'.repeat(40) });
const hold = { pr: 4522, by: 4532, mergedAt: '2026-10-09T01:52:13Z' };
const fakes = () => { const options = ({ repo, now: legacyNow, settings: { hold: true, lookbackDays: 14 },
  readMergedPrs: vi.fn(() => [fixture.merged]), readOpenNumbers: vi.fn(() => [4522, 1]),
  readPr: vi.fn(() => ({ ...targetSnapshot(), state: 'OPEN' })), postHold: vi.fn(() => ({ ok: true, labeled: true })),
  readBodyEdit: vi.fn(() => sourceSnapshot()) });
  options.postHold.mockImplementation(({ hold: h }) => {
    options.readPr.mockReturnValue({ ...targetSnapshot({ number: h.pr, state: 'OPEN', labels: [], comments: [] }),
      comments: [{ author: { login: 'web-everything' }, body: buildSupersededStandDownComment(h) }] });
    return { ok: true, labeled: true };
  });
  return options;
};

describe('runSupersedeWatch', () => {
  it.each([true, false])('plans the real incident with apply=%s', (apply) => {
    const opts = fakes();
    const result = runSupersedeWatch({ ...opts, apply });
    expect(result.holds).toEqual([hold]);
    expect(opts.readPr).toHaveBeenCalledWith({ repo, pr: 4522 });
    expect(opts.postHold).toHaveBeenCalledTimes(apply ? 1 : 0);
    if (apply) expect(opts.postHold).toHaveBeenCalledWith({ repo, hold });
    expect(result.applied).toEqual(apply ? [{ ...hold, ok: true, labeled: true }] : []);
  });
  it('rechecks whether the candidate is still open', () => {
    const opts = fakes();
    opts.readPr.mockReturnValue({ ...targetSnapshot(), state: 'CLOSED' });
    const result = runSupersedeWatch(opts);
    expect(result).toMatchObject({ holds: [], applied: [] });
    expect(opts.postHold).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('blocked');
  });
  it.each([undefined, null, 42, {}])('blocks dispatch when a candidate state is unreadable: %j', state => {
    const opts = fakes();
    opts.readPr.mockReturnValue({ ...fixture.open, state });
    const result = runSupersedeWatch(opts);
    expect(result).toMatchObject({ blocked: true, error: expect.stringMatching(/unreadable/), holds: [], applied: [] });
    expect(opts.postHold).not.toHaveBeenCalled();
    expect(formatSupersedeLines({ repos: [result] }).join('')).toContain('retried next tick');
  });
  // PR #4560 advisory (security): the marker is read only from a trusted author's merged PR.
  it('an untrusted merged PR author plans no hold, reads no candidate and posts nothing', () => {
    const opts = fakes();
    opts.readMergedPrs.mockReturnValue([{ ...fixture.merged, author: { login: 'rando' } }]);
    const result = runSupersedeWatch({ ...opts, apply: true });
    expect(result.holds).toEqual([]);
    expect(opts.readPr).not.toHaveBeenCalled();
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it('reads the body edit only for a trusted-author PR that carries a marker', () => {
    const opts = fakes();
    const noMarker = { ...fixture.merged, number: 7, body: 'Fixes #1' };
    const outsider = { ...fixture.merged, number: 8, author: { login: 'rando' } };
    opts.readMergedPrs.mockReturnValue([fixture.merged, noMarker, outsider]);
    runSupersedeWatch(opts);
    expect(opts.readBodyEdit).toHaveBeenCalledTimes(2);
    expect(opts.readBodyEdit).toHaveBeenCalledWith({ repo, pr: 4532 });
  });
  it('does not read a body edit when no target of the marker is open', () => {
    const opts = fakes();
    opts.readOpenNumbers.mockReturnValue([1]);
    expect(runSupersedeWatch(opts).holds).toEqual([]);
    expect(opts.readBodyEdit).not.toHaveBeenCalled();
  });
  it('reports failed edit reads so a persistent failure is not silent', () => {
    const opts = fakes();
    opts.readBodyEdit.mockImplementation(() => { throw new Error('graphql denied'); });
    const result = runSupersedeWatch(opts);
    expect(result).toMatchObject({ holds: [], bodyEditFailures: 1 });
    expect(result.error).toBeUndefined();
    expect(formatSupersedeLines({ repos: [result] }).join('\n')).toMatch(/1 merged-PR body-edit read\(s\) failed/);
    expect(runSupersedeWatch(fakes())).not.toHaveProperty('bodyEditFailures');
  });
  it('a body rewritten after the merge by an outsider plans no hold, reads no candidate and posts nothing', () => {
    const opts = fakes();
    opts.readBodyEdit.mockReturnValue({ ...sourceSnapshot(), lastEditedAt: '2026-10-09T05:00:00Z', editor: { login: 'rando' } });
    const result = runSupersedeWatch({ ...opts, apply: true });
    expect(result.holds).toEqual([]);
    expect(opts.readPr).not.toHaveBeenCalled();
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it('a body edited after the merge by the operator still holds', () => {
    const opts = fakes();
    opts.readBodyEdit.mockReturnValue({ ...sourceSnapshot(), lastEditedAt: '2026-10-09T05:00:00Z', editor: { login: 'chalbert' } });
    expect(runSupersedeWatch(opts).holds).toEqual([hold]);
  });
  it('a failed edit read ignores only that PR and does not fail the pass', () => {
    const opts = fakes();
    const other = { ...fixture.merged, number: 4533, body: 'Supersedes: #1', mergedAt: '2026-10-09T03:00:00Z' };
    opts.readMergedPrs.mockReturnValue([fixture.merged, other]);
    opts.readBodyEdit.mockImplementation(({ pr }) => { if (pr === 4532) throw new Error('graphql down'); return sourceSnapshot(other); });
    opts.readPr.mockImplementation(({ pr }) => targetSnapshot({ number: pr, state: 'OPEN', labels: [], comments: [] }));
    const result = runSupersedeWatch(opts);
    expect(result.error).toBeUndefined();
    expect(result.holds).toEqual([{ pr: 1, by: 4533, mergedAt: '2026-10-09T03:00:00Z' }]);
  });
  it('defaultReadBodyEdit maps the GraphQL answer and rejects a missing PR', () => {
    const answer = (pullRequest) => vi.fn(() => JSON.stringify({ data: { repository: { pullRequest } } }));
    expect(defaultReadBodyEdit({ repo, pr: 4532, exec: answer({ lastEditedAt: '2026-10-09T01:11:15Z', editor: { login: 'chalbert' } }) }))
      .toEqual({ lastEditedAt: '2026-10-09T01:11:15Z', editor: { login: 'chalbert' } });
    expect(defaultReadBodyEdit({ repo, pr: 4532, exec: answer({ lastEditedAt: null, editor: null }) })).toEqual({ lastEditedAt: null, editor: null });
    expect(() => defaultReadBodyEdit({ repo, pr: 4532, exec: answer(null) })).toThrow(/no pull request #4532/);
  });
  it('reads every page of open and merged PRs past the 200 limit', () => {
    const all = Array.from({ length: 203 }, (_, i) => ({ number: i + 1, body: '',
      state: 'closed', merged_at: '2026-10-09T01:52:13Z', updated_at: '2026-10-09T02:00:00Z',
      user: { login: 'web-everything[bot]' } }));
    const exec = vi.fn((_cmd, args) => {
      expect(args[0]).toBe('api');
      const url = new URL(args[1], 'https://api.github.com');
      expect(url.searchParams.get('per_page')).toBe('100');
      const page = Number(url.searchParams.get('page'));
      return JSON.stringify(all.slice((page - 1) * 100, page * 100));
    });
    expect(defaultReadOpenNumbers({ repo, exec })).toEqual(all.map(p => p.number));
    const merged = defaultReadMergedPrs({ repo, lookbackDays: 14,
      now: Date.parse('2026-10-10T00:00:00Z'), exec });
    expect(merged.map(p => p.number)).toEqual(all.map(p => p.number));
    expect(merged[0]).toMatchObject({ author: { login: 'web-everything[bot]' },
      state: 'MERGED', mergedAt: all[0].merged_at });
    expect(exec).toHaveBeenCalledTimes(6);
  });
  it('stops merged pagination at an old updated page, not an old merge updated recently', () => {
    const recent = '2026-10-09T00:00:00Z', old = '2026-01-01T00:00:00Z';
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
      number: i + 1, body: null, state: 'closed', merged_at: i === 0 ? old : recent, updated_at: recent, user: { login: 'bot' },
    })))).mockReturnValueOnce(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
      number: i + 101, body: '', state: 'closed', merged_at: old, updated_at: old, user: { login: 'bot' },
    }))));
    const rows = defaultReadMergedPrs({ repo, lookbackDays: 14,
      now: Date.parse('2026-10-10T00:00:00Z'), exec });
    expect(rows).toHaveLength(99);
    expect(exec).toHaveBeenCalledTimes(2);
  });
  it.each([defaultReadOpenNumbers, defaultReadMergedPrs])('refuses incomplete lists at the page cap with an operator fallback (%s)', read => {
    const exec = vi.fn(() => JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
      number: i + 1, body: '', state: 'closed', user: { login: 'bot' }, merged_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z',
    }))));
    expect(() => read({ repo, exec, lookbackDays: 14, now: Date.parse('2026-10-10T00:00:00Z') }))
      .toThrow(/page cap.*operator/i);
    expect(exec.mock.calls.length).toBeLessThanOrEqual(100);
  });
  it.each([{ body: undefined }, { body: 42 }, { user: undefined }, { user: {} }])('rejects incomplete merged evidence and blocks dispatch: %j', fields => {
    const row = { number: 4532, body: '', state: 'closed', user: { login: 'bot' },
      merged_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z', ...fields };
    const readMergedPrs = () => defaultReadMergedPrs({ repo, lookbackDays: 14,
      now: Date.parse('2026-10-10T00:00:00Z'), exec: () => JSON.stringify([row]) });
    expect(readMergedPrs).toThrow(/unreadable/);
    const opts = { ...fakes(), readMergedPrs };
    expect(runSupersedeWatch(opts)).toMatchObject({ blocked: true, error: expect.stringMatching(/unreadable/), holds: [] });
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it.each([null, { message: 'not a list' }])('rejects an unreadable list: %j', answer => {
    for (const read of [defaultReadOpenNumbers, defaultReadMergedPrs]) {
      expect(() => read({ repo, lookbackDays: 14, exec: () => JSON.stringify(answer) })).toThrow();
    }
  });
  it('a GraphQL answer with errors or missing fields counts as a failed read', () => {
    for (const [pullRequest, errors] of [
      [{ lastEditedAt: null, editor: null }, [{ message: 'partial failure' }]],
      [null, undefined], [{ editor: null }, undefined], [{ lastEditedAt: null }, undefined],
    ]) {
      const exec = () => JSON.stringify({ data: { repository: { pullRequest } }, errors });
      expect(() => defaultReadBodyEdit({ repo, pr: 4532, exec })).toThrow();
    }
  });
  it.each(['returned', 'thrown'])('a hold that fails to apply is reported, not dropped (%s)', mode => {
    const opts = fakes();
    opts.postHold.mockImplementation(() => {
      if (mode === 'thrown') throw new Error('denied');
      return { ok: false, error: 'denied' };
    });
    const result = runSupersedeWatch(opts);
    expect(result).toMatchObject({ holds: [hold], applied: [{ ...hold, ok: false, error: 'denied' }] });
    expect(result).not.toHaveProperty('error');
    expect(result).not.toHaveProperty('blocked');
    expect(formatSupersedeLines({ repos: [result] }).join('')).toContain('FAILED (denied)');
  });
  it('posts nothing on a second pass when the thread already holds', () => {
    const opts = fakes();
    expect(runSupersedeWatch(opts).applied).toHaveLength(1);
    opts.readPr.mockReturnValue({ ...targetSnapshot(), state: 'OPEN', comments: [
      ...fixture.open.comments, { author: { login: 'web-everything' },
        body: buildSupersededStandDownComment(hold) },
    ] });
    expect(runSupersedeWatch(opts).applied).toEqual([]);
    expect(opts.postHold).toHaveBeenCalledTimes(1);
  });
  it('off skips every read and write', () => {
    const opts = fakes();
    expect(runSupersedeWatch({ ...opts, settings: { hold: false } })).toMatchObject({ skipped: expect.any(String), holds: [] });
    for (const fn of [opts.readMergedPrs, opts.readOpenNumbers, opts.readPr, opts.postHold]) expect(fn).not.toHaveBeenCalled();
  });
  it('reports read failure without throwing', () => {
    const opts = fakes();
    opts.readMergedPrs.mockImplementation(() => { throw new Error('read unavailable'); });
    expect(runSupersedeWatch(opts)).toMatchObject({ error: 'read unavailable', holds: [] });
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it.each([
    [[{ ...hold, ok: true, labeled: true }], 'stood down, labelled superseded'],
    [[{ ...hold, ok: false, error: 'denied' }], 'FAILED (denied)'],
    [[], 'planned (dry run)'],
  ])('formats posting outcomes %j', (applied, text) => {
    const lines = formatSupersedeLines({ repos: [{ repo, holds: [hold], applied }] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(text);
    expect(lines[0]).toContain('PR #4522 — superseded by merged #4532');
    expect(lines[0]).toContain('closing needs an operator decision');
  });
});

const noopDispatch = () => ({ dispatched: [], refusals: [] });
const noopRecovery = () => ({ dispatch: [], refusals: [], applied: [] });
const tickFakes = () => ({ repos: [repo], fixTick: noopDispatch, ciHealTick: async () => noopDispatch(),
  hungCiTick: noopRecovery, mainRedRebaseTick: noopRecovery, missingRunTick: noopRecovery,
  promoteDraftTick: noopDispatch, notesTick: () => ({ notes: [], prsByNumber: new Map() }),
  awaitVerifyTick: async () => ({ rows: [] }), stuckFixerTick: async () => ({ rows: [] }), notesDryRun: true });

describe('supersede daemon wiring', () => {
  it('posts the hold before the fix half reads the repo', async () => {
    const order = [];
    const supersedeTick = vi.fn(({ repo: slug }) => { order.push(`supersede:${slug}`); return { repo: slug, holds: [hold], applied: [] }; });
    const fixTick = ({ repo: slug }) => { order.push(`fix:${slug}`); return noopDispatch(); };
    const result = await runTickAllRepos({ ...tickFakes(), supersedeTick, fixTick });
    expect(order).toEqual([`supersede:${repo}`, `fix:${repo}`]);
    expect(supersedeTick).toHaveBeenCalledWith({ repo });
    expect(result.supersede.repos[0].holds).toEqual([hold]);
  });
  it.each(['load', 'parse'])('blocks dispatch when markdown-it cannot %s; retries after repair', async (failure) => {
    const fixTick = vi.fn(noopDispatch);
    const ciHealTick = vi.fn(async () => noopDispatch());
    setMarkdownLoader(() => {
      if (failure === 'load') throw new Error('markdown-it unavailable');
      return class { disable() { return this; } parse() { throw new Error('markdown-it unavailable'); } };
    });
    const options = { ...tickFakes(), fixTick, ciHealTick, supersedeTick: () => runSupersedeWatch(fakes()) };
    try {
      const result = runSupersedeWatch(fakes());
      expect(result).toMatchObject({ blocked: true, error: 'markdown-it unavailable' });
      expect(formatSupersedeLines({ repos: [result] }).join('')).toContain('dispatch blocked');
      await expect(runTickAllRepos(options)).rejects.toThrow('markdown-it unavailable');
      expect(fixTick).not.toHaveBeenCalled();
      expect(ciHealTick).not.toHaveBeenCalled();
    } finally { setMarkdownLoader(); }
    await runTickAllRepos(options);
    expect(fixTick).toHaveBeenCalledTimes(1);
    expect(ciHealTick).toHaveBeenCalledTimes(1);
  });
  it('never invokes the real supersede watcher in an injected test tick', async () => {
    expect((await runTickAllRepos(tickFakes())).supersede).toEqual({ repos: [] });
  });
  it('isolates repo failures', () => {
    const tick = vi.fn(({ repo: slug }) => { if (slug === 'bad') throw new Error('offline'); return { repo: slug, holds: [hold], applied: [] }; });
    expect(runSupersedeAllRepos({ repos: ['bad', repo], tick }).repos).toEqual([
      { repo: 'bad', holds: [], applied: [], error: 'offline' }, { repo, holds: [hold], applied: [] },
    ]);
  });
});

// All hardening evidence is synthetic; no host, checkout discovery or subprocess reads.
const hardNow = Date.parse('2026-11-26T12:00:00Z');
const hardSource = () => ({ number: 20, id: 'PR_20', body: 'Supersedes: #10', state: 'MERGED',
  author: { login: 'web-everything' }, mergedAt: '2026-11-25T10:00:00Z',
  updatedAt: '2026-11-25T11:00:00Z', lastEditedAt: null, editor: null, headRefOid: 'a'.repeat(40) });
const hardTarget = () => ({ number: 10, id: 'PR_10', state: 'OPEN', headRefOid: 'b'.repeat(40), labels: [], comments: [] });
const hardOptions = () => ({ repo: 'fixture/project', now: hardNow, settings: { hold: true, lookbackDays: 14 },
  readMergedPrs: vi.fn(() => [hardSource()]), readOpenNumbers: vi.fn(() => [10]),
  readBodyEdit: vi.fn(() => hardSource()), readPr: vi.fn(() => hardTarget()),
  postHold: vi.fn(() => ({ ok: true, labeled: true })) });

describe('bound supersede evidence', () => {
  it('199 unique candidates from a claimed 200-item mutable listing reports incomplete and supersedes nothing', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ number: i + 1, state: 'open' }));
    rows[100] = rows[99];
    const exec = vi.fn((_cmd, args) => {
      if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequests: { totalCount: 200 } } } });
      const page = Number(new URL(args[1], 'https://fixture.invalid').searchParams.get('page'));
      return JSON.stringify(rows.slice((page - 1) * 100, page * 100));
    });
    const opts = hardOptions();
    opts.readOpenNumbers = () => defaultReadOpenNumbers({ repo: opts.repo, exec, requireComplete: true });
    const result = runSupersedeWatch(opts);
    expect(result).toMatchObject({ blocked: true, holds: [], applied: [], error: expect.stringMatching(/incomplete.*retry/i) });
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it.each(['UNKNOWN', '', 'open-ish'])('unknown candidate state refuses: %j', state => {
    const opts = hardOptions();
    opts.readPr.mockReturnValue({ ...hardTarget(), state });
    expect(runSupersedeWatch(opts)).toMatchObject({ blocked: true, holds: [] });
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it.each(['', 'yesterday', '2026-02-30T00:00:00Z', '2027-01-01T00:00:00Z', 42])('invalid lastEditedAt refuses: %j', lastEditedAt => {
    const opts = hardOptions();
    opts.readBodyEdit.mockReturnValue({ ...hardSource(), lastEditedAt, editor: { login: 'web-everything' } });
    expect(runSupersedeWatch(opts).holds).toEqual([]);
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it.each([
    { body: 'Supersedes: #99' }, { updatedAt: '2026-11-25T11:01:00Z' },
    { number: 21 }, { id: 'OTHER' }, { state: 'CLOSED' }, { headRefOid: 'c'.repeat(40) },
    { author: { login: 'rando' } }, { lastEditedAt: undefined },
  ])('mismatched body version, identity, state or author refuses: %j', fields => {
    const opts = hardOptions();
    opts.readBodyEdit.mockReturnValue({ ...hardSource(), ...fields });
    expect(runSupersedeWatch(opts).holds).toEqual([]);
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it('evidence-changes-before-write refuses a concurrent edit', () => {
    const opts = hardOptions();
    opts.readBodyEdit.mockReturnValueOnce(hardSource()).mockReturnValue({ ...hardSource(), body: 'withdrawn' });
    expect(runSupersedeWatch(opts).applied.every(a => a.ok === false)).toBe(true);
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it.each([{ number: 99 }, { headRefOid: 'c'.repeat(40) }, { state: 'CLOSED' }])('moved candidate refuses: %j', fields => {
    const opts = hardOptions();
    opts.readPr.mockReturnValueOnce(hardTarget()).mockReturnValue({ ...hardTarget(), ...fields });
    runSupersedeWatch(opts);
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it('effect read-back must observe the trusted hold before recording completion', () => {
    const opts = hardOptions();
    const result = runSupersedeWatch(opts);
    expect(opts.postHold).toHaveBeenCalledTimes(1);
    expect(result.applied).toEqual([expect.objectContaining({ ok: false, error: expect.stringMatching(/read-back.*retry/i) })]);
  });
  it('stable bound snapshot stores candidate identity and version after trusted read-back', () => {
    const opts = hardOptions();
    opts.postHold.mockImplementation(() => {
      opts.readPr.mockReturnValue({ ...hardTarget(), comments: [{ author: { login: 'web-everything' },
        body: buildSupersededStandDownComment({ pr: 10, by: 20, mergedAt: hardSource().mergedAt }) }] });
      return { ok: true, labeled: true };
    });
    const result = runSupersedeWatch(opts);
    expect(result.applied).toEqual([expect.objectContaining({ ok: true })]);
    expect(result.evidence).toEqual([expect.objectContaining({ candidateId: 'PR_10', sourceId: 'PR_20', version: hardSource().updatedAt })]);
  });
});

describe('complete listing replay', () => {
  const replay = ({ count = 200, change = false, omit = false } = {}) => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ number: i + 1, state: 'open',
      updated_at: new Date(hardNow - i * 1000).toISOString() }));
    let reads = 0;
    const exec = vi.fn((_cmd, args) => {
      if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequests: { totalCount: count } } } });
      const page = Number(new URL(args[1], 'https://fixture.invalid').searchParams.get('page'));
      reads++;
      const data = omit ? rows.slice(0, 199) : rows;
      const batch = data.slice((page - 1) * 100, page * 100).map(r => ({ ...r }));
      if (change && page === 2) batch[0] = { ...rows[0], updated_at: new Date(hardNow).toISOString() };
      return JSON.stringify(batch);
    });
    return { exec, rows, get reads() { return reads; } };
  };
  it('missing unique row against the claimed total refuses with operator retry', () => {
    const { exec } = replay({ omit: true });
    expect(() => defaultReadOpenNumbers({ repo: 'fixture/project', exec, requireComplete: true })).toThrow(/incomplete.*retry/i);
  });
  it('two pages with an update between reads report incomplete and zero writes', () => {
    const { exec } = replay({ change: true });
    const opts = hardOptions();
    opts.readOpenNumbers = () => defaultReadOpenNumbers({ repo: opts.repo, exec, requireComplete: true });
    const result = runSupersedeWatch(opts);
    expect(result).toMatchObject({ blocked: true, holds: [], applied: [] });
    expect(formatSupersedeLines({ repos: [result] }).join('')).toMatch(/incomplete/);
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it('stable complete two-page snapshot returns all expected candidates', () => {
    const { exec, rows } = replay();
    expect(defaultReadOpenNumbers({ repo: 'fixture/project', exec, requireComplete: true })).toEqual(rows.map(r => r.number));
  });
  it('bound snapshot producer requests body, identity, state and edit version together', () => {
    const exec = vi.fn(() => JSON.stringify({ data: { repository: { pullRequest: hardSource() } } }));
    expect(defaultReadBodyEdit({ repo: 'fixture/project', pr: 20, exec })).toEqual(hardSource());
    const query = exec.mock.calls[0][1].find(arg => arg.startsWith('query='));
    for (const field of ['id', 'number', 'body', 'state', 'author', 'mergedAt', 'updatedAt', 'headRefOid', 'lastEditedAt', 'editor']) {
      expect(query).toMatch(new RegExp('\\b' + field + '\\b'));
    }
  });
  it('untrusted read-back marker never records a completed effect', () => {
    const opts = hardOptions();
    opts.postHold.mockImplementation(() => {
      opts.readPr.mockReturnValue({ ...hardTarget(), comments: [{ author: { login: 'rando' },
        body: buildSupersededStandDownComment({ pr: 10, by: 20, mergedAt: hardSource().mergedAt }) }] });
      return { ok: true, labeled: true };
    });
    expect(runSupersedeWatch(opts).applied).toEqual([expect.objectContaining({ ok: false })]);
  });
});

describe('closed completeness paths', () => {
  it.each([null, undefined, -1, '200', 1.5])('missing or unreadable inventory count blocks the default authority: %j', totalCount => {
    const postHold = vi.fn();
    const exec = routeExec({ open: [{ number: 10 }], closed: [probeClosed()], totalCount });
    const result = runSupersedeWatch({ repo: 'fixture/project', now: hardNow,
      settings: { hold: true, lookbackDays: 14 }, exec, postHold });
    expect(result).toMatchObject({ blocked: true, holds: [], applied: [], error: expect.stringMatching(/incomplete.*retry/) });
    expect(postHold).not.toHaveBeenCalled();
    expect(proofCalls(exec)).toHaveLength(1);
    expect(exec.mock.calls.at(-1)[1][1]).toBe('graphql');
  });
  it('oversized proved inventory refuses with operator inspection and retry', () => {
    const exec = vi.fn(() => JSON.stringify({ data: { repository: { pullRequests: { totalCount: 10001 } } } }));
    expect(() => defaultReadOpenNumbers({ repo: 'fixture/project', exec, requireComplete: true }))
      .toThrow(/page cap.*operator.*retry/);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('changed count across pages refuses even when every returned identity is unique', () => {
    let counts = 0;
    const exec = vi.fn((_cmd, args) => args[1] === 'graphql'
      ? JSON.stringify({ data: { repository: { pullRequests: { totalCount: ++counts } } } })
      : JSON.stringify([{ number: 10, state: 'open' }]));
    expect(() => defaultReadOpenNumbers({ repo: 'fixture/project', exec, requireComplete: true })).toThrow(/incomplete.*retry/);
  });
  it('a read throwing before the write refuses the effect', () => {
    const opts = hardOptions();
    opts.readBodyEdit.mockReturnValueOnce(hardSource()).mockImplementation(() => { throw Error('read unavailable'); });
    expect(runSupersedeWatch(opts).applied).toEqual([expect.objectContaining({ ok: false, error: 'read unavailable' })]);
    expect(opts.postHold).not.toHaveBeenCalled();
  });
});

// Synthetic API rows and injected IO only: these tests never discover a checkout or host state.
function probeClosed(number = 20, body = 'Supersedes: #10') {
  return { number, state: 'closed', body, updated_at: hardSource().updatedAt,
    merged_at: hardSource().mergedAt, user: { login: 'web-everything' } };
}
function routeExec(spec) {
  return vi.fn((_file, args) => {
    if (args[1] !== 'graphql') {
      const url = new URL(args[1], 'https://fixture.invalid');
      const state = url.searchParams.get('state');
      const page = Number(url.searchParams.get('page'));
      const override = spec.rest?.(state, page);
      if (override !== undefined) return override;
      return JSON.stringify((state === 'open' ? spec.open : spec.closed).slice((page - 1) * 100, page * 100));
    }
    if (spec.rejectGraphql) throw Error('fake-gh: unsupported graphql query');
    if (args.some(a => a.includes('totalCount'))) {
      const totalCount = Object.hasOwn(spec, 'totalCount') ? spec.totalCount
        : (args.includes('s[]=OPEN') ? spec.open : spec.closed).length;
      return JSON.stringify({ data: { repository: { pullRequests: { totalCount } } } });
    }
    if (args.some(a => a.includes('pullRequest(number:'))) {
      if (spec.snapshotError) throw Error('snapshot unavailable');
      const number = Number(args.find(a => a.startsWith('p=')).slice(2));
      return JSON.stringify({ data: { repository: { pullRequest: { ...hardSource(), number, id: `PR_${number}` } } } });
    }
    throw Error('fake-gh: unsupported graphql query');
  });
}
const proofCalls = exec => exec.mock.calls.filter(([, args]) => args[1] === 'graphql');
const probeOptions = exec => ({ repo: 'fixture/project', now: hardNow,
  settings: { hold: true, lookbackDays: 14 }, exec, postHold: vi.fn() });

describe('default authority candidate probe', () => {
  it('default authority with no observed candidate reads no count proof and does not block', () => {
    const exec = routeExec({ open: [{ number: 10 }], closed: [], rejectGraphql: true });
    const opts = probeOptions(exec);
    expect(runSupersedeWatch(opts)).toEqual({ repo: opts.repo, holds: [], applied: [] });
    expect(proofCalls(exec)).toHaveLength(0);
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it('daemon wrapper sees no error/blocked for a candidate-free repo', () => {
    const exec = routeExec({ open: [{ number: 10 }], closed: [], rejectGraphql: true });
    const opts = probeOptions(exec);
    const result = runSupersedeAllRepos({ ...opts, repos: [opts.repo] }).repos[0];
    expect(result.error).toBeUndefined();
    expect(result.blocked).toBeUndefined();
    expect(proofCalls(exec)).toHaveLength(0);
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it('a trusted marker whose target is not open is not an observed candidate', () => {
    const exec = routeExec({ open: [{ number: 10 }], closed: [probeClosed(20, 'Supersedes: #99')], rejectGraphql: true });
    const opts = probeOptions(exec);
    expect(runSupersedeWatch(opts)).toEqual({ repo: opts.repo, holds: [], applied: [] });
    expect(proofCalls(exec)).toHaveLength(0);
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it.each(['open throws', 'closed throws', 'malformed JSON', 'bad open row', 'bad closed row', 'page cap', 'parser failure'])(
    'probe failure blocks and stops all further reads: %s', failure => {
      const spec = { open: [{ number: 10 }], closed: [probeClosed()] };
      let last;
      if (failure === 'bad open row') spec.open = [{ number: 'x' }];
      if (failure === 'bad closed row') spec.closed = [{ ...probeClosed(), updated_at: 'bad' }];
      spec.rest = (state, page) => {
        last = { state, page };
        if (failure === `${state} throws`) throw Error('probe unavailable');
        if (failure === 'malformed JSON') return 'not json';
        if (failure === 'page cap' && state === 'open') return JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ number: (page - 1) * 100 + i + 1 })));
      };
      if (failure === 'parser failure') setMarkdownLoader(() => { throw Error('md down'); });
      const exec = routeExec(spec);
      const opts = probeOptions(exec);
      try {
        const result = runSupersedeWatch(opts);
        expect(result.blocked).toBe(true);
        expect(opts.postHold).not.toHaveBeenCalled();
        expect(proofCalls(exec)).toHaveLength(0);
        const expectedState = ['closed throws', 'bad closed row', 'parser failure'].includes(failure) ? 'closed' : 'open';
        expect(last).toEqual({ state: expectedState, page: failure === 'page cap' ? 100 : 1 });
        expect(exec).toHaveBeenCalledTimes(failure === 'page cap' ? 100 : expectedState === 'closed' ? 2 : 1);
        if (failure === 'page cap') expect(result.error).toMatch(/page cap.*operator.*retry/);
      } finally { setMarkdownLoader(); }
    });
  it.each([150, 6300])('candidate on a later page completes with a separate probe budget: %i rows', count => {
    const source = count === 150 ? 1120 : 1000 + count;
    const spec = { open: Array.from({ length: count }, (_, i) => ({ number: i + 1 })),
      closed: Array.from({ length: count }, (_, i) => probeClosed(1001 + i, 1001 + i === source ? 'Supersedes: #10' : 'No marker')) };
    const exec = routeExec(spec);
    const opts = { ...probeOptions(exec), readPr: vi.fn(() => hardTarget()) };
    opts.postHold.mockImplementation(({ hold }) => {
      opts.readPr.mockReturnValue({ ...hardTarget(), comments: [{ author: { login: 'web-everything' }, body: buildSupersededStandDownComment(hold) }] });
      return { ok: true };
    });
    const result = runSupersedeWatch(opts);
    expect(result.applied).toEqual([expect.objectContaining({ pr: 10, by: source, ok: true })]);
    expect(result.evidence).toEqual([expect.objectContaining({ candidateId: 'PR_10', sourceId: `PR_${source}` })]);
    expect(proofCalls(exec).filter(([, args]) => args.some(a => a.includes('totalCount')))).toHaveLength(4);
    expect(proofCalls(exec).filter(([, args]) => args.some(a => a.includes('pullRequest(number:')))).toHaveLength(2);
    expect(opts.readPr).toHaveBeenCalledTimes(3);
    expect(opts.postHold).toHaveBeenCalledTimes(1);
  });
  it.each(['readMergedPrs', 'readOpenNumbers'])('only %s injected skips probe and keeps default completeness', reader => {
    const exec = routeExec({ open: [], closed: [], rejectGraphql: true });
    const opts = { ...probeOptions(exec), [reader]: () => reader === 'readMergedPrs' ? [] : [10] };
    expect(runSupersedeWatch(opts)).toMatchObject({ blocked: true, error: 'fake-gh: unsupported graphql query' });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(proofCalls(exec)).toHaveLength(1);
    expect(exec.mock.calls[0][1]).toContain(reader === 'readMergedPrs' ? 's[]=OPEN' : 's[]=CLOSED');
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it('initial candidate source snapshot failure blocks dispatch after complete inventories', () => {
    const exec = routeExec({ open: [{ number: 10 }], closed: [probeClosed()], snapshotError: true });
    const opts = { ...probeOptions(exec), readPr: vi.fn() };
    expect(runSupersedeWatch(opts)).toMatchObject({ blocked: true, holds: [], applied: [] });
    expect(proofCalls(exec)).toHaveLength(5);
    expect(opts.readPr).not.toHaveBeenCalled();
    expect(opts.postHold).not.toHaveBeenCalled();
  });
});
