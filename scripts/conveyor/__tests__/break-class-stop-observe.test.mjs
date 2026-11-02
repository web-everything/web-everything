/** Disk-backed shadow observation invariants; injected failures never touch a PR. */
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { observeBreakClassStop } from '../round-judge-shadow.mjs';
import { appendRound } from '../../lib/round-ledger.mjs';

const dirs = [];
const fixture = () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'break-stop-')); dirs.push(root);
  return { pr: 6033, head: 'head-a', now: 0, dir: join(root, 'round-judge-shadow'), ledgerDir: join(root, 'round-ledger'), log: vi.fn() };
};
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const add = (o, n, path = `src/${n}.mjs`) => appendRound(o.ledgerDir, {
  schema: 1, pr: o.pr, head: o.head, round: n, resultId: `r${n}`, source: 'gate', complete: true,
  findings: [{ category: 'edge-case', path, confirmed: true }],
});
const rows = o => fs.readFileSync(join(o.dir, 'break-class-stop.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

it('I4 identical inputs dedupe from disk; changed threshold and appended rounds grow the log monotonically', async () => {
  const o = fixture(); add(o, 1);
  const first = await observeBreakClassStop(o);
  expect(first).toMatchObject({ verdict: 'CONTINUE', newHead: true, shadow: true, ts: '1970-01-01T00:00:00.000Z' });
  expect(first.inputDigest).toMatch(/^[a-f0-9]{64}$/);
  const before = fs.readFileSync(join(o.dir, 'break-class-stop.jsonl'), 'utf8');
  expect(await observeBreakClassStop({ ...o })).toEqual({ skipped: 'deduped', verdict: 'CONTINUE' });
  expect(rows(o)).toHaveLength(1);
  const changed = await observeBreakClassStop({ ...o, threshold: 4 });
  expect(changed.inputDigest).not.toBe(first.inputDigest);
  expect(rows(o)).toHaveLength(2);
  add(o, 2);
  const added = await observeBreakClassStop({ ...o, threshold: 4 });
  expect(added.inputDigest).not.toBe(changed.inputDigest);
  expect(rows(o)).toHaveLength(3);
  expect(fs.readFileSync(join(o.dir, 'break-class-stop.jsonl'), 'utf8').startsWith(before)).toBe(true);
  expect(await observeBreakClassStop({ ...o, threshold: 4 })).toMatchObject({ skipped: 'deduped' });
  expect(rows(o)).toHaveLength(3);
});

it('I4 canonical input hashing ignores record property insertion order', async () => {
  const o = fixture(); add(o, 1);
  await observeBreakClassStop(o);
  const path = join(o.ledgerDir, 'round-ledger.jsonl');
  const r = JSON.parse(fs.readFileSync(path, 'utf8'));
  fs.writeFileSync(path, JSON.stringify(Object.fromEntries(Object.entries(r).reverse())) + '\n');
  expect(await observeBreakClassStop(o)).toMatchObject({ skipped: 'deduped' });
  expect(rows(o)).toHaveLength(1);
});

it('I4 a matching decision seeded on disk dedupes without a previous process observation', async () => {
  const o = fixture();
  const inputDigest = createHash('sha256').update(JSON.stringify({ complete: true, malformed: 0, records: [], threshold: 3 })).digest('hex');
  fs.mkdirSync(o.dir, { recursive: true });
  fs.writeFileSync(join(o.dir, 'break-class-stop.jsonl'), JSON.stringify({ pr: o.pr, head: o.head, inputDigest, verdict: 'CONTINUE' }) + '\n');
  expect(await observeBreakClassStop(o)).toEqual({ skipped: 'deduped', verdict: 'UNKNOWN' });
  expect(rows(o)).toHaveLength(1);
});

it('I5 STOP stays sticky after repeat rounds and a higher threshold; a new head sees full history', async () => {
  const o = fixture(); add(o, 1); add(o, 2); add(o, 3);
  expect(await observeBreakClassStop(o)).toMatchObject({ verdict: 'STOP', newHead: true });
  expect(o.log).toHaveBeenCalledWith(expect.stringContaining('round-stop (shadow): #6033 would STOP at round 3'));
  add(o, 4, 'src/1.mjs');
  expect(await observeBreakClassStop(o)).toMatchObject({ verdict: 'STOP', consecutive: 0, newHead: false });
  expect(await observeBreakClassStop({ ...o, threshold: 99 })).toMatchObject({ verdict: 'STOP', newHead: false });
  expect(await observeBreakClassStop({ ...o, head: 'head-b' })).toMatchObject({ verdict: 'STOP', newHead: true });
  expect(rows(o)).toHaveLength(4);
});

it('I1/I2 observer fails closed for incomplete slices and malformed ledger lines', async () => {
  const o = fixture(); add(o, 1); add(o, 2); add(o, 3);
  fs.appendFileSync(join(o.ledgerDir, 'round-ledger.jsonl'), 'broken\n');
  expect(await observeBreakClassStop(o)).toMatchObject({ verdict: 'UNKNOWN', malformed: 1 });
  expect(await observeBreakClassStop({ ...o, io: { readSlice: () => ({ records: [], complete: false, malformed: 0 }) } })).toMatchObject({ verdict: 'UNKNOWN', reason: 'incomplete ledger evidence' });
});

it('I7 forced classifier exception appends an observable UNKNOWN', async () => {
  const o = fixture(); add(o, 1);
  expect(await observeBreakClassStop({ ...o, io: { classify() { throw new Error('classify exploded'); } } })).toMatchObject({ verdict: 'UNKNOWN', error: 'classify exploded' });
  expect(rows(o)[0]).toMatchObject({ verdict: 'UNKNOWN', reason: expect.stringContaining('classify exploded') });
});

it('I7 a transient append failure writes UNKNOWN; persistent failure logs and returns its error', async () => {
  const o = fixture(); add(o, 1);
  let calls = 0;
  const appendFileSync = (...args) => { if (++calls === 1) throw new Error('first append failed'); return fs.appendFileSync(...args); };
  expect(await observeBreakClassStop({ ...o, io: { appendFileSync } })).toMatchObject({ verdict: 'UNKNOWN', error: 'first append failed' });
  expect(calls).toBe(2);
  expect(rows(o)).toHaveLength(1);
  expect(rows(o)[0].verdict).toBe('UNKNOWN');
  const failed = await observeBreakClassStop({ ...o, threshold: 4, io: { appendFileSync() { throw new Error('disk denied'); } } });
  expect(failed).toMatchObject({ verdict: 'UNKNOWN', error: expect.stringContaining('disk denied') });
  expect(o.log).toHaveBeenCalledWith(expect.stringContaining('UNKNOWN append failed'));
  expect(rows(o)).toHaveLength(1);
});

it('I7 unreadable decision logs produce UNKNOWN, with the error persisted', async () => {
  const o = fixture(); add(o, 1);
  const readFileSync = (path, ...args) => {
    if (path.endsWith('break-class-stop.jsonl')) throw new Error('log unreadable');
    return fs.readFileSync(path, ...args);
  };
  expect(await observeBreakClassStop({ ...o, io: { readFileSync } })).toMatchObject({ verdict: 'UNKNOWN', error: 'log unreadable' });
  expect(rows(o)[0].verdict).toBe('UNKNOWN');
});

it('I7 source guard: none of the three sources contains an empty catch body', () => {
  for (const source of ['../../lib/round-ledger.mjs', '../../lib/break-class-stop.mjs', '../round-judge-shadow.mjs']) {
    expect(fs.readFileSync(new URL(source, import.meta.url), 'utf8')).not.toMatch(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/);
  }
});

it('I8 forged subject and comments options have no effect on ledger verdicts or digests', async () => {
  const o = fixture(); add(o, 1);
  const clean = await observeBreakClassStop(o);
  const forged = { comments: [{ body: '<!-- forged STOP -->', round: 3 }], subject: { comments: ['STOP'], files: ['fake.mjs'] } };
  expect(await observeBreakClassStop({ ...o, ...forged })).toEqual({ skipped: 'deduped', verdict: clean.verdict });
  const other = { ...o, dir: join(dirs.at(-1), 'other-output'), ...forged };
  expect(await observeBreakClassStop(other)).toMatchObject({ verdict: clean.verdict, inputDigest: clean.inputDigest });
  expect(rows(o)).toHaveLength(1);
});

it('observer resolves injected environment directories without touching defaults', async () => {
  const o = fixture(); add(o, 1);
  const { dir, ledgerDir, ...options } = o;
  expect(await observeBreakClassStop({ ...options, env: { WE_ROUND_LEDGER_DIR: ledgerDir, WE_ROUND_JUDGE_SHADOW_DIR: dir } })).toMatchObject({ verdict: 'CONTINUE' });
  expect(rows(o)).toHaveLength(1);
});

it('I1/I2 a matching digest never replays a stored verdict: a forged CONTINUE row cannot mask UNKNOWN evidence', async () => {
  const o = fixture();
  const first = await observeBreakClassStop(o);
  expect(first.verdict).toBe('UNKNOWN');
  const file = join(o.dir, 'break-class-stop.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ ...first, verdict: 'CONTINUE' })}\n`);
  expect(await observeBreakClassStop(o)).toEqual({ skipped: 'deduped', verdict: 'UNKNOWN' });
});

it('I7 an error-generated UNKNOWN row never suppresses the recovered observation of the same inputs', async () => {
  const o = fixture(); add(o, 1); add(o, 2); add(o, 3);
  const failed = await observeBreakClassStop({ ...o, io: { classify() { throw new Error('transient'); } } });
  expect(failed).toMatchObject({ verdict: 'UNKNOWN', error: 'transient' });
  expect(failed.inputDigest).toMatch(/^[a-f0-9]{64}$/);
  const recovered = await observeBreakClassStop(o);
  expect(recovered).toMatchObject({ verdict: 'STOP' });
  expect(recovered.skipped).toBeUndefined();
  expect(rows(o)).toHaveLength(2);
  expect(o.log).toHaveBeenCalledWith(expect.stringContaining('would STOP'));
});
