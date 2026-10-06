/**
 * @file scripts/conveyor/health-smells/__tests__/build-supervision.test.mjs
 * @description Fixture tests for the four build/prepare supervision smells and their probes
 *   (`we:scripts/conveyor/build-supervision.mjs`). Pure fixtures + a throwaway temp dir; nothing reads the host.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMELLS } from '../index.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../../health-smells-notify-list.mjs';
import { parseBuildSessionName, mostRepeatedCommand, probeBuildSessions, probeExternalRuns } from '../../build-supervision.mjs';

const MIN = 60_000;
const byId = (id) => SMELLS.find((s) => s.id === id);
const run = (id, probes) => byId(id).evaluate.call(byId(id), probes);
const bash = (command) => ({ blocks: [{ kind: 'tool_use', name: 'Bash', rawInput: { command } }] });
const row = (over = {}) => ({ name: 'conveyor-4452', kind: 'build', card: '4452', pr: { number: 4100 }, state: 'working', ageMs: 5 * MIN,
  idleMs: 1 * MIN, pendingToolCall: false, repeated: null, transcriptPath: '/t.jsonl', ...over });

describe('registration', () => {
  for (const id of ['build-session-idle', 'build-session-overrun', 'build-session-looping', 'external-run-stalled']) {
    it(`${id} is discovered, shape-valid, detection-only and notifies`, () => {
      expect(byId(id)).toBeTruthy();
      expect(() => validateSmellShape(byId(id), id)).not.toThrow();
      expect(byId(id).action).toBe('alert');
      expect(NOTIFY_EVEN_IN_SHADOW.has(id)).toBe(true);
    });
  }
});

describe('parseBuildSessionName', () => {
  it('maps build and prepare slugs; ignores others', () => {
    expect(parseBuildSessionName('conveyor-4452')).toEqual({ kind: 'build', num: '4452' });
    expect(parseBuildSessionName('prepare-item-4773')).toEqual({ kind: 'prepare', num: '4773' });
    expect(parseBuildSessionName('fix-2735')).toBeNull();
  });
});

describe('build-session-idle', () => {
  it('breaches at 12 min idle, names session/card/PR, not below', () => {
    const [hit] = run('build-session-idle', { buildSessions: [row({ idleMs: 13 * MIN })] });
    expect(hit.breach).toBe(true);
    expect(hit.subject).toBe('session:conveyor-4452');
    expect(hit.summary).toMatch(/conveyor-4452.*#4452.*PR #4100.*13 min/);
    expect(run('build-session-idle', { buildSessions: [row({ idleMs: 11 * MIN })] })[0].breach).toBe(false);
  });
  it('skips a session whose transcript could not be read (never guessed idle)', () => {
    expect(run('build-session-idle', { buildSessions: [row({ idleMs: null })] })).toEqual([]);
  });
});

describe('build-session-overrun', () => {
  it('breaches at 60 min, not at 59', () => {
    expect(run('build-session-overrun', { buildSessions: [row({ ageMs: 61 * MIN })] })[0].breach).toBe(true);
    expect(run('build-session-overrun', { buildSessions: [row({ ageMs: 59 * MIN })] })[0].breach).toBe(false);
  });
});

describe('build-session-looping', () => {
  it('mostRepeatedCommand counts normalised Bash commands', () => {
    const e = [bash('npm  test'), bash('ls'), bash('npm test'), bash('npm test'), bash(' npm test ')];
    expect(mostRepeatedCommand(e)).toEqual({ command: 'npm test', count: 4 });
  });
  it('breaches at 4 repeats with the command as evidence, not at 3', () => {
    const [hit] = run('build-session-looping', { buildSessions: [row({ repeated: { command: 'npm test', count: 4 } })] });
    expect(hit.breach).toBe(true);
    expect(hit.measure.command).toBe('npm test');
    expect(run('build-session-looping', { buildSessions: [row({ repeated: { command: 'npm test', count: 3 } })] })[0].breach).toBe(false);
  });
});

describe('probeBuildSessions', () => {
  it('keeps only live build/prepare sessions and joins a PR by card number', () => {
    const now = Date.parse('2026-10-06T13:00:00Z');
    const rows = probeBuildSessions([
      { name: 'conveyor-4452', state: 'working', startedAt: '2026-10-06T12:00:00Z', cwd: '/c', sessionId: 's' },
      { name: 'prepare-item-9', state: 'done', startedAt: '2026-10-06T12:00:00Z' },
      { name: 'fix-1', state: 'working' },
    ], { nowMs: now, prs: [{ number: 77, title: 'Build #4452 thing', headRefName: 'lane/x' }],
      read: () => ({ lastActivityMs: now - 20 * MIN, pendingToolCall: false, repeated: null, file: '/t' }) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ card: '4452', ageMs: 60 * MIN, idleMs: 20 * MIN, pr: { number: 77 } });
  });
});

describe('external-run-stalled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extrun-'));
  const runs = join(dir, 'runs'); const lanes = join(dir, 'lanes');
  mkdirSync(runs, { recursive: true });
  const now = Date.now();
  const rec = (id, effect) => writeFileSync(join(runs, `dispatch-lane-${id}.json`), JSON.stringify({ id, effects: [effect] }));
  const eff = (over = {}) => ({ status: 'in-flight', handle: 'pid:4242', startedAt: new Date(now - 30 * MIN).toISOString(),
    dispatch: { executor: 'codex', launchKind: 'prepare-item' }, payload: { num: '4773', lane: 20, pr: null }, ...over });
  const log = (lane, ageMin) => {
    const d = join(lanes, 'web-everything', `lane-${lane}`, '.git'); mkdirSync(d, { recursive: true });
    const p = join(d, 'codex-direct-task.jsonl'); writeFileSync(p, 'x');
    const t = (now - ageMin * MIN) / 1000; utimesSync(p, t, t);
  };
  rec('stalled', eff()); log(20, 25);
  rec('active', eff({ payload: { num: '1', lane: 21 } })); log(21, 2);
  rec('unconfirmed', eff({ handle: null, startedAt: new Date(now - 15 * MIN).toISOString(), payload: { num: '2', lane: 22 } }));
  rec('claude', eff({ dispatch: { executor: 'claude' } }));
  rec('dead', eff({ handle: 'pid:1' }));
  const probe = () => probeExternalRuns({ runsDir: runs, lanesRoot: lanes, nowMs: now, isAlive: (p) => p !== 1 });

  it('probe returns external in-flight live runs only', () => {
    expect(probe().map((r) => r.runId).sort()).toEqual(['active', 'stalled', 'unconfirmed']);
  });
  it('flags the silent run and the unconfirmed launch, not the active one', () => {
    const out = Object.fromEntries(run('external-run-stalled', { externalRuns: probe() }).map((r) => [r.subject, r]));
    expect(out['run:stalled'].breach).toBe(true);
    expect(out['run:stalled'].summary).toMatch(/codex prepare-item \(card #4773, lane-20\).*25 min/);
    expect(out['run:unconfirmed'].breach).toBe(true);
    expect(out['run:unconfirmed'].summary).toMatch(/never confirmed/);
    expect(out['run:active'].breach).toBe(false);
  });
  it('a missing records dir yields no rows, never throws', () => {
    expect(probeExternalRuns({ runsDir: join(dir, 'nope'), lanesRoot: lanes })).toEqual([]);
  });
});
