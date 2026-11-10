// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { localPhaseReason, phaseAdmissionPlan, localPhaseAdmissionRecord } from '../lib/verify-remote-routing.mjs';
import { acquireSlotBlocking, releaseOwnedSlot, recordRemoteFallback, ADMISSION_DEFERRED_EXIT,
  ADMISSION_POLICY_STANDARD, resolveAdmissionPolicy } from '../readiness/heavy-admission.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const source = readFileSync(new URL('../verify-lane.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function acquireAdmission(');
const end = source.indexOf('const admission = await acquireAdmission(', start);
const command = 'npx vitest run scripts/one.test.mjs';
function fixture({ decision = { remote: false, reason: 'remote-disabled' }, kind = 'files', env = {}, real = false, fullLocalFallback, justification } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verify-admission-'));
  roots.push(root);
  const acquire = vi.fn(real ? options => acquireSlotBlocking({ ...options, env: {},
    hostAdmission: () => ({ admitted: true }), log() {},
    policy: { settings: { ...ADMISSION_POLICY_STANDARD, fastSlots: 0 }, sources: {}, invalid: [], ignored: [] },
  }) : async () => ({ ok: true, slot: 0, waitedMs: 0 }));
  const emit = vi.fn((result, code) => { throw Object.assign(new Error(result.reason), { code }); });
  const record = vi.fn(recordRemoteFallback);
  // Inject the policy loader's result while the parallel R834 PR owns the setting's schema.
  const policy = resolveAdmissionPolicy({ env: {} });
  if (fullLocalFallback !== undefined) {
    policy.settings.fullLocalFallback = fullLocalFallback;
    policy.sources.fullLocalFallback = 'platform';
  }
  const loadAdmissionPolicy = vi.fn(() => policy);
  const context = { flags: { 'local-justification': justification }, loadAdmissionPolicy, localPhaseReason, phaseAdmissionPlan, localPhaseAdmissionRecord, recordRemoteFallback: record,
    decidePhaseRemote: vi.fn(async () => decision), acquireSlotBlocking: acquire, ADMISSION_DEFERRED_EXIT, emit,
    phaseAdmission: true, phaseAdmissionKind: () => ({ kind }), classifyCommandKind: () => kind,
    resolvedGate: { decision: {} }, admissionPhases: {}, laneMatch: null, GATE: command,
    ADMISSION_LOCK_ROOT: root, ADMISSION_CAP: 1, ADMISSION_TIMEOUT_MS: 1000, REPO: root,
    headSha: 'abc', process: { env, stderr: { write: vi.fn() } } };
  return { root, acquire, record, context, run: runInNewContext(source.slice(start, end) + '; acquireAdmission', context),
    rows: () => readFileSync(join(root, 'remote-fallbacks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
}
describe('verify-lane admission routing evidence', () => {
  it('remote phase takes no outer slot and writes no local fallback', async () => {
    const f = fixture({ decision: { remote: true, reason: 'remote-enabled' } });
    expect(await f.run('vitest', command)).toMatchObject({ remote: true, takeLocalSlot: false, setHeld: false });
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
  it('local phase records its reason and releases command + route + routeReason into durations', async () => {
    const f = fixture({ real: true });
    expect(await f.run('vitest', command)).toMatchObject({ ok: true });
    expect(f.rows()).toMatchObject([{ reason: 'remote-disabled' }]);
    releaseOwnedSlot({ lockRoot: f.root, cap: 1, owner: f.root });
    expect(JSON.parse(readFileSync(join(f.root, 'durations.jsonl'), 'utf8'))).toMatchObject({
      command, route: 'local', routeReason: 'remote-disabled',
    });
  });
  it.each(['npx vitest related scripts/one.mjs --run', 'echo ok'])('records local-only phase: %s', async localCommand => {
    const f = fixture();
    await f.run('vitest', localCommand);
    expect(f.rows()).toMatchObject([{ reason: localPhaseReason(localCommand) }]);
  });
  it('records remote-red-confirm on a forced local rerun', async () => {
    const f = fixture();
    await f.run('vitest', command, { forceLocal: true });
    expect(f.rows()).toMatchObject([{ reason: 'remote-red-confirm' }]);
    expect(f.acquire.mock.calls[0][0].routeReason).toBe('remote-red-confirm');
  });
  it('records unwrappable-command when a remote decision cannot wrap the chain', () => {
    expect(localPhaseAdmissionRecord({ command: 'npx vitest run scripts/one.test.mjs --config custom.mjs',
      decision: { remote: true }, kind: 'files', env: {} })).toMatchObject({ reason: 'unwrappable-command', refused: false });
  });
  it.each(['npx vitest run', 'npx vitest run --config vitest.soak.config.ts'])('refuses command-classified heavy work even with a narrower routing kind: %s', fullCommand => {
    expect(localPhaseAdmissionRecord({ command: fullCommand, decision: { remote: false }, kind: 'files', env: {} }))
      .toMatchObject({ refused: true, reason: 'full-local-refused' });
  });
  it.each(['FULL', 'soak'])('refuses %s by default even with a justification', async kind => {
    const f = fixture({ kind, justification: 'Forge maintenance' });
    await expect(f.run('vitest', command)).rejects.toMatchObject({ code: 75 });
    expect(f.rows()).toMatchObject([{ reason: 'full-local-refused', detail: expect.stringContaining('fullLocalFallback=refuse') }]);
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.context.loadAdmissionPolicy).toHaveBeenCalledWith({ env: {}, checkoutRoot: f.root });
  });
  it.each(['FULL', 'soak'])('justified policy refuses %s without a non-empty flag string', async kind => {
    for (const justification of [undefined, '', '  ', true, 42]) {
      const f = fixture({ kind, fullLocalFallback: 'justified', justification });
      await expect(f.run('vitest', command)).rejects.toMatchObject({ code: 75 });
      expect(f.rows()).toMatchObject([{ reason: 'full-local-refused' }]);
      expect(f.acquire).not.toHaveBeenCalled();
    }
  });
  it.each(['FULL', 'soak'])('allows justified %s local and logs flag and policy provenance', async kind => {
    const f = fixture({ kind, fullLocalFallback: 'justified', justification: 'Forge maintenance' });
    expect(await f.run('vitest', command)).toMatchObject({ ok: true });
    expect(f.rows()).toMatchObject([{ reason: 'remote-disabled', detail: expect.stringContaining('Forge maintenance') }]);
    expect(f.rows()[0].detail).toContain('fullLocalFallback=justified (source: platform)');
    expect(f.rows()[0].detail).toContain('--local-justification (source: flag)');
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.acquire.mock.calls[0][0].policy.settings.fullLocalFallback).toBe('justified');
  });
  it.each(['FULL', 'soak'])('allow policy permits %s local without justification', async kind => {
    const f = fixture({ kind, fullLocalFallback: 'allow' });
    expect(await f.run('vitest', command)).toMatchObject({ ok: true });
    expect(f.rows()).toMatchObject([{ reason: 'remote-disabled', detail: expect.stringContaining('fullLocalFallback=allow (source: platform)') }]);
    expect(f.acquire).toHaveBeenCalledOnce();
  });
  it.each([undefined, null, {}, { settings: { fullLocalFallback: 'unknown' } }])('unreadable or unknown policy fails closed: %j', policy => {
    expect(localPhaseAdmissionRecord({ command, kind: 'FULL', policy, justification: 'maintenance', env: {} }))
      .toMatchObject({ refused: true, reason: 'full-local-refused' });
  });
});
