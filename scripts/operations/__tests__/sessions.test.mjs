/** Card 128 S1 — SessionRow contract: state/kind mapping + toSessionRow + live-work carrying lane/model/executor. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapState, mapKind, toSessionRow } from '../sessions.mjs';
import { assessLiveWork } from '../live-work.mjs';
import { resolveAgentActivity } from '../agent-activity.mjs';
import { leasesFromLanePoolStatus, readJobIndex, modelFromRespawnFlags, interactiveRows } from '../agent-activity-io.mjs';

describe('mapState (the operator four-state vocabulary)', () => {
  it.each([
    ['working', 'working', 'active'], ['idle-too-long', 'working', 'quiet'],
    ['waiting-for-test-slot', 'awaiting-verify', 'waiting-slot'],
    ['blocked-permission', 'blocked', 'permission'], ['dead', 'blocked', 'dead'],
    ['done', 'done', 'done-ok'],
  ])('%s -> %s (%s)', (input, state, detail) => {
    expect(mapState(input)).toEqual({ state, detail });
  });
});

describe('mapKind', () => {
  it('passes the roles, maps session to chat, everything else to other', () => {
    expect(mapKind('prepare')).toBe('prepare');
    expect(mapKind('session')).toBe('chat');
    expect(mapKind('background')).toBe('other');
    expect(mapKind('unknown')).toBe('other');
  });
});

describe('prepare-item role', () => {
  it('prepare-item-4708 resolves to kind prepare, not unknown', () => {
    const { runs } = resolveAgentActivity([{ id: 'r1', sessionId: 's1', name: 'prepare-item-4708', runtime: 'claude', kind: 'background' }]);
    expect(runs[0].role).toBe('prepare');
  });
});

describe('live-work carries lane / executor / model', () => {
  const NOW = Date.parse('2026-10-07T12:00:00Z');
  const read = {
    observedAt: new Date(NOW).toISOString(), prToCard: {}, heavyQueue: { rows: [] },
    rows: [{
      id: 'r1', sessionId: 's1', name: 'prepare-item-4708', runtime: 'claude', kind: 'background', model: 'sonnet',
      lease: { purpose: 'x', session: 'y', ownerSession: 's1', lane: 8, repo: 'web-everything' },
      lastActivityAt: NOW - 1000, pidAlive: true,
    }],
  };
  it('puts lane, executor, model, name on the row, and toSessionRow projects them', () => {
    const [row] = assessLiveWork(read).running;
    expect(row.lane).toEqual({ repo: 'web-everything', n: 8 });
    expect(row.model).toBe('sonnet');
    expect(row.executor).toBe('claude');
    const s = toSessionRow(row);
    expect(s).toMatchObject({ kind: 'prepare', executor: 'claude', model: 'sonnet', lane: { repo: 'web-everything', n: 8 },
      state: 'working', endedAt: null, transcript: { ref: 'r1' } });
  });
  it('subagents are not sessions', () => {
    expect(toSessionRow({ runId: 'x', kind: 'subagent', state: 'working' })).toBeNull();
  });
});

describe('lease lane + job index', () => {
  it('leasesFromLanePoolStatus keeps the lane number and repo', () => {
    const out = leasesFromLanePoolStatus({ repo: 'web-everything', lanes: [{ lane: 3, lease: null }, { lane: 8, lease: { purpose: 'p' } }] });
    expect(out).toEqual([{ purpose: 'p', lane: 8, repo: 'web-everything' }]);
  });
  it('modelFromRespawnFlags reads --model', () => {
    expect(modelFromRespawnFlags(['-n', 'x', '--model', 'opus[1m]'])).toBe('opus[1m]');
    expect(modelFromRespawnFlags(['-n', 'x'])).toBeNull();
  });
  it('an interactive transcript whose sessionId is a job is background (with its name/model), not a chat', () => {
    const jobs = mkdtempSync(join(tmpdir(), 'jobs-'));
    const sid = '11111111-1111-1111-1111-111111111111';
    const other = '22222222-2222-2222-2222-222222222222';
    mkdirSync(join(jobs, 'aaaa1111'));
    writeFileSync(join(jobs, 'aaaa1111', 'state.json'), JSON.stringify({ sessionId: sid, name: 'fix-4271', respawnFlags: ['--model', 'sonnet'] }));
    mkdirSync(join(jobs, 'broken'));
    writeFileSync(join(jobs, 'broken', 'state.json'), '{nope');
    const idx = readJobIndex(jobs);
    expect(idx.get(sid)).toEqual({ name: 'fix-4271', model: 'sonnet' });
    const proj = mkdtempSync(join(tmpdir(), 'proj-'));
    mkdirSync(join(proj, 'slug'));
    writeFileSync(join(proj, 'slug', `${sid}.jsonl`), '');
    writeFileSync(join(proj, 'slug', `${other}.jsonl`), '');
    const rows = interactiveRows(new Set(), proj, Date.now(), idx);
    expect(rows.find((r) => r.sessionId === sid)).toMatchObject({ kind: 'background', name: 'fix-4271', model: 'sonnet' });
    expect(rows.find((r) => r.sessionId === other).kind).toBe('interactive');
  });
});
