/** Hermetic append/read contract and fail-closed ledger probes. */
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendRound, readSlice, ledgerDir, ROUND_LEDGER_SCHEMA } from '../round-ledger.mjs';

const dirs = [];
const temp = () => { const dir = fs.mkdtempSync(join(tmpdir(), 'round-ledger-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const rec = (extra = {}) => ({ schema: 1, pr: 6033, head: 'a', resultId: 'r1', source: 'gate', findings: [], complete: true, ...extra });

it('I1 ledger reads missing files as complete, read failures as incomplete', () => {
  expect(readSlice(temp(), 6033)).toEqual({ records: [], malformed: 0, complete: true });
  expect(readSlice(temp(), 6033, { readFileSync() { throw new Error('denied'); } })).toEqual({ records: [], malformed: 0, complete: false });
});

it('I2 counts a malformed fourth line alongside three good rounds', () => {
  const dir = temp();
  for (let round = 1; round <= 3; round++) appendRound(dir, rec({ round, resultId: `r${round}` }));
  fs.appendFileSync(join(dir, 'round-ledger.jsonl'), '{torn\n');
  expect(readSlice(dir, 6033)).toMatchObject({ records: expect.any(Array), malformed: 1 });
  expect(readSlice(dir, 6033).records).toHaveLength(3);
});

it('I2 wrong schema, invalid records, blank lines and incomplete rows are counted even for other PRs', () => {
  const dir = temp();
  fs.writeFileSync(join(dir, 'round-ledger.jsonl'), [rec({ round: 1, schema: 2 }), rec({ round: 2, pr: 7, complete: false }), {}, ''].map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  expect(readSlice(dir, 6033)).toEqual({ records: [], malformed: 4, complete: false });
  expect(() => appendRound(dir, rec())).toThrow(/malformed/);
});

it('ledger append validates, creates directories, assigns PR-wide rounds, dedupes and reads all heads sorted', () => {
  const dir = join(temp(), 'nested');
  expect(ROUND_LEDGER_SCHEMA).toBe(1);
  expect(() => appendRound(dir, rec({ schema: 2 }))).toThrow(/invalid/);
  expect(appendRound(dir, rec({ round: 2 }))).toEqual({ appended: true });
  expect(appendRound(dir, rec({ round: 1, head: 'b' }))).toEqual({ appended: true });
  const before = fs.readFileSync(join(dir, 'round-ledger.jsonl'), 'utf8');
  expect(appendRound(dir, rec())).toEqual({ appended: false });
  expect(fs.readFileSync(join(dir, 'round-ledger.jsonl'), 'utf8')).toBe(before);
  appendRound(dir, rec({ head: 'c', resultId: 'r3' }));
  appendRound(dir, rec({ pr: 9 }));
  expect(readSlice(dir, 6033).records.map(r => [r.round, r.head])).toEqual([[1, 'b'], [2, 'a'], [3, 'c']]);
  expect(readSlice(dir, 9).records[0].round).toBe(1);
});

it('ledgerDir accepts only the named override and defaults portably', () => {
  const base = temp();
  const fallback = join(homedir(), 'workspace', '.operations', 'round-ledger');
  expect(ledgerDir({})).toBe(fallback);
  expect(ledgerDir({ WE_ROUND_LEDGER_DIR: base })).toBe(fallback);
  expect(ledgerDir({ WE_ROUND_LEDGER_DIR: ` ${join(base, 'round-ledger')} ` })).toBe(resolve(base, 'round-ledger'));
});

it('I4 a conflicting duplicate (pr, head, resultId) is rejected, an identical one is a no-op', () => {
  const dir = temp();
  expect(appendRound(dir, rec({ round: 1 }))).toEqual({ appended: true });
  expect(appendRound(dir, rec({ round: 1 }))).toEqual({ appended: false });
  const worse = rec({ round: 1, findings: [{ category: 'security', path: 'a.mjs', confirmed: true }] });
  expect(() => appendRound(dir, worse)).toThrow(/conflicting duplicate/);
  expect(fs.readFileSync(join(dir, 'round-ledger.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});
