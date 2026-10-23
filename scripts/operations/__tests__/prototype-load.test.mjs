/**
 * @file Hermetic prototype admission proofs.
 * WHY (incident 2026-10-22): pin main preservation, ready evidence, add-before-remove, stale
 * replacement, and adoption refusal with injected doubles, plus real filesystem refusal persistence.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withRealRepo } from './helpers/real-repo.mjs';
import { createPrototypeLoader, defaultDeps } from '../prototype-load-io.mjs';
import { changedPaths, comparePaths, nextMergeRef, prototypeLoadOperation, PROTOTYPE_LOAD_EFFECT } from '../prototype-load.mjs';
import { createRegistry } from '../registry.mjs';
import { startRun, advance } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { parseOperationArgv } from '../cli-adapter.mjs';
const SHA = 'a'.repeat(40), TREE = 'b'.repeat(40), MERGE = 'c'.repeat(40);
const BASE = { branch: 'lane/new', sha: SHA, daemon: 'control' };
const settings = {
  daemons: { control: { label: 'com.we.control', clone: 'wev-control' }, review: { label: 'com.we.review-daemon' }, drain: { label: 'com.plateau.drain-daemon', clone: '.lanes/we-drain-daemon/code' } },
  workspaceRoot: '~/workspace', launchAgentsDir: '~/Library/LaunchAgents', recordPath: '~/records', readyRecordPath: '~/ready',
  loaderCli: 'scripts/daemon-overlay.mjs', adoption: { timeoutMs: 30, pollMs: 10 },
};
function fixture(options = {}) {
  const calls = [], records = [], sleeps = [], reads = [], cloneRoots = [];
  let clock = 0;
  let remoteTip = SHA;
  let tipReads = 0;
  const admitted = [];
  const env = { HOME: '/home/test', USER: 'tester', PATH: '/bin', GH_TOKEN: 'secret', NODE_OPTIONS: 'unsafe', WE_ALLOW_NO_PR: '1', ...options.env };
  const ready = { ref: BASE.branch, sha: SHA, tests: 'green', audit: 'NOT WEAKENED' };
  const fs = {
    readFileSync(p) {
      reads.push(p);
      if (options.readError && p === '/home/test/ready') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      if (p === '/home/test/ready') return options.ready ?? `bad line\n${JSON.stringify(ready)}\n`;
      if (p.endsWith('.alerts.jsonl')) return options.alerts || '';
      if (p.endsWith('.events.jsonl')) return options.events || '';
      const e = new Error('missing'); e.code = 'ENOENT'; throw e;
    },
    mkdirSync() {}, appendFileSync(p, line) { records.push({ path: p, ...JSON.parse(line) }); },
  };
  const fail = (status, stdout = '', stderr = 'failed') => { throw Object.assign(new Error(stderr), { status, stdout, stderr }); };
  const exec = (cmd, args, config) => {
    calls.push({ cmd, args, config });
    expect(args.join(' ')).not.toMatch(/--allow-conflict|--force|--allow-no-pr/);
    expect(Object.keys(config.env).sort()).toEqual(['HOME', 'PATH', 'USER', ...(env.WE_DAEMON_OVERLAY_DIR ? ['WE_DAEMON_OVERLAY_DIR'] : [])]);
    if (options.execFailure === args[0]) throw Object.assign(new Error('maxBuffer exceeded; inspect full output separately'), { code: 'ENOBUFS' });
    if (cmd === 'plutil') return JSON.stringify({ WorkingDirectory: '/home/test/workspace/review' });
    if (cmd === 'node') {
      const action = args[1], ref = args.find((a) => a.startsWith('--ref='))?.slice(6);
      if (action === 'list') return options.listRaw ?? JSON.stringify({ list: (options.list || []).map((ref) => ({ ref })) });
      if (args.includes('--check')) {
        if (options.checkRaw) return options.checkRaw;
        if (options.unverifiable === ref) return fail(1, JSON.stringify({ check: { ok: false } }));
        const clean = !(options.conflicts || []).includes(ref);
        const data = JSON.stringify({ check: { ok: true, clean, candSha: remoteTip, ...(clean ? {} : { files: ['x'], conflicting: [{ ref: 'lane/other' }] }) }, wouldRegister: clean });
        if (options.advanceAfterCheck && ref === (options.behind ? 'lane/new-m1' : BASE.branch)) remoteTip = TREE;
        return clean ? data : fail(3, data);
      }
      if (action === 'add' && options.addFails) return fail(1);
      if (action === 'add') {
        admitted.push({ ref });
        return '{}';
      }
      if (action === 'remove' && options.removeFails === ref) return fail(1);
      return '{}';
    }
    if (args[0] === '-C') {
      expect(args.slice(2)).toEqual(['merge-base', '--is-ancestor', options.behind ? MERGE : SHA, 'HEAD']);
      return options.timeout ? fail(1) : '';
    }
    if (args[0] === 'fetch') return '';
    if (args[0] === 'rev-parse') {
      tipReads++;
      if (options.tipReadFails && tipReads > 1) return fail(1);
      return options.tip || remoteTip;
    }
    if (args[0] === 'diff') return args.at(-1).startsWith('origin/main...') ? 'M\0x\0' : options.diff ?? 'M\0x\0';
    if (args[0] === 'merge-base') {
      if (args[2] === 'origin/main') return options.behind ? fail(1) : '';
      return (options.contained || []).includes(args[2].slice(7)) ? '' : fail(1);
    }
    if (args[0] === 'merge-tree') return options.mergeConflict ? fail(1, `${TREE}\n100644 ${SHA} 1\tx\nCONFLICT (content): Merge conflict in x\n`) : TREE;
    if (args[0] === 'ls-remote') return options.remote || '';
    if (args[0] === 'commit-tree') return MERGE;
    if (args[0] === 'push') { remoteTip = MERGE; return ''; }
    throw new Error(`unexpected command ${cmd} ${args}`);
  };
  const load = createPrototypeLoader({ exec, fs, env, settings: structuredClone(settings), now: () => clock,
    cloneKey: (root) => { cloneRoots.push(root); return 'test-clone-key'; },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  return { calls, records, sleeps, admitted, reads, cloneRoots, run: (input = {}) => load({ ...BASE, ...input }) };
}
const mutations = (f, action) => f.calls.filter((c) => c.cmd === 'node' && c.args[1] === action && !c.args.includes('--check'));
describe('prototype-load', () => {
  it('refuses missing readiness evidence and persists the refusal on a real filesystem', async () => {
    await withRealRepo(async ({ root }) => {
      const recordPath = join(root, 'audit', 'prototype-load.jsonl');
      const load = createPrototypeLoader({ ...defaultDeps(),
        env: { HOME: root },
        settings: { ...settings, workspaceRoot: root, recordPath, readyRecordPath: join(root, 'missing-ready.jsonl') },
      });
      const result = await load(BASE);
      expect(result).toMatchObject({ ok: false, stopReason: 'no-ready', registered: false, adopted: false });
      const records = readFileSync(recordPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ ...BASE, ok: false, stopReason: 'no-ready', registered: false, adopted: false });
    });
  });

  it.each([
    ['missing', ''], ['wrong sha', JSON.stringify({ ref: BASE.branch, sha: TREE, tests: 'green', audit: 'NOT WEAKENED' })],
    ['weakened', JSON.stringify({ ref: BASE.branch, sha: SHA, tests: 'green', audit: 'WEAKENED' })],
  ])('no-ready: %s stops before git and records', async (_, ready) => {
    const f = fixture({ ready }); expect((await f.run()).stopReason).toBe('no-ready'); expect(f.calls).toHaveLength(0); expect(f.records[0].stopReason).toBe('no-ready');
  });
  it('accepts explicit tests-run and NOT WEAKENED pair', async () => {
    const f = fixture({ ready: '' }); expect((await f.run({ testsRun: 'test-1', audit: 'not weakened' })).ok).toBe(true);
  });
  it('refuses a branch tip mismatch before main checks', async () => {
    const f = fixture({ tip: TREE }); const r = await f.run(); expect(r.gate.reason).toBe('sha-not-branch-tip'); expect(r.stopReason).toBe('no-ready'); expect(f.calls).toHaveLength(2);
  });
  it.each(['lane/../x', '-danger', 'lane/x.lock', 'main'])('bad-input: refuses unsafe ref %s', async (branch) => {
    const f = fixture(); expect((await f.run({ branch })).stopReason).toBe('bad-input'); expect(f.calls).toHaveLength(0);
  });
  it('bad-input: malformed sha records refusal', async () => { const f = fixture(); expect((await f.run({ sha: 'short' })).stopReason).toBe('bad-input'); expect(f.records).toHaveLength(1); });
  it.each([[null, 'lane/new-m1'], [`${SHA}\trefs/heads/lane/new-m1\n`, 'lane/new-m2']])('clean behind-main merge publishes next suffix', async (remote, ref) => {
    const f = fixture({ behind: true, remote }); const r = await f.run(); expect(r.ok).toBe(true); expect(r.effectiveRef).toBe(ref); expect(r.effectiveSha).toBe(MERGE);
    expect(f.calls.find((c) => c.args[0] === 'push').args).toEqual(['push', 'origin', `${MERGE}:refs/heads/${ref}`]);
  });
  it('behind-main-conflict names paths and never registers', async () => {
    const f = fixture({ behind: true, mergeConflict: true }); const r = await f.run(); expect(r.stopReason).toBe('behind-main-conflict'); expect(r.mainCheck.files).toEqual(['x']); expect(mutations(f, 'add')).toHaveLength(0);
  });
  it('reverts-main catches outside paths before push or check', async () => {
    const f = fixture({ behind: true, diff: 'M\0x\0D\0main-fix\0' }); const r = await f.run(); expect(r.stopReason).toBe('reverts-main'); expect(r.offendingPaths).toEqual(['main-fix']); expect(f.calls.some((c) => c.cmd === 'node' || c.args[0] === 'push')).toBe(false);
  });
  it.each([false, true])('stale-registration names blocker and stops before add (candidate conflict: %s)', async (candidateConflict) => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old', ...(candidateConflict ? [BASE.branch] : [])] }); const r = await f.run(); expect(r.stopReason).toBe('stale-registration'); expect(r.message).toBe('stale-registration: lane/old'); expect(mutations(f, 'add')).toHaveLength(0);
  });
  it('contained stale registration is replaced by an ordered swap', async () => {
    const f = fixture({ list: ['lane/old', 'lane/also'], contained: ['lane/old', 'lane/also'], conflicts: ['lane/old'] }); const r = await f.run(); expect(r.ok).toBe(true); expect(r.stale).toEqual(['lane/old']); expect(r.removed).toEqual(['lane/old', 'lane/also']);
    const index = f.calls.findIndex((c) => c.cmd === 'node' && c.args[1] === 'add' && !c.args.includes('--check'));
    for (const remove of mutations(f, 'remove')) expect(f.calls.indexOf(remove)).toBeGreaterThan(index);
  });
  it('check-conflict preserves files and conflicting registrations', async () => {
    const f = fixture({ conflicts: [BASE.branch] }); const r = await f.run(); expect(r.stopReason).toBe('check-conflict'); expect(r.check.files).toEqual(['x']); expect(r.check.conflicting).toEqual([{ ref: 'lane/other' }]);
  });
  it.each([BASE.branch, 'lane/old'])('check-unverifiable refuses incomplete candidate or established evidence: %s', async (unverifiable) => {
    const f = fixture({ unverifiable, list: ['lane/old'] }); expect((await f.run()).stopReason).toBe('check-unverifiable'); expect(mutations(f, 'add')).toHaveLength(0);
  });
  it('register-failed never removes anything', async () => {
    const f = fixture({ list: ['lane/old'], contained: ['lane/old'], addFails: true }); const r = await f.run(); expect(r.stopReason).toBe('register-failed'); expect(mutations(f, 'remove')).toHaveLength(0); expect(f.calls.some((c) => c.args[0] === '-C')).toBe(false);
  });
  it.each([false, true])('sha-moved stops before add or removal (generated merge: %s)', async (behind) => {
    const f = fixture({ behind, advanceAfterCheck: true, list: ['lane/old'], contained: ['lane/old'] });
    const r = await f.run();
    expect(r).toMatchObject({ stopReason: 'no-ready', detail: 'sha-moved', registered: false, adopted: false });
    expect(mutations(f, 'add')).toEqual([]); expect(mutations(f, 'remove')).toEqual([]);
    expect(f.calls.some((c) => c.args[0] === '-C')).toBe(false);
    expect(f.records[0].detail).toBe('sha-moved');
  });
  it('unreadable tip before real add fails closed', async () => {
    const f = fixture({ tipReadFails: true });
    expect((await f.run()).stopReason).toBe('no-ready');
    expect(mutations(f, 'add')).toEqual([]);
  });
  it('swap-remove-failed leaves remaining entries alone without rollback', async () => {
    const f = fixture({ list: ['lane/a', 'lane/b', 'lane/c'], contained: ['lane/a', 'lane/b', 'lane/c'], removeFails: 'lane/b' });
    const r = await f.run(); expect(r.stopReason).toBe('swap-remove-failed'); expect(r.registered).toBe(true); expect(r.removed).toEqual(['lane/a']); expect(r.swap.failed).toBe('lane/b'); expect(mutations(f, 'remove')).toHaveLength(2);
  });
  it('adoption-timeout bounds injected polling and retains registration', async () => {
    const f = fixture({ timeout: true }); const r = await f.run(); expect(r.stopReason).toBe('adoption-timeout'); expect(r.registered).toBe(true); expect(r.adopted).toBe(false); expect(f.sleeps).toEqual([10, 10, 10]);
  });
  it.each(['alerts', 'events'])('adoption-refused reads %s and stops even if HEAD contains candidate', async (file) => {
    const f = fixture({ [file]: JSON.stringify({ at: new Date(0).toISOString(), ref: BASE.branch, kind: 'conflict-dropped' }) }); expect((await f.run()).stopReason).toBe('adoption-refused');
  });
  it.each([undefined, '/custom/overlays', '~/custom-overlays'])('reads refusal files with injected clone key and overlay directory: %s', async (directory) => {
    const f = fixture({ env: directory ? { WE_DAEMON_OVERLAY_DIR: directory } : {} });
    expect((await f.run()).ok).toBe(true);
    expect(f.cloneRoots).toEqual(['/home/test/workspace/wev-control']);
    const root = directory === '~/custom-overlays' ? '/home/test/custom-overlays' : directory || '/home/test/.claude/daemon-overlays';
    expect(f.reads).toContain(`${root}/test-clone-key.alerts.jsonl`);
    expect(f.reads).toContain(`${root}/test-clone-key.events.jsonl`);
  });
  it('uses the existing loader argv contract for checks, list, add and remove', async () => {
    const f = fixture({ list: ['lane/old'], contained: ['lane/old'] });
    expect((await f.run({ why: 'tested change' })).ok).toBe(true);
    const calls = f.calls.filter((c) => c.cmd === 'node').map((c) => c.args.slice(1));
    const clone = '--clone=/home/test/workspace/wev-control';
    expect(calls).toEqual([
      ['add', clone, '--ref=lane/new', '--check', '--json'],
      ['list', clone, '--json'],
      ['add', clone, '--ref=lane/old', '--check', '--json'],
      ['add', clone, '--ref=lane/new', '--reason=tested change', '--by=tester', '--json'],
      ['remove', clone, '--ref=lane/old', '--reason=prototype-load: replaced by lane/new'],
    ]);
    const addIndex = f.calls.findIndex((c) => c.cmd === 'node' && c.args.includes('--by=tester'));
    expect(f.calls.slice(addIndex - 2, addIndex).map((c) => c.args)).toEqual([
      ['fetch', 'origin', BASE.branch], ['rev-parse', `origin/${BASE.branch}`],
    ]);
  });
  it('ignores old refusals and unrelated events', async () => {
    const f = fixture({ events: JSON.stringify({ at: new Date(-1).toISOString(), ref: BASE.branch, event: 'removed' }), alerts: JSON.stringify({ at: new Date(0).toISOString(), ref: 'lane/else', event: 'refused' }) }); expect((await f.run()).ok).toBe(true);
  });
  it('happy path pins full command sequence, safe env and recorded provenance', async () => {
    const f = fixture(); const r = await f.run({ why: 'load tested patch' }); expect(r).toMatchObject({ ok: true, registered: true, adopted: true, stopReason: null, cloneSource: 'settings:prototype-load.json#daemons.control.clone' });
    expect(f.calls.map((c) => c.cmd === 'node' ? `${c.args[1]}${c.args.includes('--check') ? ':check' : ''}` : c.args[0])).toEqual(['fetch', 'rev-parse', 'fetch', 'diff', 'merge-base', 'diff', 'add:check', 'list', 'fetch', 'rev-parse', 'add', '-C']);
    expect(f.records[0]).toMatchObject({ path: '/home/test/records', daemon: 'control', branch: BASE.branch, sha: SHA, effectiveRef: BASE.branch, effectiveSha: SHA, dryRun: false, ok: true, registered: true, adopted: true, why: 'load tested patch' });
    expect(r.settings.sources['daemons.control.clone']).toBe('tool'); expect(r.settings.log).toContain('wev-control');
  });
  it('already registered is idempotent but still waits for adoption', async () => {
    const f = fixture({ list: [BASE.branch] }); expect((await f.run()).registered).toBe('already'); expect(mutations(f, 'add')).toHaveLength(0); expect(f.calls.at(-1).args[0]).toBe('-C');
  });
  it('dry-run checks original ref and records without push/add/remove or adoption', async () => {
    const f = fixture({ behind: true, list: ['lane/old'], contained: ['lane/old'] }); const r = await f.run({ dryRun: true }); expect(r.ok).toBe(true); expect(r.wouldMerge.ref).toBe('lane/new-m1'); expect(r.wouldRegister).toBe(true); expect(r.effectiveRef).toBe(BASE.branch); expect(r.wouldRemove).toEqual(['lane/old']);
    expect(f.calls.some((c) => ['push', 'commit-tree', '-C'].includes(c.args[0]))).toBe(false); expect(mutations(f, 'add')).toHaveLength(0); expect(mutations(f, 'remove')).toHaveLength(0); expect(f.records[0].dryRun).toBe(true);
  });
  it('resolves plist WorkingDirectory with logged source', async () => { const f = fixture(); const r = await f.run({ daemon: 'review' }); expect(r.cloneSource).toBe('plist:com.we.review-daemon'); expect(r.clone).toBe('/home/test/workspace/review'); expect(f.calls[0].cmd).toBe('plutil'); });
  it('drain override selects CODE clone without reading plist', async () => { const f = fixture(); const r = await f.run({ daemon: 'drain' }); expect(r.clone).toBe('/home/test/workspace/.lanes/we-drain-daemon/code'); expect(f.calls.some((c) => c.cmd === 'plutil')).toBe(false); });
  it('unknown-daemon records without executing anything', async () => { const f = fixture(); expect((await f.run({ daemon: 'unknown' })).stopReason).toBe('unknown-daemon'); expect(f.calls).toHaveLength(0); expect(f.records).toHaveLength(1); });
  it('unreadable readiness fails closed and records the read failure', async () => {
    const f = fixture({ readError: true }); expect((await f.run()).stopReason).toBe('no-ready'); expect(f.calls).toHaveLength(0); expect(f.records[0].error).toContain('permission denied');
  });
  it.each([{ listRaw: '{}' }, { listRaw: '{broken' }, { checkRaw: '{"check":{"ok":true,"clean":false}}' }])('incomplete loader evidence refuses admission: %j', async (options) => {
    const f = fixture(options); expect((await f.run()).stopReason).toBe('check-unverifiable'); expect(mutations(f, 'add')).toHaveLength(0);
  });
  it('oversized subprocess output fails closed with an operator fallback', async () => {
    const f = fixture({ execFailure: 'diff' }); const r = await f.run(); expect(r.stopReason).toBe('check-unverifiable'); expect(r.error).toContain('maxBuffer'); expect(r.fallback).toContain('Inspect'); expect(mutations(f, 'add')).toHaveLength(0);
    expect(f.calls.every((c) => c.config.maxBuffer > 0 && c.config.timeout > 0)).toBe(true);
  });
  it('dry-run preserves already registered evidence', async () => {
    const f = fixture({ list: [BASE.branch] }); const r = await f.run({ dryRun: true }); expect(r.registered).toBe('already'); expect(r.wouldRegister).toBe(false); expect(mutations(f, 'add')).toHaveLength(0);
  });
  it('pure comparison handles renames, copies and exact path equality', () => {
    expect(changedPaths('R100\0old path\0new path\0C80\0from\0to\0')).toEqual(['from', 'new path', 'old path', 'to']);
    expect(comparePaths(['x'], ['y'])).toEqual({ outside: ['y'], missing: ['x'] });
    expect(nextMergeRef(BASE.branch, `${SHA}\trefs/heads/lane/new-m9\n${SHA}\trefs/heads/lane/new-mabc`)).toBe('lane/new-m10');
    expect(() => changedPaths('M\0')).toThrow();
  });
  it('declaration exposes verdict and marks transaction as writing', () => {
    const declaration = prototypeLoadOperation(); expect(declaration.name).toBe('prototype-load'); expect(declaration.verdictFrom).toBe('assess');
  });
  it('derived CLI and engine await the transaction and publish its JSON verdict', async () => {
    const f = fixture({ ready: '' });
    const declaration = prototypeLoadOperation();
    const argv = [`--branch=${BASE.branch}`, `--sha=${SHA}`, '--daemon=control', '--tests-run=case-1', '--audit=NOT WEAKENED', '--dry-run', '--json'];
    const parsed = parseOperationArgv(declaration, argv);
    expect(parsed.errors).toEqual([]);
    const registry = createRegistry(); registry.register(declaration);
    let run = startRun({ op: declaration.name, id: 'prototype-test', input: parsed.input, registry });
    run = advance(run, { registry });
    expect(f.calls).toHaveLength(0);
    run = (await applyPendingEffects(run, { store: createMemoryRunStore(), sinks: { [PROTOTYPE_LOAD_EFFECT]: (input) => f.run(input) } })).run;
    run = advance(run, { registry }); run = advance(run, { registry });
    expect(run.verdict).toMatchObject({ ok: true, dryRun: true, registered: false, adopted: false });
    expect(JSON.parse(JSON.stringify(run.verdict)).gate.testsRun).toBe('case-1');
  });
});
