import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFileRunStore, newRunRecord, pruneTerminalRuns } from '../run-store.mjs';
import { producerBuildContext, readAuthorship, backfillAuthorship } from '../build-pr-authorship.mjs';

it('retains a producer receipt after the wrapper dies without settling; backfills only actual PR results', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-authorship-'));
  try {
    const store = createFileRunStore(join(dir, 'runs'));
    const record = newRunRecord({ id: 'dispatch-lane-crash', op: 'dispatch-lane' });
    record.effects = [{ key: 'dispatch:0:0', type: 'conveyor.dispatch-delivery-agent', stepIndex: 0, index: 0,
      status: 'in-flight', handle: 'pid:99999', payload: { num: '4502', launchKind: 'build' }, result: null }];
    store.write(record);
    const env = { ...process.env, WE_BUILD_PR_CONTEXT: JSON.stringify({ runId: record.id, key: 'dispatch:0:0', dir: join(dir, 'runs') }) };
    const module = pathToFileURL(resolve('scripts/operations/build-pr-authorship.mjs')).href;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { producerBuildContext, checkpointBuildPr } from ${JSON.stringify(module)};
      checkpointBuildPr(producerBuildContext(), { repo: 'web-everything/web-everything', pr: 3033, ref: 'lane/4502b-example' }, ${JSON.stringify(join(dir, 'receipts'))});
      process.kill(process.pid, 'SIGKILL');
    `], { env, encoding: 'utf8' });
    expect(out.signal, out.stderr).toBe('SIGKILL');
    expect(store.read(record.id).effects[0].result).toBeNull();
    expect(readAuthorship(join(dir, 'receipts'))[0]).toMatchObject({ pr: 3033, entry: { payload: { launchKind: 'build' } } });
    const args = { runs: [{ id: record.id, record }], prs: [{ number: 3033, headRefName: 'lane/4502b-example' }], repo: 'web-everything/web-everything' };
    expect(backfillAuthorship(args)).toEqual([]);
    record.effects[0].status = 'applied';
    record.effects[0].result = { pr: 3033 };
    store.write(record);
    expect(backfillAuthorship({ ...args, persist: true, dir: join(dir, 'backfill') })).toHaveLength(1);
    expect(readAuthorship(join(dir, 'backfill'))).toHaveLength(1);
    expect(pruneTerminalRuns({ dir: join(dir, 'runs'), maxAgeMs: 0 }).pruned).toEqual([]);
    expect(store.read(record.id)).not.toBeNull();
    record.effects[0].payload.launchKind = 'prepare-item';
    store.write(record);
    expect(() => producerBuildContext(env)).toThrow('unproven');
    expect(backfillAuthorship(args)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
