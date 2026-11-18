import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPrepareRefusal, repeatedPrepareRefusals } from '../prepare-refusal-stop.mjs';
import { readPrepareRefusals, recordPrepareRefusal } from '../prepare-refusal-stop-io.mjs';

const now = Date.parse('2026-11-18T12:00:00Z');
const hour = 3_600_000;
const refusal = { num: '4421', reason: 'merged prepare PR #9 (within 24h guard)' };
const first = appendPrepareRefusal([], refusal, { now: now - hour });
const two = appendPrepareRefusal(first, { ...refusal, reason: 'scope moved after prepare' }, { now });

describe('prepare repeat refusal stop', () => {
  it('allows one refusal and empty history', () => {
    expect(repeatedPrepareRefusals([], { now })).toEqual([]);
    expect(repeatedPrepareRefusals(first, { now })).toEqual([]);
  });
  it('skips two refusals within 24h and reports the latest reason', () => {
    expect(repeatedPrepareRefusals(two, { now })).toEqual([
      { num: '4421', refusals: 2, lastReason: 'scope moved after prepare' },
    ]);
    expect(repeatedPrepareRefusals([...two].reverse(), { now })).toEqual(repeatedPrepareRefusals(two, { now }));
  });
  it('allows the card as soon as the oldest counted refusal reaches 24h', () => {
    expect(repeatedPrepareRefusals(two, { now: now + 23 * hour })).toEqual([]);
    expect(repeatedPrepareRefusals(two, { now: now + 23 * hour + 1 })).toEqual([]);
  });
  it('isolates cards and respects configured threshold and window', () => {
    const rows = appendPrepareRefusal(two, { num: '4460', reason: 'open PR' }, { now });
    expect(repeatedPrepareRefusals(rows, { now }).map(r => r.num)).toEqual(['4421']);
    expect(repeatedPrepareRefusals(rows, { now, repeatRefusalMax: 3 })).toEqual([]);
    expect(repeatedPrepareRefusals(rows, { now, repeatRefusalWindowHours: 0.5 })).toEqual([]);
  });
});

describe('durable prepare refusal history', () => {
  function fixture(run) {
    const root = mkdtempSync(join(tmpdir(), 'prepare-refusals-'));
    try { run(join(root, 'state.json')); } finally { rmSync(root, { recursive: true, force: true }); }
  }
  it('starts empty, persists records across readers and prunes expired history on write', () => fixture(path => {
    expect(readPrepareRefusals({ path, now })).toEqual([]);
    recordPrepareRefusal(refusal, { path, now: now - 25 * hour });
    recordPrepareRefusal(refusal, { path, now: now - hour });
    recordPrepareRefusal({ ...refusal, reason: 'second' }, { path, now });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(2);
    expect(repeatedPrepareRefusals(readPrepareRefusals({ path, now }), { now })).toEqual([
      { num: '4421', refusals: 2, lastReason: 'second' },
    ]);
  }));
  it.each(['{', '{}', '[{}]', '[{"num":"4421","reason":"x","at":"bad"}]'])('fails closed on incomplete/corrupt evidence %s with an operator fallback', raw => fixture(path => {
    writeFileSync(path, raw);
    expect(() => readPrepareRefusals({ path, now })).toThrow('restore prepare-refusals.json or remove it after operator review');
    expect(() => recordPrepareRefusal(refusal, { path, now })).toThrow('prepare refusal history unavailable');
    expect(readFileSync(path, 'utf8')).toBe(raw);
  }));
  it('fails closed on unreadable state and failed persistence', () => fixture(path => {
    mkdirSync(path);
    expect(() => readPrepareRefusals({ path, now })).toThrow('prepare refusal history unavailable');
    const nested = join(path, 'not-a-directory');
    writeFileSync(nested, 'x');
    expect(() => recordPrepareRefusal(refusal, { path: join(nested, 'state'), now })).toThrow('prepare refusal history unavailable');
  }));
});
