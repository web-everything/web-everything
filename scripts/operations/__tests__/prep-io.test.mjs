import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { withRealDirectory } from './helpers/real-repo.mjs';
import { createPrepIO, createPrepStore } from '../prep-io.mjs';
import { buildRecord, recordHash } from '../../lib/prep-record.mjs';
import { PREP_DEFAULTS } from '../../lib/prep-settings.mjs';
import { prepOperation, PREP_OP, PREP_STORE_EFFECT } from '../prep.mjs';
import { createRegistry } from '../registry.mjs';
import { advanceWhileRunning, startRun } from '../engine.mjs';

describe('prep store real filesystem fidelity', () => {
  it('atomically refuses concurrent new operations after both existence checks pass, preserving the first record and allowing amend', async () => {
    await withRealDirectory(({ root }) => {
      const storeDir = join(root, 'prep');
      const client = () => createPrepIO({ env: {}, store: createPrepStore({ storeDir, env: {} }),
        settings: { config: PREP_DEFAULTS, errors: [] } });
      const first = client();
      const second = client();
      const prepare = (io, action, acceptance, runId) => {
        const registry = createRegistry();
        registry.register(prepOperation({ readContext: io.readContext }));
        const run = advanceWhileRunning(startRun({ op: PREP_OP, id: runId, registry,
          input: { action, id: 'card-123', acceptance } }), { registry });
        expect(run.verdict.write).toBe(true);
        expect(run.effects).toHaveLength(1);
        return run.effects[0].payload;
      };
      // Deterministically overlap the operations: both finish their reads and
      // declare a write before either writer publishes its record.
      const initial = prepare(first, 'new', 'First creator acceptance criteria.', 'first');
      const competing = prepare(second, 'new', 'Competing creator acceptance criteria.', 'second');
      first.sinks[PREP_STORE_EFFECT](initial);
      expect(() => second.sinks[PREP_STORE_EFFECT](competing)).toThrow('already exists; use amend');
      const store = createPrepStore({ storeDir, env: {} });
      expect(store.read('card-123')).toEqual(initial.record);
      expect(readdirSync(storeDir)).toEqual(['card-123.json']);

      const amended = prepare(second, 'amend', 'Explicit amendment acceptance criteria.', 'amended');
      second.sinks[PREP_STORE_EFFECT](amended);
      expect(store.read('card-123')).toEqual(amended.record);
      expect(amended.record.history[0].record).toEqual(initial.record);
      expect(readdirSync(storeDir)).toEqual(['card-123.json']);
    });
  });
  it('fails old record-only effects closed instead of replacing existing records', async () => {
    await withRealDirectory(({ root }) => {
      const store = createPrepStore({ storeDir: root, env: {} });
      const io = createPrepIO({ env: {}, store, settings: { config: PREP_DEFAULTS, errors: [] } });
      const record = buildRecord({ id: 'card-123', acceptance: 'Original acceptance criteria.' });
      io.sinks[PREP_STORE_EFFECT](record);
      expect(() => io.sinks[PREP_STORE_EFFECT]({ ...record, acceptance: 'Different acceptance criteria.' }))
        .toThrow('already exists; use amend');
      expect(store.read(record.id)).toEqual(record);
      expect(() => io.sinks[PREP_STORE_EFFECT]({ record, action: 'unknown' })).toThrow('Unknown prep store action');
    });
  });
  it('replaces a nested store record atomically without temporary leftovers or Git', async () => {
    await withRealDirectory(({ root }) => {
      const storeDir = join(root, 'coordination', 'prep');
      const store = createPrepStore({ storeDir, env: {} });
      const record = buildRecord({ id: 'card-123', touchSet: ['docs/example.md'] });
      store.write(record);
      const amended = buildRecord({ ...record, touchSet: [...record.touchSet, 'docs/second.md'] });
      store.write(amended);
      expect(createPrepStore({ storeDir, env: {} }).read(record.id)).toEqual(amended);
      expect(store.read(record.id).hash).toBe(recordHash(amended));
      expect(readdirSync(storeDir)).toEqual(['card-123.json']);
    });
  });
});
