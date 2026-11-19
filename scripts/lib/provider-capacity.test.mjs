import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProviderCapacity, scoreProvider, chooseBuilder, burnWindows, planLine, calendarReset } from './provider-capacity.mjs';
import { effectiveBuilder } from './routing-settings.mjs';
import { resolveFixExecutorChain, pickChainRung } from './fix-executor-chain.mjs';
import { recordCapacityDecision, observeCapacity } from './provider-capacity-io.mjs';
import { readCodexQuota } from './codex-usage-ledger.mjs';
import { capacityCalendar, renderCalendar } from '../operations/capacity-calendar.mjs';

const now = Date.parse('2026-11-19T12:00:00Z'), hour = 3600000;
const cap = (provider, used, hours, extra = {}) => ({ provider, windows: used === null ? [] : [{ name: 'seven_day', usedPercent: used,
  resetsAt: now + hours * hour, source: 'live', lengthHours: 168 }], known: used !== null, held: false, health: 1, now, ...extra });
const choose = (capacities, settings = {}, kind = 'fix') => chooseBuilder({ kind, capacities, settings: { ...settings, now }, fallback: 'claude' });
const repo = { routing: { builder: 'auto' } };
const chain = capacities => resolveFixExecutorChain({ repo, platform: {}, env: {}, capacity: capacities, now, quota: () => null, record: () => {} }).value;

test('expiring Codex 27% beats Claude 10% with five days remaining', () => {
  assert.equal(choose([cap('codex', 27, 2), cap('claude', 10, 120)]).provider, 'codex');
});
test('exhausted and held providers are excluded from the first and escalation rungs', () => {
  for (const c of [cap('codex', 98, 2), cap('codex', 27, 2, { held: true })]) {
    assert.equal(choose([c, cap('claude', 10, 120)]).provider, 'claude');
    assert.deepEqual(chain([c, cap('claude', 10, 120)]), ['claude']);
  }
  assert.deepEqual(chain([cap('codex', 27, 2), cap('claude', 98, 120)]), ['codex', 'codex-alt']);
  assert.deepEqual(chain([cap('codex', 98, 2), cap('claude', 98, 120)]), []);
  assert.equal(pickChainRung({ chain: [] }).executor, null);
  assert.equal(pickChainRung({ chain: ['codex'], critical: true, criticalClaudeFromRung: 1 }).executor, 'codex');
});
test('tier minimum excludes lower-tier provider and unknown usage never beats known', () => {
  const cs = [cap('codex', 27, 2), cap('claude', 10, 120)];
  assert.equal(choose(cs, { tiers: { codex: 1, claude: 3 }, kindMinTier: { fix: 2 } }).provider, 'claude');
  assert.equal(choose([cap('codex', null), cap('claude', 90, 2)]).provider, 'claude');
});
test('all readers failing preserves historical threshold fallback and repair chain', () => {
  const capacity = readProviderCapacity({ now, readers: { codex: () => { throw Error(); } } });
  const out = effectiveBuilder({ repo, env: {}, capacity, now, quota: () => null, record: () => {} });
  assert.equal(out.builder, 'claude'); assert.equal(out.decision.reason, 'all-readers-unknown');
  assert.deepEqual(chain(capacity), ['codex', 'codex-alt', 'claude']);
  assert.equal(effectiveBuilder({ repo, env: {}, capacity, now, quota: () => ({ used_percent: 27 }), record: () => {} }).builder, 'codex');
});
test('explicit builders bypass capacity and disabled auto retains threshold', () => {
  assert.equal(effectiveBuilder({ repo: { routing: { builder: 'codex' } }, env: {}, capacity: [], quota: () => { throw Error(); } }).builder, 'codex');
  assert.equal(effectiveBuilder({ repo: { routing: { builder: 'auto', capacity: { enabled: false } } }, env: {}, quota: () => ({ used_percent: 80 }) }).builder, 'claude');
});
test('reserve protects every window until release; security retains access', () => {
  const c = cap('codex', 90, 12);
  assert.equal(scoreProvider(c, 'fix', {}).label, 'reserve-only');
  assert.ok(scoreProvider(c, 'security', {}).score > 0);
  assert.ok(scoreProvider(cap('codex', 90, 5), 'fix', {}).score > 0);
  c.windows.push({ name: 'five_hour', usedPercent: 30, resetsAt: now + hour, lengthHours: 5 });
  assert.equal(scoreProvider(c, 'fix', {}).label, 'reserve-only');
});
test('pace ahead penalizes and behind boosts; long work prefers remaining absolute capacity', () => {
  const ahead = scoreProvider(cap('codex', 70, 150), 'fix', {});
  const behind = scoreProvider(cap('codex', 27, 2), 'fix', {});
  assert.equal(ahead.paceFactor, 0.7); assert.equal(behind.paceFactor, 1.2);
  assert.equal(choose([cap('codex', 27, 2), cap('claude', 10, 120)], { longKinds: ['build'] }, 'build').provider, 'claude');
});
test('stale, expired, malformed usage and configured resets remain unknown; tightest live window binds', () => {
  const readers = { codex: () => ({ used_percent: 27, resets_at: (now + 2 * hour) / 1000, secondary: { used_percent: 80, resets_at: (now + 100 * hour) / 1000 } }),
    claude: () => ({ at: new Date(now - 7 * hour).toISOString(), five_hour: { used_percentage: 5, resets_at: new Date(now + hour).toISOString() } }) };
  const cs = readProviderCapacity({ now, readers, settings: { calendar: { claude: { weekly: 'Thu 14:00 America/New_York' } } } });
  assert.equal(cs[0].windows.length, 2); assert.equal(scoreProvider(cs[0], 'fix').usedPercent, 80);
  assert.equal(cs[1].known, false); assert.equal(cs[1].windows[0].source, 'configured');
  assert.equal(calendarReset('Thu 14:00 America/New_York', now), Date.parse('2026-11-19T19:00:00Z'));
  assert.equal(calendarReset('99:00 Invalid/Zone', now), null);
  const expired = readProviderCapacity({ now, readers: { codex: () => ({ used_percent: 0, resets_at: now / 1000 }) } });
  assert.equal(expired[0].known, false);
});
test('agy requires allowlisting; unknown emergency requires explicit opt-in and no scored alternative', () => {
  const cs = [cap('codex', 98, 2), cap('agy-gemini', 5, 1), cap('agy-claude', null)];
  assert.equal(choose(cs).provider, null);
  assert.equal(choose(cs, { allowed: { fix: ['agy-gemini'] } }).provider, 'agy-gemini');
  const settings = { allowed: { fix: ['agy-claude'] }, allowUnknownEmergency: true };
  assert.equal(choose(cs, settings).provider, 'agy-claude');
  assert.equal(choose(cs, { ...settings, allowUnknownEmergency: false }).provider, null);
});
test('plan line, calendar scores, burn detection, durable dedupe and never-throw ledger', () => {
  const capacities = [cap('codex', 27, 2), cap('claude', 40, 120)];
  assert.match(planLine(capacities, {}, now), /^codex: 27% used, resets in 2h -> burn; claude: 40% used, resets .*EST ->/);
  assert.equal(burnWindows(capacities).length, 1);
  const report = capacityCalendar({ capacities, settings: {}, now });
  assert.ok(report.providers[0].scores.fix.score > 0); assert.match(renderCalendar(report), /burn windows:/);
  const dir = mkdtempSync(join(tmpdir(), 'capacity-'));
  try {
    const env = { WE_CAPACITY_LEDGER: join(dir, 'decisions.jsonl') }, events = [];
    const decision = choose(capacities), opts = { env, now, kind: 'fix', capacities, emit: e => events.push(e) };
    recordCapacityDecision(decision, opts); recordCapacityDecision(decision, opts);
    assert.equal(events.length, 1); assert.equal(events[0].kind, 'capacity-burn-window');
    assert.equal(readFileSync(env.WE_CAPACITY_LEDGER, 'utf8').trim().split('\n').length, 2);
    recordCapacityDecision(decision, { ...opts, capacities: [cap('codex', 27, 3)] }); assert.equal(events.length, 2);
    assert.doesNotThrow(() => recordCapacityDecision(decision, { ...opts, append: () => { throw Error(); } }));
    mkdirSync(join(dir, '.plateau'));
    const file = join(dir, '.plateau', 'claude-usage.json'); writeFileSync(file, ' '.repeat(2 * 1024 * 1024 + 1));
    assert.equal(observeCapacity({ env: { HOME: dir, CONVEYOR_STATE_ROOT: dir }, now, quota: () => null, records: [] })[1].known, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('Codex live reader preserves primary shape and returns secondary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-'));
  try {
    const secondary = { used_percent: 40, resets_at: (now + hour) / 1000 };
    mkdirSync(join(dir, 'sessions'));
    writeFileSync(join(dir, 'sessions', 'rollout.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: 27, resets_at: now / 1000 }, secondary } } }));
    const result = readCodexQuota({ CODEX_HOME: dir });
    assert.equal(result.used_percent, 27); assert.deepEqual(result.secondary, secondary);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
