import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scorecardOperationSnapshot, snapshotStoreRecords } from '../scorecard-operation-snapshot.mjs';
import { readStore } from '../../conveyor/run-scorecard-store.mjs';

describe('scorecardOperationSnapshot (xwu9oxh S2, per operation)', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sc-op-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads once per snapshot; a new snapshot reads fresh', () => {
    const p = join(dir, 's.json');
    writeFileSync(p, JSON.stringify({ records: [1] }));
    const op = scorecardOperationSnapshot(p);
    const first = op.read();
    writeFileSync(p, JSON.stringify({ records: [2] }));
    expect(op.read()).toBe(first);
    expect(snapshotStoreRecords(scorecardOperationSnapshot(p))).toEqual([2]);
  });

  it('snapshotStoreRecords matches readStore for good, odd, malformed and missing stores', () => {
    const cases = { good: JSON.stringify({ version: 2, records: [{ x: 1 }] }), notStore: '{"rows":[]}', nul: 'null', bad: '{' };
    for (const [name, text] of Object.entries(cases)) {
      const p = join(dir, `${name}.json`);
      writeFileSync(p, text);
      expect(snapshotStoreRecords(scorecardOperationSnapshot(p)), name).toEqual(readStore({ path: p }).records);
    }
    const none = join(dir, 'none.json');
    expect(snapshotStoreRecords(scorecardOperationSnapshot(none))).toEqual(readStore({ path: none }).records);
  });

  it('keeps the read error code and the parse error for each reader to judge', () => {
    expect(scorecardOperationSnapshot(join(dir, 'none.json')).read()).toMatchObject({ ok: false, error: { code: 'ENOENT' } });
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{');
    expect(scorecardOperationSnapshot(p).read().parseError).toBeInstanceOf(SyntaxError);
  });
});
