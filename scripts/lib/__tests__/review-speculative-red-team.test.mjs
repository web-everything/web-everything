/**
 * Card xbizuci — `review.speculativeRedTeam`: the policy-cascade setting, the loop's read sink, and the pure
 * decision the review job takes once the review is over.
 */
import { describe, it, expect } from 'vitest';

import {
  decideSpeculativeOutcome, formatSpeculativeRedTeamSourceLine, loadSpeculativeRedTeam, resolveSpeculativeRedTeam,
  withReadSink, SPECULATIVE_RED_TEAM_ENV, TOOL_SETTINGS_FILE, PLATFORM_PREFERENCES_FILE,
} from '../review-speculative-red-team.mjs';

describe('review.speculativeRedTeam — the policy cascade', () => {
  it('defaults to on, set by the standard layer', () => {
    expect(resolveSpeculativeRedTeam({ env: {} })).toEqual({ value: 'on', enabled: true, source: 'standard', invalid: [] });
  });

  it('platform preference beats the standard; the tool override beats the platform; env beats everything', () => {
    expect(resolveSpeculativeRedTeam({ env: {}, platform: false })).toMatchObject({ enabled: false, source: 'platform' });
    expect(resolveSpeculativeRedTeam({ env: {}, platform: false, tool: 'on' })).toMatchObject({ enabled: true, source: 'tool' });
    expect(resolveSpeculativeRedTeam({ env: { [SPECULATIVE_RED_TEAM_ENV]: 'off' }, platform: true, tool: 'on' })).toMatchObject({ enabled: false, source: 'env' });
  });

  it('an invalid value never overrides a lower layer and is reported', () => {
    const r = resolveSpeculativeRedTeam({ env: { [SPECULATIVE_RED_TEAM_ENV]: 'maybe' }, tool: 'sometimes', platform: 'off' });
    expect(r).toMatchObject({ value: 'off', source: 'platform' });
    expect(r.invalid).toEqual(['env="maybe"', 'tool="sometimes"']);
    expect(formatSpeculativeRedTeamSourceLine(r)).toBe('review.speculativeRedTeam=off (platform) · ignored invalid: env="maybe"; tool="sometimes"');
  });

  it('loads the tool layer from review.json and the platform layer from the delivery preferences file (missing = unset)', () => {
    const files = {
      [TOOL_SETTINGS_FILE]: JSON.stringify({ parallelSeats: 'on' }),
      [PLATFORM_PREFERENCES_FILE]: JSON.stringify({ mergeDelivery: { strategy: 'drain-direct' }, review: { speculativeRedTeam: false } }),
    };
    const readFile = (p) => { if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[p]; };
    expect(loadSpeculativeRedTeam({ env: {}, readFile })).toMatchObject({ enabled: false, source: 'platform' });
    delete files[PLATFORM_PREFERENCES_FILE];
    expect(loadSpeculativeRedTeam({ env: {}, readFile })).toMatchObject({ enabled: true, source: 'standard' });
  });
});

describe('the loop\'s read sink', () => {
  it('writes {pr, repo, read} once, on the first store write that carries the read finding', () => {
    const written = [];
    const writes = [];
    const store = { write: (run) => { writes.push(run.id); return 'ok'; }, read: (id) => id };
    const s = withReadSink(store, '/tmp/sink.json', { write: (p, t) => written.push([p, JSON.parse(t)]) });
    expect(s.write({ id: 'r1', input: { pr: 5, repo: 'o/r' }, findings: {} })).toBe('ok');
    expect(written).toEqual([]);
    s.write({ id: 'r1', input: { pr: 5, repo: 'o/r' }, findings: { read: { netBasis: { rev: 'a' } } } });
    s.write({ id: 'r1', input: { pr: 5, repo: 'o/r' }, findings: { read: { netBasis: { rev: 'b' } } } });
    expect(written).toEqual([['/tmp/sink.json', { pr: 5, repo: 'o/r', runId: 'r1', read: { netBasis: { rev: 'a' } } }]]);
    expect(writes).toEqual(['r1', 'r1', 'r1']);
    expect(s.read('x')).toBe('x');
  });

  it('no sink → the store itself; a failing sink write never fails the review', () => {
    const store = { write: () => 'ok' };
    expect(withReadSink(store, null)).toBe(store);
    const s = withReadSink(store, '/tmp/sink.json', { write: () => { throw new Error('disk full'); } });
    expect(s.write({ findings: { read: {} } })).toBe('ok');
  });
});

describe('what the job does with the speculative pass', () => {
  it('discards on any non-accept, whatever the pass did', () => {
    for (const spec of [null, { status: 'speculated' }, { status: 'error' }]) expect(decideSpeculativeOutcome({ accepted: false, spec })).toBe('discard');
  });
  it('accept: finish a made call; a dead or errored pass is a failed red team; no call made → sequential', () => {
    expect(decideSpeculativeOutcome({ accepted: true, spec: { status: 'speculated' } })).toBe('finish');
    expect(decideSpeculativeOutcome({ accepted: true, spec: null })).toBe('failed');
    expect(decideSpeculativeOutcome({ accepted: true, spec: { status: 'error' } })).toBe('failed');
    for (const status of ['skipped', 'disabled', 'prior-row', 'no-read']) {
      expect(decideSpeculativeOutcome({ accepted: true, spec: { status } })).toBe('sequential');
    }
  });
});
