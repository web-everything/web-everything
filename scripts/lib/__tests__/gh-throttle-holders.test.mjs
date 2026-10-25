import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepAliveScript } from '../test-keepalive.mjs';
import { acquireGhSlotSync, noteSlotTimeout, runGhSync, runGhCliPassthrough, classifyGhWrite, ghCallerPriority, classifyGhResource } from '../gh-throttle.mjs';
import { ghHolderMeta, readGhSlotHolders, loadGhThrottleSettings, ghExecOptions, ghCallerKey, redactGhArgs, isGhWatch, ghOpLabel, acquireGhHolderSlot, describeLegacyHolders, ghHoldersSummary } from '../gh-throttle-holders.mjs';
import { readLockEntry, reserve, releaseLockDir } from '../../readiness/file-locks.mjs';
import { slotPath } from '../../readiness/heavy-admission.mjs';

let root, logPath;
const policy = { maxHoldSeconds: 90, reapGraceSeconds: 15, perCallerMax: 4 };
const clock = 1_800_000_000_000;
function acquire(owner, caller = 'worker', extra = {}) {
  return acquireGhSlotSync({ lockRoot: root, logPath, cap: 6, owner, pid: process.pid, meta: ghHolderMeta({ caller, args: ['api', 'user'], nowMs: clock }), now: () => clock, sleep: () => {}, timeoutMs: 0, policy, warn: () => {}, ...extra });
}
function rows() { return readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse); }
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gh-holders-')); logPath = join(root, 'calls.jsonl'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('gh holders', () => {
  it.each([
    ['-fapi_key=hidden-value'], ['-Fprivate_key=hidden-value'], ['--field', 'credential=hidden-value'],
    ['--raw-field=body=hidden-value'], ['-HCookie: hidden-value'], ['--header', 'X-App-Key: hidden-value'],
    ['--body', 'hidden-value\n`quoted`\r\u2028invisible\u200b'], ['--token', 'hidden-value'],
  ])('omits attached, separate and free-text values: %j', (...tail) => {
    const meta = ghHolderMeta({ caller: 'worker', args: ['api', 'user', ...tail] });
    expect(JSON.stringify(meta)).not.toContain('hidden-value');
  });
  it('sanitizes every holder field supplied directly to timeout reporting', () => {
    const warn = vi.fn();
    const holders = [{ caller: 'worker --token hidden-value', op: 'pr view hidden-value', parent: 'node -e 0 --token hidden-value.mjs', ppid: 'hidden-value', slot: 'hidden-value', pid: 'hidden-value', alive: 'hidden-value', heldMs: 'hidden-value', args: 'hidden-value' }];
    noteSlotTimeout(logPath, { timedOut: true, holders }, {}, warn);
    expect(readFileSync(logPath, 'utf8') + JSON.stringify(warn.mock.calls)).not.toContain('hidden-value');
  });
  it.each(['api_key', 'private_key', 'credential', 'body', 'cookie', 'x-service-key'])('never persists %s payloads or headers', (key) => {
    const args = ['api', 'user', '-f', `${key}=sensitive-value`, '-H', 'Cookie: sensitive-value', '--header=X-Service-Key: sensitive-value'];
    acquire('one', 'worker', { cap: 1, meta: ghHolderMeta({ caller: 'worker', args, nowMs: clock }) });
    expect(JSON.stringify(readLockEntry(root, slotPath(0)))).not.toContain('sensitive-value');
    const warn = vi.fn();
    noteSlotTimeout(logPath, acquire('two', 'other', { cap: 1 }), {}, warn);
    expect(readFileSync(logPath, 'utf8') + JSON.stringify(warn.mock.calls)).not.toContain('sensitive-value');
  });
  it('sanitizes stored legacy metadata before reaping, logging and warning', () => {
    reserve(root, slotPath(0), 'one', clock, new Date(clock).toISOString(), process.pid, 'unknown', 60, { caller: 'worker --token hidden-value', op: "api user -H 'Cookie: hidden-value'", parent: 'node parent.mjs --credential hidden-value', acquiredAt: new Date(clock).toISOString() });
    const holders = readGhSlotHolders({ lockRoot: root, cap: 1, nowMs: clock });
    expect(JSON.stringify(holders) + ghHoldersSummary(holders)).not.toContain('hidden-value');
    const warn = vi.fn();
    acquire('next', 'other', { cap: 1, now: () => clock + 106000, warn });
    expect(readFileSync(logPath, 'utf8') + JSON.stringify(warn.mock.calls)).not.toContain('hidden-value');
    expect(rows()[0].op).toBe('api');
  });
  it.each([false, true].flatMap(capped => [false, true].flatMap(full => [false, true].map(aged => [capped, full, aged]))))('admission decision table: capped=%s full=%s aged=%s', (capped, full, aged) => {
    for (let i = 0; i < (full ? 6 : 4); i++) acquire(`old-${i}`, i < 4 ? 'worker' : `other-${i}`);
    const r = acquire('next', capped ? 'worker' : 'new-worker', { now: () => clock + (aged ? 106000 : 104000) });
    expect(r.ok).toBe(aged || (!capped && !full));
    if (aged && (capped || full)) expect(rows().some(row => row.outcome === 'slot_reaped')).toBe(true);
  });
  it.each([[300000, 106000, false], [300000, 315001, true], [0, 400000, false]])('respects effective timeout %s when reaping at %s', (timeoutMs, age, reaped) => {
    acquire('one', 'worker', { cap: 1, meta: ghHolderMeta({ caller: 'worker', args: ['pr', 'view', '123'], timeoutMs, nowMs: clock }) });
    expect(acquire('next', 'other', { cap: 1, now: () => clock + age }).ok).toBe(reaped);
  });
  it('reap logs and metrics use bounded operations', async () => {
    const telemetry = await import('../../operations/telemetry-store.mjs');
    const recordMetric = vi.fn();
    const spy = vi.spyOn(telemetry, 'createTelemetryRecorder').mockReturnValue({ recordMetric });
    try {
      acquire('one', 'worker', { cap: 1, meta: ghHolderMeta({ caller: 'worker', args: ['pr', 'view', '123', '--body', 'private-body'], nowMs: clock }) });
      acquire('next', 'other', { cap: 1, now: () => clock + 106000 });
      expect(rows()[0]).toMatchObject({ outcome: 'slot_reaped', op: 'pr view' });
      expect(rows()[0].args).not.toMatch(/123|private-body/);
      expect(recordMetric).toHaveBeenCalledWith('gh.throttle.slot_reaped', 1, { unit: 'count', attributes: { op: 'pr view', source: 'max-hold', attempt: undefined } });
    } finally { spy.mockRestore(); }
  });
  it('writes redacted metadata and reads live holder attribution', () => {
    const args = ['api', 'user', '-H', 'Authorization: Bearer abc', '-f', 'client_secret=hidden', '-F', 'password=hidden', 'ghp_abcdef', 'github_pat_abcdef', 'token=hidden', '--field=client_secret=hidden', '--raw-field=password=hidden', 'Bearer', 'hidden', 'token="hidden words"', "Bearer 'hidden words'"];
    acquire('one', 'worker', { meta: ghHolderMeta({ caller: 'worker', args, nowMs: clock }) });
    const entry = readLockEntry(root, slotPath(0));
    expect(entry.meta).toMatchObject({ caller: 'worker', pid: process.pid, ppid: process.ppid, acquiredAt: new Date(clock).toISOString() });
    expect(entry.meta.op).not.toMatch(/hidden|abcdef|Bearer|abc/);
    expect(entry.meta.op).toBe('api');
    expect(entry.meta.args).toBe('api <redacted>');
    expect(redactGhArgs(['x'.repeat(500)])).toBe('unknown');
    expect(readGhSlotHolders({ lockRoot: root, cap: 6, nowMs: clock + 95000 })[0]).toMatchObject({ slot: 0, alive: true, heldMs: 95000, caller: 'worker' });
  });
  it('logs holders and warns on slot timeout', () => {
    acquire('one', 'worker', { cap: 1 });
    const acq = acquire('two', 'other', { cap: 1 });
    const warn = vi.fn();
    noteSlotTimeout(logPath, acq, { caller: 'other' }, warn);
    expect(rows()[0]).toMatchObject({ outcome: 'slot_timeout', holders: [{ caller: 'worker', slot: 0 }] });
    expect(warn.mock.calls[0][0]).toContain('holders: worker(api, 0s)');
  });
  it.each([[106000, 90, true], [104000, 90, false], [106000, 0, false]])('reaps only over-age enabled holds (%s, %s)', (age, maxHoldSeconds, reaped) => {
    acquire('one', 'worker', { cap: 1 });
    const r = acquire('two', 'other', { cap: 1, now: () => clock + age, policy: { ...policy, maxHoldSeconds } });
    expect(r.ok).toBe(reaped);
    if (reaped) expect(rows()[0]).toMatchObject({ outcome: 'slot_reaped', caller: 'worker', heldMs: age });
  });
  it('uses the heartbeat for legacy holders without metadata', () => {
    reserve(root, slotPath(0), 'old', clock, new Date(clock).toISOString(), process.pid);
    expect(acquire('next', 'other', { cap: 1, now: () => clock + 106000 }).ok).toBe(true);
  });
  it('caps a caller at four while allowing other callers, and zero disables', () => {
    for (let i = 0; i < 4; i++) expect(acquire('owner' + i).ok).toBe(true);
    expect(acquire('fifth').ok).toBe(false);
    expect(acquire('other', 'different').ok).toBe(true);
    expect(acquire('uncapped', 'worker', { policy: { ...policy, perCallerMax: 0 } }).ok).toBe(true);
    expect(ghCallerKey({ caller: 'node', ppid: 123 })).toBe('ppid:123');
  });
  it('does not reap a holder that changed owners after the snapshot', () => {
    acquire('one', 'worker', { cap: 1 });
    let calls = 0;
    const onReap = vi.fn();
    acquireGhHolderSlot({ lockRoot: root, cap: 1, owner: 'waiter', pid: process.pid, pollMs: 1, timeoutMs: 0,
      now: () => clock + 106000, sleep: () => {}, meta: ghHolderMeta({ caller: 'other', args: [] }), policy, onReap,
      trySlot: () => {
        if (++calls === 1) {
          releaseLockDir(root, slotPath(0));
          reserve(root, slotPath(0), 'replacement', clock, new Date(clock).toISOString(), process.pid);
        }
        return { ok: false };
      },
    });
    expect(onReap).not.toHaveBeenCalled();
    expect(readLockEntry(root, slotPath(0)).owner).toBe('replacement');
  });
  it('waits with the injected clock and sleep', () => {
    acquire('one', 'worker', { cap: 1 });
    let t = clock;
    const r = acquire('two', 'other', { cap: 1, now: () => t, sleep: (ms) => { t += ms; }, pollMs: 10, timeoutMs: 20 });
    expect(r.waitedMs).toBe(20);
  });
});

describe('hold policy and execution', () => {
  it('uses the same safe operation on call and memo-hit logs', () => {
    const memo = join(root, 'memo');
    mkdirSync(memo);
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) }));
    const throttle = { lockRoot: root, logPath, spawn, budgetPerMin: 100, personalRoute: false,
      env: { WE_GH_READ_MEMO_DIR: memo, WE_GH_THROTTLE_COST_HEADERS: '1', WE_GH_PERSONAL_READS: '0' } };
    const args = ['api', 'repos/o/r?api_key=hidden-value', '--method', 'GET'];
    runGhSync(args, { throttle });
    runGhSync(args, { throttle });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(rows()).toMatchObject([{ outcome: 'call', op: 'api' }, { outcome: 'memo_hit', op: 'api' }]);
    expect(readFileSync(logPath, 'utf8')).not.toContain('hidden-value');
  });
  it('preserves an explicit kill signal when adding the default timeout', () => {
    expect(ghExecOptions({ killSignal: 'SIGKILL' }, ['api'], policy)).toEqual({ timeout: 90000, killSignal: 'SIGKILL' });
  });
  it.each([300000, 0])('records the effective explicit timeout %s in the executing holder', (timeout) => {
    const spawn = vi.fn(() => {
      expect(readGhSlotHolders({ lockRoot: root, cap: 6 })[0].timeoutMs).toBe(timeout);
      return { status: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) };
    });
    runGhSync(['api', 'user'], { timeout, throttle: { lockRoot: root, logPath, env: {}, spawn, budgetPerMin: 100 } });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it.each([['sync', 90], ['sync', 0], ['passthrough', 90], ['passthrough', 0]])('records the default effective timeout and safe operation in %s execution (policy %s)', (mode, maxHoldSeconds) => {
    const spawn = vi.fn(() => {
      expect(readGhSlotHolders({ lockRoot: root, cap: 6 })[0]).toMatchObject({ timeoutMs: maxHoldSeconds * 1000, op: 'api' });
      return { status: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) };
    });
    const throttle = { lockRoot: root, logPath, env: { WE_GH_THROTTLE_MAX_HOLD_SECONDS: String(maxHoldSeconds) }, spawn, budgetPerMin: 100 };
    if (mode === 'sync') runGhSync(['api', 'user'], { throttle });
    else runGhCliPassthrough(['api', 'user'], { throttle, spawn });
    expect(rows().find(row => row.outcome === 'call').op).toBe('api');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('resolves tool JSON and env provenance', () => {
    expect(loadGhThrottleSettings({ env: {} })).toMatchObject({ value: policy, sources: { maxHoldSeconds: 'tool', reapGraceSeconds: 'tool', perCallerMax: 'tool' } });
    expect(loadGhThrottleSettings({ env: { WE_GH_THROTTLE_MAX_HOLD_SECONDS: '0', WE_GH_THROTTLE_PER_CALLER_MAX: '2' } })).toMatchObject({ value: { maxHoldSeconds: 0, perCallerMax: 2 }, sources: { maxHoldSeconds: 'env', perCallerMax: 'env' } });
  });
  it('preserves explicit timeout, disables at zero and exempts all watch shapes', () => {
    expect(ghExecOptions({}, ['api'], policy)).toEqual({ timeout: 90000, killSignal: 'SIGTERM' });
    expect(ghExecOptions({ timeout: 7 }, ['api'], policy)).toEqual({ timeout: 7 });
    expect(ghExecOptions({}, ['api'], { ...policy, maxHoldSeconds: 0 })).toEqual({});
    for (const a of [['run', 'watch'], ['pr', 'checks', '--watch']]) expect(ghExecOptions({ timeout: 7 }, a, policy)).toEqual({});
  });
  // gh parses with cobra/pflag: global flags may precede the command, bool flags take `--flag=value`,
  // and a value flag consumes the next argument even when it starts with `--`.
  it.each([
    ['run', 'watch'], ['run', 'watch', '123'], ['--repo', 'o/r', 'run', 'watch', '123'], ['-R', 'o/r', 'run', 'watch'],
    ['run', '-R', 'o/r', 'watch', '123'], ['-Ro/r', 'run', 'watch'], ['--repo=o/r', 'run', 'watch'],
    ['pr', 'checks', '--watch'], ['pr', 'checks', '123', '--watch=true'], ['pr', 'checks', '123', '--watch=1'], ['pr', 'checks', '--watch=T'],
    ['--repo', 'o/r', 'pr', 'checks', '123', '--watch'], ['pr', '-R', 'o/r', 'checks', '--watch'], ['pr', 'checks', '--required', '--watch'],
    ['pr', 'checks', '--fail-fast', '-w', '--watch'], ['pr', 'checks', '-i', '5', '--watch'], ['pr', 'checks', '-wRo/r', '--watch'],
    ['pr', 'checks', '--watch=false', '--watch'],
  ].map(a => [a]))('treats a valid watch invocation as watch: %j', (args) => {
    expect(isGhWatch(args)).toBe(true);
    expect(ghExecOptions({ timeout: 7 }, args, policy)).toEqual({});
  });
  it.each([
    ['pr', 'comment', '123', '--body', '--watch'], ['pr', 'checks', '123', '--jq', '--watch'], ['pr', 'checks', '-q', '--watch'],
    ['pr', 'checks', '-t', '--watch'], ['pr', 'checks', '-wq', '--watch'], ['pr', 'checks', '--watch=false'], ['pr', 'checks', '--watch', '--watch=0'],
    ['pr', 'checks', '--watch=maybe'], ['pr', 'checks', '--', '--watch'], ['pr', '--', 'checks', '--watch'], ['api', '-f', '--watch'],
    ['api', 'repos/o/r', '--watch'], ['run', 'view', 'watch'], ['--repo', 'run', 'watch'], ['issue', 'list', '--search', 'run watch'],
    ['pr', 'view', 'checks', '--watch'], ['pr', '--watch', 'checks'], [],
    // Inherited Object members are not watch leaves (a plain-object table resolved these and threw).
    ['constructor', '--watch'], ['toString', '-w'], ['__proto__', '--watch'], ['hasOwnProperty', '--x', 'y'],
  ].map(a => [a]))('does not treat an argument value or other command as watch: %j', (args) => {
    expect(isGhWatch(args)).toBe(false);
    expect(ghExecOptions({ timeout: 7 }, args, policy)).toEqual({ timeout: 7 });
    expect(ghExecOptions({}, args, policy)).toEqual({ timeout: 90000, killSignal: 'SIGTERM' });
  });
  it.each([
    [['--repo', 'o/r', 'run', 'watch', '123'], 'run watch'], [['pr', '-R', 'o/r', 'checks', '1'], 'pr checks'],
    [['--repo=o/r', 'pr', 'view'], 'pr view'], [['-R', 'pr', 'issue', 'list'], 'issue list'], [['api', '-X', 'GET', 'user'], 'api'],
  ])('labels the operation from command positions, not fixed indices: %j', (args, label) => {
    expect(ghOpLabel(args)).toBe(label);
  });
  it.each([
    [['-R', 'o/r', 'pr', 'comment', '1', '--body', 'x'], true], [['--repo=o/r', 'issue', 'close', '1'], true], [['run', '-R', 'o/r', 'cancel', '1'], true],
    [['api', '-X', 'DELETE', 'repos/o/r/labels/x'], true], [['api', '--method=POST', 'repos/o/r'], true], [['api', '-XPATCH', 'repos/o/r'], true],
    [['api', '--method', 'POST', '--method', 'GET', 'repos/o/r'], false], [['api', '-X', 'GET', 'repos/o/r', '-f', 'per_page=1'], false],
    [['api', 'repos/o/r/labels', '-fname=x'], true], [['api', 'repos/o/r/labels', '--field=name=x'], true], [['api', 'repos/o/r', '--raw-field=a=b'], true],
    [['-R', 'o/r', 'pr', 'view', '1'], false], [['pr', 'view', 'comment'], false],
    // a flag value that looks like a flag stays a value; clustered short flags still count
    [['api', 'repos/o/r', '-H', '-XPOST'], false], [['api', 'repos/o/r', '-X', 'GET', '-q', '-XPOST'], false], [['api', 'repos/o/r', '--jq', '-XPOST'], false],
    [['api', '-iXDELETE', 'repos/o/r/git/refs/heads/x'], true], [['api', '-iX', 'POST', 'repos/o/r'], true], [['api', '-if', 'title=x', 'repos/o/r/issues'], true],
    // the graphql read exemption: endpoint by parse, every --input spelling, every query spelling (gh sends the last)
    [['--hostname', 'graphql', 'api', 'repos/o/r/issues', '-f', 'query={x}'], true], [['api', 'graphql', '--input=q.json', '-f', 'query={viewer{login}}'], true],
    [['-R', 'graphql', 'api', 'repos/o/r/issues', '-f', 'query={viewer{login}}'], true],
    [['--repo', 'graphql', 'api', 'repos/o/r/issues', '-f', 'query={viewer{login}}'], true],
    [['-R', 'o/r', 'api', 'graphql', '-f', 'query={viewer{login}}'], false],
    [['-X', 'POST', 'api', 'graphql', '-f', 'query={viewer{login}}'], true],
    [['--input', 'q.json', 'api', 'graphql', '-f', 'query={viewer{login}}'], true],
    [['api', 'graphql', '-f', 'query={viewer{login}}', '-F', 'query=mutation{x}'], true], [['api', 'graphql', '-f', 'query={viewer{login}}', '-f', 'query=mutation{x}'], true],
    [['api', 'graphql', '-fquery={viewer{login}}'], false], [['api', 'graphql', '--raw-field=query={viewer{login}}'], false], [['api', 'graphql', '--jq', '.x', '-f', 'query={viewer{login}}'], false],
    [['api', 'graphql', '-F', 'query=@q.graphql'], true], [['api', 'graphql', '-f', 'owner=o'], true],
    // non-strings are compared as spawn stringifies them, so gh's real command decides
    [[5, 'pr', 'merge'], false],
  ])('classifies a write from gh command positions and every method spelling: %j', (args, write) => {
    expect(classifyGhWrite(args)).toBe(write);
  });
  it('resolves land priority and the rate-limit bucket past leading global flags', () => {
    expect(ghCallerPriority('pr-land', ['-R', 'o/r', 'pr', 'merge', '1'])).toBe('critical');
    expect(ghCallerPriority('pr-land', ['-R', 'o/r', 'pr', 'view', '1'])).toBe('normal');
    expect(classifyGhResource(['-R', 'o/r', 'pr', 'list'])).toBe('graphql');
    expect(classifyGhResource(['--repo', 'o/r', 'run', 'list'])).toBe('core');
    expect(classifyGhResource(['api', '-iq', '.data', 'graphql', '-f', 'query={x}'])).toBe('graphql');
    expect(classifyGhResource(['api', '-iH', 'graphql', 'repos/o/r'])).toBe('core');
    expect(ghCallerPriority('pr-land', [5, 'pr', 'merge'])).toBe('normal');
    expect(isGhWatch([null, 'run', 'watch'])).toBe(false);
    expect(classifyGhResource(['--hostname', 'h', 'api', 'graphql', '-f', 'query=x'])).toBe('graphql');
    expect(classifyGhResource(['--hostname', 'h', 'api', '-X', 'POST', 'graphql'])).toBe('graphql');
    expect(classifyGhResource(['-R', 'o/r', 'api', 'repos/o/r'])).toBe('core');
  });
  it.each([90, 0])('applies the timeout to both real execution paths (%s)', (maxHoldSeconds) => {
    const env = { WE_GH_THROTTLE_MAX_HOLD_SECONDS: String(maxHoldSeconds), WE_GH_THROTTLE_COST_HEADERS: '1' };
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) }));
    const throttle = { lockRoot: root, logPath, env, spawn, budgetPerMin: 100, caller: 'test' };
    runGhSync(['api', 'user'], { throttle });
    runGhCliPassthrough(['api', 'user'], { throttle, spawn });
    for (const [, , opts] of spawn.mock.calls) expect(opts.timeout).toBe(maxHoldSeconds ? 90000 : undefined);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it('watch takes no slot, has no timeout, and logs its exemption', () => {
    const spawn = vi.fn(() => {
      expect(readGhSlotHolders({ lockRoot: root, cap: 6 })).toEqual([]);
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    const throttle = { lockRoot: root, logPath, env: {}, spawn, budgetPerMin: 100 };
    runGhSync(['run', 'watch'], { timeout: 1, throttle });
    runGhCliPassthrough(['pr', 'checks', '--watch'], { throttle, spawn });
    runGhSync(['--repo', 'o/r', 'run', 'watch', '123'], { throttle });
    runGhCliPassthrough(['pr', 'checks', '123', '--watch=true'], { throttle, spawn });
    expect(spawn.mock.calls.every((c) => c[2].timeout === undefined)).toBe(true);
    expect(rows().filter((r) => r.outcome === 'call')).toHaveLength(4);
    expect(rows().filter((r) => r.outcome === 'call').every((r) => r.unslotted === 'watch')).toBe(true);
  });
  it('a literal --watch argument value still takes a slot and keeps its timeout in both paths', () => {
    const spawn = vi.fn(() => {
      expect(readGhSlotHolders({ lockRoot: root, cap: 6 })).toHaveLength(1);
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    const throttle = { lockRoot: root, logPath, env: {}, spawn, budgetPerMin: 100 };
    runGhSync(['pr', 'comment', '123', '--body', '--watch'], { timeout: 7, throttle });
    runGhCliPassthrough(['pr', 'comment', '123', '--body', '--watch'], { throttle, spawn });
    expect(spawn.mock.calls.map((c) => c[2].timeout)).toEqual([7, 90000]);
    expect(rows().filter((r) => r.outcome === 'call').some((r) => r.unslotted)).toBe(false);
  });
  it('preserves native subprocess timeout fields and logs both execution paths', () => {
    const args = ['-e', keepAliveScript()];
    const nativeOpts = { timeout: 20, killSignal: 'SIGTERM', stdio: 'pipe' };
    let native;
    try { execFileSync(process.execPath, args, nativeOpts); } catch (e) { native = e; }
    const throttle = { lockRoot: root, logPath, bin: process.execPath, env: { WE_GH_THROTTLE_COST_HEADERS: '0', WE_GH_THROTTLE_MAX_HOLD_SECONDS: '1' }, budgetPerMin: 100 };
    let syncError, cliError;
    try { runGhSync(args, { ...nativeOpts, throttle }); } catch (e) { syncError = e; }
    try { runGhCliPassthrough(args, { bin: process.execPath, throttle }); } catch (e) { cliError = e; }
    expect(native.code).toBe('ETIMEDOUT');
    expect(syncError).toMatchObject({ code: native.code, signal: native.signal, status: native.status, stdout: native.stdout, stderr: native.stderr });
    expect(cliError.code).toBe(native.code);
    expect(rows().filter((r) => r.outcome === 'call')).toMatchObject([{ timedOut: true }, { timedOut: true }]);
    // A timed-out child frees its slot at once rather than holding the pool until the reaper.
    expect(readGhSlotHolders({ lockRoot: root, cap: 6 })).toEqual([]);
  });
  it('logs timeout and throws the identical native error in both paths', () => {
    const error = Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
    const spawn = () => ({ error, status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    const throttle = { lockRoot: root, logPath, env: {}, spawn, budgetPerMin: 100 };
    expect(() => runGhSync(['api', 'user'], { throttle })).toThrow(error);
    expect(() => runGhCliPassthrough(['api', 'user'], { throttle, spawn })).toThrow(error);
    expect(rows().filter((r) => r.outcome === 'call')).toMatchObject([{ timedOut: true }, { timedOut: true }]);
  });
});

describe('legacy holders without meta', () => {
  it.each(['node -e 0 --token hidden-value.mjs', 'bash -c true --password hidden-value.js'])('does not infer parent scripts from arbitrary arguments: %s', (parent) => {
    const out = describeLegacyHolders([{ pid: 10, alive: true, caller: 'unknown', op: '' }], pid => pid === 10 ? '20 gh pr list' : `1 ${parent}`);
    expect(JSON.stringify(out)).not.toContain('hidden-value');
  });
  it.each(["-H 'Authorization: token ghp_hidden'", "--token hidden-value", "-H 'Cookie: hidden-value'", '-f private_key=hidden-value', '--field=body=hidden-value', '--header="X-App-Key: hidden-value"'])('drops legacy command payloads: %s', (payload) => {
    const ps = pid => pid === 10 ? `20 gh api user ${payload}` : `1 node drain-daemon.mjs ${payload}`;
    const out = describeLegacyHolders([{ slot: 0, pid: 10, alive: true, caller: 'unknown', op: '', parent: '', heldMs: 5 }], ps);
    expect(JSON.stringify(out) + ghHoldersSummary(out)).not.toMatch(/ghp_hidden|hidden-value/);
    expect(out[0].parent).toContain('drain-daemon.mjs');
  });
  it('are named from the process table on timeout only', async () => {
    const { describeLegacyHolders } = await import('../gh-throttle-holders.mjs');
    const ps = (pid) => (pid === 10 ? ' 20 node gh-throttle.mjs api x' : ' 1 node drain-daemon.mjs');
    const out = describeLegacyHolders([{ slot: 0, pid: 10, alive: true, caller: 'unknown', op: '', parent: '', ppid: null, heldMs: 5 }, { slot: 1, pid: 11, alive: true, caller: 'w', op: 'pr list', parent: 'p', ppid: 2, heldMs: 1 }], ps);
    expect(out[0]).toMatchObject({ ppid: 20, op: 'api', parent: 'drain-daemon.mjs' });
    expect(out[1]).toMatchObject({ caller: 'w', op: 'pr list' });
  });
});
