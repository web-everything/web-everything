import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFixDispatchClaimStatus, runReconcileFixDispatch } from '../reconcile-fix-dispatch.mjs';
import { createFixWaitingObserver } from '../fix-waiting.mjs';
import { isSendBackFix, readSendBackFixPriority, resolveFixWaitingPrioritySettings, yieldToWaitingSendBack } from '../fix-waiting-priority.mjs';
import { gateLaunch } from '../../lib/resource-gate.mjs';
import { decideAdmission } from '../../lib/resource-policy.mjs';
import { gateHost } from '../../lib/dispatch-throttle.mjs';
import { cliHostLoadGate } from '../../../skills-src/conveyor/build-dispatch-daemon.mjs';

const NOW = 1000000;
const REPO = 'web-everything/web-everything';
const dirs = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'send-back-priority-')); dirs.push(dir);
  const path = join(dir, 'fix-waiting-we.json');
  const env = { WE_PR_LIMIT_STATE_FILE: join(dir, 'pr-limit.json'), WE_PLATFORM_PREFERENCES_FILE: join(dir, 'absent.json') };
  const provider = { ensureLabel: vi.fn(), setLabels: vi.fn() };
  const notify = vi.fn(() => ({ ok: true }));
  const observer = now => createFixWaitingObserver({ repo: REPO, path, now, provider, notify, log() {}, setting: { value: 30, source: 'default' } });
  const readWaiting = opts => readSendBackFixPriority({ ...opts, env, paths: [path],
    setting: resolveFixWaitingPrioritySettings({ env, file: {}, platform: {} }) });
  const launch = (kind, nowMs = NOW, verdict = 'admit') => gateLaunch({ kind, env, nowMs, readWaiting,
    legacyGate: () => ({ admit: true }), settings: { cutover: 'enforce' }, log() {},
    shadow: () => ({ verdict, reason: 'resource guard', snapshotAge: 0, kind }) });
  return { path, env, observer, readWaiting, launch, provider, notify };
}

describe('send-back fix priority from the existing waiting episode', () => {
  it.each([{ labels: ['review:changes'] }, { labels: [{ name: 'red-team:blocked' }] },
    { operatorSendBack: { body: 'fix it' } }])('recognizes send-backs: %j', fields => {
    expect(isSendBackFix(fields)).toBe(true);
    const f = fixture(); f.observer(NOW).deferred({ pr: 5806, ...fields });
    expect(f.launch('build')).toMatchObject({ admit: false, kind: 'send-back-priority', why: expect.stringContaining('yielding to waiting send-back fix #5806') });
    expect(f.launch('graduation').admit).toBe(false);
  });
  it.each([{ labels: ['review:changes'], sendBack: true }, { labels: ['red-team:blocked'], sendBack: false },
    { labels: [], operatorSendBack: { body: 'fix it', login: 'operator' }, sendBack: false }])('keeps reserved-cap eligibility separate from waiting priority in live and preview paths: %j', ({ sendBack, ...fields }) => {
    const f = fixture(); const tryAdmit = vi.fn(() => ({ admit: false, kind: 'host-load', why: 'busy' }));
    const dispatch = vi.fn();
    const options = { checkStaleness: () => ({ fresh: true, behind: 0 }), priorityShadow: null,
      reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 5806, headRefName: 'lane/123-fix', ...fields }], refusals: [] }),
      findItemFn: () => ({ num: '123', scope: ['we:scripts/a.mjs'] }), loadItems: () => [],
      // Match the reconcile-fix-dispatch fixtures: every external reader stays local.
      fetchItemlessDiffPaths: () => [], resolveFallbackScope: () => [], resolveCardScopeAtRef: () => [],
      readPrComments: () => [], readMainRedPriorityRecord: () => null,
      tryResume: () => ({ resumed: false, resumeAttempt: null }), tryResumeRound: null,
      pickFreeLanes: () => [10], listBuildClaims: () => [], listFixClaims: () => [],
      dispatchThrottle: { tryAdmit }, waiting: f.observer(NOW), dispatch };
    runReconcileFixDispatch(options);
    expect(tryAdmit).toHaveBeenCalledWith('fix', { sendBack });
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.launch('build').admit).toBe(false);
    tryAdmit.mockClear();
    const deferred = vi.fn();
    planFixDispatchClaimStatus({ ...options, readClaim: () => null, waiting: { deferred } });
    expect(tryAdmit).toHaveBeenCalledWith('fix', { sendBack });
    expect(deferred).toHaveBeenCalledWith(expect.objectContaining(fields));
  });
  it('refreshes on each host refusal, expires after three passes, and ignores absent/corrupt/future records', () => {
    const f = fixture();
    expect(f.launch('build').admit).toBe(true);
    f.observer(NOW).deferred({ pr: 5806, labels: ['review:changes'] });
    expect(f.launch('build', NOW + 360001).admit).toBe(true);
    expect(f.launch('build', NOW - 1).admit).toBe(true);
    f.observer(NOW + 300000).deferred({ pr: 5806 });
    expect(f.launch('build', NOW + 360001).admit).toBe(false);
    writeFileSync(f.path, '{');
    expect(f.launch('build').admit).toBe(true);
  });
  it('ordinary fixes do not block builds; dispatch clears the blocker but preserves bounded heavy identity', () => {
    const f = fixture();
    f.observer(NOW).deferred({ pr: 5807, labels: [] });
    expect(f.launch('build').admit).toBe(true);
    f.observer(NOW).deferred({ pr: 5806, labels: ['red-team:blocked'] });
    f.observer(NOW + 1).dispatched({ pr: 5806, labels: ['red-team:blocked'] });
    expect(f.launch('build', NOW + 2).admit).toBe(true);
    expect(f.readWaiting({ nowMs: NOW + 2, waitingOnly: false })[0]).toMatchObject({ session: 'fix-5806' });
    expect(f.readWaiting({ nowMs: NOW + 86400002, waitingOnly: false })).toEqual([]);
  });
  it('fix and ci-heal admission is unchanged, and a host-load refusal stays a refusal', () => {
    const f = fixture(); f.observer(NOW).deferred({ pr: 5806, labels: ['review:changes'] });
    for (const kind of ['fix', 'ci-heal']) expect(f.launch(kind).admit).toBe(true);
    for (const kind of ['fix', 'ci-heal', 'build']) expect(f.launch(kind, NOW, 'wait'))
      .toMatchObject({ admit: false, kind: 'host-load', why: expect.stringContaining('resource guard') });
  });
  it('the actual build launcher yields through gateHost without changing the CPU floors', () => {
    const f = fixture();
    const now = Date.now(); f.observer(now).deferred({ pr: 5806, labels: ['review:changes'] });
    const sample = idlePct => () => ({ ok: true, idlePct, memFreePct: 90 });
    expect(cliHostLoadGate('build', { env: f.env, sample: sample(90) }))
      .toMatchObject({ admit: false, why: expect.stringContaining('yielding to waiting send-back fix #5806') });
    for (const [kind, floor] of [['fix', 8], ['ci-heal', 8], ['build', 15]]) {
      const refused = gateHost({ kind, env: f.env, sample: sample(floor - 0.1) });
      expect(refused).toMatchObject({ admit: false, kind: 'host-load' });
      expect(refused.why).not.toContain('yielding');
      if (kind !== 'build') expect(gateHost({ kind, env: f.env, sample: sample(floor) }).admit).toBe(true);
    }
  });
  it('retains shared resource-policy floors even with a fresh priority record', () => {
    const f = fixture(); f.observer(NOW).deferred({ pr: 5806, labels: ['review:changes'] });
    for (const [kind, floor] of [['fix', 8], ['ci-heal', 8], ['build', 15]]) {
      const snapshot = idlePct => ({ sampledAt: new Date(NOW - 1).toISOString(), freshUntil: new Date(NOW + 1000).toISOString(),
        cpu: { idlePct }, memory: { pressureLevel: 1 } });
      expect(decideAdmission({ kind, snapshot: snapshot(floor - 0.1), nowMs: NOW }).verdict).not.toBe('admit');
      expect(decideAdmission({ kind, snapshot: snapshot(floor), nowMs: NOW }).verdict).toBe('admit');
    }
  });
  it('resolves freshness through the cascade with provenance and bounded invalid overrides', () => {
    const r = resolveFixWaitingPrioritySettings({ file: { fixWaiting: { waitingFreshMs: 240000 } },
      platform: { waitingFreshMs: 120000, dispatchedFreshMs: 600000 }, env: { WE_FIX_WAITING_FRESH_MS: '300000' } });
    expect(r.value).toMatchObject({ waitingFreshMs: 300000, dispatchedFreshMs: 600000 });
    expect(r.sources).toMatchObject({ waitingFreshMs: 'env', dispatchedFreshMs: 'platform' });
    expect(resolveFixWaitingPrioritySettings({ file: {}, platform: {}, env: { WE_FIX_WAITING_FRESH_MS: 'Infinity' } }).value.waitingFreshMs).toBe(360000);
  });
});

describe('absolute send-back yield bound', () => {
  it.each(['build', 'graduation', 'graduate'])('stops yielding %s at the bound despite continued refreshes', kind => {
    const f = fixture();
    f.observer(NOW).deferred({ pr: 5806, labels: ['review:changes'] });
    for (const minutes of [5, 15, 29]) {
      const nowMs = NOW + minutes * 60000;
      f.observer(nowMs).deferred({ pr: 5806 });
      expect(f.launch(kind, nowMs)).toMatchObject({ admit: false,
        why: expect.stringContaining('fixWaiting.yieldMaxMinutes=30 (source: standard)') });
    }
    for (const minutes of [30, 31, 60]) {
      const nowMs = NOW + minutes * 60000;
      f.observer(nowMs).deferred({ pr: 5806 });
      expect(f.launch(kind, nowMs).admit).toBe(true);
      expect(f.launch(kind, nowMs, 'wait').admit).toBe(false);
      expect(f.readWaiting({ nowMs })[0].firstDeferredAt).toBe(NOW);
    }
    expect(Object.values(JSON.parse(readFileSync(f.path, 'utf8')))[0])
      .toMatchObject({ waiting: true, labelled: true, firstDeferredAt: NOW, alertedAt: NOW + 31 * 60000 });
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.provider.setLabels).not.toHaveBeenCalledWith(REPO, 5806, { remove: ['fix-waiting:host-busy'] });
  });
  it('honors the cascaded bound and includes its source in the reason', () => {
    const f = fixture(); f.observer(NOW).deferred({ pr: 5806, labels: ['review:changes'] });
    const env = { ...f.env, WE_FIX_WAITING_YIELD_MAX_MINUTES: '1' };
    const result = { admit: true, kind: 'host-load', why: 'resources available' };
    const check = nowMs => yieldToWaitingSendBack(result, { kind: 'build', env, nowMs, readWaiting: f.readWaiting });
    expect(check(NOW + 59999)).toMatchObject({ admit: false,
      why: expect.stringContaining('fixWaiting.yieldMaxMinutes=1 (source: env)') });
    expect(check(NOW + 60000)).toBe(result);
  });
  it('uses a legacy waitingSince origin and never substitutes a refreshed timestamp for a missing origin', () => {
    const f = fixture(); const key = `${REPO}#5806`;
    const nowMs = NOW + 31 * 60000;
    const row = { waiting: true, sendBack: true, updatedAt: nowMs };
    for (const origin of [{ waitingSince: new Date(NOW).toISOString() }, {}, { firstDeferredAt: 'invalid' }, { firstDeferredAt: nowMs + 1 }]) {
      writeFileSync(f.path, JSON.stringify({ [key]: { ...row, ...origin } }));
      expect(f.launch('build', nowMs).admit).toBe(true);
    }
    writeFileSync(f.path, JSON.stringify({ [key]: { ...row, waitingSince: new Date(nowMs - 60000).toISOString() } }));
    expect(f.launch('build', nowMs).admit).toBe(false);
  });
  it('checks remaining eligible episodes after an older one has exhausted its bound', () => {
    const f = fixture();
    f.observer(NOW).deferred({ pr: 5806, labels: ['review:changes'] });
    const nowMs = NOW + 31 * 60000;
    f.observer(nowMs - 1).deferred({ pr: 5806 });
    f.observer(nowMs).deferred({ pr: 5807, labels: ['review:changes'] });
    expect(f.launch('build', nowMs).why).toContain('yielding to waiting send-back fix #5807');
  });
  it('resolves the bound through every settings layer and rejects values outside 1..240', () => {
    const resolve = (file = {}, platform = {}, env = {}) => resolveFixWaitingPrioritySettings({ file, platform, env });
    expect(resolve().value.yieldMaxMinutes).toBe(30);
    expect(resolve({}, { yieldMaxMinutes: 20 }).sources.yieldMaxMinutes).toBe('platform');
    expect(resolve({ fixWaiting: { yieldMaxMinutes: 10 } }, { yieldMaxMinutes: 20 }).sources.yieldMaxMinutes).toBe('tool');
    for (const value of ['1', '240']) {
      const r = resolve({ fixWaiting: { yieldMaxMinutes: 10 } }, {}, { WE_FIX_WAITING_YIELD_MAX_MINUTES: value });
      expect(r.value.yieldMaxMinutes).toBe(Number(value));
      expect(r.sources.yieldMaxMinutes).toBe('env');
    }
    for (const value of ['0', '241', 'Infinity', 'NaN', '']) {
      expect(resolve({ fixWaiting: { yieldMaxMinutes: 10 } }, {}, { WE_FIX_WAITING_YIELD_MAX_MINUTES: value })
        .value.yieldMaxMinutes).toBe(10);
    }
    expect(resolve({ fixWaiting: { yieldMaxMinutes: 241 } }, { yieldMaxMinutes: 0 }).value.yieldMaxMinutes).toBe(30);
  });
});
