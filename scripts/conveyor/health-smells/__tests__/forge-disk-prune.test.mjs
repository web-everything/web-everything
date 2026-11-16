import { describe, it, expect } from 'vitest';
import smell from '../forge-disk-prune.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../../health-smells-notify-list.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';

const NOW = Date.parse('2026-11-15T20:00:00-05:00');
const fresh = '2026-11-15T19:55:00.000-05:00';
const run = (telemetry) => smell.evaluate({}, { now: NOW, readForgeHealth: () => (telemetry === undefined ? null : { telemetry: telemetry && { sampledAtET: fresh, ...telemetry } }) });
const refusal = 'forge-cache-prune: refused: Invalid reserved lock evidence';

describe('forge-disk-prune smell', () => {
  it('has a valid shape and notifies even in shadow', () => {
    expect(() => validateSmellShape(smell, 'forge-disk-prune.mjs')).not.toThrow();
    expect(NOTIFY_EVEN_IN_SHADOW.has('forge-disk-prune')).toBe(true);
  });
  it('disk 100% -> needs-you naming reason, percent, last refusal and next step', () => {
    const [f] = run({ diskUsedPct: 100, prune: { consecutiveRefused: 469, lastRefusal: refusal } });
    expect(f.breach).toBe(true);
    expect(f.escalation).toMatchObject({ humanOnly: true, status: 'needs-you' });
    expect(f.summary).toMatch(/100%/);
    expect(f.summary).toContain('Invalid reserved lock evidence');
    expect(f.recommendation).toMatch(/prune/i);
  });
  it('disk at exactly 80% fires; 79% alone does not', () => {
    expect(run({ diskUsedPct: 80, prune: { consecutiveRefused: 0 } })[0].breach).toBe(true);
    expect(run({ diskUsedPct: 79, prune: { consecutiveRefused: 0 } })[0].breach).toBe(false);
  });
  it('prune refused 3 consecutive runs -> needs-you even with a healthy disk', () => {
    const [f] = run({ diskUsedPct: 35, prune: { consecutiveRefused: 3, lastRefusal: refusal } });
    expect(f.breach).toBe(true);
    expect(f.escalation.status).toBe('needs-you');
    expect(f.summary).toMatch(/3 consecutive/);
  });
  it('healthy -> nothing breaching', () => {
    const out = run({ diskUsedPct: 35, prune: { consecutiveRefused: 2 } });
    expect(out.every((f) => f.breach === false)).toBe(true);
  });
  it('fields missing -> low-severity unobservable note, never silence', () => {
    for (const t of [{ cores: 32 }, undefined, { diskUsedPct: 'x', prune: {} }]) {
      const out = run(t);
      expect(out).toHaveLength(1);
      expect(out[0].breach).toBe(true);
      expect(out[0].severity).toBe('low');
      expect(out[0].summary).toMatch(/unobservable/);
      expect(out[0].escalation).toBeUndefined();
    }
  });
  it('a throwing reader is a note, not a crash', () => {
    const out = smell.evaluate({}, { readForgeHealth: () => { throw new Error('boom'); } });
    expect(out[0].summary).toMatch(/unobservable/);
  });
  it('missing health file -> note on the SAME subject (never closes an open episode); not applicable only under test', () => {
    const enoent = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
    expect(smell.evaluate({}, { readForgeHealth: enoent })).toEqual([]);
    const prev = process.env.VITEST; delete process.env.VITEST;
    try {
      const out = smell.evaluate({}, { readForgeHealth: enoent });
      expect(out[0]).toMatchObject({ subject: 'forge-disk-prune', breach: true, severity: 'low' });
      expect(out[0].summary).toMatch(/no remote health file/);
    } finally { process.env.VITEST = prev; }
  });
  it('breach and unobservable note share one subject', () => {
    expect(run({ diskUsedPct: 100, prune: { consecutiveRefused: 0 } })[0].subject).toBe(run({ cores: 1 })[0].subject);
  });
  it('a breach in one metric still escalates when the other is missing', () => {
    const [f] = run({ diskUsedPct: 100 });
    expect(f.breach).toBe(true);
    expect(f.escalation.status).toBe('needs-you');
    const [g] = run({ prune: { consecutiveRefused: 5, lastRefusal: refusal } });
    expect(g.escalation.status).toBe('needs-you');
  });
  it('a stale or undated healthy sample is an unobservable note, never an all-clear', () => {
    const old = smell.evaluate({}, { now: NOW, readForgeHealth: () => ({ telemetry: { sampledAtET: '2000-01-01T00:00:00.000-05:00', diskUsedPct: 10, prune: { consecutiveRefused: 0 } } }) });
    expect(old[0].severity).toBe('low');
    expect(old[0].summary).toMatch(/stale/);
    const undated = smell.evaluate({}, { now: NOW, readForgeHealth: () => ({ telemetry: { diskUsedPct: 10, prune: { consecutiveRefused: 0 } } }) });
    expect(undated[0].summary).toMatch(/unobservable/);
  });
  it('default reader targets the writer path (<dirname(lockRoot)>/remote/health.json)', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('scripts/conveyor/health-smells/forge-disk-prune.mjs', 'utf8')).toMatch(/dirname\(admissionLockRoot/);
  });
  const key = 'forge-disk-prune::forge-disk-prune';
  const withEpisode = (telemetry, episodes) => smell.evaluate({}, { now: NOW, episodes, readForgeHealth: () => ({ telemetry }) });
  it('R952 sticky: open needs-you + telemetry missing -> still needs-you "breach open, telemetry now missing"', () => {
    for (const t of [null, { cores: 1 }, { sampledAtET: '2000-01-01T00:00:00.000-05:00', diskUsedPct: 10, prune: { consecutiveRefused: 0 } }]) {
      const [f] = withEpisode(t, { [key]: { escalation: { status: 'needs-you' } } });
      expect(f.breach).toBe(true);
      expect(f.escalation).toMatchObject({ humanOnly: true, status: 'needs-you' });
      expect(f.summary).toMatch(/breach open, telemetry now missing/);
    }
  });
  it('R952 sticky: a valid healthy fresh reading clears an open episode', () => {
    const [f] = withEpisode({ sampledAtET: fresh, diskUsedPct: 30, prune: { consecutiveRefused: 0 } }, { [key]: { escalation: { status: 'needs-you' } } });
    expect(f.breach).toBe(false);
  });
  it('R952 no open breach + missing telemetry stays the low note', () => {
    const [f] = withEpisode(null, {});
    expect(f.severity).toBe('low');
    expect(f.escalation).toBeUndefined();
  });
  it('R952 negative / non-numeric / over-100 readings are invalid -> unobservable, never no-breach', () => {
    for (const t of [{ diskUsedPct: -1, prune: { consecutiveRefused: 0 } }, { diskUsedPct: 10, prune: { consecutiveRefused: -1 } }, { diskUsedPct: '90', prune: { consecutiveRefused: 0 } }, { diskUsedPct: 250, prune: { consecutiveRefused: 0 } }]) {
      const [f] = run(t);
      expect(f.breach).toBe(true);
      expect(f.severity).toBe('low');
      expect(f.summary).toMatch(/unobservable/);
    }
  });
  it('R952 sticky holds even under test when the health file is missing and an episode is open', () => {
    const enoent = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
    const [f] = smell.evaluate({}, { episodes: { [key]: { escalation: { status: 'needs-you' } } }, readForgeHealth: enoent });
    expect(f.escalation.status).toBe('needs-you');
  });
});
