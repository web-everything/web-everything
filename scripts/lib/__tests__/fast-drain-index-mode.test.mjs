import { test, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as scope from '../fast-drain-scope.mjs';
import { prestagePorts } from '../../__tests__/fixtures/merge-ai-prs-fake-ports.mjs';
import { runInProcess } from '../../__tests__/fixtures/merge-ai-prs-cli-harness.mjs';
import { createPrestageWorld } from '../../__tests__/fixtures/merge-ai-prs-prestage-world.mjs';
vi.mock('node:child_process', async () => (await import('../../__tests__/fixtures/merge-ai-prs-cli-harness.mjs')).childProcessMock);
vi.setConfig({ testTimeout: 120_000 });

test('index mode defaults to shadow and logs cascade provenance', () => {
  const resolve = options => scope.resolveFastDrainIndexModeSetting({ env: {}, tool: {}, platform: {}, ...options });
  expect(resolve()).toMatchObject({ mode: 'shadow', source: 'standard' });
  expect(resolve({ platform: { index: { mode: 'off' } }, tool: { index: { mode: 'shadow' } }, env: { WE_FAST_DRAIN_INDEX_MODE: 'on' } }))
    .toMatchObject({ mode: 'on', source: 'env' });
  expect(resolve().line).toContain('mode=shadow (standard)');
});

test('unknown, non-string, duplicate and unreadable settings fail closed to off', () => {
  for (const options of [
    { tool: { index: { mode: 'unknown' } } }, { tool: { index: { mode: 1 } } },
    { env: { WE_FAST_DRAIN_INDEX_MODE: 'unknown' } }, { platform: { index: { mode: null } } },
    { readSettings: () => { throw Error('unreadable'); } },
    { readSettings: () => ({ errors: ['unreadable'] }) },
    { readSettings: () => ({ duplicates: [{ path: 'mergeQueue.fastDrain.index.mode' }] }) },
  ]) expect(scope.resolveFastDrainIndexModeSetting({ env: {}, platform: {}, ...options })).toMatchObject({ mode: 'off' });
});

test('an unreadable settings file selects off even with an on environment override', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'index-settings-'));
  try {
    expect(scope.resolveFastDrainIndexModeSetting({ env: { WE_FAST_DRAIN_INDEX_MODE: 'on' }, platform: {},
      readSettings: () => JSON.parse(readFileSync(join(dir, 'missing.json'), 'utf8')) })).toMatchObject({ mode: 'off' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('off never calls the index path; on calls only the live index path', async () => {
  const legacy = vi.fn(() => 'legacy'), index = vi.fn(() => 'index');
  expect(await scope.dispatchFastDrainIndex({ mode: 'off', legacy, index })).toBe('legacy');
  expect(index).not.toHaveBeenCalled();
  legacy.mockClear();
  expect(await scope.dispatchFastDrainIndex({ mode: 'on', legacy, index })).toBe('index');
  expect(legacy).not.toHaveBeenCalled();
  expect(index).toHaveBeenCalledWith(expect.objectContaining({ writeScope: 'enqueue-only' }));
});

test('shadow refuses every gh/git write and appends exactly one seven-field row per PR/pass', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'index-mode-'));
  try {
    const path = join(dir, 'shadow.jsonl'), writes = [], legacy = vi.fn(() => 'live');
    for (const pr of [7, 8]) {
      const index = vi.fn(({ writeScope, writeBoundary }) => {
        expect(writeScope).toBe('none');
        const exec = writeBoundary.exec((...args) => writes.push(args));
        for (const [file, args] of [
          ['git', ['push', 'origin', 'HEAD']], ['git', ['fetch', 'origin', 'main']],
          ['gh', ['pr', 'edit', String(pr), '--repo', 'fixture/repo', '--add-label', 'red-team:clear']],
          ['gh', ['pr', 'comment', String(pr), '--repo', 'fixture/repo', '--body', 'hold']],
          ['gh', ['api', 'graphql', '-f', 'query=mutation { enqueuePullRequest { id } }']],
          ['gh', ['api', 'repos/fixture/repo/issues', '-XPOST']],
        ]) expect(() => exec(file, args)).toThrow(/write-boundary/);
        expect(() => writeBoundary.helper('local-state', () => writes.push('helper'))()).toThrow(/write-boundary/);
        return { indexDecision: 'defer', reason: 'write refused' };
      });
      expect(await scope.dispatchFastDrainIndex({ mode: 'shadow', legacy, index, repo: 'fixture/repo', pr,
        head: 'a'.repeat(40), mainSha: 'b'.repeat(40), shadowPath: path, now: () => 1000 })).toBe('live');
      expect(index).toHaveBeenCalledTimes(1);
    }
    expect(writes).toEqual([]);
    const rows = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.pr)).toEqual([7, 8]);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['at', 'pr', 'repo', 'head', 'indexDecision', 'reason', 'mainSha'].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a throwing shadow or append cannot fail the live child and logs one line', async () => {
  const legacy = vi.fn(() => 'live'), log = vi.fn(), rows = [];
  expect(await scope.dispatchFastDrainIndex({ mode: 'shadow', legacy, index: () => { throw Error('shadow\nfailure'); },
    append: (_path, row) => rows.push(row), log })).toBe('live');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ indexDecision: 'error', reason: 'shadow\nfailure' });
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0][0]).not.toContain('\n');
  log.mockClear();
  expect(await scope.dispatchFastDrainIndex({ mode: 'shadow', legacy, index: () => ({}),
    append: () => { throw Error('disk full'); }, log })).toBe('live');
  expect(log).toHaveBeenCalledTimes(1);
  expect(await scope.dispatchFastDrainIndex({ mode: 'shadow', legacy, index: () => { throw Error('shadow failure'); },
    append: () => {}, log: () => { throw Error('logging failed'); } })).toBe('live');
});

test('real child retains main prestage in off/shadow; shadow adds zero gh/git writes; on runs the index gates', async () => {
  const world = createPrestageWorld((argv, options) => runInProcess(argv, { ...options, ports: prestagePorts }));
  const traces = [];
  for (const indexMode of ['off', 'shadow', 'on']) {
    await world(async ({ pr, run, dir }) => {
      await run(false, { indexMode });
      pr.statusCheckRollup[0] = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: pr.headRefOid };
      const next = await run(true, { indexMode });
      if (indexMode === 'on') {
        expect(next.report.prestaged).not.toBe(true);
        expect(next.report.enqueueOutcomes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'defer-to-pass:couple-unknown' })]));
      } else {
        expect(next.report.prestaged, next.stderr).toBe(true);
        expect(next.report.enqueueOutcomes).toMatchObject([{ outcome: 'enqueued' }]);
        const writes = next.calls.filter(a => a[0] === 'git' ? ['push', 'fetch', 'config', 'checkout', 'commit', 'reset'].includes(a[1])
          : a[0] === 'pr' && !['view', 'list', 'diff', 'checks'].includes(a[1])
          || a[0] === 'api' && a.some(v => /mutation\b/.test(v)));
        traces.push(writes.map(a => a.map(v => v.replaceAll(dir, '<fixture>'))));
      }
      expect(next.indexShadow).toHaveLength(indexMode === 'shadow' ? 1 : 0);
      if (indexMode === 'shadow') {
        expect(next.indexShadow[0]).toMatchObject({ pr: 42, repo: 'web-everything/web-everything', head: pr.headRefOid });
        expect(Object.keys(next.indexShadow[0]).sort()).toEqual(['at', 'pr', 'repo', 'head', 'indexDecision', 'reason', 'mainSha'].sort());
      }
    }, { slug: 'web-everything/web-everything', fastTargetManifest: false });
  }
  expect(traces[1]).toEqual(traces[0]);
});

test.each(['hold', 'park', 'baseline', 'overlap', 'overlap-missing'])('full shadow pass performs no authoritative writes or fetches (%s)', async scenario => {
  const calls = [], appends = [], pushes = [], baselineWrites = [], baselines = [], legacy = vi.fn();
  const scopePath = new URL('../fast-drain-scope.mjs', import.meta.url).pathname;
  const ledgerPath = new URL('../verdict-ledger.mjs', import.meta.url).pathname;
  const baselinePath = new URL('../review-baseline-state.mjs', import.meta.url).pathname;
  const dispatch = vi.fn(async options => {
    const actual = await vi.importActual(scopePath);
    return actual.dispatchFastDrainIndex({ ...options, legacy });
  });
  vi.doMock(scopePath, async () => ({ ...await vi.importActual(scopePath), dispatchFastDrainIndex: dispatch }));
  vi.doMock(ledgerPath, async () => ({ ...await vi.importActual(ledgerPath), appendVerdict: (...args) => {
    appends.push(args); pushes.push(args);
    return { ok: true, errors: [] };
  } }));
  vi.doMock(baselinePath, async () => {
    const actual = await vi.importActual(baselinePath);
    return { ...actual, recordBaseline: (...args) => { baselines.push(args); return actual.recordBaseline(...args); } };
  });
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual('node:fs');
    return { ...actual, writeFileSync: (path, ...args) => {
      if (String(path).endsWith('/review-baseline-state.json')) baselineWrites.push(path);
      return actual.writeFileSync(path, ...args);
    } };
  });
  const ports = Object.fromEntries(Object.entries(prestagePorts).map(([file, port]) => [file, (args, env) => {
    calls.push([file, ...args]);
    if (scenario === 'overlap-missing' && file === 'git' && args[0] === 'cat-file' && args.at(-1).startsWith('b'.repeat(40)))
      return { status: 128, stdout: '', stderr: 'missing pinned object' };
    return port(args, env);
  }]));
  const world = createPrestageWorld(async (argv, options) => {
    const result = await runInProcess(argv, { ...options, ports });
    return { ...result, stdout: '{}' }; // The live half is deliberately not invoked by this audit.
  });
  try {
    await world(async ({ pr, run }) => {
      pr.statusCheckRollup[0] = { name: 'test', status: 'COMPLETED', conclusion: scenario === 'hold' ? 'FAILURE' : 'SUCCESS', head_sha: pr.headRefOid };
      if (scenario === 'park') pr.comments = [];
      if (scenario.startsWith('overlap')) pr.contextPartners = [{ ...pr, number: 43, headRefOid: 'b'.repeat(40), headRefName: 'lane/partner', contextPartners: undefined,
        statusCheckRollup: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'].map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: 'b'.repeat(40) })) }];
      const next = await run(true, { indexMode: 'shadow', args: scenario.startsWith('overlap') ? ['--no-review-escalation'] : [] });
      expect(next.indexShadow).toHaveLength(1);
      expect(next.indexShadow[0]).toMatchObject({ pr: 42, repo: 'web-everything/web-everything', head: pr.headRefOid });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(legacy).toHaveBeenCalledTimes(1);
      expect(calls.filter(([file, ...args]) => file === 'git' && args.includes('fetch'))).toEqual([]);
      const readonly = scope.createFastDrainWriteBoundary({ writeScope: 'none', repo: 'web-everything/web-everything', num: 42 }).exec(() => {});
      expect(calls.filter(([file, ...args]) => {
        try { readonly(file, args.map(arg => arg === '-i' ? '--include' : arg)); return false; } catch { return true; }
      })).toEqual([]);
      expect(appends).toEqual([]);
      expect(pushes).toEqual([]);
      expect(baselineWrites).toEqual([]);
      expect(next.indexShadow[0].indexDecision).not.toBe('error');
      if (scenario === 'baseline') expect(baselines.length).toBeGreaterThan(0);
      if (scenario === 'overlap') expect(calls.some(([file, ...args]) => file === 'git' && args.includes('diff') && args.some(a => a.endsWith('...' + 'b'.repeat(40))))).toBe(true);
      if (scenario === 'overlap-missing') {
        expect(calls.some(([file, ...args]) => file === 'git' && args[0] === 'cat-file' && args.at(-1).startsWith('b'.repeat(40)))).toBe(true);
        expect(next.indexShadow[0]).toMatchObject({ indexDecision: 'not-enqueued', reason: 'skipped: needs fetch' });
      }
    }, { slug: 'web-everything/web-everything' });
  } finally { vi.doUnmock(scopePath); vi.doUnmock(ledgerPath); vi.doUnmock(baselinePath); vi.doUnmock('node:fs'); }
});
