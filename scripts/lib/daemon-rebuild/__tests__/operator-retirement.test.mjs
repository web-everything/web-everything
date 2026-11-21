import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodeFs, { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as adoption from '../adopt.mjs';
import { prepareRebuild, readOverlayEventLog } from '../prepare.mjs';
import { writeReadyCandidate, writeRebuildState } from '../state.mjs';
import * as planner from '../plan.mjs';
import * as edgeFetch from '../edge-fetch.mjs';
import * as localState from '../local-state.mjs';
import * as lease from '../lease.mjs';
import * as repair from '../../lane-repair.mjs';
import { addOverlay, appendOverlayEvent, overlayFilePath, readOverlays, removeOverlay } from '../../daemon-overlays.mjs';
import { createPrototypeLoader } from '../../../operations/prototype-load-io.mjs';
import { OPERATOR_LOGINS } from '../../marker-authorship.mjs';
import * as overlayOperator from '../../../daemon-overlay.mjs';
import { removeRegistration, retireRegistration } from '../../../daemon-overlay.mjs';

const ref = 'lane/overlay-fix';
const sha = 'a'.repeat(40);
const actor = OPERATOR_LOGINS[0];
const added = { kind: 'added', ref, at: '2026-11-14T10:00:00Z' };
describe('prepare registration and audit identity hardening', () => {
  let root, env;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'overlay-retirement-'));
    env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
    addOverlay(root, { ref }, { env });
    appendOverlayEvent(root, added, { env });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['ready', 'skip-unrelated'])('%s adoption rechecks audit evidence after waiting for the add guard', async path => {
    const liveHead = 'b'.repeat(40), mainSha = 'c'.repeat(40), candidate = 'd'.repeat(40);
    const readyPath = join(root, 'fix-ready.jsonl');
    env = { ...env, WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_AUTO_REBASE: '0',
      WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only', WE_FIX_READY_PATH: readyPath,
      WE_PLATFORM_PREFERENCES_FILE: join(root, 'platform.json') };
    writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
    const green = { ref, sha, tests: 'green', audit: 'NOT WEAKENED' };
    writeFileSync(readyPath, JSON.stringify(green));
    const plan = { ok: true, finalSha: candidate, mainSha, inputsKey: 'plan',
      applied: [{ ref, sha }], decisions: [], alerts: [] };
    writeRebuildState(root, { adopted: { head: liveHead, mainSha, applied: [] } }, env);
    if (path === 'ready') writeReadyCandidate(root, { kind: 'candidate', prevHead: liveHead,
      passedAt: '2026-11-15T10:00:00Z', tree: 'candidate-tree', adopt: plan }, env);
    vi.spyOn(localState, 'ensureSafeToMove').mockReturnValue({ safe: true, untracked: [] });
    vi.spyOn(repair, 'repairCloneRefs').mockReturnValue({ ok: true, pruned: [], reportedNew: [] });
    vi.spyOn(edgeFetch, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [] });
    vi.spyOn(planner, 'planRebuild').mockResolvedValue(plan);
    vi.spyOn(adoption, 'readyBuildVerified').mockReturnValue(true);
    const matching = vi.spyOn(adoption, 'matchReadyCandidate');
    const run = vi.fn(args => {
      const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
      if (args[0] === 'symbolic-ref') return ok('main');
      if (args[0] === 'rev-parse') {
        const rev = args.at(-1);
        if (rev === 'HEAD') return ok(liveHead);
        if (rev === 'origin/main^{commit}') return ok(mainSha);
        if (rev === `refs/remotes/origin/${ref}^{commit}`) return ok(sha);
        if (rev.endsWith('^{tree}')) return ok('candidate-tree');
      }
      if (['ls-files', 'log', 'diff'].includes(args[0])) return ok();
      if (['merge-base', 'merge-tree', 'config'].includes(args[0])) return { status: 1, stdout: '', stderr: '' };
      throw new Error(`unexpected Git: ${args.join(' ')}`);
    });
    const lock = overlayOperator.withAddGuardLock;
    let release, acquired, attempted;
    const held = new Promise(resolve => { release = resolve; });
    const acquiredPromise = new Promise(resolve => { acquired = resolve; });
    const attemptedPromise = new Promise(resolve => { attempted = resolve; });
    const holder = lock(root, env, async () => { acquired(); await held; });
    await acquiredPromise;
    vi.spyOn(overlayOperator, 'withAddGuardLock').mockImplementation((root, env, fn) =>
      lock(root, env, fn, { onPhase: phase => {
        if (phase === 'attempt' && attempted) {
          expect(existsSync(`${overlayFilePath(root, env)}.add-guard.lock`)).toBe(true);
          attempted();
          attempted = null;
        }
      } }));
    const pending = prepareRebuild({ root, env, run, now: () => Date.parse('2026-11-15T10:01:00Z'),
      skipCheck: () => ({ skip: true, reason: 'unrelated' }) });
    try {
      await Promise.race([attemptedPromise, pending.then(() => { throw new Error('adoption did not wait for the add guard'); })]);
      if (path === 'ready') expect(matching.mock.results[0].value.adopt).toBeTruthy();
      writeFileSync(readyPath, [green, { ...green, tests: 'red' }].map(JSON.stringify).join('\n'));
    } finally {
      vi.mocked(overlayOperator.withAddGuardLock).mockRestore();
      release();
      await holder;
    }
    const done = await pending;
    expect(done.result).toMatchObject({ moved: false, reason: 'ready-audit-revoked' });
    expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(existsSync(`${overlayFilePath(root, env)}.add-guard.lock`)).toBe(false);
  });

  function loader(identity = () => ({ login: actor.toUpperCase(), type: 'User' })) {
    return createPrototypeLoader({ fs: nodeFs, env: { ...env, HOME: root }, now: () => 0,
      sleep: () => { throw new Error('unexpected sleep'); }, resolveOperatorIdentity: identity,
      settings: { workspaceRoot: root, daemons: { control: { clone: root } }, loaderCli: 'scripts/daemon-overlay.mjs', recordPath: join(root, 'records.jsonl') },
      exec: (command, args) => {
        if (command === 'node' && args[1] === 'list') return JSON.stringify({ list: readOverlays(root, { env }) });
        if (command === 'git' && args[0] === 'fetch') return '';
        if (command === 'git' && args[0] === 'rev-parse') return sha;
        if (command === 'git' && args[0] === 'ls-remote') return `${sha}\trefs/heads/${ref}`;
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      } });
  }

  it('real prototype-load --remove verifies the actor and records auto-retired evidence', async () => {
    expect(await loader()({ daemon: 'control', remove: ref, actor: actor.toUpperCase(), reason: 'withdraw live fix' }))
      .toMatchObject({ ok: true, removed: [ref] });
    expect(readOverlayEventLog(root, env).at(-1)).toMatchObject({ kind: 'auto-retired', ref, actor,
      operatorReason: true, by: env.USER || 'prototype-load', reason: 'withdraw live fix', tip: sha });
  });

  it.each([
    ['non-operator', 'outsider', () => ({ login: 'outsider', type: 'User' })],
    ['mismatched actor', 'outsider', () => ({ login: actor, type: 'User' })],
    ['bot identity', actor, () => ({ login: actor, type: 'Bot' })],
    ['unreadable identity', actor, () => { throw new Error('identity unavailable'); }],
  ])('prototype-load refuses %s --actor without removing anything', async (_name, declared, identity) => {
    const before = readOverlays(root, { env });
    expect(await loader(identity)({ daemon: 'control', remove: ref, actor: declared, reason: 'withdraw' }))
      .toMatchObject({ ok: false, stopReason: 'operator-identity-refused', removed: [] });
    expect(readOverlays(root, { env })).toEqual(before);
    expect(readOverlayEventLog(root, env)).toEqual([added]);
  });

  it('automatic retireRegistration supplies no operator proof', async () => {
    expect(await retireRegistration({ root, ref, expectedTip: sha, env, by: 'prototype-load', deps: {
      prove: () => ({ action: 'retire', tip: sha, reason: 'in-main' }), tip: () => sha,
    } })).toMatchObject({ retired: true });
    const event = readOverlayEventLog(root, env).at(-1);
    expect(event).toMatchObject({ kind: 'auto-retired', reason: 'in-main', tip: sha });
    expect(event).not.toHaveProperty('actor');
    expect(event).not.toHaveProperty('operatorReason');
  });

  it('prototype-load without an actor removes without operator evidence', async () => {
    expect(await loader(() => { throw new Error('must not resolve absent actor'); })({ daemon: 'control', remove: ref, reason: 'withdraw' }))
      .toMatchObject({ ok: true, removed: [ref] });
    expect(readOverlayEventLog(root, env).at(-1)).not.toHaveProperty('actor');
  });

  it('removeRegistration records credential identity independently of caller-supplied attribution', () => {
    expect(removeRegistration({ root, ref, by: 'caller', actor: 'forged', source: 'forged',
      reason: 'withdraw fix', env, deps: { tip: () => sha, viewerLogin: () => 'CHALBERT' } }).removed).toBe(true);
    expect(readOverlayEventLog(root, env).at(-1)).toMatchObject({ kind: 'removed', ref, tip: sha,
      by: 'caller', actor: 'chalbert', source: 'removeRegistration', reason: 'withdraw fix' });
  });

  it('removeRegistration still removes when credential evidence is unreadable without recording authority', () => {
    expect(removeRegistration({ root, ref, by: actor, reason: 'withdraw fix', env,
      deps: { tip: () => sha, viewerLogin: () => { throw new Error('unreadable credential'); } } }).removed).toBe(true);
    const event = readOverlayEventLog(root, env).at(-1);
    expect(event).toMatchObject({ kind: 'removed', ref, tip: sha, by: actor });
    expect(event).not.toHaveProperty('actor');
    expect(event).not.toHaveProperty('source');
  });

  it('removeRegistration records tip/by/reason but drops a caller-supplied actor', () => {
    expect(removeRegistration({ root, ref, by: 'operator', actor, reason: 'retire fix', env,
      deps: { tip: () => sha } }).removed).toBe(true);
    const events = readOverlayEventLog(root, env);
    expect(events.at(-1)).toMatchObject({ kind: 'removed', ref, tip: sha, by: 'operator', reason: 'retire fix' });
    expect(events.at(-1)).not.toHaveProperty('actor');
    expect(Number.isFinite(Date.parse(events.at(-1).at))).toBe(true);
  });

  it.each([
    'removed during planning',
    'audited omission', 'explicitly pinned omission', 're-registered pinned during planning',
  ])('prepareRebuild adapter: %s', async (mode) => {
    env = { ...env, WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_AUTO_REBASE: '0',
      WE_DAEMON_OVERLAY_FOLLOW_TIP: mode === 'audited omission' ? 'audited-only' : 'follow' };
    const liveHead = 'b'.repeat(40), mainSha = 'c'.repeat(40), candidate = 'd'.repeat(40);
    const carried = 'lane/carried';
    const pinnedOmission = ['explicitly pinned omission', 're-registered pinned during planning'].includes(mode);
    if (mode === 'explicitly pinned omission') addOverlay(root, { ref, pinned: true }, { env });
    addOverlay(root, { ref: carried, pr: 100 }, { env });
    appendOverlayEvent(root, { ...added, ref: carried }, { env });
    const plan = { ok: true, finalSha: 'e'.repeat(40), mainSha, inputsKey: 'new-plan', applied: [], decisions: [], alerts: [] };
    if (mode === 'audited omission') plan.auditAdopted = [ref];
    writeRebuildState(root, { adopted: { head: liveHead, mainSha, applied: [{ ref, sha }] } }, env);
    writeReadyCandidate(root, { kind: 'candidate', prevHead: liveHead, passedAt: '2026-11-15T10:00:00Z', tree: 'candidate-tree',
      adopt: { finalSha: candidate, mainSha, inputsKey: 'ready-plan', applied: pinnedOmission || mode === 'audited omission' ? [] : [{ ref: carried, sha }] } }, env);
    vi.spyOn(localState, 'ensureSafeToMove').mockReturnValue({ safe: true, untracked: [] });
    vi.spyOn(repair, 'repairCloneRefs').mockReturnValue({ ok: true, pruned: [], reportedNew: [] });
    vi.spyOn(edgeFetch, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [] });
    vi.spyOn(planner, 'planRebuild').mockImplementation(async () => {
      if (mode === 'removed during planning') removeOverlay(root, ref, { env });
      if (mode === 're-registered pinned during planning') {
        removeOverlay(root, ref, { env });
        addOverlay(root, { ref, pinned: true }, { env });
      }
      return plan;
    });
    vi.spyOn(adoption, 'readyBuildVerified').mockReturnValue(true);
    vi.spyOn(lease, 'claimBuildLease').mockReturnValue(null);
    const matching = vi.spyOn(adoption, 'matchReadyCandidate');
    vi.spyOn(adoption, 'finalizeRebuild').mockResolvedValue({ moved: true, head: candidate });
    const run = (args) => {
      const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
      if (args[0] === 'symbolic-ref') return ok('main');
      if (args[0] === 'rev-parse') {
        const rev = args.at(-1);
        if (rev === 'HEAD') return ok(liveHead);
        if (rev === 'origin/main^{commit}') return ok(mainSha);
        if (rev === `${plan.finalSha}^{tree}`) return ok('plan-tree');
        if (rev === `refs/remotes/origin/${carried}^{commit}`) return ok(sha);
      }
      if (args[0] === 'ls-files' || args[0] === 'log') return ok();
      if (args[0] === 'merge-base') return { status: 1, stdout: '', stderr: '' };
      if (['merge-tree', 'config'].includes(args[0])) return { status: 1, stdout: '', stderr: '' };
      throw new Error(`unexpected Git: ${args.join(' ')}`);
    };
    await prepareRebuild({ root, env, run, now: () => Date.parse('2026-11-15T10:01:00Z'), adoptOnly: true });
    expect(matching).toHaveBeenCalledOnce();
    if (pinnedOmission) {
      const hooks = matching.mock.calls[0][0];
      expect(hooks.registered(ref)).toBe(true);
      expect(hooks.auditedTip).not.toBeTypeOf('function');
      expect(readOverlays(root, { env }).find((o) => o.ref === ref)?.pinned).toBe(true);
      expect(adoption.finalizeRebuild).not.toHaveBeenCalled();
    }
    const match = matching.mock.results[0].value;
    expect(match).toMatchObject({ adopt: null, reason: `superseded-omits-live-overlay: ${ref}` });
  });
});
