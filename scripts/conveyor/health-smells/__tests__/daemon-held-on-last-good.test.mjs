/**
 * @file scripts/conveyor/health-smells/__tests__/daemon-held-on-last-good.test.mjs
 * @description x5wbsbc (epic #4075) — the PURE `evaluate()` of the `daemon-held-on-last-good` smell (a daemon
 *   clone the rebuild has frozen on its last-good build after a failed live smoke, per the 2026-09-26 operator
 *   ruling to fall back rather than block delivery), its notify-scope wiring through `planActions` (still
 *   notifies even in shadow mode — a previously-approved sign the Sun 2026-09-27 `notify-list.mjs` addition
 *   carries forward unchanged, see that file's header), and `health-watch.mjs#probeSelfSync`'s pass-through of
 *   `state.held` from a real `<cloneKey>.rebuild.json` file.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import daemonHeldOnLastGood, { MAX_HELD_AGE_MS } from '../daemon-held-on-last-good.mjs';
import {
  MINUTE, HOUR, emptyHealthState, stepEpisodes, planActions, runHealthTick,
} from '../../health-watch-core.mjs';
import { probeSelfSync } from '../../health-watch.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../../health-smells-notify-list.mjs';

const NOW = Date.parse('2026-09-26T20:00:00Z');

const clone = (cloneKey, held) => ({ cloneKey, alerts: [], rebuild: { held } });

describe('last-good hold alarm contract', () => {
  const held = (minutes, extra = {}) => ({ since: NOW - minutes * MINUTE,
    reason: 'smoke-rejected', failed: 'live-smoke', lastGood: 'abc123', target: 'def456', ...extra });
  const tick = (rows, state = emptyHealthState(), now = NOW) => runHealthTick(state,
    { selfSync: rows }, [daemonHeldOnLastGood], now);
  // The same action plan consumed by the health-watch alert sink, with all IO replaced by this collector.
  const sink = (result) => result.plan.filter(p => p.kind === 'notify' && p.suppressed === null)
    .map(p => result.state.episodes[p.key].measure);

  it('ten-hour last-good hold remains actionable and reaches the alert sink', () => {
    const result = tick([clone('incident-7472', held(600))]);
    expect(sink(result)).toEqual([expect.objectContaining({ daemon: 'incident-7472', lastGood: 'abc123',
      target: 'def456', heldMs: 10 * HOUR, heldReason: 'smoke-rejected', failedChecks: 'live-smoke',
      episodeId: expect.any(String), uncertainty: [] })]);
  });

  it.each([29, 30, 31])('keeps the earlier sign actionable at %i minutes', (minutes) => {
    const result = tick([clone('boundary', held(minutes))]);
    expect(sink(result)).toEqual([expect.objectContaining({ heldMs: minutes * MINUTE })]);
  });

  it('ancient state emits uncertainty alongside the actionable hold', () => {
    const result = tick([clone('ancient', held(25 * 60))]);
    expect(sink(result)).toEqual([expect.objectContaining({ overMaxAge: true, uncertainty: ['ancient-hold'] })]);
    expect(result.evaluations[0].results[0].recommendation).toMatch(/inspect.*rebuild/i);
  });

  it.each([null, 'not-a-date', NaN, NOW + MINUTE, 1e30])('reports uncertain since %s without throwing or going healthy', (since) => {
    const result = tick([clone('unknown', held(31, { since }))]);
    expect(result.evaluations[0].error).toBeUndefined();
    expect(sink(result)).toEqual([expect.objectContaining({ heldMs: null, heldSinceIso: null,
      uncertainty: expect.arrayContaining(['invalid-since']), episodeId: expect.any(String) })]);
  });

  it('oversized evidence stays actionable with a bounded diagnostic and inspect/rebuild fallback', () => {
    const result = tick([clone('large', held(31, { failed: 'x'.repeat(100_000) }))]);
    const [record] = sink(result);
    expect(record.uncertainty).toContain('oversized-failed');
    expect(record.failedChecks.length).toBeLessThanOrEqual(4096);
    expect(result.evaluations[0].results[0].recommendation).toMatch(/inspect.*rebuild/i);
  });

  it('adoption closes exactly the matching hold; repeated ticks dedupe and a new hold has a new identity', () => {
    const rows = [clone('one', held(31)), clone('two', held(31))];
    const first = tick(rows);
    const repeated = tick([clone('one', held(31, { target: 'new-target' })), rows[1]], first.state, NOW + MINUTE);
    expect(sink(repeated)).toEqual([]);
    const firstId = first.state.episodes['daemon-held-on-last-good::clone:one'].measure.episodeId;
    expect(repeated.state.episodes['daemon-held-on-last-good::clone:one'].measure.episodeId).toBe(firstId);
    const adopted = { cloneKey: 'one', rebuild: { held: null, adopted: { at: NOW + 2 * MINUTE, head: 'new-target' } } };
    const closed = tick([adopted, rows[1]], repeated.state, NOW + 2 * MINUTE);
    expect(closed.transitions.filter(t => t.type === 'closed').map(t => t.episode.subject)).toEqual(['clone:one']);
    expect(closed.state.episodes['daemon-held-on-last-good::clone:two']).toBeDefined();
    const next = tick([clone('one', held(0)), rows[1]], closed.state, NOW + 31 * MINUTE);
    expect(sink(next)[0].episodeId).not.toBe(firstId);
  });

  it('malformed non-array selfSync advances the evaluator-error streak and exposes the failure', () => {
    const first = tick([clone('fixture-daemon', held(31))]);
    const errorKey = `smell:${daemonHeldOnLastGood.id}`;
    const state = { ...first.state, probeErrors: { [errorKey]: { count: 2, last: 'previous failure' } } };
    const result = tick({ malformed: true }, state, NOW + MINUTE);
    expect(result.state.probeErrors[errorKey]).toEqual({ count: 3, last: expect.stringMatching(/selfSync.*array/i) });
    expect(result.evaluations[0]).toMatchObject({ results: null, error: expect.stringMatching(/selfSync.*array/i) });
    expect(result.state.episodes).toEqual(first.state.episodes);
    expect(result.transitions).toEqual([]);
  });

  it('missing selfSync preserves the evaluator-error streak until a successful sample', () => {
    const first = tick([clone('fixture-daemon', held(31))]);
    const errorKey = `smell:${daemonHeldOnLastGood.id}`;
    const failedOnce = tick({ malformed: true }, first.state, NOW + MINUTE);
    const failedTwice = tick({ malformed: true }, failedOnce.state, NOW + 2 * MINUTE);
    expect(failedTwice.state.probeErrors[errorKey].count).toBe(2);

    const missing = runHealthTick(failedTwice.state, {}, [daemonHeldOnLastGood], NOW + 3 * MINUTE);
    expect(missing.state.probeErrors[errorKey]).toEqual(failedTwice.state.probeErrors[errorKey]);
    expect(missing.evaluations[0].results[0].measure.uncertainty).toContain('unconfirmed-adoption');
    expect(missing.transitions.some(t => t.type === 'closed')).toBe(false);

    const failedAgain = tick({ malformed: true }, missing.state, NOW + 4 * MINUTE);
    expect(failedAgain.state.probeErrors[errorKey].count).toBe(3);
    const recovered = tick([clone('fixture-daemon', held(31))], failedAgain.state, NOW + 5 * MINUTE);
    expect(recovered.state.probeErrors[errorKey]).toBeUndefined();
  });

  it('same-head recovery closes the episode so a later hold notifies again', () => {
    const first = tick([clone('fixture-daemon', held(31))]);
    const [firstRecord] = sink(first);
    const recovered = tick([{ cloneKey: 'fixture-daemon', rebuild: { held: null,
      adopted: { at: NOW + MINUTE, head: firstRecord.lastGood } } }], first.state, NOW + MINUTE);
    expect(recovered.transitions.filter(t => t.type === 'closed').map(t => t.episode.subject))
      .toEqual(['clone:fixture-daemon']);
    expect(recovered.state.episodes['daemon-held-on-last-good::clone:fixture-daemon']).toBeUndefined();
    const next = tick([clone('fixture-daemon', held(31, { since: NOW + 2 * MINUTE }))],
      recovered.state, NOW + 33 * MINUTE);
    expect(sink(next)).toHaveLength(1);
    expect(sink(next)[0].daemon).toBe('fixture-daemon');
    expect(sink(next)[0].episodeId).not.toBe(firstRecord.episodeId);
  });

  it.each([
    { rows: [] },
    { rows: [{ cloneKey: 'one', rebuild: null }] },
    { rows: [{ cloneKey: 'one', rebuild: { held: null } }] },
    { rows: [{ cloneKey: 'one', rebuild: { held: null, adopted: { at: NOW - HOUR, head: 'def456' } } }] },
    // Same-head recovery is valid when fresh (tested above); this adoption predates the hold.
    { rows: [{ cloneKey: 'one', rebuild: { held: null, adopted: { at: NOW - HOUR, head: 'abc123' } } }] },
  ])('missing or stale adoption evidence does not close an owed hold (%j)', ({ rows }) => {
    const first = tick([clone('one', held(31))]);
    const result = tick(rows, first.state, NOW + MINUTE);
    expect(result.evaluations[0].error).toBeUndefined();
    expect(result.transitions.some(t => t.type === 'closed')).toBe(false);
    expect(result.state.episodes['daemon-held-on-last-good::clone:one'].measure.uncertainty.length).toBeGreaterThan(0);
  });

  it('replays the ten-hour incident and synthetic 31-minute hold from isolated state files into the health feed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'last-good-replay-'));
    try {
      for (const [name, minutes] of [['incident-7472', 600], ['synthetic-31m', 31]]) {
        const state = held(minutes);
        writeFileSync(join(dir, `${name}.rebuild.json`), JSON.stringify({ held: { ...state,
          since: new Date(state.since).toISOString() } }));
      }
      const records = sink(tick(probeSelfSync(dir)));
      expect(records.map(r => [r.daemon, r.heldMs])).toEqual([
        ['incident-7472', 10 * HOUR], ['synthetic-31m', 31 * MINUTE],
      ]);
      console.info('last-good health-feed replay:', JSON.stringify(records));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('daemon-held-on-last-good — evaluate', () => {
  it('breaches once held past heldForMs (16 min) and names the failing check(s) + reason in the summary', () => {
    const held = {
      since: NOW - 16 * MINUTE, reason: 'smoke-harness-broken', failed: 'lane-acquire-release', lastGood: 'abc123def4567890', target: 'def456789abc', mainSha: 'xyz',
    };
    const out = daemonHeldOnLastGood.evaluate({ selfSync: [clone('x', held)] }, { now: NOW });
    const r = out.find((x) => x.subject === 'clone:x');
    expect(r.breach).toBe(true);
    expect(r.summary).toMatch(/smoke-harness-broken/);
    expect(r.summary).toMatch(/lane-acquire-release/);
    expect(r.summary).toMatch(/abc123def456/);
    expect(r.summary).toMatch(/still dispatching from it/);
    expect(r.measure.heldMin).toBe(16);
    expect(r.measure.failedChecks).toBe('lane-acquire-release');
  });

  it('does not breach yet at 10 minutes held', () => {
    const held = { since: NOW - 10 * MINUTE, reason: 'smoke-rejected', failed: 'tree-stays-clean', lastGood: 'abc123', target: 'def456' };
    const out = daemonHeldOnLastGood.evaluate({ selfSync: [clone('x', held)] }, { now: NOW });
    const r = out.find((x) => x.subject === 'clone:x');
    expect(r.breach).toBe(false);
  });

  it('never breaches when the clone is not held at all', () => {
    const out = daemonHeldOnLastGood.evaluate({ selfSync: [clone('x', null)] }, { now: NOW });
    const r = out.find((x) => x.subject === 'clone:x');
    expect(r.breach).toBe(false);
    expect(r.measure.heldReason).toBeNull();
  });

  it('smoke-harness-broken gets the "fix the tool, not the tree" recommendation wording', () => {
    const held = {
      since: NOW - 20 * MINUTE, reason: 'smoke-harness-broken', failed: 'lane-acquire-release', lastGood: 'abc123def4567890', target: 'def456',
    };
    const out = daemonHeldOnLastGood.evaluate({ selfSync: [clone('x', held)] }, { now: NOW });
    const r = out.find((x) => x.subject === 'clone:x');
    expect(r.recommendation).toMatch(/smoke harness\/environment itself fails/);
    expect(r.recommendation).toMatch(/lane-acquire-release/);
    expect(r.recommendation).toMatch(/not the clone/);
    expect(r.recommendation).not.toMatch(/origin\/main \(or an overlay\) fails/);
  });

  it('any other reason gets the "the new tree fails" recommendation wording instead', () => {
    const held = {
      since: NOW - 20 * MINUTE, reason: 'smoke-rejected', failed: 'tree-stays-clean', lastGood: 'abc123def4567890', target: 'def456',
    };
    const out = daemonHeldOnLastGood.evaluate({ selfSync: [clone('x', held)] }, { now: NOW });
    const r = out.find((x) => x.subject === 'clone:x');
    expect(r.recommendation).toMatch(/origin\/main \(or an overlay\) fails/);
    expect(r.recommendation).toMatch(/tree-stays-clean/);
  });

  it('flags overMaxAge once held past 24h, not before', () => {
    const under = { since: NOW - 1 * HOUR, reason: 'smoke-rejected', failed: 'x', lastGood: 'abc123' };
    const over = { since: NOW - (MAX_HELD_AGE_MS + HOUR), reason: 'smoke-rejected', failed: 'x', lastGood: 'abc123' };
    const outUnder = daemonHeldOnLastGood.evaluate({ selfSync: [clone('x', under)] }, { now: NOW });
    const outOver = daemonHeldOnLastGood.evaluate({ selfSync: [clone('x', over)] }, { now: NOW });
    expect(outUnder.find((x) => x.subject === 'clone:x').measure.overMaxAge).toBe(false);
    expect(outOver.find((x) => x.subject === 'clone:x').measure.overMaxAge).toBe(true);
  });
});

describe('daemon-held-on-last-good — notify scope', () => {
  // Approved by an earlier operator decision; the Sun 2026-09-27 notify-list.mjs addition is additive and
  // never demotes a sign already approved — this one stays in NOTIFY_EVEN_IN_SHADOW unchanged.
  it('is in NOTIFY_EVEN_IN_SHADOW (a previously-approved sign, carried forward unchanged)', () => {
    expect(NOTIFY_EVEN_IN_SHADOW.has(daemonHeldOnLastGood.id)).toBe(true);
  });

  it('an "opened" transition in shadow mode yields a notify with suppressed:null (never suppressed)', () => {
    const r = stepEpisodes(emptyHealthState(), [
      { smell: daemonHeldOnLastGood, results: [{ subject: 'clone:x', breach: true }] },
    ], 0);
    const plan = planActions(r.transitions, { [daemonHeldOnLastGood.id]: daemonHeldOnLastGood }, { mode: 'shadow' });
    const notify = plan.find((p) => p.kind === 'notify' && p.key === `${daemonHeldOnLastGood.id}::clone:x`);
    expect(notify).toBeDefined();
    expect(notify.suppressed).toBeNull();
  });

  it('a smell NOT in an injected notifySet stays suppressed (the mechanism planActions uses)', () => {
    const r = stepEpisodes(emptyHealthState(), [
      { smell: daemonHeldOnLastGood, results: [{ subject: 'clone:x', breach: true }] },
    ], 0);
    const plan = planActions(r.transitions, { [daemonHeldOnLastGood.id]: daemonHeldOnLastGood },
      { mode: 'shadow', notifySet: new Set() });
    const notify = plan.find((p) => p.kind === 'notify' && p.key === `${daemonHeldOnLastGood.id}::clone:x`);
    expect(notify.suppressed).toBe('shadow mode');
  });
});

describe('probeSelfSync — passes `held` through with `since` parsed to ms', () => {
  it('reads a real <cloneKey>.rebuild.json and parses held.since', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x5wbsbc-self-sync-'));
    try {
      const sinceIso = new Date(NOW - 16 * MINUTE).toISOString();
      writeFileSync(join(dir, 'myclone.rebuild.json'), JSON.stringify({
        adopted: null,
        rejected: null,
        inProgress: null,
        quarantine: null,
        held: {
          since: sinceIso, reason: 'smoke-harness-broken', failed: 'lane-acquire-release', details: [{ name: 'lane-acquire-release', detail: 'no lanes provisioned' }], lastGood: 'abc123def4567890', target: 'def456789abc', mainSha: 'xyz', updatedAt: sinceIso,
        },
      }));
      const out = probeSelfSync(dir);
      const row = out.find((x) => x.cloneKey === 'myclone');
      expect(row).toBeTruthy();
      expect(row.rebuild.held.since).toBe(Date.parse(sinceIso));
      expect(row.rebuild.held.reason).toBe('smoke-harness-broken');
      expect(row.rebuild.held.failed).toBe('lane-acquire-release');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses an invalid `since` as null (never a false-positive timestamp)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x5wbsbc-self-sync-'));
    try {
      writeFileSync(join(dir, 'myclone.rebuild.json'), JSON.stringify({ held: { since: 'not-a-date', reason: 'smoke-transient' } }));
      const out = probeSelfSync(dir);
      const row = out.find((x) => x.cloneKey === 'myclone');
      expect(row.rebuild.held.since).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads `held: null` as null (an adopted clone)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x5wbsbc-self-sync-'));
    try {
      writeFileSync(join(dir, 'myclone.rebuild.json'), JSON.stringify({ adopted: { at: new Date(NOW).toISOString() }, held: null }));
      const out = probeSelfSync(dir);
      const row = out.find((x) => x.cloneKey === 'myclone');
      expect(row.rebuild.held).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
