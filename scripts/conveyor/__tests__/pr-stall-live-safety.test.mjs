/** Live restart safety contracts, with isolated mutations proving each assertion detects a removed guard. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runStallSweep, STALL_SWEEP_DEFAULTS, resolveStallSweepSettings } from '../pr-stall-sweep.mjs';
import { resetRestartCounter } from '../pr-stall-reset.mjs';

const sourceUrl = pathToFileURL(resolve('scripts/conveyor/pr-stall-sweep.mjs'));
const source = fs.readFileSync(sourceUrl, 'utf8');
const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-10-21T18:00:00Z');
const OLD = new Date(NOW - 180 * 60_000).toISOString();
const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const target = { repo: REPO, pr: 11, head: HEAD };
const identityKey = ({ repo, pr: number, head }) => `${repo}#${number}@${head}`;
const restartItem = identity => ({ ...identity, prHead: identityKey(identity), lane: 'system', action: 'restart-red-team',
  key: `${identityKey(identity)}:red-team-pending:restart-3` });
function restartHistory(identity, phase = 'intent', ageMinutes = 90) {
  return [1, 2].flatMap(n => {
    const record = { ...restartItem(identity), key: `${identityKey(identity)}:red-team-pending:restart-${n}`,
      phase, ts: new Date(NOW - ageMinutes * 60_000).toISOString() };
    return phase === 'intent' ? [record, { ...record, phase: 'did' }] : [record];
  });
}
function seedHistory(dir, history) {
  fs.writeFileSync(join(dir, '2026-10.jsonl'), history.map(r => JSON.stringify(r)).join('\n') + '\n');
}
function resetTarget(dir) {
  const before = fs.readFileSync(join(dir, '2026-10.jsonl'), 'utf8');
  const receipt = resetRestartCounter({ dir, ...target, actor: 'fixture-operator', reason: 'owner inspected',
    ruling: 'R804', now: NOW - 30 * 60_000 });
  expect(receipt).toMatchObject({ ...target, prHead: identityKey(target), phase: 'operator-reset' });
  expect(fs.readFileSync(join(dir, '2026-10.jsonl'), 'utf8'))
    .toBe(before + JSON.stringify(receipt) + '\n');
}
async function resetIsolation(api, other) {
  const dir = fixture();
  seedHistory(dir, [...restartHistory(target), ...restartHistory(other)]);
  const limits = options(dir).settings.value;
  const items = [restartItem(target), restartItem(other)];
  expect(api.planStallActions(items, { history: records(dir), now: NOW, limits }).act).toEqual([]);
  resetTarget(dir);
  const after = api.planStallActions(items, { history: records(dir), now: NOW, limits });
  expect(after.act).toEqual([restartItem(target)]);
  expect(after.held).toEqual([{ ...restartItem(other), held: expect.stringMatching(/restart per-head cap/) }]);

  // The sweep sees the current head; the other identity's retained cap was checked above.
  const input = options(dir);
  const out = await api.runStallSweep(input);
  expect(out.incomplete).toBe(false);
  expect(input.dispatchRestart).toHaveBeenCalledTimes(1);
  expect(input.dispatchRestart).toHaveBeenCalledWith(expect.objectContaining({ repo: target.repo, pr: target.pr }));
  expect(records(dir).filter(r => r.phase === 'did' && r.ts === new Date(NOW).toISOString()))
    .toEqual([expect.objectContaining({ prHead: identityKey(target) })]);
}
async function resetPreservesHourlySpend(api, phase) {
  const dir = fixture();
  const ordinaryHead = `${REPO}#99@${HEAD}`;
  seedHistory(dir, [...restartHistory(target, phase, 40), {
    phase: 'would-do', action: 'ask-review-daemon', prHead: ordinaryHead, key: `${ordinaryHead}:ask-review-daemon`,
    ts: new Date(NOW - 10 * 60_000).toISOString(),
  }]);
  const limits = { ...options(dir).settings.value, maxActionsPerHour: 3 };
  const item = restartItem(target);
  expect(api.planStallActions([item], { history: records(dir), now: NOW, limits }).act).toEqual([]);
  resetTarget(dir);
  const history = records(dir);
  const after = api.planStallActions([item], { history, now: NOW, limits });
  expect(after.act).toEqual([]);
  expect(after.held).toEqual([{ ...item, held: 'per-hour cap' }]);
  // One additional hourly slot admits the reset head, proving only hourly spend still blocks it.
  expect(api.planStallActions([item], { history, now: NOW, limits: { ...limits, maxActionsPerHour: 4 } }).act).toEqual([item]);
}

describe('operator restart reset accounting contracts', () => {
  const otherIdentities = [
    ['another repo', { ...target, repo: 'other/repo' }],
    ['another PR', { ...target, pr: 12 }],
    ['another head', { ...target, head: 'b'.repeat(40) }],
  ];
  it.each(otherIdentities)('reset admits exactly repo#pr@head while %s remains restart-capped', async (_name, other) => {
    await resetIsolation(await loadCopy(), other);
  });
  it.each(otherIdentities)('mutation proof: a reset must not clear the restart cap of %s', async (_name, other) => {
    const mutant = await loadCopy('Date.parse(r.ts) >= (resets.get(r.prHead) ?? -Infinity)',
      'Date.parse(r.ts) >= Math.max(-Infinity, ...resets.values())');
    await expect(resetIsolation(mutant, other)).rejects.toThrow();
  });
  it.each(['would-do', 'intent'])('reset preserves hourly %s spend and admission remains capped', async phase => {
    await resetPreservesHourlySpend(await loadCopy(), phase);
  });
  it.each(['would-do', 'intent'])('mutation proof: hourly admission must retain pre-reset %s history', async phase => {
    const mutant = await loadCopy('let hour = spending(history).filter(', 'let hour = spending(afterRestartResets(history)).filter(');
    await expect(resetPreservesHourlySpend(mutant, phase)).rejects.toThrow();
  });
  // Only the ruling that authorizes this reset may clear a cap; any other recorded ruling clears nothing.
  const unknownRulingKeepsCap = api => {
    const reset = { phase: 'operator-reset', ...target, prHead: identityKey(target), actor: 'fixture-operator',
      reason: 'owner inspected', ruling: 'whatever', ts: new Date(NOW - 30 * 60_000).toISOString() };
    const limits = options(fixture()).settings.value;
    const out = api.planStallActions([restartItem(target)], { history: [...restartHistory(target), reset], now: NOW, limits });
    expect(out.act).toEqual([]);
  };
  it('a reset recorded under an unknown ruling clears no restart cap', async () => {
    unknownRulingKeepsCap(await loadCopy());
  });
  it('mutation proof: a reset must name an allowed ruling', async () => {
    const mutant = await loadCopy('&& RESET_RULINGS.includes(r.ruling)', '');
    expect(() => unknownRulingKeepsCap(mutant)).toThrow();
  });
});

function fixture() {
  const dir = fs.mkdtempSync(join(process.env.TMPDIR, 'stall-live-safety-'));
  roots.push(dir);
  return dir;
}
const records = dir => {
  const path = join(dir, '2026-10.jsonl');
  return fs.existsSync(path) ? fs.readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
};
const pr = number => ({ repo: REPO, number, headRefOid: HEAD, title: 'pending review', body: '', isDraft: false,
  updatedAt: OLD, createdAt: OLD, headCommittedAt: OLD, labels: ['red-team:pending'], labelEvents: [],
  comments: [], statusCheckRollup: [] });

function options(dir, patch = {}) {
  return { now: NOW, env: {}, dir, log: () => {},
    settings: { value: { ...STALL_SWEEP_DEFAULTS, mode: 'shadow', actionModes: { 'restart-red-team': 'on' } }, sources: {}, errors: [] },
    readPrHead: () => HEAD,
    gh: () => { throw new Error('unexpected GitHub call'); },
    read: () => ({ now: NOW, prs: [pr(11)], liveJobs: [], unreadable: [], stalledAfterMinutes: 45 }),
    readRedTeamStatus: ({ pr: number }) => ({ repo: REPO, pr: number, head: HEAD, status: 'running',
      host: 'fixture-host', pidNamespace: 'fixture-ns', pid: 12345, pidStart: 'original-owner', startedAt: OLD }),
    probe: { host: 'fixture-host', namespace: 'fixture-ns', isAlive: () => false, readPidStart: () => 'original-owner' },
    abandonStaleRun: vi.fn(() => ({ ok: true })),
    planRestartRecovery: vi.fn(() => ({ mode: 'fresh', abandon: false })),
    dispatchRestart: vi.fn(async () => ({ status: 'dispatched', jobPid: 24680 })), ...patch };
}

// Match once or fail: a moved guard must never silently turn into an untested mutation.
// Only the imported in-memory copy changes; checkout bytes remain untouched.
async function loadCopy(find, replacement) {
  if (find !== undefined) expect(source.split(find)).toHaveLength(2);
  const changed = (find === undefined ? source : source.replace(find, replacement))
    .replace(/(\bfrom\s*)(['"])(\.\.?\/[^'"\n]+)\2/g,
      (_match, prefix, quote, path) => prefix + quote + new URL(path, sourceUrl).href + quote)
    .replaceAll('import.meta.url', JSON.stringify(sourceUrl.href));
  return import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
}

async function unknownOwner(run) {
  const input = options(fixture(), { readRedTeamStatus: () => null });
  await run(input);
  expect(input.dispatchRestart).not.toHaveBeenCalled();
}
async function heldLock(run) {
  const dir = fixture();
  fs.writeFileSync(join(dir, '.lock'), 'other-owner\n');
  const input = options(dir);
  const out = await run(input);
  expect(input.dispatchRestart).not.toHaveBeenCalled();
  expect(out.act).toEqual([]);
  expect(records(dir)).toEqual([]);
  expect(fs.readFileSync(join(dir, '.lock'), 'utf8')).toBe('other-owner\n');
}
// A pass killed while holding the lock leaves it behind; an aged lock whose recorded holder is dead must self-heal.
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
async function agedLock(run, holder) {
  const dir = fixture();
  const lock = join(dir, '.lock');
  fs.writeFileSync(lock, `${holder}\n`);
  const aged = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, aged, aged);
  const input = options(dir);
  return { dir, lock, input, out: await run(input) };
}
async function deadHolderReclaimed(run) {
  const { dir, lock, input, out } = await agedLock(run, deadPid());
  expect(out.incomplete).toBe(false);
  expect(input.dispatchRestart).toHaveBeenCalledTimes(1);
  expect(records(dir).map(r => r.phase)).toEqual(['pass', 'intent', 'did']);
  expect(fs.existsSync(lock)).toBe(false);
}
// Any failed or malformed execute-time head read stops every later candidate and marks the pass incomplete.
async function headReadStops(run, failure = 'throw') {
  const input = options(fixture(), {
    read: () => ({ now: NOW, prs: [pr(11), pr(12)], liveJobs: [], unreadable: [], stalledAfterMinutes: 45 }),
    readPrHead: vi.fn(({ pr: number }) => {
      if (number !== 11) return HEAD;
      if (failure === 'throw') throw new Error('head unavailable');
      return failure === 'null' ? null : 'not-a-sha';
    }),
  });
  const out = await run(input);
  expect(input.dispatchRestart).not.toHaveBeenCalled();
  expect(input.readPrHead).toHaveBeenCalledTimes(1);
  expect(out.incomplete).toBe(true);
  expect(records(input.dir).filter(r => r.phase === 'pass').at(-1)).toMatchObject({ incomplete: true });
  expect(records(input.dir)).toContainEqual(expect.objectContaining({ phase: 'would-skip', pr: 11, held: expect.stringMatching(/head unreadable.*operator/) }));
}
async function durableIntent(run, refuse = false) {
  const dir = fixture();
  const observed = [];
  const input = options(dir, { dispatchRestart: vi.fn(async () => {
    observed.push({ locked: fs.existsSync(join(dir, '.lock')), phases: records(dir).map(r => r.phase) });
    return { status: 'dispatched', jobPid: 24680 };
  }) });
  if (refuse) {
    const append = fs.appendFileSync;
    vi.spyOn(fs, 'appendFileSync').mockImplementation((path, data, ...args) => {
      if (String(path) === join(dir, '2026-10.jsonl') && String(data).includes('"phase":"intent"')) throw new Error('intent audit unwritable');
      return append(path, data, ...args);
    });
    syncBuiltinESMExports();
  }
  await run(input);
  if (refuse) {
    expect(input.dispatchRestart).not.toHaveBeenCalled();
    expect(records(dir).some(r => r.phase === 'did')).toBe(false);
  } else {
    expect(observed).toEqual([{ locked: true, phases: ['pass', 'intent'] }]);
    expect(records(dir).map(r => r.phase)).toEqual(['pass', 'intent', 'did']);
  }
}
async function executeBudget(run, cap) {
  const dir = fixture();
  const input = options(dir);
  input.settings.value[cap] = cap === 'maxRedTeamRestartsPerHead' ? 2 : 1;
  const append = fs.appendFileSync;
  let injected = false;
  vi.spyOn(fs, 'appendFileSync').mockImplementation((path, data, ...args) => {
    const result = append(path, data, ...args);
    // Introduce competing evidence AFTER planning and writing pass, before execute-time admission.
    if (!injected && String(path) === join(dir, '2026-10.jsonl') && String(data).includes('"phase":"pass"')) {
      injected = true;
      const prHead = `${REPO}#${cap === 'maxActionsPerPrHead' || cap === 'maxRedTeamRestartsPerHead' ? 11 : 99}@${HEAD}`;
      const count = cap === 'maxRedTeamRestartsPerHead' ? 2 : 1;
      const competing = Array.from({ length: count }, (_, n) => ({ phase: 'intent', prHead,
        key: `${prHead}:competing-${n}`, action: cap === 'maxRedTeamRestartsPerHead' ? 'restart-red-team' : 'ask-review-daemon',
        ts: new Date(cap === 'maxActionsPerSweep' ? NOW : NOW - 10 * 60_000).toISOString() }));
      append(path, competing.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    return result;
  });
  syncBuiltinESMExports();
  await run(input);
  expect(injected).toBe(true);
  expect(input.dispatchRestart).not.toHaveBeenCalled();
  expect(records(dir)).toContainEqual(expect.objectContaining({ phase: 'would-skip', action: 'restart-red-team', held: expect.stringMatching(/cap/) }));
}
// The red-team job's queued admission refuses a dead owner's running status unless it was abandoned first, so the
// sweep abandons it after durable intent and before dispatch, for exactly the assessed head.
async function abandonBeforeDispatch(run) {
  const dir = fixture();
  const events = [];
  const input = options(dir, {
    abandonStaleRun: vi.fn(key => { events.push(['abandon', key, records(dir).map(r => r.phase)]); return { ok: true }; }),
    dispatchRestart: vi.fn(async () => { events.push(['dispatch']); return { status: 'dispatched', jobPid: 24680 }; }),
  });
  await run(input);
  expect(events).toEqual([['abandon', { repo: REPO, pr: 11, head: HEAD, env: {} }, ['pass', 'intent']], ['dispatch']]);
  expect(records(dir).map(r => r.phase)).toEqual(['pass', 'intent', 'did']);
}
async function abandonRefusalStops(run, refusal = { ok: false }) {
  const input = options(fixture(), {
    read: () => ({ now: NOW, prs: [pr(11), pr(12)], liveJobs: [], unreadable: [], stalledAfterMinutes: 45 }),
    abandonStaleRun: vi.fn(() => { if (refusal instanceof Error) throw refusal; return refusal; }),
  });
  const out = await run(input);
  expect(input.abandonStaleRun).toHaveBeenCalledTimes(1);
  expect(input.dispatchRestart).not.toHaveBeenCalled();
  expect(out.incomplete).toBe(true);
  expect(records(input.dir).filter(r => r.action === 'restart-red-team').map(r => [r.pr, r.phase]))
    .toEqual([[11, 'intent'], [11, 'error']]);
  expect(records(input.dir).find(r => r.phase === 'error').error).toMatch(/abandon.*operator/);
}
// Queued admission re-plans the abandoned run and refuses any other mode: a completed seat must restart as resume.
async function recoveryModeDispatched(run) {
  const events = [];
  const input = options(fixture(), {
    abandonStaleRun: vi.fn(() => { events.push('abandon'); return { ok: true }; }),
    planRestartRecovery: vi.fn(key => { events.push(['plan', key]); return { mode: 'resume', abandon: false }; }),
    dispatchRestart: vi.fn(async args => { events.push(['dispatch', args.redTeamMode]); return { status: 'dispatched', jobPid: 24680 }; }),
  });
  await run(input);
  expect(events).toEqual(['abandon', ['plan', { repo: REPO, pr: 11, head: HEAD, env: {} }], ['dispatch', 'resume']]);
  expect(records(input.dir).map(r => r.phase)).toEqual(['pass', 'intent', 'did']);
}
// A plan admission would refuse (still abandonable, skip, unknown mode, unreadable) stops before any spawn.
async function inadmissibleRecoveryStops(run, plan = { mode: 'skip', why: 'prior pass cannot restart' }) {
  const input = options(fixture(), {
    read: () => ({ now: NOW, prs: [pr(11), pr(12)], liveJobs: [], unreadable: [], stalledAfterMinutes: 45 }),
    planRestartRecovery: vi.fn(() => { if (plan instanceof Error) throw plan; return plan; }),
  });
  const out = await run(input);
  expect(input.planRestartRecovery).toHaveBeenCalledTimes(1);
  expect(input.dispatchRestart).not.toHaveBeenCalled();
  expect(out.incomplete).toBe(true);
  expect(records(input.dir).filter(r => r.action === 'restart-red-team').map(r => [r.pr, r.phase]))
    .toEqual([[11, 'intent'], [11, 'error']]);
  expect(records(input.dir).find(r => r.phase === 'error').error).toMatch(/recovery not admissible.*operator/);
}
async function stopAfterError(run) {
  const input = options(fixture(), {
    read: () => ({ now: NOW, prs: [pr(11), pr(12)], liveJobs: [], unreadable: [], stalledAfterMinutes: 45 }),
    dispatchRestart: vi.fn(async () => { throw new Error('dispatch refused'); }),
  });
  const out = await run(input);
  expect(input.dispatchRestart).toHaveBeenCalledTimes(1);
  expect(out.incomplete).toBe(true);
  expect(records(input.dir).filter(r => r.action === 'restart-red-team').map(r => [r.pr, r.phase]))
    .toEqual([[11, 'intent'], [11, 'error']]);
}
async function shadowDefault(run) {
  const input = options(fixture());
  input.settings.value.actionModes = STALL_SWEEP_DEFAULTS.actionModes;
  await run(input);
  expect(input.dispatchRestart).not.toHaveBeenCalled();
  expect(records(input.dir).map(r => r.phase)).toEqual(['pass', 'would-do']);
}

const reread = ['const current = readAuditHistory(outDir);', 'const current = { records: history, complete: historyOk };'];
const guarantees = [
  ['unknown ownership refuses execution', unknownOwner, 'if (entry?.ownerAlive !== false)', 'if (false)'],
  ['exclusive lock refuses another owner without an audit write', heldLock, "fs.openSync(lock, 'wx')", "fs.openSync(lock, 'w')"],
  ['an aged lock whose holder is dead is reclaimed', deadHolderReclaimed, 'reclaimStaleLock(lock);', ''],
  // 'null' records no reader error, so only the unreadable-head stop holds the second candidate back.
  ['an unreadable execute-time head read stops later candidates', run => headReadStops(run, 'null'),
    "if (typeof head !== 'string' || !/^[0-9a-f]{40}$/i.test(head)) {", 'if (false) {'],
  ['durable intent precedes dispatch under the lock', durableIntent, "record({ ...i, ts, phase: 'intent', mode: cfg.mode });", ''],
  ['unwritable intent refuses dispatch', run => durableIntent(run, true), "record({ ...i, ts, phase: 'intent', mode: cfg.mode });", ''],
  ...['maxActionsPerSweep', 'maxActionsPerHour', 'maxActionsPerPrHead', 'maxRedTeamRestartsPerHead']
    .map(cap => [`execute-time ${cap} rechecks evidence added after planning`, run => executeBudget(run, cap), ...reread]),
  ['first dispatch error stops subsequent planned heads', stopAfterError, 'break; // No retry or subsequent dispatch after any error.', ''],
  ['a dead owner is abandoned after intent and before dispatch', abandonBeforeDispatch,
    'const abandoned = await abandonStaleRun({ repo: i.repo, pr: i.pr, head: i.head, env });', 'const abandoned = { ok: true };'],
  ['a refused abandonment stops the pass without dispatch', run => abandonRefusalStops(run),
    "if (abandoned?.ok !== true) throw new Error('stale red-team abandonment refused; operator must inspect');", ''],
  ['the restart dispatches the mode the post-abandonment recovery plan names', recoveryModeDispatched,
    'redTeamMode = recovery.mode;', "redTeamMode = 'fresh';"],
  ['an inadmissible post-abandonment recovery plan stops the pass without dispatch', run => inadmissibleRecoveryStops(run),
    "if (recovery?.abandon !== false || !['fresh', 'resume'].includes(recovery?.mode)) {", 'if (false) {'],
  ['a still-abandonable recovery plan stops the pass without dispatch', run => inadmissibleRecoveryStops(run, { mode: 'fresh', abandon: true }),
    "if (recovery?.abandon !== false || !['fresh', 'resume'].includes(recovery?.mode)) {", 'if (false) {'],
  ['standard shadow default never executes', shadowDefault,
    "i.action === 'restart-red-team' && cfg.actionModes?.['restart-red-team'] === 'on'", "i.action === 'restart-red-team'"],
];

describe('live restart execution guarantees', () => {
  it.each(guarantees)('%s', async (_name, verify) => {
    const control = await loadCopy();
    await verify(control.runStallSweep);
  });
  it.each(guarantees)('mutation proof: %s', async (_name, verify, find, replacement) => {
    const mutant = await loadCopy(find, replacement);
    // The same contract assertion must fail when its guard is removed.
    await expect(verify(mutant.runStallSweep)).rejects.toThrow();
  });
  it.each([[new Error('witness unreadable')], [undefined], [{ mode: 'retry', abandon: false }]])(
    'an unreadable or unknown post-abandonment recovery plan (%s) stops the pass without dispatch', async plan => {
      const control = await loadCopy();
      await inadmissibleRecoveryStops(control.runStallSweep, plan);
    });

  it.each(['off', 'shadow', 'on'])('explicit tool actionModes=%s overrides the standard shadow default with provenance', async mode => {
    const settings = resolveStallSweepSettings({ env: {}, log: () => {}, read: path => JSON.stringify({ prStallSweep:
      String(path).endsWith('pr-stall-sweep.json') ? { mode: 'shadow', actionModes: { 'restart-red-team': mode } } : {} }) });
    expect(settings.value.actionModes['restart-red-team']).toBe(mode);
    expect(settings.sources['actionModes.restart-red-team']).toBe('tool');
    const input = options(fixture(), { settings });
    await runStallSweep(input);
    expect(input.dispatchRestart).toHaveBeenCalledTimes(mode === 'on' ? 1 : 0);
  });

  it('an aged lock whose holder is still alive is never stolen', async () => {
    const { dir, lock, input, out } = await agedLock(runStallSweep, process.ppid);
    expect(input.dispatchRestart).not.toHaveBeenCalled();
    expect(out.act).toEqual([]);
    expect(records(dir)).toEqual([]);
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.ppid}\n`);
  });

  it.each(['throw', 'malformed'])('a %s execute-time head read stops later candidates', async failure => {
    await headReadStops(runStallSweep, failure);
  });

  it.each([['a throw', new Error('status claim busy')], ['no result', undefined], ['a non-true ok', { ok: 'yes' }]])(
    'an abandonment that returns %s stops the pass without dispatch', async (_name, refusal) => {
      await abandonRefusalStops(runStallSweep, refusal);
    });

  it('global off overrides the explicit live action', async () => {
    const input = options(fixture());
    input.settings.value.mode = 'off';
    await runStallSweep(input);
    expect(input.dispatchRestart).not.toHaveBeenCalled();
    expect(records(input.dir)).toEqual([]);
  });

  it('holds the exclusive lock across an awaited dispatcher and rejects an overlapping pass', async () => {
    const dir = fixture();
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const first = options(dir, { dispatchRestart: vi.fn(async () => { entered(); await held; return { status: 'dispatched', jobPid: 24680 }; }) });
    const pending = runStallSweep(first);
    try {
      await started;
      expect(fs.existsSync(join(dir, '.lock'))).toBe(true);
      const second = options(dir);
      const out = await runStallSweep(second);
      expect(out.incomplete).toBe(true);
      expect(second.dispatchRestart).not.toHaveBeenCalled();
      expect(records(dir).map(r => r.phase)).toEqual(['pass', 'intent']);
    } finally { release(); await pending; }
    expect(first.dispatchRestart).toHaveBeenCalledTimes(1);
    expect(records(dir).map(r => r.phase)).toEqual(['pass', 'intent', 'did']);
    expect(fs.existsSync(join(dir, '.lock'))).toBe(false);
  });
});


describe('execute-time evidence failure stops the whole pass', () => {
  it.each(['status', 'liveness'])('unreadable first candidate %s blocks both restarts and records an incomplete pass', async kind => {
    const input = options(fixture(), {
      read: () => ({ now: NOW, prs: [pr(11), pr(12)], liveJobs: [], unreadable: [], stalledAfterMinutes: 45 }),
    });
    const readStatus = input.readRedTeamStatus;
    let firstReads = 0, probes = 0;
    input.readRedTeamStatus = key => {
      if (key.pr === 11 && ++firstReads === 2 && kind === 'status') throw Error('status unreadable at execute');
      return readStatus(key);
    };
    input.probe.isAlive = () => {
      if (++probes === 3 && kind === 'liveness') throw Error('liveness unreadable at execute');
      return false;
    };
    const out = await runStallSweep(input);
    expect(input.dispatchRestart).not.toHaveBeenCalled();
    expect(out.incomplete).toBe(true);
    expect(records(input.dir).filter(r => r.phase === 'pass').at(-1)).toMatchObject({ incomplete: true });
  });
});
