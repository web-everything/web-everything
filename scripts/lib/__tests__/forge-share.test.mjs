/** R497 — forgeShare: remote heavy runs ÷ countable heavy runs, fail-closed on missing data. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeForgeShare, normalizeFallbackReason, loadForgeShareSettings, readForgeShareInputs, probeForgeShare } from '../forge-share.mjs';

const NOW = Date.parse('2026-11-03T16:00:00Z');
const MIN = 60_000;
const at = (minAgo) => new Date(NOW - minAgo * MIN).toISOString();
const fb = (reason, minAgo = 5) => ({ ts: at(minAgo), reason, kind: 'files' });
const local = (minAgo = 5, ms = 10_000) => ({ at: at(minAgo), ms, kind: 'files' });
const remote = (minAgo = 5, ms = 20_000) => ({ ts: at(minAgo), ms });
const cov = { remoteRuns: true, localRuns: true, fallbacks: true };
const base = { coverage: cov, now: NOW, windowMs: 60 * MIN, target: 0.9, expectedLocalReasons: ['command-not-allowed', 'needs-git'] };

describe('normalizeFallbackReason', () => {
  it('strips parenthetical and colon detail', () => {
    expect(normalizeFallbackReason('remote-full (30s wait exhausted)')).toBe('remote-full');
    expect(normalizeFallbackReason('remote client override: per-run override must be an absolute path')).toBe('remote client override');
    expect(normalizeFallbackReason('ignored-test-file')).toBe('ignored-test-file');
  });
});

describe('computeForgeShare', () => {
  it('is remote / (remote + counted local) with a by-reason breakdown', () => {
    const r = computeForgeShare({ ...base, remoteRuns: [remote(), remote(), remote()], localRuns: [local()], fallbacks: [fb('remote-full (30s wait exhausted)')] });
    expect(r.status).toBe('ok');
    expect(r.share).toBeCloseTo(0.75);
    expect(r.belowTarget).toBe(true);
    expect(r.runs).toMatchObject({ remote: 3, local: 1, expectedLocal: 0, counted: 4 });
    expect(r.byReason).toEqual({ 'remote-full': 1 });
  });
  it('excludes expected-local reasons from the denominator and reports them separately', () => {
    const r = computeForgeShare({
      ...base, remoteRuns: [remote(), remote(), remote(), remote(), remote(), remote(), remote(), remote(), remote()],
      localRuns: [local(5, 1000), local(5, 1000), local(5, 1000), local(5, 1000)].map((l, i) => ({ ...l, lane: String(i + 1) })),
      fallbacks: [fb('command-not-allowed'), fb('command-not-allowed'), fb('command-not-allowed'), fb('ignored-test-file')].map((f, i) => ({ ...f, ts: at(6), lane: `lane-${i + 1}` })),
    });
    expect(r.runs).toMatchObject({ remote: 9, local: 4, expectedLocal: 3, counted: 10 });
    expect(r.share).toBeCloseTo(0.9);
    expect(r.belowTarget).toBe(false);
    expect(r.expectedLocalByReason).toEqual({ 'command-not-allowed': 3 });
    expect(r.byReason).toEqual({ 'ignored-test-file': 1 });
  });
  it('ignores rows outside the window', () => {
    const r = computeForgeShare({ ...base, remoteRuns: [remote(5), remote(61)], localRuns: [local(5), local(90)], fallbacks: [fb('remote-full', 70)] });
    expect(r.runs).toMatchObject({ remote: 1, local: 1 });
    expect(r.byReason).toEqual({});
  });
  it('is unknown (never 100%) when there is no remote success record', () => {
    const r = computeForgeShare({ ...base, remoteRuns: null, localRuns: [local()], fallbacks: [fb('remote-full')] });
    expect(r).toMatchObject({ status: 'unknown', share: null, belowTarget: null, unknownReason: 'no-remote-success-record' });
  });
  it.each([['localRuns'], ['fallbacks']])('is unknown when %s is unreadable', (k) => {
    const input = { ...base, remoteRuns: [remote()], localRuns: [local()], fallbacks: [] };
    input[k] = null;
    expect(computeForgeShare(input)).toMatchObject({ status: 'unknown', share: null });
  });
  it('is unknown, not 0 or 1, when the window holds no countable runs', () => {
    expect(computeForgeShare({ ...base, remoteRuns: [], localRuns: [], fallbacks: [fb('command-not-allowed')], })).toMatchObject({ status: 'unknown', unknownReason: 'no-countable-runs' });
  });
  it('is 0 (known) when the remote log exists but holds no run and local runs happened', () => {
    expect(computeForgeShare({ ...base, remoteRuns: [], localRuns: [local()], fallbacks: [] })).toMatchObject({ status: 'ok', share: 0, belowTarget: true });
  });
  it('is unknown when the log tail does not cover the window', () => {
    const r = computeForgeShare({ ...base, remoteRuns: [remote()], localRuns: [local()], fallbacks: [], coverage: { fallbacks: false, localRuns: true, remoteRuns: true } });
    expect(r).toMatchObject({ status: 'unknown', unknownReason: 'window-not-covered:fallbacks' });
  });
  it('does not let a pending expected-local fallback erase an unrelated completed run (audit 3)', () => {
    const r = computeForgeShare({ ...base, remoteRuns: [remote()], localRuns: [{ ...local(), lane: '7' }], fallbacks: [{ ...fb('command-not-allowed', 1), lane: 'lane-9' }] });
    expect(r.runs).toMatchObject({ remote: 1, local: 1, expectedLocal: 0, expectedLocalPending: 1, counted: 2 });
    expect(r.share).toBeCloseTo(0.5);
  });
  it('matches an expected-local fallback to its own lane completion, a later one only', () => {
    const r = computeForgeShare({ ...base, remoteRuns: [remote()], localRuns: [{ ...local(2, 1000), lane: '9' }, { ...local(30, 1000), lane: '9' }], fallbacks: [{ ...fb('command-not-allowed', 20), lane: 'lane-9' }] });
    expect(r.runs).toMatchObject({ local: 2, expectedLocal: 1, counted: 2 });
  });
  it('requires explicit coverage and valid timestamps from direct callers (audit 3)', () => {
    const good = { ...base, remoteRuns: [remote()], localRuns: [local()], fallbacks: [] };
    expect(computeForgeShare({ ...good, coverage: undefined })).toMatchObject({ status: 'unknown', share: null });
    expect(computeForgeShare({ ...good, localRuns: [local(), { ms: 1 }] })).toMatchObject({ status: 'unknown', unknownReason: 'malformed-rows:localRuns' });
  });
  it('matches by identity: unknown lanes, runs that started before the fallback, and completions before it never match (audit 2)', () => {
    const run = (ls, f) => computeForgeShare({ ...base, remoteRuns: [remote()], localRuns: ls, fallbacks: f }).runs.expectedLocal;
    const f = { ...fb('command-not-allowed', 10), lane: 'lane-9' };
    expect(run([{ ...local(5, 1000), lane: '9' }], [f])).toBe(1);
    expect(run([local(5, 1000)], [{ ...f, lane: undefined }])).toBe(0);
    expect(run([{ ...local(5, 8 * MIN), lane: '9' }], [f])).toBe(0);
    expect(run([{ ...local(11, 1000), lane: '9' }], [f])).toBe(0);
  });
  it('requires the same kind, and rejects rows missing ms or reason (round 3)', () => {
    const f = { ...fb('command-not-allowed', 10), lane: 'lane-9' };
    const run = (l) => computeForgeShare({ ...base, remoteRuns: [remote()], localRuns: [l], fallbacks: [f] });
    expect(run({ ...local(5, 1000), lane: '9', kind: 'standards' }).runs.expectedLocal).toBe(0);
    expect(run({ at: at(5), lane: '9', kind: 'files' })).toMatchObject({ status: 'unknown', unknownReason: 'malformed-rows:localRuns' });
    expect(computeForgeShare({ ...base, remoteRuns: [remote()], localRuns: [local()], fallbacks: [{ ts: at(5) }] })).toMatchObject({ status: 'unknown', unknownReason: 'malformed-rows:fallbacks' });
  });
  it('secondsShare is null (not 0) when a remote run has no duration', () => {
    const r = computeForgeShare({ ...base, remoteRuns: [{ ts: at(5) }], localRuns: [local(5, 1000)], fallbacks: [] });
    expect(r).toMatchObject({ status: 'ok', share: 0.5, secondsShare: null });
  });
  it('reports held-seconds share too', () => {
    const r = computeForgeShare({ ...base, remoteRuns: [remote(5, 90_000)], localRuns: [local(5, 10_000)], fallbacks: [] });
    expect(r.seconds).toEqual({ remote: 90, local: 10 });
    expect(r.secondsShare).toBeCloseTo(0.9);
  });
  it('rejects a bad target or window as unknown', () => {
    expect(computeForgeShare({ ...base, target: 'x', remoteRuns: [], localRuns: [], fallbacks: [] }).status).toBe('unknown');
    expect(computeForgeShare({ ...base, windowMs: 0, remoteRuns: [], localRuns: [], fallbacks: [] }).status).toBe('unknown');
  });
});

describe('settings + IO', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-share-'));
  const write = (n, body) => { const f = join(dir, n); writeFileSync(f, body); return f; };
  it('loads defaults from the settings file and rejects invalid values', () => {
    const f = write('ok.json', JSON.stringify({ target: 0.9, windowMinutes: 60, alertAfterMinutes: 60, expectedLocalReasons: ['command-not-allowed'] }));
    expect(loadForgeShareSettings({ file: f })).toEqual({ target: 0.9, windowMs: 3_600_000, alertAfterMs: 3_600_000, expectedLocalReasons: ['command-not-allowed'] });
    expect(() => loadForgeShareSettings({ file: write('bad.json', JSON.stringify({ target: 2, windowMinutes: 60, alertAfterMinutes: 60, expectedLocalReasons: [] })) })).toThrow();
    expect(() => loadForgeShareSettings({ file: join(dir, 'missing.json') })).toThrow();
  });
  it('reads the three logs; a missing remote-runs log is null, torn lines are skipped', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-lock-'));
    writeFileSync(join(root, 'remote-fallbacks.jsonl'), `${JSON.stringify(fb('remote-full'))}\n{torn`);
    writeFileSync(join(root, 'durations.jsonl'), `${JSON.stringify(local())}\n`);
    const r = readForgeShareInputs({ lockRoot: root, now: NOW, windowMs: 120 * MIN });
    expect(r.remoteRuns).toBeNull();
    expect(r.fallbacks).toHaveLength(1);
    expect(r.localRuns).toHaveLength(1);
    writeFileSync(join(root, 'remote-runs.jsonl'), `${JSON.stringify(remote())}\n`);
    expect(readForgeShareInputs({ lockRoot: root, now: NOW, windowMs: 120 * MIN }).remoteRuns).toHaveLength(1);
  });
  it('a corrupt middle row, or a row with no timestamp, makes the source unreadable (audit 1)', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-corrupt-'));
    writeFileSync(join(root, 'durations.jsonl'), `${JSON.stringify(local(130))}\n{garbage\n${JSON.stringify(local())}\n`);
    expect(readForgeShareInputs({ lockRoot: root, now: NOW, windowMs: 120 * MIN }).localRuns).toBeNull();
    writeFileSync(join(root, 'durations.jsonl'), `${JSON.stringify(local(130))}\n${JSON.stringify({ ms: 5 })}\n${JSON.stringify(local())}\n`);
    expect(readForgeShareInputs({ lockRoot: root, now: NOW, windowMs: 120 * MIN }).localRuns).toBeNull();
  });
  it('an unparseable first or timestamp-less last row of a fully read log is corrupt (audit 1)', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-edge-'));
    const read = () => readForgeShareInputs({ lockRoot: root, now: NOW, windowMs: 120 * MIN }).localRuns;
    writeFileSync(join(root, 'durations.jsonl'), `{bad\n${JSON.stringify(local())}\n`);
    expect(read()).toBeNull();
    writeFileSync(join(root, 'durations.jsonl'), `${JSON.stringify(local())}\n${JSON.stringify({ ms: 1 })}`);
    expect(read()).toBeNull();
    writeFileSync(join(root, 'durations.jsonl'), `${JSON.stringify(local())}\n{torn`);
    expect(read()).toHaveLength(1);
  });
  it('a fully-read log whose oldest row is newer than the window start is NOT covered (rotation, audit 2)', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-rot-'));
    for (const f of ['remote-fallbacks.jsonl', 'remote-runs.jsonl', 'durations.jsonl']) writeFileSync(join(root, f), `${JSON.stringify({ ts: at(1), at: at(1) })}\n`);
    expect(readForgeShareInputs({ lockRoot: root, now: NOW, windowMs: 120 * MIN }).coverage).toEqual({ fallbacks: false, localRuns: false, remoteRuns: false });
    writeFileSync(join(root, 'durations.jsonl'), `${JSON.stringify({ at: at(200) })}\n${JSON.stringify({ at: at(1) })}\n`);
    expect(readForgeShareInputs({ lockRoot: root, now: NOW, windowMs: 120 * MIN }).coverage.localRuns).toBe(true);
  });
  it('probeForgeShare never throws: a bad lock root or settings reads as unknown', () => {
    const p = probeForgeShare({ lockRoot: join(dir, 'nope'), settingsFile: join(dir, 'missing.json'), now: NOW });
    expect(p.current.status).toBe('unknown');
    expect(p.earlier.status).toBe('unknown');
  });
});
