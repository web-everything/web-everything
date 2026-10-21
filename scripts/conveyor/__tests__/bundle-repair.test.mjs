// Bundle repair (prototype, 2026-10-21): the supervised overlay-top repair for a daemon clone held on its last-good
// build by an overlay conflict. Pins the trigger thresholds, one repair per clone, the kill switch, the brief never
// carrying a forbidden command, and the escalation path.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUNDLE_REPAIR_BOT, BUNDLE_REPAIR_STANDARD, HOLD_RULES, assertBriefSafe, cloneName, heldRefs, holdIdFor,
  planBundleRepairs, planReconcile, validateOutcome,
} from '../bundle-repair-core.mjs';
import {
  defaultLock, fillRepairBrief, ledgerPath, outcomePath, readLedger, recordOutcome, repairSettingsEnv, resolveBundleRepairSettings,
  runBundleRepairs, workerSpawnEnv,
} from '../bundle-repair-dispatch.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-10-21T21:00:00Z');
const ROOT = '/ws/wev-review-daemon';
const KEY = '206df80ef82e6401';
const held = (minutesAgo, reason = 'established-overlay-conflict') => ({
  since: NOW - minutesAgo * MIN, reason, failed: 'lane/unfreeze-review-top-1021b, lane/ruling-identity: conflict with main', lastGood: 'a'.repeat(40),
});
const clone = (minutesAgo, o = {}) => ({ cloneKey: KEY, root: ROOT, held: held(minutesAgo), ...o });
const on = (o = {}) => ({ ...BUNDLE_REPAIR_STANDARD, enabled: true, mode: 'live', ...o });

describe('planBundleRepairs — trigger and budget', () => {
  it('does nothing while disabled (the default) or with the kill switch', () => {
    expect(planBundleRepairs({ clones: [clone(60)], settings: BUNDLE_REPAIR_STANDARD, now: NOW }).off).toBe('disabled');
    const k = planBundleRepairs({ clones: [clone(60)], settings: on(), killed: true, now: NOW });
    expect(k.off).toBe('kill-switch');
    expect(k.dispatch).toEqual([]);
  });

  it('waits for the trigger minutes, then dispatches once', () => {
    const under = planBundleRepairs({ clones: [clone(19)], settings: on({ triggerMinutes: 20 }), now: NOW });
    expect(under.dispatch).toEqual([]);
    expect(under.held[0].rule).toBe(HOLD_RULES.UNDER_TRIGGER);
    const over = planBundleRepairs({ clones: [clone(20)], settings: on({ triggerMinutes: 20 }), now: NOW });
    expect(over.dispatch).toHaveLength(1);
    expect(over.dispatch[0]).toMatchObject({ cloneKey: KEY, root: ROOT, name: 'review', refs: ['lane/unfreeze-review-top-1021b', 'lane/ruling-identity'] });
  });

  it('only repairs overlay-conflict holds on selected, known clones', () => {
    const smoke = planBundleRepairs({ clones: [{ cloneKey: KEY, root: ROOT, held: held(60, 'smoke-rejected') }], settings: on(), now: NOW });
    expect(smoke.dispatch).toEqual([]);
    expect(smoke.held[0].rule).toBe(HOLD_RULES.NOT_OVERLAY_HOLD);
    expect(planBundleRepairs({ clones: [{ cloneKey: KEY, root: ROOT, held: held(60, 'pinned-overlay-conflict') }], settings: on(), now: NOW }).dispatch).toHaveLength(1);
    expect(planBundleRepairs({ clones: [clone(60)], settings: on({ clones: ['fix'] }), now: NOW }).held[0].rule).toBe(HOLD_RULES.NOT_SELECTED);
    expect(planBundleRepairs({ clones: [clone(60)], settings: on({ clones: ['review'] }), now: NOW }).dispatch).toHaveLength(1);
    expect(planBundleRepairs({ clones: [clone(60, { root: null })], settings: on(), now: NOW }).held[0].rule).toBe(HOLD_RULES.UNKNOWN_ROOT);
  });

  it('one repair per clone, one attempt per hold, max concurrent', () => {
    const c = clone(60);
    const running = [{ cloneKey: KEY, holdId: 'older', status: 'running' }];
    expect(planBundleRepairs({ clones: [c], ledger: running, settings: on(), now: NOW }).held[0].rule).toBe(HOLD_RULES.ONE_PER_CLONE);
    const done = [{ cloneKey: KEY, holdId: holdIdFor(c, c.held), status: 'escalated' }];
    expect(planBundleRepairs({ clones: [c], ledger: done, settings: on(), now: NOW }).held[0].rule).toBe(HOLD_RULES.ONE_PER_HOLD);
    const other = { cloneKey: 'fde6cfdae10394e1', root: '/ws/wev-fix-daemon', held: held(60) };
    const two = planBundleRepairs({ clones: [c, other], settings: on({ maxConcurrent: 1 }), now: NOW });
    expect(two.dispatch).toHaveLength(1);
    expect(two.held[0].rule).toBe(HOLD_RULES.MAX_CONCURRENT);
  });

  it('names clones the way the operator does', () => {
    expect(cloneName('/ws/wev-review-daemon')).toBe('review');
    expect(cloneName('/ws/wev-health-watch')).toBe('health-watch');
    expect(cloneName('/ws/.lanes/we-drain-daemon/code')).toBe('we-drain-code');
    expect(heldRefs({ failed: 'lane/a (PR #12), lane/b: conflict with main' })).toEqual(['lane/a', 'lane/b']);
  });
});

describe('the brief never carries a forbidden command', () => {
  const target = { root: ROOT, name: 'review', holdId: 'review-206df80e-x', refs: ['lane/a', 'lane/b'] };

  it('the real template fills cleanly with no conflict override, no force push, no hook bypass', async () => {
    const { prompt, session } = await fillRepairBrief(target);
    expect(prompt).not.toMatch(/--allow-conflict/);
    expect(prompt).not.toMatch(/push[^\n]*(--force|\s-f\b)/);
    expect(prompt).not.toMatch(/--no-verify/);
    expect(prompt).not.toMatch(/\{\{/);
    expect(prompt).toContain(`--clone=${ROOT}`);
    expect(prompt).toContain(`--allow-no-pr --by=${BUNDLE_REPAIR_BOT}`);
    expect(prompt).toContain('weakened-twice');
    expect(session).toBe('bundle-repair-review-206df80e-x');
  });

  it('removes the original overlays only AFTER the new top is adopted (the rollback baseline survives a failed load)', async () => {
    const { prompt } = await fillRepairBrief(target);
    const add = prompt.indexOf('daemon-overlay.mjs add');
    const load = prompt.indexOf('daemon-load-overlay.mjs --clone=');
    const removeOriginal = prompt.indexOf('--ref=<ref> --by=');
    expect(add).toBeGreaterThan(0);
    expect(load).toBeGreaterThan(add);
    expect(removeOriginal).toBeGreaterThan(load);
    expect(prompt).toMatch(/remove nothing/);
  });

  it('refuses a brief that carries one', async () => {
    expect(() => assertBriefSafe('node daemon-overlay.mjs add --ref=x --allow-conflict --reason=y')).toThrow(/conflict override/);
    expect(() => assertBriefSafe('LANE_SESSION=s git push --force origin HEAD')).toThrow(/force push/);
    expect(() => assertBriefSafe('git push origin +HEAD:refs/heads/x')).toThrow(/force push/);
    expect(() => assertBriefSafe('git commit --no-verify')).toThrow(/hook bypass/);
    const bad = (r) => `${readFileSync(join(r, 'skills-src/conveyor/bundle-repair-brief.md'), 'utf8')}\nthen add --allow-conflict\n`;
    await expect(fillRepairBrief(target, { readBrief: bad })).rejects.toThrow(/forbidden/);
  });
});

describe('validateOutcome', () => {
  it('two WEAKENED audits can only be recorded as an escalation', () => {
    const audits = [{ verdict: 'WEAKENED' }, { verdict: 'WEAKENED' }, { verdict: 'NOT WEAKENED' }];
    expect(() => validateOutcome({ outcome: 'repaired', top: 'lane/unfreeze-review-top-1021d', audits, detail: 'x' })).toThrow(/weakened-twice/);
    expect(validateOutcome({ outcome: 'escalate', reason: 'weakened-twice', audits, detail: 'x' }).reason).toBe('weakened-twice');
    expect(() => validateOutcome({ outcome: 'repaired', top: 'lane/t', audits: [{ verdict: 'WEAKENED' }], detail: 'x' })).toThrow(/final NOT WEAKENED/);
    expect(() => validateOutcome({ outcome: 'escalate', reason: 'wall-time', audits: [], detail: 'x' })).toThrow(/reason/);
  });
});

describe('planReconcile — the escalation path', () => {
  const c = clone(60);
  const id = holdIdFor(c, c.held);
  const entry = (o = {}) => ({ holdId: id, cloneKey: KEY, root: ROOT, status: 'running', startedAt: NOW - 30 * MIN, deadlineAt: NOW + 90 * MIN, ...o });

  it('hold cleared → cleared, no escalation', () => {
    expect(planReconcile([entry()], { clones: [{ ...c, held: null }], now: NOW })).toEqual([expect.objectContaining({ status: 'cleared', escalate: null, stop: true })]);
  });
  it('session escalated → stop + escalate with its reason', () => {
    const a = planReconcile([entry()], { clones: [c], now: NOW, outcomeFor: () => ({ outcome: 'escalate', reason: 'unresolvable-conflict', detail: 'd' }) });
    expect(a[0]).toMatchObject({ stop: true, status: 'escalated', escalate: 'unresolvable-conflict' });
  });
  it('a conflict override by the bot → escalate, even when the session said repaired', () => {
    const a = planReconcile([entry()], { clones: [c], now: NOW, overrideFor: () => ({ ref: 'lane/x' }), outcomeFor: () => ({ outcome: 'repaired', top: 'lane/x' }) });
    expect(a[0].escalate).toBe('conflict-override-used');
  });
  it('a mandatory alert outranks a cleared hold; a clone missing from the probe is not "cleared"', () => {
    const gone = [{ ...c, held: null }];
    expect(planReconcile([entry()], { clones: gone, now: NOW, overrideFor: () => ({ ref: 'lane/x' }) })[0].escalate).toBe('conflict-override-used');
    expect(planReconcile([entry()], { clones: gone, now: NOW, outcomeFor: () => ({ outcome: 'escalate', reason: 'weakened-twice', detail: 'd' }) })[0].escalate).toBe('weakened-twice');
    expect(planReconcile([entry()], { clones: [], now: NOW })).toEqual([]);
    expect(planReconcile([entry({ deadlineAt: NOW })], { clones: [], now: NOW })[0].escalate).toBe('wall-time');
  });
  it('the wall time is never suppressed by a cleared hold or a repaired outcome', () => {
    const late = entry({ deadlineAt: NOW });
    expect(planReconcile([late], { clones: [{ ...c, held: null }], now: NOW })[0]).toMatchObject({ status: 'cleared', escalate: 'wall-time' });
    expect(planReconcile([late], { clones: [c], now: NOW, outcomeFor: () => ({ outcome: 'repaired', top: 'lane/x' }) })[0]).toMatchObject({ escalate: 'hold-not-cleared', stop: true });
    // cleared before the deadline is a clean success
    expect(planReconcile([entry()], { clones: [{ ...c, held: null }], now: NOW })[0].escalate).toBeNull();
  });
  it('round 3: a late repaired outcome is still a wall-time overrun; another hold is not "cleared"; the stop-settled tick is watched', () => {
    const late = entry({ deadlineAt: NOW - MIN });
    const lateRepaired = { outcome: 'repaired', top: 'lane/x', recordedAt: new Date(NOW).toISOString() };
    expect(planReconcile([late], { clones: [{ ...c, held: null }], now: NOW, outcomeFor: () => lateRepaired })[0].escalate).toBe('wall-time');
    const timely = { ...lateRepaired, recordedAt: new Date(NOW - 2 * MIN).toISOString() };
    expect(planReconcile([late], { clones: [{ ...c, held: null }], now: NOW, outcomeFor: () => timely })[0].escalate).toBeNull();
    const smokeHeld = [{ ...c, held: { ...c.held, reason: 'smoke-rejected' } }];
    expect(planReconcile([entry({ status: 'repaired', deadlineAt: NOW })], { clones: smokeHeld, now: NOW })[0]).toMatchObject({ escalate: 'hold-not-cleared' });
    expect(planReconcile([entry({ status: 'repaired' })], { clones: smokeHeld, now: NOW })).toEqual([]);
    const settledNow = entry({ status: 'cleared', stopSettledAt: NOW });
    expect(planReconcile([settledNow], { clones: [], now: NOW, overrideFor: () => ({ ref: 'lane/x' }) })[0].escalate).toBe('conflict-override-used');
  });
  it('round 4: a session that cannot be stopped escalates wall-time once, cleared or repaired', () => {
    const stuck = entry({ status: 'cleared', stopPending: true, deadlineAt: NOW });
    expect(planReconcile([stuck], { clones: [{ ...c, held: null }], now: NOW })[0]).toMatchObject({ escalate: 'wall-time', stop: true, status: 'cleared' });
    expect(planReconcile([{ ...stuck, escalations: ['wall-time'] }], { clones: [{ ...c, held: null }], now: NOW })).toEqual([]);
    const repairedStuck = entry({ status: 'repaired', stopPending: true, deadlineAt: NOW });
    expect(planReconcile([repairedStuck], { clones: [{ ...c, held: null }], now: NOW })[0].escalate).toBe('wall-time');
    expect(planReconcile([entry()], { clones: [{ ...c, held: undefined }], now: NOW })).toEqual([]);
  });
  it('a settled entry whose stop is still pending is still watched for a conflict override (once)', () => {
    const settled = entry({ status: 'cleared', stopPending: true });
    const a = planReconcile([settled], { clones: [{ ...c, held: null }], now: NOW, overrideFor: () => ({ ref: 'lane/x' }) });
    expect(a[0]).toMatchObject({ escalate: 'conflict-override-used', stop: true });
    expect(planReconcile([{ ...settled, escalations: ['conflict-override-used'] }], { clones: [], now: NOW, overrideFor: () => ({ ref: 'lane/x' }) })).toEqual([]);
    expect(planReconcile([{ ...settled, stopPending: false }], { clones: [], now: NOW, overrideFor: () => ({ ref: 'lane/x' }) })).toEqual([]);
  });
  it('wall time → escalate; repaired but still held at the wall time → hold-not-cleared', () => {
    expect(planReconcile([entry({ deadlineAt: NOW })], { clones: [c], now: NOW })[0].escalate).toBe('wall-time');
    expect(planReconcile([entry({ status: 'repaired', deadlineAt: NOW })], { clones: [c], now: NOW })[0]).toMatchObject({ escalate: 'hold-not-cleared', stop: false });
  });
});

describe('runBundleRepairs (IO shell, every seam injected)', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-repair-'));
    const selfSync = [{ cloneKey: KEY, rebuild: { held: held(60) } }];
    const published = [];
    const dispatched = [];
    const stopped = [];
    const seams = {
      dir, selfSync, now: NOW, root: process.cwd(),
      rootsByKey: async () => new Map([[KEY, ROOT]]),
      killed: () => false,
      overrideFor: () => null,
      dispatch: async (t, o) => { dispatched.push({ t, o }); return { handle: 'h1' }; },
      stop: (e) => { stopped.push(e.holdId); },
      publish: (item) => { published.push(item); },
      log: () => {},
      host: 'test-host',
    };
    return { dir, published, dispatched, stopped, seams };
  };
  const settings = (o) => ({ settingsResolved: { settings: on(o), sources: {}, invalid: [] } });

  it('live: launches ONE session per clone, and a second tick launches none', async () => {
    const { dir, dispatched, seams } = setup();
    const s1 = await runBundleRepairs({ ...seams, ...settings() });
    expect(s1.dispatched).toHaveLength(1);
    expect(dispatched[0].o.prompt).not.toMatch(/--allow-conflict/);
    expect(readLedger(dir)[0]).toMatchObject({ status: 'running', handle: 'h1', deadlineAt: NOW + 120 * MIN });
    const s2 = await runBundleRepairs({ ...seams, now: NOW + MIN, ...settings() });
    expect(s2.dispatched).toEqual([]);
    expect(s2.held[0].rule).toBe(HOLD_RULES.ONE_PER_CLONE);
    expect(dispatched).toHaveLength(1);
  });

  it('kill switch: nothing launched', async () => {
    const { dispatched, seams } = setup();
    const s = await runBundleRepairs({ ...seams, killed: () => true, ...settings() });
    expect(s.off).toBe('kill-switch');
    expect(dispatched).toEqual([]);
  });

  it('shadow: posts the brief it would launch, once per hold, and launches nothing', async () => {
    const { dir, dispatched, published, seams } = setup();
    const s = await runBundleRepairs({ ...seams, ...settings({ mode: 'shadow' }) });
    expect(dispatched).toEqual([]);
    expect(s.shadow).toHaveLength(1);
    const entry = readLedger(dir)[0];
    expect(entry.status).toBe('shadow');
    expect(readFileSync(entry.briefPath, 'utf8')).toContain(`--clone=${ROOT}`);
    expect(published[0]).toMatchObject({ kind: 'bundle-repair-shadow' });
    await runBundleRepairs({ ...seams, now: NOW + MIN, ...settings({ mode: 'shadow' }) });
    expect(published).toHaveLength(1);
  });

  it('escalation: a recorded escalate stops the session and raises ONE needs-you item; never re-dispatched', async () => {
    const { dir, published, stopped, dispatched, seams } = setup();
    await runBundleRepairs({ ...seams, ...settings() });
    const e = readLedger(dir)[0];
    mkdirSync(join(dir, 'bundle-repair', 'outcomes'), { recursive: true });
    writeFileSync(outcomePath(dir, e.holdId), JSON.stringify({ outcome: 'escalate', reason: 'weakened-twice', detail: 'audit said WEAKENED twice' }));
    const s = await runBundleRepairs({ ...seams, now: NOW + 5 * MIN, ...settings() });
    expect(s.escalated).toEqual([{ holdId: e.holdId, reason: 'weakened-twice' }]);
    expect(stopped).toEqual([e.holdId]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: 'bundle-repair', repo: 'host/test-host', pr: 0 });
    expect(published[0].reason).toMatch(/weakened-twice/);
    await runBundleRepairs({ ...seams, now: NOW + 10 * MIN, ...settings() });
    expect(dispatched).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it('reserves the ledger entry BEFORE launching (a crash mid-launch cannot double-launch)', async () => {
    const { dir, seams } = setup();
    let onDisk = null;
    await runBundleRepairs({ ...seams, dispatch: async () => { onDisk = readLedger(dir); throw new Error('crashed mid-launch'); }, ...settings() });
    expect(onDisk).toEqual([expect.objectContaining({ status: 'running', indeterminate: true })]);
    const again = await runBundleRepairs({ ...seams, now: NOW + MIN, ...settings() });
    expect(again.dispatched).toEqual([]);
    expect(again.held[0].rule).toBe(HOLD_RULES.ONE_PER_CLONE);
  });

  it('a failed escalation post is retried next tick, never lost; a failed stop is retried and blocks a new launch', async () => {
    const { dir, published, dispatched, seams } = setup();
    await runBundleRepairs({ ...seams, ...settings() });
    const e = readLedger(dir)[0];
    mkdirSync(join(dir, 'bundle-repair', 'outcomes'), { recursive: true });
    writeFileSync(outcomePath(dir, e.holdId), JSON.stringify({ outcome: 'escalate', reason: 'unresolvable-conflict', detail: 'd' }));
    const failing = { publish: () => { throw new Error('feed down'); }, stop: () => { throw new Error('stop failed'); } };
    await runBundleRepairs({ ...seams, ...failing, now: NOW + MIN, ...settings() });
    const pending = readLedger(dir)[0];
    expect(pending).toMatchObject({ status: 'escalated', stopPending: true, escalationPending: [{ reason: 'unresolvable-conflict' }] });
    // the hold is still there and a later hold id would be new — but a pending stop still counts as a live repair
    const s = await runBundleRepairs({ ...seams, now: NOW + 2 * MIN, ...settings() });
    expect(published).toEqual([expect.objectContaining({ kind: 'bundle-repair' })]);
    const settled = readLedger(dir)[0];
    expect(settled.escalationPending).toBeUndefined();
    expect(settled.stopPending).toBeUndefined();
    expect(s.dispatched).toEqual([]);
    expect(dispatched).toHaveLength(1);
  });

  it('off with nothing recorded leaves no files and takes no lock', async () => {
    const { dir, seams } = setup();
    const s = await runBundleRepairs({ ...seams, lock: () => { throw new Error('must not lock'); }, settingsResolved: { settings: BUNDLE_REPAIR_STANDARD, sources: {}, invalid: [] } });
    expect(s.off).toBe('disabled');
    expect(existsSync(join(dir, 'bundle-repair'))).toBe(false);
  });

  it('a live pass holding the ledger lock makes another pass fail closed (no launch), and the lock is released after', async () => {
    const { dir, dispatched, seams } = setup();
    const { withFileLock } = await import('../../lib/atomic-json-file.mjs');
    mkdirSync(join(dir, 'bundle-repair'), { recursive: true });
    writeFileSync(`${ledgerPath(dir)}.lock`, `${process.pid}\n`); // a live holder (this process)
    const quick = (d, fn) => defaultLock(d, fn, { withFileLock, timeoutMs: 200 });
    await expect(runBundleRepairs({ ...seams, lock: quick, ...settings() })).rejects.toThrow(/timed out/);
    expect(dispatched).toEqual([]);
    const { unlinkSync } = await import('node:fs');
    unlinkSync(`${ledgerPath(dir)}.lock`);
    await runBundleRepairs({ ...seams, lock: quick, ...settings() });
    expect(dispatched).toHaveLength(1);
    expect(existsSync(`${ledgerPath(dir)}.lock`)).toBe(false);
  });

  it('round 4: unreadable rebuild state is unknown, not cleared', async () => {
    const { dir, stopped, seams } = setup();
    await runBundleRepairs({ ...seams, ...settings() });
    const s = await runBundleRepairs({ ...seams, selfSync: [{ cloneKey: KEY, rebuild: null }], now: NOW + MIN, ...settings() });
    expect(s.reconciled).toEqual([]);
    expect(stopped).toEqual([]);
    expect(readLedger(dir)[0].status).toBe('running');
  });

  it('round 4: the audit trail is re-read after the stop — an override made just before the stop is still caught', async () => {
    const { dir, published, seams } = setup();
    await runBundleRepairs({ ...seams, ...settings() });
    let stoppedYet = false;
    const s = await runBundleRepairs({
      ...seams, selfSync: [{ cloneKey: KEY, rebuild: { held: null } }], now: NOW + MIN, ...settings(),
      stop: () => { stoppedYet = true; },
      overrideFor: () => (stoppedYet ? { ref: 'lane/sneaky' } : null),
    });
    expect(s.escalated).toEqual([{ holdId: readLedger(dir)[0].holdId, reason: 'conflict-override-used' }]);
    expect(published.at(-1)).toMatchObject({ kind: 'bundle-repair' });
    expect(readLedger(dir)[0].status).toBe('escalated');
  });

  it('record: only the session holding the capability, once', async () => {
    const { dir, seams } = setup();
    let token;
    await runBundleRepairs({ ...seams, dispatch: async (t, o) => { token = o.token; return { handle: 'h' }; }, ...settings() });
    const e = readLedger(dir)[0];
    const input = { outcome: 'repaired', top: 'lane/unfreeze-review-top-1021d', audits: [{ verdict: 'NOT WEAKENED' }], detail: 'ok' };
    expect(() => recordOutcome({ dir, holdId: e.holdId, session: e.session, input, token: 'wrong' })).toThrow(/capability/);
    expect(() => recordOutcome({ dir, holdId: e.holdId, session: 'other', input, token })).toThrow(/belongs to/);
    recordOutcome({ dir, holdId: e.holdId, session: e.session, input, token });
    expect(() => recordOutcome({ dir, holdId: e.holdId, session: e.session, input, token })).toThrow();
  });
});

describe('no operator credential', () => {
  it('the session spawns as the worker role and its settings env is resolved with the sink\'s worker options', () => {
    expect(workerSpawnEnv({ WE_GITHUB_APP_ROLE: 'operator', X: '1' })).toEqual({ WE_GITHUB_APP_ROLE: 'worker', X: '1' });
    const base = vi.fn((cwd, opts) => ({ ROLE: opts?.env?.WE_GITHUB_APP_ROLE ?? 'parent' }));
    const env = repairSettingsEnv(base, { stateRoot: '/s', token: 't', stateRootEnv: 'S' })('/cwd', { env: workerSpawnEnv({}) });
    expect(base).toHaveBeenCalledWith('/cwd', { env: { WE_GITHUB_APP_ROLE: 'worker' } });
    expect(env).toEqual({ ROLE: 'worker', S: '/s', WE_BUNDLE_REPAIR_TOKEN: 't' });
  });
});

describe('settings via the cascade', () => {
  it('standard default is off + shadow; tool and env layers override with their source named; invalid ignored', async () => {
    const env = { WE_POLICY_CASCADE_LOG: '0' };
    const std = await resolveBundleRepairSettings({ env, tool: undefined, platform: null });
    expect(std.settings.mode).toBe('shadow');
    const log = vi.fn();
    const r = await resolveBundleRepairSettings({
      env: { WE_BUNDLE_REPAIR_ENABLED: '1', WE_POLICY_CASCADE_LOG: '1' }, platform: null, log,
      tool: { enabled: false, triggerMinutes: 45, maxConcurrent: 99, clones: ['review'] },
    });
    expect(r.settings).toMatchObject({ enabled: true, triggerMinutes: 45, maxConcurrent: 1, clones: ['review'], mode: 'shadow' });
    expect(r.sources).toMatchObject({ enabled: 'env', triggerMinutes: 'tool', maxConcurrent: 'standard', mode: 'standard' });
    expect(r.invalid.join()).toMatch(/maxConcurrent/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^policy-cascade · bundleRepair: .*enabled=true \(env\)/));
  });

  it('the committed tool file ships disabled, in shadow', () => {
    const file = JSON.parse(readFileSync(join(process.cwd(), 'scripts/settings/bundle-repair.json'), 'utf8'));
    expect(file.bundleRepair).toMatchObject({ enabled: false, mode: 'shadow' });
  });
});
