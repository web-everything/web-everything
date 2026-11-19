import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import smell from '../forge-disk-prune.mjs';
import * as forgeDiskPrune from '../forge-disk-prune.mjs';
import { emptyHealthState, stepEpisodes, planActions } from '../../health-watch-core.mjs';
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
    const out = smell.evaluate({}, { readForgeHealth: () => { throw new Error('boom\n\x1b\u2028\u202e' + 'x'.repeat(500)); } });
    expect(out[0].summary).toMatch(/unobservable/);
    expect(out[0].summary).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(out[0].summary).not.toContain('x'.repeat(81));
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
  it('default reader sees a real breach at the writer path and rejects oversized health files', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-disk-prune-'));
    vi.stubEnv('LANE_POOL_ROOT', root);
    try {
      const remote = join(root, '.admission', 'remote');
      mkdirSync(remote, { recursive: true });
      const file = join(remote, 'health-g2.json');
      const json = JSON.stringify({ telemetry: { sampledAtET: fresh, diskUsedPct: 100, prune: { consecutiveRefused: 0 } } });
      writeFileSync(file, json);
      expect(smell.evaluate({}, { now: NOW })[0].escalation?.status).toBe('needs-you');
      writeFileSync(file, json.padEnd(64 * 1024, ' '));
      expect(smell.evaluate({}, { now: NOW })[0].escalation?.status).toBe('needs-you');
      writeFileSync(file, json.padEnd(64 * 1024 + 1, ' '));
      const [oversized] = smell.evaluate({}, { now: NOW });
      expect(oversized.severity).toBe('low');
      expect(oversized.summary).toMatch(/unobservable.*exceeds.*65536/);
      const [sticky] = smell.evaluate({}, { now: NOW, episodes: { [key]: { escalation: { status: 'needs-you' } } } });
      expect(sticky.escalation?.status).toBe('needs-you');
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('default reader bounds each read to the remaining byte budget, handles short reads, and closes on errors', () => {
    const budget = 64 * 1024;
    for (const kind of ['oversized', 'short', 'invalid', 'error']) {
      const data = Buffer.from(kind === 'short' ? '{"telemetry":{}}' : kind === 'invalid' ? '{' : ' '.repeat(budget + 1));
      let cursor = 0;
      const io = {
        openSync: vi.fn(() => 17), closeSync: vi.fn(),
        readSync: vi.fn((_fd, buffer, offset, length, position) => {
          expect(position).toBeNull();
          expect(offset + length).toBeLessThanOrEqual(budget + 1);
          expect(cursor + length).toBeLessThanOrEqual(budget + 1);
          if (kind === 'error') throw new Error('read failed');
          const bytes = Math.min(length, data.length - cursor, kind === 'short' ? 3 : length);
          data.copy(buffer, offset, cursor, cursor + bytes);
          cursor += bytes;
          return bytes;
        }),
      };
      const read = () => forgeDiskPrune.defaultReadForgeHealth({ io });
      if (kind === 'short') expect(read()).toEqual({ telemetry: {} });
      else expect(read).toThrow(kind === 'oversized' ? /exceeds/ : kind === 'error' ? /read failed/ : /JSON/);
      expect(io.openSync).toHaveBeenCalledTimes(1);
      expect(io.closeSync).toHaveBeenCalledTimes(1);
      expect(io.closeSync).toHaveBeenCalledWith(17);
      expect(cursor).toBeLessThanOrEqual(budget + 1);
      expect(io.readSync).toHaveBeenCalled();
    }
  });
  it('hostile lastRefusal is printable and capped at 200 characters in the summary', () => {
    const hostile = '\n\r\x1b[31mX\x00\x7f\u0085\u2028\u2029\u200b\u202e`"--../' + 'x'.repeat(500);
    const [f] = run({ diskUsedPct: 100, prune: { consecutiveRefused: 3, lastRefusal: hostile } });
    expect(f.measure.lastRefusal).toHaveLength(200);
    expect(f.summary).toContain(`last prune refusal: ${f.measure.lastRefusal}.`);
    expect(f.summary).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(f.measure.lastRefusal).toContain('`"--../');
  });
  it.each(['fresh note', 'persisted high note'])('unobservable episode stays low and later breach notifies once: %s', (kind) => {
    const tick = (state, telemetry, now) => stepEpisodes(state, [{ smell, results: smell.evaluate({}, {
      now, episodes: state.episodes, readForgeHealth: () => ({ telemetry: { sampledAtET: fresh, ...telemetry } }),
    }) }], now);
    const note = tick(emptyHealthState(), {}, NOW);
    expect(note.state.episodes[key].severity).toBe('low');
    expect(planActions(note.transitions, { [smell.id]: smell }).filter(p => p.kind === 'notify')).toEqual([]);
    if (kind === 'persisted high note') note.state.episodes[key].severity = 'high';
    const breach = tick(note.state, { diskUsedPct: 100, prune: { consecutiveRefused: 0 } }, NOW + 1);
    expect(breach.state.episodes[key]).toMatchObject({ severity: 'high', escalation: { status: 'needs-you' } });
    expect(planActions(breach.transitions, { [smell.id]: smell }).filter(p => p.kind === 'notify')).toEqual([
      expect.objectContaining({ key, suppressed: null, reason: 'escalated' }),
    ]);
    const missing = tick(breach.state, {}, NOW + 2);
    expect(missing.state.episodes[key]).toMatchObject({ severity: 'high', escalation: { status: 'needs-you' } });
    expect(planActions(missing.transitions, { [smell.id]: smell })).toEqual([]);
    const healthy = { diskUsedPct: 30, prune: { consecutiveRefused: 0 } };
    const clean = tick(missing.state, healthy, NOW + 3);
    expect(tick(clean.state, healthy, NOW + 4).state.episodes[key]).toBeUndefined();
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
