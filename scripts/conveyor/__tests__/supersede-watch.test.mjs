import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSupersedeWatch, formatSupersedeLines, defaultReadMergedPrs, defaultReadBodyEdit } from '../supersede-watch.mjs';
import { runTickAllRepos, runSupersedeAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/supersede/pr4522-2026-10-09.json'), 'utf8'));
const repo = 'web-everything/web-everything';
const hold = { pr: 4522, by: 4532, mergedAt: '2026-10-09T01:52:13Z' };
const fakes = () => ({ repo, settings: { hold: true, lookbackDays: 14 },
  readMergedPrs: vi.fn(() => [fixture.merged]), readOpenNumbers: vi.fn(() => [4522, 1]),
  readPr: vi.fn(() => ({ ...fixture.open, state: 'OPEN' })), postHold: vi.fn(() => ({ ok: true, labeled: true })),
  readBodyEdit: vi.fn(() => ({ lastEditedAt: null, editor: null })) });

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
    opts.readPr.mockReturnValue({ ...fixture.open, state: 'CLOSED' });
    expect(runSupersedeWatch(opts).holds).toEqual([]);
    expect(opts.postHold).not.toHaveBeenCalled();
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
    expect(opts.readBodyEdit).toHaveBeenCalledTimes(1);
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
    opts.readBodyEdit.mockReturnValue({ lastEditedAt: '2026-10-09T05:00:00Z', editor: { login: 'rando' } });
    const result = runSupersedeWatch({ ...opts, apply: true });
    expect(result.holds).toEqual([]);
    expect(opts.readPr).not.toHaveBeenCalled();
    expect(opts.postHold).not.toHaveBeenCalled();
  });
  it('a body edited after the merge by the operator still holds', () => {
    const opts = fakes();
    opts.readBodyEdit.mockReturnValue({ lastEditedAt: '2026-10-09T05:00:00Z', editor: { login: 'chalbert' } });
    expect(runSupersedeWatch(opts).holds).toEqual([hold]);
  });
  it('a failed edit read ignores only that PR and does not fail the pass', () => {
    const opts = fakes();
    const other = { ...fixture.merged, number: 4533, body: 'Supersedes: #1', mergedAt: '2026-10-09T03:00:00Z' };
    opts.readMergedPrs.mockReturnValue([fixture.merged, other]);
    opts.readBodyEdit.mockImplementation(({ pr }) => { if (pr === 4532) throw new Error('graphql down'); return { lastEditedAt: null, editor: null }; });
    opts.readPr.mockImplementation(({ pr }) => ({ number: pr, state: 'OPEN', labels: [], comments: [] }));
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
  it('asks gh for the merged PR author and keeps it on the rows it returns', () => {
    const exec = vi.fn(() => JSON.stringify([{ ...fixture.merged, mergedAt: '2026-10-09T01:52:13Z' }]));
    const rows = defaultReadMergedPrs({ repo, lookbackDays: 14, now: Date.parse('2026-10-10T00:00:00Z'), exec });
    const args = exec.mock.calls[0][1];
    expect(args[args.indexOf('--json') + 1].split(',')).toContain('author');
    expect(rows[0].author).toEqual({ is_bot: true, login: 'app/web-everything' });
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
