/**
 * Card xjddimd (epic x8juafk) — replay fixtures for the delivery priority class rule. Each fixture is facts +
 * settings in, exact class (and order, score, invalid settings when given) out. The runner also proves it FAILS on a
 * deliberately broken rule, so a passing replay means something.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  deliveryPriority, rankByDeliveryPriority, resolvePrioritySettings, PRIORITY_SETTINGS_OFF,
} from '../delivery-priority.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(readFileSync(join(HERE, 'fixtures', 'delivery-priority.replay.json'), 'utf8')).fixtures;
const SETTINGS_FILE = JSON.parse(readFileSync(join(HERE, '..', 'delivery-priority-settings.json'), 'utf8'));

/** Replay one fixture through `rank`; returns the list of mismatches (empty = pass). */
function replay(fixture, rank = rankByDeliveryPriority) {
  const now = Date.parse(fixture.now);
  const ranked = rank(fixture.items, fixture.settings, now);
  const byId = new Map(ranked.map((r) => [String(r.id), r]));
  const misses = [];
  for (const [id, cls] of Object.entries(fixture.expect ?? {})) {
    if (byId.get(id)?.class !== cls) misses.push(`#${id}: expected ${cls}, got ${byId.get(id)?.class}`);
  }
  if (fixture.expectOrder) {
    const order = ranked.map((r) => r.id);
    if (JSON.stringify(order) !== JSON.stringify(fixture.expectOrder)) misses.push(`order ${JSON.stringify(order)} != ${JSON.stringify(fixture.expectOrder)}`);
  }
  if (fixture.expectFirst != null && ranked[0]?.id !== fixture.expectFirst) misses.push(`first ${ranked[0]?.id} != ${fixture.expectFirst}`);
  for (const [id, score] of Object.entries(fixture.expectScore ?? {})) {
    if (byId.get(id)?.score !== score) misses.push(`#${id}: score ${byId.get(id)?.score} != ${score}`);
  }
  if (fixture.expectInvalid) {
    const invalid = resolvePrioritySettings(fixture.settings).invalid;
    if (JSON.stringify(invalid) !== JSON.stringify(fixture.expectInvalid)) misses.push(`invalid ${JSON.stringify(invalid)}`);
  }
  return misses;
}

describe('delivery priority replay fixtures', () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => { expect(replay(fixture)).toEqual([]); });
  }

  it('the incident replay names #4522 P0 with its reason, and the held PRs with theirs', () => {
    const incident = FIXTURES.find((f) => f.name.startsWith('incident 2026-10-08'));
    const ranked = rankByDeliveryPriority(incident.items, incident.settings, Date.parse(incident.now));
    expect(ranked[0]).toMatchObject({ id: 4522, class: 'P0', reasons: ['owns the fix for the open main-red episode'] });
    expect(ranked.find((r) => r.id === 4439).reasons.some((r) => /up one class/.test(r))).toBe(true);
    expect(ranked.find((r) => r.id === 4478).reasons).toContain('changes no code');
    expect(ranked).toHaveLength(15);
  });

  it('fails on a deliberately broken rule (owner fact ignored, aging into P0)', () => {
    const broken = (items, settings, now) => rankByDeliveryPriority(
      items.map((i) => ({ ...i, facts: { ...i.facts, incident: { open: false } } })), settings, now,
    );
    const incident = FIXTURES.find((f) => f.name.startsWith('incident 2026-10-08'));
    expect(replay(incident, broken)).not.toEqual([]);
    const constantP3 = (items) => items.map((i, n) => ({ id: i.id, class: 'P3', score: 0, rank: n + 1 }));
    const failing = FIXTURES.filter((f) => replay(f, constantP3).length > 0);
    expect(failing.length).toBeGreaterThan(5);
  });
});

describe('delivery priority settings', () => {
  it('the off value is today: mode off', () => {
    expect(PRIORITY_SETTINGS_OFF.mode).toBe('off');
    expect(resolvePrioritySettings(undefined)).toMatchObject({ mode: 'off', invalid: [] });
  });

  it('the declared settings file resolves with no invalid field and runs in shadow', () => {
    const s = resolvePrioritySettings(SETTINGS_FILE.deliveryPriority);
    expect(s).toEqual({ mode: 'shadow', agingHours: 8, maxLiveP0: 2, unblockWeightMinutes: 60, invalid: [] });
  });

  it('is pure: same input, same output, input not mutated', () => {
    const facts = { incident: { open: true, owner: true }, waitingSince: '2026-10-08T22:00:00Z' };
    const copy = structuredClone(facts);
    const now = Date.parse('2026-10-08T23:00:00Z');
    expect(deliveryPriority(facts, { mode: 'shadow' }, now)).toEqual(deliveryPriority(facts, { mode: 'shadow' }, now));
    expect(facts).toEqual(copy);
  });

  it('a future or unreadable waitingSince counts as 0 minutes', () => {
    const now = Date.parse('2026-10-08T23:00:00Z');
    expect(deliveryPriority({ waitingSince: '2026-10-09T00:00:00Z' }, { mode: 'shadow' }, now).minutesWaited).toBe(0);
    expect(deliveryPriority({ waitingSince: 'yesterday-ish' }, { mode: 'shadow' }, now).minutesWaited).toBe(0);
  });
});
