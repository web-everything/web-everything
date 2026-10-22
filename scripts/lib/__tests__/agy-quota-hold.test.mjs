import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, utimesSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgyReprobePolicy, probeAgyModel, readAgyHoldReprobing } from '../agy-quota-hold.mjs';
import { agyRunEvidence, readAgyHold, saveAgyHold, AGY_HOLD_OBSERVATION } from '../antigravity-run-evidence.mjs';

const model = 'claude-opus-5-5-high';
const canonical = 'claude-opus-5-5';
const quotaStderr = 'error: Individual quota reached ... Resets in 126h11m11s.\nAGY_ERROR: {"code":"RESOURCE_EXHAUSTED"}\n';
const stream = (result, servedModel = model) => [JSON.stringify({ event: 'init', init: { model: servedModel } }), JSON.stringify({ event: 'result', result })].join('\n');
const policy = { enabled: true, intervalMinutes: 60, source: { enabled: 'default', intervalMinutes: 'default' } };

describe('reprobe policy', () => {
  it('uses defaults with absent settings and resolves the declared feature settings', () => {
    expect(resolveAgyReprobePolicy({ settings: {}, env: {} })).toEqual(policy);
    expect(resolveAgyReprobePolicy({ env: {} })).toEqual({ ...policy, source: { enabled: 'settings/agy-quota-reprobe.json', intervalMinutes: 'settings/agy-quota-reprobe.json' } });
  });
  it('settings override defaults and env overrides settings, including the kill switch', () => {
    const settings = { agyQuotaReprobe: { enabled: false, intervalMinutes: 12 } };
    expect(resolveAgyReprobePolicy({ settings, env: {} })).toEqual({ enabled: false, intervalMinutes: 12, source: { enabled: 'settings/agy-quota-reprobe.json', intervalMinutes: 'settings/agy-quota-reprobe.json' } });
    expect(resolveAgyReprobePolicy({ settings, env: { WE_AGY_REPROBE: '1', WE_AGY_REPROBE_INTERVAL_MIN: '5' } })).toEqual({ enabled: true, intervalMinutes: 5, source: { enabled: 'env', intervalMinutes: 'env' } });
    expect(resolveAgyReprobePolicy({ settings: {}, env: { WE_AGY_REPROBE: '0' } }).enabled).toBe(false);
  });
  it.each(['', 'bad'])('invalid enabled env falls through to settings: %j', (enabled) => {
    for (const intervalMinutes of ['', 'bad', 'x', '0', '-1', 'Infinity']) {
      expect(resolveAgyReprobePolicy({ settings: { agyQuotaReprobe: { enabled: false, intervalMinutes: 5 } }, env: { WE_AGY_REPROBE: enabled, WE_AGY_REPROBE_INTERVAL_MIN: intervalMinutes } })).toEqual({ enabled: false, intervalMinutes: 5, source: { enabled: 'settings/agy-quota-reprobe.json', intervalMinutes: 'settings/agy-quota-reprobe.json' } });
    }
  });
  it('resolves each field independently and defaults only after both layers are invalid', () => {
    const settings = { agyQuotaReprobe: { enabled: false, intervalMinutes: 12 } };
    expect(resolveAgyReprobePolicy({ settings, env: { WE_AGY_REPROBE: 'bad', WE_AGY_REPROBE_INTERVAL_MIN: '5' } })).toEqual({ enabled: false, intervalMinutes: 5, source: { enabled: 'settings/agy-quota-reprobe.json', intervalMinutes: 'env' } });
    expect(resolveAgyReprobePolicy({ settings: { agyQuotaReprobe: { enabled: 'bad', intervalMinutes: 0 } }, env: { WE_AGY_REPROBE: 'bad', WE_AGY_REPROBE_INTERVAL_MIN: 'x' } })).toEqual(policy);
  });
  it('invalid settings use defaults', () => {
    expect(resolveAgyReprobePolicy({ settings: { agyQuotaReprobe: { enabled: 'false', intervalMinutes: null } }, env: {} })).toEqual(policy);
  });
});

describe('probeAgyModel (fake synchronous spawn only)', () => {
  it('requires exit zero and a terminal result; uses one tiny tool-free call', () => {
    const spawnSyncFn = vi.fn(() => ({ status: 0, stdout: stream({ status: 'SUCCESS', response: 'OK' }) }));
    expect(probeAgyModel(model, { spawnSyncFn, cli: 'fake-agy', timeoutMs: 123 })).toMatchObject({ outcome: 'ok', code: 0 });
    expect(spawnSyncFn).toHaveBeenCalledOnce();
    expect(spawnSyncFn).toHaveBeenCalledWith('fake-agy', ['--print', 'Reply with the single word OK.', '--model', model, '--output-format', 'stream-json', '--disable-slash-commands', '--print-timeout', '60s'], { encoding: 'utf8', timeout: 123, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  });
  it('identifies quota and an explicit reset from error evidence', () => {
    const before = Date.now();
    const result = probeAgyModel(model, { spawnSyncFn: () => ({ status: 1, stdout: stream({ status: 'ERROR', error: 'RESOURCE_EXHAUSTED: Resets in 2h' }) }) });
    expect(result).toMatchObject({ outcome: 'quota', explicitReset: true, code: 1, evidence: { quotaState: 'exhausted' } });
    expect(Date.parse(result.evidence.quotaResetsAt)).toBeGreaterThanOrEqual(before + 7200000);
    expect(result.errorText).toContain('Resets in 2h');
    expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 1, stdout: stream({}), stderr: 'RESOURCE_EXHAUSTED' }) })).toMatchObject({ outcome: 'quota', explicitReset: false });
  });
  it('classifies the live stderr quota fixture before the success stderr gate', () => {
    const before = Date.now();
    for (const status of [0, 1]) {
      const result = probeAgyModel(model, { spawnSyncFn: () => ({ status, stdout: stream({ response: 'OK' }), stderr: quotaStderr }) });
      expect(result).toMatchObject({ outcome: 'quota', explicitReset: true, errorText: quotaStderr.trim() });
      expect(Date.parse(result.evidence.quotaResetsAt)).toBeGreaterThanOrEqual(before + 454271000);
    }
    expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 1,
      stdout: JSON.stringify({ event: 'init', init: { model } }), stderr: quotaStderr }) }))
      .toMatchObject({ outcome: 'quota', explicitReset: true });
  });
  it.each(['warning: transport interrupted'])('rejects non-quota stderr even with a successful result: %s', (stderr) => {
    expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 0, stdout: stream({ response: 'OK' }), stderr: `  ${stderr}\n` }) })).toMatchObject({ outcome: 'error', errorText: stderr });
  });
  it('accepts whitespace-only stderr and blank stdout lines around valid events', () => {
    expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 0, stdout: `\n \t\n${stream({ response: 'OK' })}\n \t\n`, stderr: ' \t\r\n' }) }).outcome).toBe('ok');
  });
  it.each([model, canonical, 'gemini-3.1-pro', 'unknown', undefined])('rejects repeated or conflicting init identity: %s', (servedModel) => {
    const [init, result] = stream({ response: 'OK' }).split('\n');
    const extra = JSON.stringify({ event: 'init', init: { model: servedModel } });
    for (const stdout of [`${init}\n${extra}\n${result}`, `${extra}\n${init}\n${result}`]) {
      expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 0, stdout }) }).outcome).toBe('error');
    }
  });
  it('requires exactly one matching canonical init', () => {
    expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 0, stdout: JSON.stringify({ event: 'result', result: { response: 'OK' } }) }) }).outcome).toBe('error');
    expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 0, stdout: stream({ response: 'OK' }, canonical) }) }).outcome).toBe('ok');
  });
  it.each(['not JSON', '{"event":'])('rejects malformed stdout anywhere: %s', (line) => {
    const [init, result] = stream({ response: 'OK' }).split('\n');
    for (const stdout of [`${line}\n${init}\n${result}`, `${init}\n${line}\n${result}`, `${init}\n${result}\n${line}`]) {
      expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 0, stdout }) }).outcome).toBe('error');
    }
  });
  it.each([{ event: 'progress' }, { event: 'result', result: { response: 'OK' } }, null, 'extra'])('rejects any JSON line after the terminal result: %j', (event) => {
    const stdout = `${stream({ response: 'OK' })}\n\n${JSON.stringify(event)}\n`;
    expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 0, stdout }) }).outcome).toBe('error');
  });
  it.each(['Error: broken', 'NOT OK', 'ok but failed'])('rejects a non-acknowledgement: %s', (response) => {
    expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 0, stdout: stream({ status: 'SUCCESS', response }) }) }).outcome).toBe('error');
  });
  it.each(['  "Ok."  ', '“ok!”', '(OK)', '\n OK \t'])('accepts an exact acknowledgement with surrounding punctuation: %j', (response) => {
    expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 0, stdout: stream({ status: 'SUCCESS', response }) }) }).outcome).toBe('ok');
  });
  it.each([
    { status: 1, stdout: stream({ status: 'SUCCESS' }) },
    { status: 0, stdout: '{"event":"init"}' },
    { status: 0, stdout: stream({ error: 'failure' }) },
    { status: 0, stdout: stream({ status: 'ERROR' }) },
    { status: 0, stdout: stream({ status: 'SUCCESS' }) },
    { status: 0, stdout: stream({ status: 'SUCCESS', response: '' }) },
    { status: 0, stdout: stream({ status: 'SUCCESS', response: '   ' }) },
    { status: 0, stdout: stream({ status: 'SUCCESS', response: 'done' }) },
    { status: 0, stdout: stream({ status: 'SUCCESS', response: { text: 'OK' } }) },
    ...['FAILED', 'CANCELLED', 'IN_PROGRESS', null].map((status) => ({ status: 0, stdout: stream({ status, response: 'OK' }) })),
    { status: null, error: new Error('spawn timeout'), stdout: stream({ status: 'SUCCESS' }) },
    { status: 0, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), stdout: stream({ status: 'SUCCESS', response: 'OK' }) },
    { status: null, signal: 'SIGKILL', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), stdout: stream({ error: 'RESOURCE_EXHAUSTED Resets in 2h' }) },
  ])('does not lift on failed or incomplete calls: %j', (run) => {
    expect(probeAgyModel(model, { spawnSyncFn: () => run }).outcome).toBe('error');
  });
  it('accepts case-insensitive OK with an absent status, using the last terminal result', () => {
    expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 0, stdout: stream({ response: 'ok' }) }) }).outcome).toBe('ok');
    expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 0, stdout: stream({ response: 'OK' }) + '\n' + JSON.stringify({ event: 'result', result: { status: 'CANCELLED', response: 'OK' } }) }) }).outcome).toBe('error');
  });
  it.each(['unknown', 'sonnet', 'claude-sonnet-4-6', 'gemini-3.1-pro'])('rejects served identity %s even with success or quota evidence', (servedModel) => {
    for (const terminal of [{ status: 'SUCCESS', response: 'OK' }, { error: 'RESOURCE_EXHAUSTED Resets in 2h' }]) {
      expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 0, stdout: stream(terminal, servedModel) }) }).outcome).toBe('error');
    }
  });
  it('never spawns an alias and cannot disable the timeout', () => {
    const spawnSyncFn = vi.fn(() => ({ status: 0, stdout: stream({ response: 'OK' }) }));
    expect(probeAgyModel('sonnet', { spawnSyncFn }).outcome).toBe('error');
    expect(spawnSyncFn).not.toHaveBeenCalled();
    for (const timeoutMs of [0, -1, Infinity, NaN]) {
      probeAgyModel(model, { spawnSyncFn, timeoutMs });
      expect(spawnSyncFn.mock.lastCall[2].timeout).toBe(90000);
    }
  });
  it('handles spawn throws and trims error text to 500 characters', () => {
    expect(probeAgyModel(model, { spawnSyncFn: () => { throw new Error(' failed '); } })).toMatchObject({ outcome: 'error', code: null, errorText: 'failed' });
    expect(probeAgyModel(model, { spawnSyncFn: () => ({ status: 1, stderr: ' '.repeat(5) + 'x'.repeat(600) }) }).errorText).toHaveLength(500);
  });
});

describe('hold reprobing with isolated state', () => {
  let dir, now, statePath, lockPath, original, log;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agy-reprobe-'));
    now = Date.now();
    statePath = join(dir, 'probes', `${canonical}.json`);
    lockPath = join(dir, 'probes', `${canonical}.lock`);
    original = agyRunEvidence({ requestedModel: model, now, stdout: stream({ error: 'RESOURCE_EXHAUSTED Resets in 90h' }) });
    saveAgyHold(original, { dir });
    for (const name of readdirSync(join(dir, 'anthropic'))) utimesSync(join(dir, 'anthropic', name), (now - 2000) / 1000, (now - 2000) / 1000);
    log = vi.fn();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const result = (outcome, evidence = {}, extra = {}) => ({ outcome, evidence: { servedModel: model, ...evidence }, errorText: '', ...extra });
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const seed = (value) => { mkdirSync(join(dir, 'probes'), { recursive: true }); writeFileSync(statePath, JSON.stringify(value)); };
  const run = (probe, extra = {}) => readAgyHoldReprobing(model, { dir, now, policy, log, probe, ...extra });

  it('propagates hold read errors rather than admitting a launch', () => {
    writeFileSync(join(dir, 'anthropic', 'unreadable.json'), 'invalid JSON');
    const probe = vi.fn();
    expect(() => run(probe)).toThrow(SyntaxError);
    expect(probe).not.toHaveBeenCalled();
    rmSync(join(dir, 'anthropic', 'unreadable.json'));
    mkdirSync(join(dir, 'anthropic', 'unreadable.json'));
    expect(() => run(probe)).toThrow();
  });
  it.each(['sonnet', 'opus', 'custom-alias'])('never probes alias request or alias-only observation: %s', (alias) => {
    const probe = vi.fn();
    expect(readAgyHoldReprobing(alias === 'custom-alias' ? 'sonnet' : alias, { dir, now, policy, probe, log })).not.toBeNull();
    rmSync(join(dir, 'anthropic'), { recursive: true });
    saveAgyHold({ ...original, requestedModel: alias, servedModel: alias, servedBackend: 'anthropic' }, { dir });
    expect(run(probe)).not.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('throttles within the interval, then probes at the boundary', () => {
    seed({ lastProbeAt: now - 3599999 });
    const probe = vi.fn(() => result('error', {}, { errorText: 'offline' }));
    expect(run(probe)?.quotaResetsAt).toBe(original.quotaResetsAt);
    expect(probe).not.toHaveBeenCalled();
    run(probe, { now: now + 1 });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(model);
    expect(state().lastProbeAt).toBe(now + 1);
  });
  it('skips disabled policy, even forced, and skips absent holds', () => {
    const probe = vi.fn();
    expect(run(probe, { policy: { ...policy, enabled: false }, force: true })).not.toBeNull();
    expect(readAgyHoldReprobing('gemini-3.1-pro', { dir, now, policy, probe })).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
  it('returns immediately when another process holds the lock', () => {
    seed({}); writeFileSync(lockPath, '');
    const probe = vi.fn();
    expect(run(probe)).not.toBeNull();
    expect(probe).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(true);
  });
  it('shares single-flight admission and throttling across effort variants', () => {
    const second = vi.fn(() => result('error'));
    run(() => {
      expect(readAgyHoldReprobing(`${canonical}-low`, { dir, now, policy, probe: second, log })).not.toBeNull();
      return result('error');
    });
    expect(second).not.toHaveBeenCalled();
    readAgyHoldReprobing(`${canonical}-low`, { dir, now, policy, probe: second, log });
    expect(second).not.toHaveBeenCalled();
  });
  it('breaks a lock older than ten minutes and releases its own lock', () => {
    seed({}); writeFileSync(lockPath, '');
    utimesSync(lockPath, (now - 600001) / 1000, (now - 600001) / 1000);
    const probe = vi.fn(() => result('error'));
    run(probe);
    expect(probe).toHaveBeenCalledOnce();
    expect(existsSync(lockPath)).toBe(false);
  });
  it('does not probe when a competing stale breaker replaced the lock with a fresh one', () => {
    seed({}); writeFileSync(lockPath, '');
    utimesSync(lockPath, (now - 600001) / 1000, (now - 600001) / 1000);
    const winner = vi.fn(() => {
      // A delayed stale breaker has now moved our fresh lock aside; its age check must stop it.
      rmSync(lockPath);
      return result('error');
    });
    const loser = vi.fn(() => result('error'));
    run(loser, { force: true, fsOps: { statSync, renameSync: (from, to) => {
      run(winner, { force: true });
      writeFileSync(lockPath, 'fresh successor');
      renameSync(from, to);
    } } });
    expect(winner).toHaveBeenCalledOnce();
    expect(loser).not.toHaveBeenCalled();
  });
  it('a fresh state claim prevents a second probe after stale-lock recovery, even forced', () => {
    const second = vi.fn(() => result('error'));
    const first = vi.fn(() => {
      expect(state().claim).toMatchObject({ token: expect.any(String), startedAt: now });
      utimesSync(lockPath, (now - 600001) / 1000, (now - 600001) / 1000);
      expect(run(second, { force: true })).not.toBeNull();
      return result('error');
    });
    run(first);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(state().claim).toBeUndefined();
  });
  it.each([
    {}, { servedModel: 'unknown' }, { servedModel: 'sonnet' },
    { servedModel: 'claude-sonnet-4-6' }, { servedModel: 'gemini-3.1-pro' },
    { servedModel: model, fallbackDecision: 'skip-backend-mismatch' },
    { servedModel: model, fallbackDecision: 'skip-model-mismatch' },
  ])('keeps holds and never saves or supersedes on invalid probe identity: %j', (evidence) => {
    for (const outcome of ['ok', 'quota']) {
      expect(run(() => ({ outcome, evidence: { quotaResetsAt: new Date(now + 60000).toISOString(), quotaState: 'exhausted', servedBackend: 'google', ...evidence }, explicitReset: true }), { force: true })).not.toBeNull();
      expect(state()).toMatchObject({ outcome: 'error' });
      expect(state().supersedesBefore).toBeUndefined();
      expect(readdirSync(join(dir, 'anthropic'))).toHaveLength(1);
      expect(existsSync(join(dir, 'google'))).toBe(false);
    }
  });
  it('lifts on success, persists supersession and logs the model, interval and source', () => {
    expect(run(() => result('ok', { servedModel: canonical }))).toBeNull();
    expect(state()).toMatchObject({ outcome: 'ok', lastProbeAt: now, supersedesBefore: now, probedModel: model });
    expect(readAgyHold(model, { dir, now })).toBeNull();
    expect(log.mock.calls[0][0]).toContain(`lifted for ${model}: probe succeeded (${canonical})`);
    expect(log.mock.calls[0][0]).toContain('interval 60m (source');
    expect(existsSync(lockPath)).toBe(false);
  });
  it('replaces the old end date only with explicitly observed quota reset evidence', () => {
    const evidence = agyRunEvidence({ requestedModel: model, now, stdout: stream({ error: 'RESOURCE_EXHAUSTED Resets in 2h' }) });
    expect(run(() => result('quota', evidence, { explicitReset: true }))?.quotaResetsAt).toBe(evidence.quotaResetsAt);
    expect(state()).toMatchObject({ outcome: 'quota', supersedesBefore: now - 1, quotaResetsAt: evidence.quotaResetsAt });
    expect(readdirSync(join(dir, 'anthropic'))).toHaveLength(2);
    expect(log.mock.calls[0][0]).toContain(`kept for ${model}: quota reset ${evidence.quotaResetsAt}`);
  });
  it.each(['default', undefined].flatMap((requestedModel) => [undefined, model].map((lookup) => [requestedModel, lookup])))('preserves default-launch scope for %j when reprobing via %j', (requestedModel, lookup) => {
    rmSync(join(dir, 'anthropic'), { recursive: true });
    const observed = { ...original, requestedModel };
    if (requestedModel === undefined) delete observed.requestedModel;
    saveAgyHold(observed, { dir });
    for (const name of readdirSync(join(dir, 'anthropic'))) utimesSync(join(dir, 'anthropic', name), (now - 2000) / 1000, (now - 2000) / 1000);
    const probe = vi.fn((target) => probeAgyModel(target, { spawnSyncFn: () => ({ status: 1, stdout: stream({ error: 'RESOURCE_EXHAUSTED Resets in 2h' }) }) }));
    const after = readAgyHoldReprobing(lookup, { dir, now, policy, probe, log });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(model);
    const deadline = probe.mock.results[0].value.evidence.quotaResetsAt;
    expect(Date.parse(deadline)).toBeGreaterThanOrEqual(now + 7200000);
    expect(deadline).not.toBe(original.quotaResetsAt);
    expect(after?.quotaResetsAt).toBe(deadline);
    for (const request of [undefined, model]) {
      const held = readAgyHold(request, { dir, now });
      expect(held?.quotaResetsAt).toBe(deadline);
      expect(held?.[AGY_HOLD_OBSERVATION]).toMatchObject({ requestedModel: 'default', servedModel: model });
    }
  });
  it.each(['unknown', '1month', '5x', '2h3mx'])('keeps the long hold when a later numeric reset follows an invalid reset: %s', (token) => {
    const probe = () => probeAgyModel(model, { spawnSyncFn: () => ({ status: 1,
      stderr: `RESOURCE_EXHAUSTED Resets in ${token}`,
      stdout: stream({ error: 'Resets in 90h' }) }) });
    expect(probe()).toMatchObject({ outcome: 'quota', explicitReset: false, evidence: { quotaResetExplicit: false } });
    expect(run(probe)?.quotaResetsAt).toBe(original.quotaResetsAt);
    expect(state().supersedesBefore).toBeUndefined();
    expect(readdirSync(join(dir, 'anthropic'))).toHaveLength(1);
  });
  it.each(['quota', 'error'])('keeps every existing hold for %s without an explicit reset', (outcome) => {
    seed({ supersedesBefore: now - 5000 });
    expect(run(() => result(outcome, { quotaResetsAt: new Date(now + 60000).toISOString() }, { errorText: 'unconfirmed' }))?.quotaResetsAt).toBe(original.quotaResetsAt);
    expect(state()).toMatchObject({ lastProbeAt: now, outcome, supersedesBefore: now - 5000, errorText: 'unconfirmed' });
    expect(readdirSync(join(dir, 'anthropic'))).toHaveLength(1);
  });
  it.each([new Error('broken probe'), null])('keeps a hold when probe throws %j and releases the lock', (error) => {
    expect(run(() => { throw error; })?.quotaResetsAt).toBe(original.quotaResetsAt);
    expect(existsSync(lockPath)).toBe(false);
    expect(log.mock.calls[0][0]).toContain(error ? 'broken probe' : 'null');
  });
  it('keeps a hold on internal state failure, even if logging throws', () => {
    seed({}); writeFileSync(statePath, 'invalid');
    const probe = vi.fn();
    expect(run(probe, { log: () => { throw new Error('log failed'); } })?.quotaResetsAt).toBe(original.quotaResetsAt);
    expect(probe).not.toHaveBeenCalled();
  });
  it('force bypasses the interval while retaining the lock', () => {
    seed({ lastProbeAt: now });
    const probe = vi.fn(() => result('error'));
    run(probe, { force: true });
    expect(probe).toHaveBeenCalledOnce();
    writeFileSync(lockPath, '');
    run(probe, { force: true });
    expect(probe).toHaveBeenCalledOnce();
  });
  it('default launches probe the observed served model, and unknown defaults never probe', () => {
    rmSync(join(dir, 'anthropic'), { recursive: true });
    saveAgyHold({ ...original, requestedModel: 'default' }, { dir });
    const probe = vi.fn(() => result('error'));
    readAgyHoldReprobing(undefined, { dir, now, policy, probe, log });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(model);
    rmSync(join(dir, 'anthropic'), { recursive: true });
    saveAgyHold({ ...original, requestedModel: 'default', servedModel: 'unknown', servedBackend: 'unknown' }, { dir });
    probe.mockClear();
    expect(readAgyHoldReprobing(undefined, { dir, now, policy, probe, log })).not.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});
