import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_DEFAULTS, readProviderCapacity, scoreProvider, chooseBuilder, burnWindows, planLine, calendarReset } from './provider-capacity.mjs';
import { effectiveBuilder } from './routing-settings.mjs';
import { resolveFixExecutorChain, pickChainRung } from './fix-executor-chain.mjs';
import { recordCapacityDecision, observeCapacity } from './provider-capacity-io.mjs';
import { readCodexQuota } from './codex-usage-ledger.mjs';
import { capacityCalendar, renderCalendar } from '../operations/capacity-calendar.mjs';

const now = Date.parse('2026-11-19T12:00:00Z'), hour = 3600000;
const cap = (provider, used, hours, extra = {}) => ({ provider, windows: used === null ? [] : [{ name: 'seven_day', usedPercent: used,
  resetsAt: now + hours * hour, source: 'live', lengthHours: 168 }], known: used !== null, held: false, health: 1, now, ...(provider === 'claude' ? { account: 'claude-a' } : {}), ...extra });
const providers = PROVIDER_DEFAULTS.providers.map(p => ({ ...p, accounts: undefined, operatorReading: undefined }));
const choose = (capacities, settings = {}, kind = 'fix') => chooseBuilder({ kind, capacities, settings: { ...settings, now }, fallback: 'claude' });
const repo = { routing: { builder: 'auto', capacity: { claudeUsageAccount: 'claude-a' } } };
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
  assert.equal(choose(cs, { providers: providers.map(p => ({ ...p, tier: p.id === 'codex' ? 1 : 3 })), minimumTiers: { fix: 2 } }).provider, 'claude');
  assert.equal(choose([cap('codex', null), cap('claude', 90, 2)]).provider, 'claude');
});
test('all readers failing preserves historical threshold fallback and repair chain', () => {
  const capacity = readProviderCapacity({ settings: { providers }, now, readers: { codex: () => { throw Error(); } } });
  const out = effectiveBuilder({ repo, env: {}, capacity, now, quota: () => null, record: () => {} });
  assert.equal(out.builder, 'claude'); assert.equal(out.decision.reason, 'all-readers-unknown');
  assert.deepEqual(chain(capacity), ['claude']);
  assert.deepEqual(resolveFixExecutorChain({ repo, platform: {}, env: {}, capacity, now, quota: () => ({ used_percent: 27 }), record: () => {} }).value, ['codex', 'codex-alt', 'claude']);
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
  const cs = readProviderCapacity({ now, readers, settings: { providers, calendar: { claude: { weekly: 'Thu 14:00 America/New_York' } } } });
  assert.equal(cs[0].windows.length, 2); assert.equal(scoreProvider(cs[0], 'fix').usedPercent, 80);
  const claude = cs.find(c => c.provider === 'claude');
  assert.equal(claude.known, false); assert.equal(claude.windows[0].source, 'configured');
  assert.equal(calendarReset('Thu 14:00 America/New_York', now), Date.parse('2026-11-19T19:00:00Z'));
  assert.equal(calendarReset('99:00 Invalid/Zone', now), null);
  const expired = readProviderCapacity({ now, readers: { codex: () => ({ used_percent: 0, resets_at: now / 1000 }) } });
  assert.equal(expired[0].known, false);
});
test('agy requires allowlisting; unknown emergency requires explicit opt-in and no scored alternative', () => {
  const cs = [cap('codex', 98, 2), cap('agy-gemini', 5, 1), cap('agy-claude', null)];
  assert.equal(choose(cs).provider, null);
  assert.equal(choose(cs, { providers: providers.map(p => ({ ...p, allowedKinds: p.id === 'agy-gemini' ? ['fix'] : [] })) }).provider, 'agy-gemini');
  const settings = { providers: providers.map(p => ({ ...p, allowedKinds: p.id === 'agy-claude' ? ['fix'] : [] })), allowUnknownEmergency: true };
  assert.equal(choose(cs, settings).provider, 'agy-claude');
  assert.equal(choose(cs, { ...settings, allowUnknownEmergency: false }).provider, null);
});
test('plan line, calendar scores, burn detection, durable dedupe and never-throw ledger', () => {
  const capacities = [cap('codex', 27, 2), cap('claude', 40, 120)];
  assert.match(planLine(capacities, {}, now), /^codex: 27% used, resets in 2h -> burn; claude-a: 40% used, resets .*EST ->/);
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
    assert.equal(observeCapacity({ env: { HOME: dir, CONVEYOR_STATE_ROOT: dir }, now, quota: () => null, records: [] }).find(c => c.provider === 'claude').known, false);
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

test('Codex window labels follow window_minutes and matching configured windows', () => {
  for (const [minutes, name] of [[10080, 'weekly'], [300, 'five_hour']]) {
    const cs = readProviderCapacity({ now, settings: { providers }, readers: { codex: () => ({ at: now, used_percent: 28, resets_at: now + 140 * hour, window_minutes: minutes }) } });
    assert.equal(cs[0].windows[0].name, name);
    assert.equal(cs[0].windows[0].lengthHours, minutes / 60);
    assert.match(renderCalendar(capacityCalendar({ capacities: cs, settings: {}, now })), new RegExp(`${name}: 28%`));
  }
});
test('plan line distinguishes Claude accounts and never transfers one account burn to another', () => {
  const line = planLine([cap('claude', 27, 2, { account: 'claude-a' }), cap('claude', 20, 120, { account: 'claude-b' })], {}, now);
  assert.match(line, /^claude-a: .* -> burn; claude-b: .* -> normal$/);
});
test('observed Codex ledger rate reaches calendar on-track and aliases with configured lookback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-rate-'));
  try {
    const env = { HOME: dir, CONVEYOR_STATE_ROOT: dir, WE_CODEX_USAGE_LEDGER: join(dir, 'usage') };
    writeFileSync(env.WE_CODEX_USAGE_LEDGER, [18, 8].map((h, i) => JSON.stringify({ at: new Date(now - h * hour).toISOString(), quota: { after_used_percent: 20 + i * 5 } })).join('\n'));
    const observe = settings => observeCapacity({ env, now, records: [], quota: () => ({ at: now, used_percent: 28, window_minutes: 10080, resets_at: now + 140 * hour }), settings });
    const cs = observe({});
    assert.equal(cs[0].currentRatePerHour, 0.5);
    assert.equal(cs.find(c => c.provider === 'codex-alt').currentRatePerHour, 0.5);
    assert.equal(capacityCalendar({ capacities: cs, now, settings: {} }).providers[0].planner.onTrack, false);
    assert.equal(observe({ rateLookbackHours: 12 })[0].currentRatePerHour, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('escalation removes reserve-only, inactive, disallowed and below-minimum capacity', () => {
  for (const bad of [cap('codex', 90, 120), cap('codex', 10, 120, { active: false }),
    cap('codex', 10, 120, { allowedKinds: [] }), cap('codex', 10, 120, { tier: -1 })]) {
    assert.deepEqual(chain([bad, cap('claude', 10, 2)]), ['claude']);
  }
});
test('mixed unknown capacity retains main escalation order and never escalates from Claude to Codex', () => {
  assert.deepEqual(chain([cap('codex', null), cap('claude', 10, 2)]), ['codex', 'codex-alt', 'claude']);
  assert.equal(pickChainRung({ chain: chain([cap('codex', null), cap('claude', 10, 2)]), trigger: 'stronger-model' }).rung, 'codex-alt');
  assert.deepEqual(chain([cap('codex', 70, 120), cap('claude', 10, 2)]), ['codex', 'codex-alt', 'claude']);
});
test('critical takeover and send-back refuse when exhausted Claude has been removed', () => {
  const value = chain([cap('codex', 27, 2), cap('claude', 98, 120)]);
  for (const trigger of ['takeover', 'ruling-not-addressed']) {
    const decision = pickChainRung({ chain: value, critical: true, trigger });
    assert.equal(decision.executor, null);
    assert.match(decision.reason, /critical escalation requires Claude/);
    assert.equal(pickChainRung({ chain: ['codex', 'claude'], critical: true, trigger,
      launcherAvailable: executor => executor !== 'claude' }).executor, null);
  }
});
test('operator readings expire at configured age despite a future reset and unavailable live quota', () => {
  const settings = { providers: [{ ...providers[0], operatorReading: {
    asOf: now - 72 * hour, usedPercent: 27, resetsAt: now + 120 * hour } }] };
  const read = extra => readProviderCapacity({ settings: { ...settings, ...extra }, now, readers: { codex: () => null } });
  const stale = read({});
  assert.equal(stale[0].known, false);
  assert.equal(choose(stale).provider, null);
  assert.match(renderCalendar(capacityCalendar({ capacities: stale, settings, now })), /operator reading stale — refresh/);
  assert.equal(read({ operatorReadingMaxAgeHours: 72 })[0].known, true);
  assert.equal(read({ operatorReadingMaxAgeHours: 71 })[0].known, false);
  const live = readProviderCapacity({ settings, now, readers: { codex: () => ({ at: now, used_percent: 10, resets_at: now + hour }) } });
  assert.equal(live[0].known, true);
  assert.equal(live[0].windows[0].usedPercent, 10);
});

test('escalation enforces the configured fix minimum tier on known and unknown rungs', () => {
  for (const used of [10, null]) {
    const result = resolveFixExecutorChain({ repo: { ...repo, providerCapacity: { minimumTiers: { fix: 3 } } },
      platform: {}, env: {}, now, quota: () => null, record: () => {},
      capacity: [cap('codex', used, 120, { tier: 2 }), cap('claude', 10, 2)] });
    assert.deepEqual(result.value, ['claude']);
  }
});


test('filtered Claude refuses critical threshold and unproductive escalation after twenty runs', () => {
  const value = chain([cap('codex', 27, 2), cap('claude', 98, 120)]);
  assert.deepEqual(value, ['codex', 'codex-alt']);
  for (const critical of [false, true]) {
    const picked = pickChainRung({ chain: value, critical, criticalClaudeFromRung: 1, codexUnproductive: 20 });
    assert.equal(picked.executor, null);
    assert.match(picked.reason, /escalation requires Claude.*filtered out/);
  }
  assert.equal(pickChainRung({ chain: value, critical: true, criticalClaudeFromRung: 1, trigger: 'stronger-model' }).executor, null);
});

test('multi-account routing scores only the live reader account and logs attribution without an account route', () => {
  const capacity = [cap('claude', 99, 2, { account: 'claude-a' }), cap('claude', 1, 2, { account: 'claude-b' }), cap('codex', 30, 120)];
  const decisions = [];
  const run = claudeUsageAccount => effectiveBuilder({ repo: { routing: { builder: 'auto', capacity: { claudeUsageAccount } } },
    env: {}, capacity, now, quota: () => null, record: decision => decisions.push(decision) });
  assert.equal(run('claude-a').builder, 'codex');
  assert.equal(run(null).builder, 'codex');
  const selected = run('claude-b');
  assert.equal(selected.builder, 'claude');
  assert.equal(Object.hasOwn(selected, 'account'), false);
  assert.equal(decisions.at(-1).account, 'claude-b');
  assert.deepEqual(decisions.at(-1).inputs.filter(i => i.provider === 'claude').map(i => i.account), ['claude-b']);
});
