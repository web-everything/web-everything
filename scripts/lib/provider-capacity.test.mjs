import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_DEFAULTS, readProviderCapacity, scoreProvider, chooseBuilder, burnWindows, planLine, calendarReset, launcherCapacity } from './provider-capacity.mjs';
import { effectiveBuilder } from './routing-settings.mjs';
import { resolveFixExecutorChain, pickChainRung } from './fix-executor-chain.mjs';
import { recordCapacityDecision, observeCapacity } from './provider-capacity-io.mjs';
import { readCodexQuota, readCodexBurnRate } from './codex-usage-ledger.mjs';
import { renderCalendar } from '../operations/capacity-calendar.mjs';
import { capacityCalendar } from '../operations/capacity-calendar-io.mjs';

const now = Date.parse('2026-11-19T12:00:00Z'), hour = 3600000;
const cap = (provider, used, hours, extra = {}) => ({ provider, windows: used === null ? [] : [{ name: 'seven_day', usedPercent: used,
  resetsAt: now + hours * hour, source: 'live', lengthHours: 168 }], known: used !== null, held: false, health: 1, now, ...(provider === 'claude' ? { account: 'claude-a' } : {}), ...extra });
const providers = PROVIDER_DEFAULTS.providers.map(p => ({ ...p, accounts: undefined, operatorReading: undefined }));
const choose = (capacities, settings = {}, kind = 'fix') => chooseBuilder({ kind, capacities, settings: { ...settings, now }, fallback: 'claude' });
const repo = { routing: { builder: 'auto', capacity: { claudeUsageAccount: 'claude-a' } } };
const chain = capacities => resolveFixExecutorChain({ repo, platform: {}, env: {}, capacity: capacities, now, quota: () => null, record: () => {} }).value;

test('signed-out providers are never selected by scores, unknown fallbacks, emergency or allowlists', () => {
  for (const provider of ['claude', 'agy-gemini', 'agy-claude']) {
    for (const used of [null, 10]) for (const emergencyOnly of [false, true]) {
      const c = cap(provider, used, 2, { signedOut: true, allowedKinds: ['fix'], emergencyOnly });
      const settings = { now, allowUnknownEmergency: true };
      const decision = chooseBuilder({ kind: 'fix', capacities: [c], settings, fallback: provider });
      assert.equal(decision.provider, null);
      assert.equal(decision.inputs[0].label, 'signed-out');
      assert.equal(decision.inputs[0].score, null);
      assert.equal(decision.inputs[0].eligible, false);
      assert.equal(choose([c, cap('codex', 20, 2)], settings).provider, 'codex');
    }
  }
});

test('signed-out capacity has zero health and ignores a newer operator reading', () => {
  const settings = { providers: [{ id: 'agy-gemini', allowedKinds: ['fix'], windows: [{ name: 'weekly' }],
    operatorReading: { asOf: now, usedPercent: 10, resetsAt: now + hour } }] };
  const [c] = readProviderCapacity({ now, settings, readers: {
    'agy-gemini': () => ({ at: now - hour, status: 'signed-out' }),
  } });
  assert.equal(c.signedOut, true);
  assert.equal(c.operatorReadingStale, false);
  assert.deepEqual(c.windows, []);
  assert.equal(c.known, false);
  assert.equal(c.health, 0);
});

test('signed-out file without its own at is never dated by the file mtime (PR 7331 merge)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-signed-out-mtime-'));
  try {
    mkdirSync(join(dir, '.plateau'));
    const file = join(dir, '.plateau', 'agy-usage.json');
    for (const body of [{ status: 'signed-out' }, { at: null, status: 'signed-out' }]) {
      writeFileSync(file, JSON.stringify(body));
      // A fresh mtime must not stand in for the missing observation time, for either reader of the file.
      utimesSync(file, new Date(now - hour), new Date(now - hour));
      const capacities = observeCapacity({ env: { HOME: dir, CONVEYOR_STATE_ROOT: dir, WE_CAPACITY_READERS: 'on' },
        now, settings: PROVIDER_DEFAULTS, records: [], quota: () => null }).filter(c => c.provider.startsWith('agy-'));
      assert.equal(capacities.length, 2);
      for (const c of capacities) {
        assert.equal(c.signedOut, undefined, `${c.provider} ${JSON.stringify(body)}`);
        assert.equal(c.health, 1);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fresh signed-out agy usage file marks both providers without adding usage windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-signed-out-'));
  try {
    mkdirSync(join(dir, '.plateau'));
    const file = join(dir, '.plateau', 'agy-usage.json');
    const settings = PROVIDER_DEFAULTS;
    for (const at of [new Date(now).toISOString(), new Date(now - 6 * hour).toISOString(),
      new Date(now - 6 * hour - 1).toISOString(), new Date(now + 1).toISOString(), 'invalid', null]) {
      // Even contradictory usage fields cannot turn a signed-out observation into quota.
      writeFileSync(file, JSON.stringify({ at, status: 'signed-out',
        five_hour: { used_percentage: 20, resets_at: now + hour } }));
      const capacities = observeCapacity({ env: { HOME: dir, CONVEYOR_STATE_ROOT: dir, WE_CAPACITY_READERS: 'on' },
        now, settings, records: [], quota: () => null }).filter(c => c.provider.startsWith('agy-'));
      assert.equal(capacities.length, 2);
      for (const c of capacities) {
        assert.equal(c.signedOut === true, typeof at === 'string' && Date.parse(at) <= now && now - Date.parse(at) <= 6 * hour);
        assert.deepEqual(c.windows, []);
        assert.equal(c.known, false);
        assert.equal(c.health, c.signedOut ? 0 : 1);
        assert.equal(scoreProvider(c, 'fix', { now }).label, c.signedOut ? 'signed-out' : 'unknown');
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real config reads Gemini percentages without attributing them to agy-claude', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-agy-signed-in-'));
  try {
    mkdirSync(join(dir, '.plateau'));
    writeFileSync(join(dir, '.plateau', 'agy-usage.json'), JSON.stringify({ at: new Date(now).toISOString(),
      five_hour: { used_percentage: 20, resets_at: now + hour },
      seven_day: { used_percentage: 30, resets_at: now + 24 * hour } }));
    const capacities = observeCapacity({ env: { HOME: dir, CONVEYOR_STATE_ROOT: dir, WE_CAPACITY_READERS: 'on' },
      now, settings: PROVIDER_DEFAULTS, records: [], quota: () => null });
    const gemini = capacities.find(c => c.provider === 'agy-gemini');
    const claude = capacities.find(c => c.provider === 'agy-claude');
    assert.equal(gemini.known, true);
    assert.deepEqual(gemini.windows.map(w => w.usedPercent), [20, 30]);
    assert.deepEqual(claude.windows, []);
    assert.equal(claude.known, false);
    assert.equal(claude.signedOut, undefined);
    assert.equal(scoreProvider(claude, 'fix', { now }).label, 'unknown');
    assert.deepEqual(PROVIDER_DEFAULTS.providers.find(p => p.id === 'agy-claude').readers, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const rolloutLine = (at, used = 94, reset = now + 120 * hour) => JSON.stringify({
  timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'token_count',
    rate_limits: { limit_id: 'codex', primary: { used_percent: used, resets_at: reset / 1000, window_minutes: 10080 } } },
});

test('codex reading comes from the newest rollout rate_limits and beats an older operator reading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-live-'));
  try {
    mkdirSync(join(dir, 'sessions'));
    const latest = join(dir, 'sessions', 'latest.jsonl');
    writeFileSync(latest, `${rolloutLine(now)}\n${rolloutLine(now - 3 * hour, 80)}\n`);
    utimesSync(latest, new Date(now - 4 * hour), new Date(now - 4 * hour));
    const old = join(dir, 'sessions', 'old.jsonl');
    writeFileSync(old, `${rolloutLine(now - 2 * hour, 90)}\n`);
    utimesSync(old, new Date(now), new Date(now));
    const settings = { providers: [{ ...providers[0], operatorReading: {
      asOf: now - hour, usedPercent: 92, resetsAt: now + 120 * hour } }] };
    const read = () => observeCapacity({ env: { HOME: dir, CODEX_HOME: dir, CONVEYOR_STATE_ROOT: dir },
      now, settings, records: [] })[0];
    assert.equal(read().windows[0].usedPercent, 94);
    assert.equal(read().windows[0].source, 'live');
    // A reset starts a new bucket: read again rather than keeping the highest percentage.
    writeFileSync(latest, `${rolloutLine(now, 2, now + 168 * hour)}\n`);
    assert.equal(read().windows[0].usedPercent, 2);
    assert.equal(read().windows[0].resetsAt, now + 168 * hour);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shared setup disables capacity host readers by default', () => {
  assert.equal(process.env.WE_CAPACITY_READERS, 'off');
  assert.ok(observeCapacity({ now }).every(c => !c.known && !c.held && c.currentRatePerHour === null));
});

test('status-only signed-out evidence suppresses independent quota, operator and calendar windows', () => {
  const settings = { providers: [{ id: 'example', readers: [],
    calendar: { weekly: 'Mon 09:00 UTC' },
    operatorReading: { asOf: now, usedPercent: 10, resetsAt: now + hour } }] };
  for (const raw of [null, { at: now, five_hour: { used_percentage: 20, resets_at: now + hour } }]) {
    const [c] = readProviderCapacity({ now, settings, readers: { example: () => raw,
      signedOut: id => { assert.equal(id, 'example'); return { at: now, status: 'signed-out' }; } } });
    assert.equal(c.signedOut, true);
    assert.equal(c.health, 0);
    assert.equal(c.known, false);
    assert.deepEqual(c.windows, []);
  }
});

test('status-only reader ignores missing, malformed, oversized and disabled host evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-agy-status-'));
  try {
    mkdirSync(join(dir, '.plateau'));
    const file = join(dir, '.plateau', 'agy-usage.json');
    const env = { HOME: dir, CONVEYOR_STATE_ROOT: dir, WE_CAPACITY_READERS: 'on' };
    for (const contents of [null, '{invalid', JSON.stringify({ status: 'signed-out' }),
      JSON.stringify({ at: new Date(now).toISOString(), status: 'signed-out', padding: 'x'.repeat(2 * 1024 * 1024) })]) {
      if (contents !== null) writeFileSync(file, contents);
      const c = observeCapacity({ env, now, settings: PROVIDER_DEFAULTS, records: [], quota: () => null })
        .find(c => c.provider === 'agy-claude');
      assert.equal(c.signedOut, undefined);
      assert.equal(c.known, false);
      assert.deepEqual(c.windows, []);
    }
    writeFileSync(file, JSON.stringify({ at: new Date(now).toISOString(), status: 'signed-out' }));
    const c = observeCapacity({ env: { ...env, WE_CAPACITY_READERS: 'off' }, now,
      settings: PROVIDER_DEFAULTS, records: [], quota: () => null }).find(c => c.provider === 'agy-claude');
    assert.equal(c.signedOut, undefined);
    assert.deepEqual(c.windows, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rollout tails are bounded and missing or changed quota evidence stays unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-tail-'));
  try {
    mkdirSync(join(dir, 'sessions'));
    const file = join(dir, 'sessions', 'rollout.jsonl'), env = { CODEX_HOME: dir };
    const valid = JSON.parse(rolloutLine(now));
    writeFileSync(file, `${rolloutLine(now)}\n${' '.repeat(256 * 1024)}\n`);
    assert.equal(readCodexQuota(env), null); // Outside the tail: refresh the rollout or use an operator reading.
    writeFileSync(file, `${'x'.repeat(300 * 1024)}\n${rolloutLine(now)}\n`);
    assert.equal(readCodexQuota(env).used_percent, 94);
    for (const change of [e => delete e.payload.rate_limits.primary.window_minutes,
      e => delete e.payload.rate_limits.primary.resets_at,
      e => e.payload.rate_limits.primary.used_percent = '94',
      e => e.payload.rate_limits.primary.used_percent = 101,
      e => e.payload.rate_limits.primary = null]) {
      const broken = structuredClone(valid); change(broken);
      writeFileSync(file, `${rolloutLine(now - hour)}\n${JSON.stringify(broken)}\n`);
      assert.equal(readCodexQuota(env), null);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Claude file account map attributes only the mapped account and keeps unknown accounts unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-account-'));
  try {
    mkdirSync(join(dir, '.plateau'));
    const file = join(dir, '.plateau', 'claude-usage.json');
    const env = { HOME: dir, CONVEYOR_STATE_ROOT: dir };
    const settings = { claudeAccountMap: { work: 'claude-b' }, claudeUsageAccount: 'claude-a' };
    const read = (account, extra = {}) => {
      writeFileSync(file, JSON.stringify({ at: now, account, seven_day: { used_percentage: 42, resets_at: now + 120 * hour } }));
      return observeCapacity({ env, now, settings: { ...settings, ...extra }, quota: () => null, records: [] });
    };
    const mapped = read('work');
    assert.deepEqual(mapped.filter(c => c.provider === 'claude').map(c => c.known), [false, true]);
    assert.equal(mapped.find(c => c.account === 'claude-b').windows[0].usedPercent, 42);
    const selected = effectiveBuilder({ repo: { routing: { builder: 'auto', capacity: settings } },
      env, platform: {}, capacity: mapped, now, quota: () => null, record: () => {} });
    assert.equal(selected.decision.account, 'claude-b');
    for (const cs of [read('unmapped'), read('toString'), read(undefined, { claudeUsageAccount: null }),
      read('work', { claudeAccountMap: { work: 'not-an-account' } })]) {
      for (const c of cs.filter(c => c.provider === 'claude')) {
        assert.equal(c.known, false);
        assert.equal(scoreProvider(c, 'fix').usedPercent, null);
      }
    }
    assert.equal(read(undefined).find(c => c.account === 'claude-a').known, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('capacity freshness clock preserves six-hour expiry and never treats readings older than a day as known', () => {
  const settings = { providers: [providers[0]] };
  const readers = { codex: () => ({ at: now, used_percent: 94, resets_at: now + 168 * hour }) };
  const read = (age, extra = {}) => readProviderCapacity({ now: now + age * hour, settings: { ...settings, ...extra }, readers })[0];
  assert.equal(read(6).known, true);
  assert.equal(read(6 + 1 / hour).known, false);
  assert.equal(read(25).stale, true);
  assert.equal(read(25, { staleHours: 72 }).known, false);
  const seeded = readProviderCapacity({ now: now + 25 * hour, settings: { providers: [{ ...providers[0],
    operatorReading: { asOf: now, usedPercent: 92, resetsAt: now + 168 * hour } }], operatorReadingMaxAgeHours: 72 } })[0];
  assert.equal(seeded.operatorReadingStale, true);
  assert.equal(seeded.stale, true);
  assert.equal(seeded.known, false);
  assert.equal(scoreProvider(seeded, 'fix').score, null);
});

test('a live reading stamped seconds after the read clock is live; one far in the future is not', () => {
  const readers = skew => ({ codex: () => ({ at: now + skew, used_percent: 94, resets_at: now + 168 * hour }) });
  const read = skew => readProviderCapacity({ now, settings: { providers: [providers[0]] }, readers: readers(skew) })[0];
  assert.equal(read(5000).known, true);
  assert.equal(read(10 * 60000).known, false);
});

test('capacity readers off ignores persisted usage and operator seeds but preserves injected readers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-off-'));
  try {
    const env = { HOME: dir, CODEX_HOME: dir, CONVEYOR_STATE_ROOT: dir,
      WE_CODEX_USAGE_LEDGER: join(dir, 'codex.jsonl'), WE_CAPACITY_LEDGER: join(dir, 'decisions.jsonl') };
    const raw = { at: now, used_percent: 27, resets_at: (now + hour) / 1000, window_minutes: 300 };
    mkdirSync(join(dir, 'sessions'));
    writeFileSync(join(dir, 'sessions', 'rollout.jsonl'), JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: {
      type: 'token_count', rate_limits: { limit_id: 'codex', primary: raw } } }));
    mkdirSync(join(dir, '.plateau'));
    const usage = { at: now, five_hour: { used_percentage: 20, resets_at: now + hour } };
    for (const file of ['claude-usage.json', 'agy-usage.json']) writeFileSync(join(dir, '.plateau', file), JSON.stringify(usage));
    writeFileSync(env.WE_CODEX_USAGE_LEDGER, [2, 1].map(h => JSON.stringify({ at: new Date(now - h * hour).toISOString(), quota: { after_used_percent: 27 - h } })).join('\n'));
    writeFileSync(env.WE_CAPACITY_LEDGER, 'invalid ledger');
    const settings = { claudeUsageAccount: 'claude-a', providers: PROVIDER_DEFAULTS.providers.map(p => ({ ...p,
      operatorReading: { asOf: now, usedPercent: 10, resetsAt: now + hour } })) };
    assert.equal(readCodexQuota(env).used_percent, 27);
    const window = { resetsAt: now + hour, lengthHours: 5, usedPercent: 27 };
    assert.equal(readCodexBurnRate({ env, now, window }), 1);
    assert.ok(observeCapacity({ env, now, settings, records: [] }).some(c => c.known));
    const disabled = { ...env, WE_CAPACITY_READERS: 'off' };
    assert.equal(readCodexQuota(disabled), null);
    assert.equal(readCodexBurnRate({ env: disabled, now, window }), null);
    assert.ok(observeCapacity({ env: disabled, now, settings }).every(c => !c.known && !c.held && c.currentRatePerHour === null));
    assert.equal(observeCapacity({ env: disabled, now, readers: { codex: () => raw } })[0].known, true);
    assert.equal(observeCapacity({ env: disabled, now, quota: () => raw })[0].known, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
  assert.equal(pickChainRung({ chain: ['codex'], critical: true }).executor, 'codex');
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
  assert.deepEqual(resolveFixExecutorChain({ repo, platform: {}, env: {}, capacity, now, quota: () => ({ at: now, used_percent: 27 }), record: () => {} }).value, ['codex', 'codex-alt', 'claude']);
  assert.equal(effectiveBuilder({ repo, env: {}, capacity, now, quota: () => ({ at: now, used_percent: 27 }), record: () => {} }).builder, 'codex');
});
test('explicit builders bypass capacity and disabled auto retains threshold', () => {
  assert.equal(effectiveBuilder({ repo: { routing: { builder: 'codex' } }, env: {}, capacity: [], quota: () => { throw Error(); } }).builder, 'codex');
  assert.equal(effectiveBuilder({ repo: { routing: { builder: 'auto', capacity: { enabled: false } } }, env: {}, quota: () => ({ used_percent: 80 }) }).builder, 'claude');
});

test('shipped capacity defaults fall back to unattributed Claude when Codex is rejected', () => {
  for (const codex of [cap('codex', 95, 120), cap('codex', 99, 120), cap('codex', 20, 120, { held: true })]) {
    const capacity = [codex, cap('claude', null, 120)];
    const options = { repo: { routing: { builder: 'auto' } }, env: {}, platform: {}, capacity, now,
      quota: () => ({ used_percent: codex.windows[0].usedPercent }), record: () => {} };
    const selected = effectiveBuilder(options);
    assert.equal(selected.settings.capacity.claudeUsageAccount, null);
    assert.equal(selected.builder, 'claude');
    assert.equal(selected.decision.reason, 'unknown-fallback');
    const resolved = resolveFixExecutorChain(options);
    assert.deepEqual(resolved.value, ['claude']);
    assert.equal(pickChainRung({ chain: resolved.value }).executor, 'claude');
  }
});

test('unknown fallback still rejects held, inactive, disallowed and below-tier Claude', () => {
  for (const extra of [{ held: true }, { active: false }, { allowedKinds: [] }, { tier: -1 }]) {
    assert.equal(choose([cap('codex', 99, 120), cap('claude', null, 120, extra)]).provider, null);
  }
});

test('operator seed only wins against missing or older live Codex readings', () => {
  const settings = { providers: [{ ...providers[0], operatorReading: {
    asOf: now - hour, usedPercent: 10, resetsAt: now + 120 * hour } }] };
  for (const at of [now - 1000, now]) {
    const live = readProviderCapacity({ now, settings,
      readers: { codex: () => ({ at, used_percent: 85, resets_at: now + 120 * hour }) } });
    assert.equal(live[0].windows[0].usedPercent, 85);
    assert.equal(live[0].windows[0].source, 'live');
  }
  for (const raw of [null, { at: now - 2 * hour, used_percent: 85, resets_at: now + 120 * hour }]) {
    const seeded = readProviderCapacity({ now, settings, readers: { codex: () => raw } });
    assert.equal(seeded[0].windows[0].source, 'operator');
    assert.equal(seeded[0].windows[0].usedPercent, 10);
  }
});
test('reserve protects every window until release; security retains access', () => {
  const c = cap('codex', 90, 12);
  assert.equal(scoreProvider(c, 'fix', {}).label, 'reserve-only');
  assert.ok(scoreProvider(c, 'security', {}).score > 0);
  assert.ok(scoreProvider(cap('codex', 90, 5), 'fix', {}).score > 0);
  c.windows.push({ name: 'five_hour', usedPercent: 30, resetsAt: now + hour, lengthHours: 5 });
  assert.equal(scoreProvider(c, 'fix', {}).label, 'reserve-only');
});

test.each([false, true])('weekly operator reading preserves exhausted five-hour quota and alias exclusion (reversed=%s)', reversed => {
  const clock = Date.parse('2026-11-19T13:00:00Z');
  const short = { used_percent: 100, window_minutes: 300, resets_at: Date.parse('2026-11-19T17:00:00Z') };
  const weekly = { used_percent: reversed ? 40 : 27, window_minutes: 10080, resets_at: Date.parse('2026-11-25T08:49:00Z') };
  const raw = { ...(reversed ? weekly : short), secondary: reversed ? short : weekly,
    at: Date.parse('2026-11-19T12:30:00Z') };
  const read = now => readProviderCapacity({ env: {}, now, readers: { codex: () => raw } });
  const capacity = read(clock);
  for (const provider of ['codex', 'codex-alt']) {
    const observation = capacity.find(c => c.provider === provider);
    assert.equal(observation.windows.length, 2);
    assert.equal(observation.windows.find(w => w.name === 'five_hour').usedPercent, 100);
    assert.equal(observation.windows.find(w => w.name === 'weekly').usedPercent, 27);
    assert.equal(observation.windows.find(w => w.name === 'weekly').source, 'operator');
    assert.equal(scoreProvider(observation, 'fix', { now: clock }).label, 'exhausted');
  }
  assert.equal(chooseBuilder({ kind: 'fix', capacities: capacity, settings: { now: clock }, fallback: 'claude' }).provider, 'claude');
  const route = now => resolveFixExecutorChain({ repo, platform: {}, env: {}, capacity: read(now), now,
    quota: () => raw, record: () => {} }).value;
  assert.deepEqual(route(clock), ['claude']);
  assert.deepEqual(route(short.resets_at), ['codex', 'codex-alt', 'claude']);
});

test.each(['weekly', 'seven_day'])('operator merge replaces only the matching %s window for non-Codex readers', name => {
  const settings = { providers: [{ ...providers.find(p => p.id === 'claude'), windows: [{ name, lengthHours: 168 }],
    operatorReading: { asOf: now - hour, usedPercent: 27, resetsAt: now + 120 * hour } }] };
  const [observation] = readProviderCapacity({ env: {}, now, settings, readers: { claude: () => ({ at: now - 2 * hour,
    five_hour: { usedPercent: 100, resetsAt: now + hour }, seven_day: { usedPercent: 99, resetsAt: now + 120 * hour } }) } });
  assert.equal(observation.windows.length, 2);
  assert.equal(observation.windows.find(w => w.name === 'five_hour').usedPercent, 100);
  assert.equal(observation.windows.find(w => w.source === 'operator').usedPercent, 27);
  assert.equal(scoreProvider(observation, 'fix', { now }).label, 'exhausted');
});

test.each([
  { usedPercent: 101, resetsAt: now + hour },
  { usedPercent: 10, resetsAt: now },
])('invalid or expired operator window preserves usable live windows (%j)', seed => {
  const settings = { providers: [{ ...providers[0], operatorReading: { ...seed, asOf: now - hour } }] };
  const [observation] = readProviderCapacity({ env: {}, now, settings, readers: { codex: () => ({ at: now - 2 * hour,
    used_percent: 100, resets_at: now + 120 * hour, window_minutes: 10080 }) } });
  assert.equal(observation.windows[0]?.source, 'live');
  assert.equal(scoreProvider(observation, 'fix', { now }).label, 'exhausted');
});
test('pace ahead penalizes and behind boosts; long work prefers remaining absolute capacity', () => {
  const ahead = scoreProvider(cap('codex', 70, 150), 'fix', {});
  const behind = scoreProvider(cap('codex', 27, 2), 'fix', {});
  assert.equal(ahead.paceFactor, 0.7); assert.equal(behind.paceFactor, 1.2);
  assert.equal(choose([cap('codex', 27, 2), cap('claude', 10, 120)], { longKinds: ['build'] }, 'build').provider, 'claude');
});
test('stale, expired, malformed usage and configured resets remain unknown; tightest live window binds', () => {
  const readers = { codex: () => ({ at: now, used_percent: 27, resets_at: (now + 2 * hour) / 1000, secondary: { used_percent: 80, resets_at: (now + 100 * hour) / 1000 } }),
    claude: () => ({ at: new Date(now - 7 * hour).toISOString(), five_hour: { used_percentage: 5, resets_at: new Date(now + hour).toISOString() } }) };
  const cs = readProviderCapacity({ now, readers, settings: { providers, calendar: { claude: { weekly: 'Thu 14:00 America/New_York' } } } });
  assert.equal(cs[0].windows.length, 2); assert.equal(scoreProvider(cs[0], 'fix').usedPercent, 80);
  const claude = cs.find(c => c.provider === 'claude');
  assert.equal(claude.known, false); assert.equal(claude.windows[0].source, 'configured');
  assert.equal(calendarReset('Thu 14:00 America/New_York', now), Date.parse('2026-11-19T19:00:00Z'));
  assert.equal(calendarReset('99:00 Invalid/Zone', now), null);
  const expired = readProviderCapacity({ now, readers: { codex: () => ({ at: now, used_percent: 0, resets_at: now / 1000 }) } });
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
    const secondary = { used_percent: 40, resets_at: (now + hour) / 1000, window_minutes: 10080 };
    mkdirSync(join(dir, 'sessions'));
    writeFileSync(join(dir, 'sessions', 'rollout.jsonl'), JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: 27, resets_at: now / 1000, window_minutes: 300 }, secondary } } }));
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
test('known Claude winner starts the chain and never escalates back to unknown or lower-scored Codex', () => {
  assert.deepEqual(chain([cap('codex', null), cap('claude', 10, 2)]), ['claude']);
  assert.equal(pickChainRung({ chain: chain([cap('codex', null), cap('claude', 10, 2)]), trigger: 'stronger-model' }).rung, 'claude');
  assert.deepEqual(chain([cap('codex', 70, 120), cap('claude', 10, 2)]), ['claude']);
});

test('capacity receipt names confine even directly injected account paths and distinguish identities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-receipt-'));
  try {
    const env = { WE_CAPACITY_LEDGER: join(dir, 'state', 'decisions.jsonl') };
    const events = [];
    for (const account of ['../outside', 'nested/account', 'nested\\account', 'account\nother']) {
      const capacities = [cap('codex', 27, 2, { account })];
      for (let i = 0; i < 2; i++) recordCapacityDecision({}, { env, now, capacities, emit: event => events.push(event) });
    }
    assert.equal(events.length, 4);
    assert.deepEqual(readdirSync(dir), ['state']);
    assert.equal(readdirSync(join(dir, 'state')).filter(file => /^capacity-[a-f0-9]{64}$/.test(file)).length, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('critical takeover and send-back use eligible codex-alt when exhausted Claude has been removed', () => {
  const value = chain([cap('codex', 27, 2), cap('claude', 98, 120)]);
  assert.deepEqual(value, ['codex', 'codex-alt']);
  for (const trigger of ['takeover', 'ruling-not-addressed']) {
    const decision = pickChainRung({ chain: value, critical: true, trigger });
    assert.equal(decision.executor, 'codex');
    assert.equal(decision.rung, 'codex-alt');
    assert.equal(decision.requiresReview, true);
    assert.equal(pickChainRung({ chain: value, critical: true, trigger,
      launcherAvailable: () => false }).executor, null);
    const exhausted = pickChainRung({ chain: value, critical: true, trigger, codexUnproductive: 3 });
    assert.equal(exhausted.executor, null);
    assert.match(exhausted.reason, /escalation requires Claude.*filtered out/);
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
  assert.equal(read({ operatorReadingMaxAgeHours: 72 })[0].known, false); // The daily ceiling cannot be extended.
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


test('filtered Claude permits critical stronger-model on codex-alt but refuses exhausted escalation', () => {
  const value = chain([cap('codex', 27, 2), cap('claude', 98, 120)]);
  assert.deepEqual(value, ['codex', 'codex-alt']);
  for (const critical of [false, true]) {
    const next = pickChainRung({ chain: value, critical, trigger: 'stronger-model' });
    assert.equal(next.executor, 'codex');
    assert.equal(next.rung, 'codex-alt');
    assert.equal(next.requiresReview === true, critical);
    for (const codexUnproductive of [3, 20]) {
      const picked = pickChainRung({ chain: value, critical, codexUnproductive });
      assert.equal(picked.executor, null);
      assert.match(picked.reason, /escalation requires Claude.*filtered out/);
    }
  }
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


test('threshold fallback rejects expired, undated and excessively future Codex evidence', () => {
  const capacity = readProviderCapacity({ now, settings: { providers } });
  for (const at of [now - 24 * hour - 1, now + 60001, undefined, 'invalid']) {
    const out = effectiveBuilder({ repo, env: {}, capacity, now,
      quota: () => ({ at, used_percent: 1 }), record: () => {} });
    assert.equal(out.builder, 'claude');
    assert.equal(out.decision.reason, 'all-readers-unknown');
    assert.equal(out.usedPercent, null);
  }
  for (const at of [now, now + 60000]) {
    assert.equal(effectiveBuilder({ repo, env: {}, capacity, now,
      quota: () => ({ at, used_percent: 1 }), record: () => {} }).builder, 'codex');
  }
});

test('only codex-rollout readers permit 60 seconds of future timestamp skew', () => {
  const claude = providers.find(p => p.id === 'claude');
  for (const at of [now + 1, now + 60000]) {
    const [observation] = readProviderCapacity({ now, settings: { providers: [claude] },
      readers: { claude: () => ({ at, seven_day: { used_percentage: 20, resets_at: now + hour } }) } });
    assert.equal(observation.known, false);
    const [codex] = readProviderCapacity({ now, settings: { providers: [providers[0]] },
      readers: { codex: () => ({ at, used_percent: 20, resets_at: now + hour }) } });
    assert.equal(codex.known, true);
  }
});

test('Codex live readings require timestamp age evidence even when quota and reset are valid', () => {
  for (const at of [undefined, null, 'invalid']) {
    const [observation] = readProviderCapacity({ now, settings: { providers: [providers[0]] },
      readers: { codex: () => ({ at, used_percent: 20, resets_at: now + hour }) } });
    assert.equal(observation.known, false);
    assert.equal(scoreProvider(observation, 'fix').label, 'unknown');
  }
});

test('unmapped explicit Claude identity cannot restore the legacy account operator seed at launch', () => {
  const claude = PROVIDER_DEFAULTS.providers.find(p => p.id === 'claude');
  const settings = { claudeUsageAccount: 'claude-a', providers: [{ ...claude,
    accounts: claude.accounts.map(a => ({ ...a, operatorReading: {
      asOf: now - hour, usedPercent: 10, resetsAt: now + 120 * hour,
    } })),
  }] };
  const read = account => readProviderCapacity({ now, settings,
    readers: { claude: () => ({ account, at: now, seven_day: { used_percentage: 20, resets_at: now + 120 * hour } }) } });
  for (const identity of ['unmapped', 'toString']) {
    const [routable] = launcherCapacity(read(identity), settings);
    assert.equal(routable.account, null);
    assert.equal(routable.known, false);
    assert.deepEqual(routable.windows, []);
  }
  const [legacy] = launcherCapacity(read(undefined), settings);
  assert.equal(legacy.account, 'claude-a');
  assert.equal(legacy.known, true);
});
