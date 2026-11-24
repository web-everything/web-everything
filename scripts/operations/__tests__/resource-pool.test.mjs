// @vitest-environment node
import { beforeEach, it, expect, vi } from 'vitest';
import { resourcePoolOperation, renderResourcePool, finishResourcePool, digestLine } from '../resource-pool.mjs';
import { collectResourcePool, appendShadowRows } from '../../lib/resource-pool-io.mjs';
import { resolveOperation } from '../run.mjs';
import { runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { handleOperationRequest } from '../http-adapter.mjs';

const poolIo = vi.hoisted(() => ({ collectResourcePool: vi.fn(), appendShadowRows: vi.fn() }));
vi.mock('../../lib/resource-pool-io.mjs', () => poolIo);
beforeEach(() => {
  vi.clearAllMocks();
  appendShadowRows.mockReturnValue(true);
});
const wiringReport = () => ({ mode: 'shadow', configuredMode: 'shadow', digest: 'pool wiring digest',
  settings: { provenance: 'fixture' }, sources: [], summary: {}, holders: [],
  rows: ['review', 'redTeam', 'fix'].map(kind => ({ kind, poolDecision: 'grant' })) });

it.each([false, true])('run.mjs binds the resource-pool finish to appendShadowRows (json=%s)', async json => {
  const report = wiringReport();
  collectResourcePool.mockReturnValue(report);
  const resolved = resolveOperation('resource-pool', { cli: true });
  const outcome = await runOperationCli({ ...resolved, argv: json ? ['--json'] : [],
    store: createMemoryRunStore(), newRunId: () => 'pool-cli' });
  expect(outcome.code).toBe(0);
  expect(collectResourcePool).toHaveBeenCalledTimes(1);
  expect(appendShadowRows).not.toHaveBeenCalled();
  const result = resolved.finish({ ...outcome, json });
  expect(result.code).toBe(0);
  expect(appendShadowRows).toHaveBeenCalledTimes(1);
  expect(appendShadowRows).toHaveBeenCalledWith(report.rows, { mode: 'shadow' });
  expect(result.lines.join('\n')).toContain(report.digest);
  if (json) expect(JSON.parse(result.lines.join('\n')).verdict.rows).toEqual(report.rows);
  else expect(result.lines).toEqual([renderResourcePool(report)]);
});

it.each(['', '/run'])('HTTP GET resource-pool%s never invokes finish or writes shadow rows', async suffix => {
  const report = wiringReport();
  collectResourcePool.mockReturnValue(report);
  const resolved = resolveOperation('resource-pool');
  const finish = vi.spyOn(resolved, 'finish');
  const response = await handleOperationRequest({ method: 'GET', url: `/operations/resource-pool${suffix}` }, {
    resolve: name => { expect(name).toBe('resource-pool'); return resolved; },
    names: () => ['resource-pool'], newRunId: () => 'pool-http',
  });
  expect(response.status).toBe(200);
  if (suffix) {
    expect(collectResourcePool).toHaveBeenCalledTimes(1);
    expect(response.body).toMatchObject({ verdict: report, persisted: false, status: 'complete' });
  } else expect(collectResourcePool).not.toHaveBeenCalled();
  expect(finish).not.toHaveBeenCalled();
  expect(appendShadowRows).not.toHaveBeenCalled();
});

it('requires a reader and declares a readout without admission effect steps', () => {
  expect(() => resourcePoolOperation()).toThrow(/collect/);
  expect(resourcePoolOperation({ collect: vi.fn() })).toBeTruthy();
});
it('renders mode, sources, holders and a digest; preserves JSON verdict digest', () => {
  const report = { mode: 'shadow', configuredMode: 'enforce', unknown: true, digest: digestLine({ unknown: true }),
    settings: { provenance: 'resourcePool mode=shadow (tool)' }, sources: [{ source: 'fix', ok: false, error: 'bad\nfile' }],
    summary: { 'studio.units': { held: 2, classes: { 1: 0, 2: 0, 3: 2, 4: 0 } } },
    holders: [{ resource: 'studio.units', class: 3, kind: 'fix', id: 'pr-1', size: 2, source: 'fix' }] };
  const text = renderResourcePool(report);
  for (const term of ['mode shadow', 'configured enforce', 'fix: UNKNOWN', 'pr-1', report.digest]) expect(text).toContain(term);
  expect(text).not.toContain('bad\nfile');
  expect(text).toContain('C3: 2 (observed minimum; total unknown)u');
  expect(finishResourcePool({ log: () => true })({ run: { verdict: report }, code: 0, lines: ['json'], json: true }).lines).toEqual(['json']);
  expect(finishResourcePool({ log: () => true })({ run: { verdict: report }, code: 0 }).lines).toEqual([text]);
});

it('shadow rows are written only through the finish sink, including JSON runs', () => {
  const log = vi.fn(() => true);
  const report = { mode: 'shadow', rows: [{ kind: 'review' }] };
  const finish = finishResourcePool({ log });
  expect(log).not.toHaveBeenCalled();
  const args = { run: { verdict: report }, code: 0, lines: ['json'], json: true };
  expect(finish(args)).toEqual({ code: 0, lines: ['json'] });
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(report.rows, { mode: 'shadow' });
  log.mockClear();
  finish({ ...args, run: { verdict: { ...report, mode: 'off' } } });
  finish({ ...args, run: {} });
  expect(log).not.toHaveBeenCalled();
  expect(() => finishResourcePool({ log: () => { throw Error('disk'); } })(args)).not.toThrow();
});

it.each([() => false, () => { throw Error('disk full'); }, undefined])('failed or absent sink is visible and exits nonzero in text and JSON', log => {
  const report = { mode: 'shadow', rows: [], digest: 'pool', settings: {}, sources: [], summary: {}, holders: [] };
  for (const json of [false, true]) {
    const payload = { verdict: report, stopped: 'complete' };
    const stderr = vi.fn();
    const result = finishResourcePool({ log, stderr })({ run: { verdict: report }, code: 0, lines: [JSON.stringify(payload, null, 2)], json });
    expect(result.code).toBe(1);
    if (json) {
      expect(JSON.parse(result.lines.join('\n'))).toEqual(payload);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('UNKNOWN — shadow log sink failed'));
    } else {
      expect(result.lines.join('\n')).toContain('UNKNOWN — shadow log sink failed');
      expect(stderr).not.toHaveBeenCalled();
    }
  }
});

it('makes the expired red-team row count visible in the readout', () => {
  const report = { mode: 'shadow', configuredMode: 'shadow', digest: 'pool', settings: {},
    sources: [{ source: 'redTeam', ok: true, expiredRedTeamRows: 2 }], summary: {}, holders: [] };
  expect(renderResourcePool(report)).toContain('2 expired red-team rows ignored (older than 24h)');
});
