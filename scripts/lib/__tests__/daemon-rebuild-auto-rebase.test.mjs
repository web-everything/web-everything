import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { kickAutoRebase, resolveAutoRebaseSwitch, runAutoRebase, finishPendingSwaps } from '../daemon-rebuild/auto-rebase.mjs';
import { addOverlay, removeOverlay, readOverlays, overlayFilePath, appendOverlayEvent } from '../daemon-overlays.mjs';
import { planRebuild } from '../daemon-rebuild/plan.mjs';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { writeRebuildState, readRebuildState, alertsFilePath } from '../daemon-rebuild/state.mjs';

const temps = [];
const temp = () => { const p = fs.mkdtempSync(join(tmpdir(), 'we-auto-test-')); temps.push(p); return p; };
afterEach(() => { temps.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); vi.restoreAllMocks(); });
const run = (args, opts = {}) => spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8', timeout: 20_000, ...opts, env: { ...process.env, ...opts.env } });
const ok = (cwd, args) => { const r = run(args, { cwd }); if (r.status !== 0) throw new Error(`${args}: ${r.stderr}`); return r.stdout.trim(); };
const write = (root, name, text) => { fs.mkdirSync(dirname(join(root, name)), { recursive: true }); fs.writeFileSync(join(root, name), text); };
const ref = 'lane/fix';
const overlay = { ref, pr: 123 };
const agentResult = (report = {}) => ({ status: 0, stdout: JSON.stringify({ exitCode: 0, timedOut: false, events: { terminal: 'turn.completed' }, ...report }) });
function fixture({ extraModule = false } = {}) {
  const base = temp(), root = join(base, 'clone'), origin = join(base, 'origin.git');
  fs.mkdirSync(root); fs.mkdirSync(join(root, 'node_modules'));
  ok(base, ['init', '--bare', '-q', origin]);
  ok(root, ['init', '-q', '-b', 'main']);
  write(root, '.gitignore', 'node_modules/\n');
  write(root, 'worker.mjs', 'base\n');
  write(root, 'worker.test.mjs', "import './worker.mjs';\n");
  if (extraModule) {
    write(root, 'extra.mjs', 'original extra module\n');
    write(root, 'extra.test.mjs', "import './extra.mjs';\n");
  }
  ok(root, ['add', '.']); ok(root, ['commit', '-qm', 'base']);
  ok(root, ['remote', 'add', 'origin', origin]); ok(root, ['push', '-qu', 'origin', 'main']);
  const baseSha = ok(root, ['rev-parse', 'HEAD']);
  ok(root, ['checkout', '-qb', ref]); write(root, 'worker.mjs', 'overlay\n');
  ok(root, ['commit', '-qam', 'hotfix']); ok(root, ['push', '-q', 'origin', ref]);
  const oldSha = ok(root, ['rev-parse', 'HEAD']);
  ok(root, ['checkout', '-q', 'main']);
  const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'), WE_DAEMON_STATE_DIR: join(base, 'state'), WE_PLATFORM_PREFERENCES_FILE: join(base, 'missing'), WE_DAEMON_AUTO_REBASE: '1', WE_DAEMON_REBUILD_SKIP_UNRELATED: '0' };
  addOverlay(root, overlay, { env });
  const moveMain = () => {
    write(root, 'worker.mjs', 'main\n'); ok(root, ['commit', '-qam', 'main moved']);
    ok(root, ['push', '-q', 'origin', 'main']);
  };
  const calls = [], scratched = [];
  const deps = {
    io: { ...fs, mkdtempSync: prefix => { const p = fs.mkdtempSync(prefix); scratched.push(p); return p; } },
    codex: vi.fn(async ({ root: scratch, args, taskFile }) => {
      calls.push('codex');
      expect(args).toContain('--gate=none'); expect(args).toContain('--task-kind=fix');
      expect(fs.readFileSync(taskFile, 'utf8')).toContain('BOTH');
      write(scratch, 'worker.mjs', 'overlay + main\n'); ok(scratch, ['add', 'worker.mjs']);
      return agentResult();
    }),
    testRunner: vi.fn(async ({ args }) => {
      calls.push('tests');
      expect(args).toEqual(['scripts/readiness/heavy-admission.mjs', 'run', '--wait-ms=540000', '--', 'npx', 'vitest', 'run', 'worker.test.mjs']);
      return { status: 0 };
    }),
    auditor: vi.fn(async ({ args }) => { calls.push('audit'); expect(args).toContain('--review'); return agentResult({ lastMessage: 'NOT WEAKENED' }); }),
    addOverlay: (...args) => { calls.push('add'); return addOverlay(...args); },
    appendOverlayEvent: (...args) => { calls.push(args[1].kind); return appendOverlayEvent(...args); },
    now: () => '2026-10-23T00:00:00.000Z',
  };
  return { base, root, origin, baseSha, oldSha, env, moveMain, calls, scratched, deps };
}
const pendingDir = f => `${overlayFilePath(f.root, f.env)}.auto-rebase`;
const job = f => runAutoRebase({ root: f.root, ref, env: f.env, deps: f.deps });
const swaps = f => finishPendingSwaps({ root: f.root, env: f.env, run,
  removeOverlay: (...args) => { f.calls.push('remove'); return removeOverlay(...args); },
  appendOverlayEvent: (...args) => { f.calls.push(args[1].kind); return appendOverlayEvent(...args); } });

describe('established overlay auto rebase', () => {
  it('defaults on, follows policy sources, and logs every consultation', () => {
    const dir = temp(), settingsPath = join(dir, 'settings.json');
    const env = { WE_PLATFORM_PREFERENCES_FILE: join(dir, 'missing') };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveAutoRebaseSwitch(env, { settingsPath })).toEqual({ enabled: true, source: 'standard' });
    fs.writeFileSync(settingsPath, JSON.stringify({ autoRebase: { enabled: true } }));
    expect(resolveAutoRebaseSwitch(env, { settingsPath })).toEqual({ enabled: true, source: 'tool' });
    expect(resolveAutoRebaseSwitch({ ...env, WE_DAEMON_AUTO_REBASE: '0' }, { settingsPath })).toEqual({ enabled: false, source: 'env' });
    expect(log).toHaveBeenCalledWith('autoRebase=off source=env');
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('env off disables kick without spawning or writing markers', () => {
    const f = fixture(), spawnFn = vi.fn();
    expect(kickAutoRebase({ ...f, env: { ...f.env, WE_DAEMON_AUTO_REBASE: '0' }, lost: [overlay], spawnFn })).toEqual({ started: [], skipped: [ref] });
    expect(spawnFn).not.toHaveBeenCalled(); expect(fs.existsSync(pendingDir(f))).toBe(false);
  });

  it('single-flights each ref, uses detached node, recovers a stale marker, and releases a failed spawn', () => {
    const f = fixture(), unref = vi.fn(), spawnFn = vi.fn(() => ({ unref }));
    const kick = () => kickAutoRebase({ ...f, lost: [overlay], spawnFn });
    expect(kick().started).toEqual([ref]); expect(kick().skipped).toEqual([ref]);
    expect(spawnFn.mock.calls[0][1]).toEqual(expect.arrayContaining([`--clone=${f.root}`, `--ref=${ref}`]));
    expect(spawnFn.mock.calls[0][2]).toMatchObject({ detached: true, stdio: 'ignore' }); expect(unref).toHaveBeenCalledTimes(1);
    const marker = join(pendingDir(f), fs.readdirSync(pendingDir(f))[0]);
    fs.utimesSync(marker, new Date(0), new Date(0)); expect(kick().started).toEqual([ref]);
    fs.unlinkSync(marker); spawnFn.mockImplementationOnce(() => { throw new Error('spawn failed'); });
    expect(kick().skipped).toEqual([ref]); expect(kick().started).toEqual([ref]);
  });

  it('retains a failed worker marker to bound retries until it becomes stale', () => {
    const f = fixture(), spawnFn = vi.fn(() => ({ unref() {} }));
    kickAutoRebase({ ...f, lost: [overlay], spawnFn });
    removeOverlay(f.root, ref, { env: f.env }); // fail before git, network, or Codex is consulted
    const args = spawnFn.mock.calls[0][1];
    const worker = spawnSync(process.execPath, args, { env: f.env, encoding: 'utf8', timeout: 20_000 });
    expect(worker.status).toBe(1);
    expect(kickAutoRebase({ ...f, lost: [overlay], spawnFn }).skipped).toEqual([ref]);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it.each(['async spawn', 'sync spawn', 'marker creation'])('alerts in both sinks on %s launch failure', async failure => {
    const f = fixture(), child = new EventEmitter(); child.unref = vi.fn();
    const spawnFn = vi.fn(() => child);
    if (failure === 'sync spawn') spawnFn.mockImplementation(() => { throw new Error('spawn failed'); });
    if (failure === 'marker creation') fs.writeFileSync(pendingDir(f), 'blocked marker directory');
    const result = kickAutoRebase({ ...f, lost: [overlay], spawnFn });
    if (failure === 'async spawn') {
      expect(result.started).toEqual([ref]);
      await Promise.resolve(); child.emit('error', new Error('spawn failed asynchronously'));
      expect(fs.existsSync(join(pendingDir(f), `${encodeURIComponent(ref)}.lock`))).toBe(false);
    } else expect(result.skipped).toEqual([ref]);
    if (failure === 'marker creation') expect(spawnFn).not.toHaveBeenCalled();
    const events = fs.readFileSync(overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(events.filter(e => e.kind === 'auto-rebase-needs-you')).toEqual([
      expect.objectContaining({ ref, stage: 'launch', reason: expect.any(String) }),
    ]);
    expect(JSON.parse(fs.readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim())).toMatchObject({
      kind: 'auto-rebase-needs-you', detail: { ref, stage: 'launch', reason: expect.any(String) },
    });
    expect(readOverlays(f.root, { env: f.env })).toEqual([expect.objectContaining(overlay)]);
  });

  it('does not escalate an active marker as a launch failure', () => {
    const f = fixture(), spawnFn = vi.fn(() => ({ unref() {} }));
    kickAutoRebase({ ...f, lost: [overlay], spawnFn });
    expect(kickAutoRebase({ ...f, lost: [overlay], spawnFn }).skipped).toEqual([ref]);
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(fs.existsSync(alertsFilePath(f.root, f.env))).toBe(false);
  });

  it('merges both parents, tests then audits then registers; only removes old after real HEAD adoption; stack clears hold', async () => {
    const f = fixture();
    const live = await planRebuild({ git: (a, o) => run(a, { cwd: f.root, ...o }), headSha: f.baseSha, mainRef: 'origin/main', overlays: [overlay] });
    f.moveMain();
    const lost = await planRebuild({ git: (a, o) => run(a, { cwd: f.root, ...o }), headSha: live.finalSha, mainRef: 'origin/main', overlays: [overlay] });
    expect(lost.establishedLost.map(o => o.ref)).toEqual([ref]);
    const result = await job(f);
    expect(result.ref).toBe(`${ref}-auto-1`);
    expect(f.calls).toEqual(['codex', 'tests', 'audit', 'add', 'auto-rebase-registered']);
    expect(readOverlays(f.root, { env: f.env })).toEqual(expect.arrayContaining([expect.objectContaining({ ref: result.ref, pr: overlay.pr, reason: `auto-rebase of ${ref}` })]));
    expect(f.scratched.every(p => !fs.existsSync(p))).toBe(true);
    swaps(f); expect(f.calls).not.toContain('remove');
    ok(f.root, ['fetch', 'origin']);
    const plan = await planRebuild({ git: (a, o) => run(a, { cwd: f.root, ...o }), headSha: live.finalSha, mainRef: 'origin/main', overlays: readOverlays(f.root, { env: f.env }), prState: async () => 'OPEN', prBaseChain: async () => ['main'] });
    expect(plan.establishedLost).toEqual([]);
    expect(plan.decisions).toContainEqual(expect.objectContaining({ ref, reason: 'stack-contained' }));
    ok(f.root, ['reset', '--hard', plan.finalSha]); swaps(f);
    expect(f.calls.slice(-2)).toEqual(['remove', 'auto-rebase-swapped']);
    expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toEqual([result.ref]);
    expect(fs.readdirSync(pendingDir(f))).toEqual([]);
  });

  it('selects related tests for a non-conflicting module edited by the fixer', async () => {
    const f = fixture({ extraModule: true }); f.moveMain();
    const resolveConflicts = f.deps.codex;
    f.deps.codex = async options => {
      const result = await resolveConflicts(options);
      write(options.root, 'extra.mjs', 'fixer also changed this module\n');
      return result; // The worker stages this additional edit through git add -A.
    };
    f.deps.testRunner = vi.fn(async ({ root, args }) => {
      expect(args.slice(0, 7)).toEqual(['scripts/readiness/heavy-admission.mjs', 'run', '--wait-ms=540000', '--', 'npx', 'vitest', 'run']);
      expect(args.slice(7).sort()).toEqual(['extra.test.mjs', 'worker.test.mjs']);
      expect(ok(root, ['show', 'HEAD:extra.mjs'])).toBe('fixer also changed this module');
      return { status: 0 };
    });
    await job(f);
    expect(f.deps.testRunner).toHaveBeenCalledOnce();
  });

  it.each(['advanced origin tip', 'failed fetch', 'unreadable tip'])('keeps both registrations and alerts when the pending replacement cannot cover %s', async failure => {
    const f = fixture(); f.moveMain(); const replacement = await job(f);
    ok(f.root, ['fetch', 'origin']); ok(f.root, ['reset', '--hard', replacement.newSha]);
    if (failure === 'advanced origin tip') {
      const author = join(f.base, 'author');
      ok(f.base, ['clone', '-q', '--branch', ref, f.origin, author]);
      write(author, 'worker.mjs', 'new overlay intent\n'); ok(author, ['commit', '-qam', 'old ref advanced']);
      ok(author, ['push', '-q', 'origin', ref]);
      expect(ok(f.root, ['rev-parse', `origin/${ref}`])).toBe(f.oldSha);
    }
    const probe = vi.fn((args, opts) => {
      if (failure === 'failed fetch' && args[0] === 'fetch') return { status: 1 };
      if (failure === 'unreadable tip' && args[0] === 'rev-parse') return { status: 0, stdout: '' };
      return run(args, opts);
    });
    finishPendingSwaps({ root: f.root, env: f.env, run: probe });
    expect(probe).toHaveBeenCalledWith(['fetch', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`], expect.objectContaining({ cwd: f.root }));
    expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toEqual([ref, replacement.ref]);
    expect(fs.readdirSync(pendingDir(f))).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim())).toMatchObject({
      kind: 'auto-rebase-needs-you', detail: { ref, stage: 'swap' },
    });
    const events = fs.readFileSync(overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl'), 'utf8');
    expect(events).toContain('auto-rebase-needs-you'); expect(events).not.toContain('auto-rebase-swapped');
  });

  describe.each(['codex', 'auditor'])('%s JSON report validation', agent => {
    it.each([
      ['nonzero exit', { exitCode: 1 }], ['timeout', { timedOut: true }],
      ['failed terminal', { events: { terminal: 'turn.failed' } }], ['missing terminal', { events: {} }],
      ['missing exit', { exitCode: undefined }], ['malformed JSON', null],
    ])('rejects %s despite wrapper status zero and a success message', async (_label, report) => {
      const f = fixture(); f.moveMain(); const original = f.deps[agent];
      f.deps[agent] = async options => {
        await original(options); // Even a fixer that staged a resolution must prove successful completion.
        return report === null ? { status: 0, stdout: '{' } : agentResult({ lastMessage: 'NOT WEAKENED', ...report });
      };
      await expect(job(f)).rejects.toThrow();
      expect(f.calls).not.toContain('add'); expect(f.calls).toContain('auto-rebase-needs-you');
      if (agent === 'codex') expect(f.deps.testRunner).not.toHaveBeenCalled();
      expect(readOverlays(f.root, { env: f.env })).toEqual([expect.objectContaining(overlay)]);
      expect(ok(f.root, ['ls-remote', 'origin', `${ref}-auto-*`])).toBe('');
      expect(JSON.parse(fs.readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim())).toMatchObject({
        kind: 'auto-rebase-needs-you', detail: { ref, stage: agent === 'codex' ? 'resolve' : 'audit' },
      });
      expect(f.scratched.every(p => !fs.existsSync(p))).toBe(true);
    });
  });

  it('requires the exact auditor message even with a successful report', async () => {
    const f = fixture(); f.moveMain();
    f.deps.auditor = async () => agentResult({ lastMessage: 'NOT WEAKENED\n' });
    await expect(job(f)).rejects.toThrow('audit did not certify NOT WEAKENED');
    expect(f.calls).not.toContain('add'); expect(f.calls).toContain('auto-rebase-needs-you');
  });

  it.each(['disabled', 'missing adoption', 'different adoption', 'interrupted unverified', 'legacy unverified', 'interrupted verified'])(
    'finishes pending swaps only on enabled, recovered, verified HEAD: %s', async scenario => {
      const f = fixture(); f.moveMain(); const replacement = await job(f);
      ok(f.root, ['fetch', 'origin']);
      const prevHead = ok(f.root, ['rev-parse', 'origin/main']);
      ok(f.root, ['reset', '--hard', replacement.newSha]);
      const state = { adopted: { head: replacement.newSha } };
      if (scenario === 'missing adoption') state.adopted = null;
      if (scenario === 'different adoption' || scenario.includes('unverified') || scenario === 'interrupted verified') state.adopted = { head: prevHead };
      if (scenario.startsWith('interrupted')) state.inProgress = {
        target: replacement.newSha, prevHead, startedAt: '1970-01-01T00:00:00.000Z',
        host: 'interrupted-host', verified: scenario === 'interrupted verified',
      };
      if (scenario === 'legacy unverified') state.unverified = { head: replacement.newSha, prevHead };
      writeRebuildState(f.root, state, f.env);
      const observed = [], cleanup = vi.fn(options => {
        const current = readRebuildState(f.root, f.env);
        observed.push({ head: ok(f.root, ['rev-parse', 'HEAD']), adopted: current.adopted?.head, inProgress: current.inProgress, unverified: current.unverified });
        return finishPendingSwaps(options);
      });
      const result = await prepareRebuild({
        root: f.root, env: { ...f.env, WE_DAEMON_AUTO_REBASE: scenario === 'disabled' ? '0' : '1' },
        run, log: {}, now: Date.now, prState: async () => 'OPEN', prBaseChain: async () => null,
        autoRebase: { resolveAutoRebaseSwitch, finishPendingSwaps: cleanup, kickAutoRebase: vi.fn() },
      });
      if (scenario === 'interrupted verified') {
        expect(result.result.reason).toBe('recovered-adopted');
        expect(observed).toEqual([{ head: replacement.newSha, adopted: replacement.newSha, inProgress: null, unverified: null }]);
        expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toEqual([replacement.ref]);
        expect(fs.readdirSync(pendingDir(f))).toEqual([]);
      } else {
        if (scenario.includes('unverified')) {
          expect(result.alerts).toContainEqual(expect.objectContaining({ kind: scenario === 'legacy unverified' ? 'unverified-build-rolled-back' : 'rebuild-interrupted-recovered' }));
          expect(observed).toEqual([{ head: prevHead, adopted: prevHead, inProgress: null, unverified: null }]);
        } else expect(cleanup).not.toHaveBeenCalled();
        expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toEqual([ref, replacement.ref]);
        expect(fs.readdirSync(pendingDir(f))).toHaveLength(1);
      }
    },
  );

  it.each(['codex', 'testRunner', 'auditor', 'ambiguous-audit', 'missing-audit', 'unreadable-graph', 'no-tests', 'oversized-tests'])('fails closed on %s, alerts needs-you, cleans scratch, and leaves old registration', async failure => {
    const f = fixture(); f.moveMain();
    if (failure === 'ambiguous-audit') f.deps.auditor = async () => agentResult({ lastMessage: 'Probably NOT WEAKENED' });
    else if (failure === 'missing-audit') f.deps.auditor = async () => agentResult();
    else if (failure === 'unreadable-graph') f.deps.io.readFileSync = (p, ...args) => { if (p.endsWith('worker.test.mjs')) throw new Error('unreadable test'); return fs.readFileSync(p, ...args); };
    else if (failure === 'no-tests' || failure === 'oversized-tests') {
      const original = f.deps.codex;
      f.deps.codex = async o => {
        const r = await original(o);
        if (failure === 'no-tests') fs.unlinkSync(join(o.root, 'worker.test.mjs'));
        else for (let n = 0; n < 101; n++) write(o.root, `x${n}.test.mjs`, "import './worker.mjs';\n");
        ok(o.root, ['add', '-A']); return r;
      };
    } else f.deps[failure] = async () => ({ status: 1 });
    await expect(job(f)).rejects.toThrow();
    expect(readOverlays(f.root, { env: f.env })).toEqual([expect.objectContaining(overlay)]);
    expect(f.calls).not.toContain('add'); expect(f.calls).toContain('auto-rebase-needs-you');
    const alert = JSON.parse(fs.readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim());
    expect(alert).toMatchObject({ kind: 'auto-rebase-needs-you', detail: { ref } });
    expect(alert.detail.stage).toBeTruthy(); expect(alert.detail.reason).toBeTruthy();
    expect(ok(f.root, ['ls-remote', 'origin', `${ref}-auto-*`])).toBe('');
    expect(f.scratched.every(p => !fs.existsSync(p))).toBe(true);
  });

  it('handles a clean merge without invoking the conflict fixer', async () => {
    const f = fixture(); ok(f.root, ['remote', 'set-url', 'origin', '../origin.git']);
    write(f.root, 'worker.test.mjs', "import './worker.mjs';\n// main improvement\n");
    ok(f.root, ['commit', '-qam', 'main test improvement']); ok(f.root, ['push', 'origin', 'main']);
    await job(f);
    expect(f.deps.codex).not.toHaveBeenCalled();
    expect(f.calls).toEqual(['tests', 'audit', 'add', 'auto-rebase-registered']);
  });

  it('preserves pending evidence when cleanup fails and retries removal after adoption', async () => {
    const f = fixture(); f.moveMain(); const replacement = await job(f);
    ok(f.root, ['fetch', 'origin']); ok(f.root, ['reset', '--hard', replacement.newSha]);
    expect(() => finishPendingSwaps({ root: f.root, env: f.env, run,
      removeOverlay: () => { throw new Error('busy list'); } })).toThrow('busy list');
    expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toContain(ref);
    expect(fs.readdirSync(pendingDir(f))).toHaveLength(1);
    swaps(f); expect(f.calls.slice(-2)).toEqual(['remove', 'auto-rebase-swapped']);
  });

  it('reports cleanup failures while preserving the original registration', async () => {
    const f = fixture(); f.moveMain();
    f.deps.io.rmSync = (p, opts) => { fs.rmSync(p, opts); throw new Error('cleanup failed'); };
    await expect(job(f)).rejects.toThrow('cleanup failed');
    expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toContain(ref);
    expect(JSON.parse(fs.readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim()).detail.stage).toBe('cleanup');
    expect(f.scratched.every(p => !fs.existsSync(p))).toBe(true);
  });

  it('selects the next unused numeric suffix', async () => {
    const f = fixture(); f.moveMain();
    for (const n of [1, 2, 4]) ok(f.root, ['push', 'origin', `${f.oldSha}:refs/heads/${ref}-auto-${n}`]);
    expect((await job(f)).ref).toBe(`${ref}-auto-5`);
  });

  it('pending registrations suppress repeated jobs and unreadable swaps never remove overlays', async () => {
    const f = fixture(); f.moveMain(); await job(f);
    const spawnFn = vi.fn(); expect(kickAutoRebase({ ...f, lost: [overlay], spawnFn }).skipped).toEqual([ref]);
    expect(spawnFn).not.toHaveBeenCalled();
    const file = join(pendingDir(f), fs.readdirSync(pendingDir(f))[0]); fs.writeFileSync(file, '{}');
    expect(() => swaps(f)).toThrow('invalid pending swap'); expect(f.calls).not.toContain('remove');
  });

  it('keeps the terminal hold byte-identical with switch off, and tolerates worker/cleanup failures when enabled', async () => {
    const f = fixture();
    const live = await planRebuild({ git: (a, o) => run(a, { cwd: f.root, ...o }), headSha: f.baseSha, mainRef: 'origin/main', overlays: [overlay] });
    f.moveMain(); ok(f.root, ['reset', '--hard', live.finalSha]);
    writeRebuildState(f.root, { adopted: { head: live.finalSha } }, f.env);
    const kick = vi.fn(() => { throw new Error('unavailable'); });
    const cleanup = vi.fn(() => { throw new Error('unavailable'); });
    const prepare = enabled => prepareRebuild({ root: f.root, env: { ...f.env, WE_DAEMON_AUTO_REBASE: enabled ? '1' : '0' }, run, log: {}, now: Date.now, prState: async () => 'OPEN', prBaseChain: async () => null, autoRebase: { resolveAutoRebaseSwitch: () => ({ enabled, source: 'env' }), kickAutoRebase: kick, finishPendingSwaps: cleanup } });
    const off = await prepare(false);
    expect(off.terminal).toBe(true); expect(off.result.reason).toBe('established-overlay-conflict');
    expect(off.result.detail).not.toHaveProperty('autoRebase'); expect(kick).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    const on = await prepare(true);
    expect(on.result.detail.autoRebase).toEqual({ started: [], skipped: [ref], source: 'env' });
    const { autoRebase, ...unchanged } = on.result.detail; expect(unchanged).toEqual(off.result.detail);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
