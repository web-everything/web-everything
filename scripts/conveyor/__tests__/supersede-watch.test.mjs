import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSupersedeWatch, formatSupersedeLines } from '../supersede-watch.mjs';
import { runTickAllRepos, runSupersedeAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/supersede/pr4522-2026-10-09.json'), 'utf8'));
const repo = 'web-everything/web-everything';
const hold = { pr: 4522, by: 4532, mergedAt: '2026-10-09T01:52:13Z' };
const fakes = () => ({ repo, settings: { hold: true, lookbackDays: 14 },
  readMergedPrs: vi.fn(() => [fixture.merged]), readOpenNumbers: vi.fn(() => [4522, 1]),
  readPr: vi.fn(() => ({ ...fixture.open, state: 'OPEN' })), postHold: vi.fn(() => ({ ok: true, labeled: true })) });

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
