import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrichVerifyGreen } from '../reconcile-pass.mjs';
const head = 'a'.repeat(40);
it('performs no ledger IO when disabled', () => {
  const read = vi.fn(() => { throw Error('must not read'); });
  const prs = [{ headRefOid: head }];
  expect(enrichVerifyGreen(prs, { policy: {}, read })).toBe(prs);
  expect(read).not.toHaveBeenCalled();
});
it('accepts only a green ledger for the exact head, refusing corrupt, skipped and missing records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'early-review-'));
  const env = { WE_VERIFY_GREEN_LEDGER_DIR: dir };
  try {
    const read = record => {
      writeFileSync(join(dir, `${head}.json`), typeof record === 'string' ? record : JSON.stringify(record));
      return enrichVerifyGreen([{ headRefOid: head }, { headRefOid: 'b'.repeat(40) }],
        { policy: { startBeforeCi: true }, env, coordinationRoot: dir }).map(pr => pr.verifyGreen);
    };
    expect(read({ sha: head, status: 'green' })).toEqual([true, false]);
    for (const record of ['{', { sha: 'b'.repeat(40), status: 'green' }, { sha: head, status: 'green', skipped: true },
      { sha: head, status: 'green', suites: 'local gate skipped' }]) expect(read(record)).toEqual([false, false]);
    expect(enrichVerifyGreen([{ headRefOid: head }], { policy: { startBeforeCi: true }, coordinationRoot: dir,
      read: () => { throw Error('unreadable'); } })[0].verifyGreen).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
