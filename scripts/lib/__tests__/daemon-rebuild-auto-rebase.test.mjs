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
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); temps.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });
const run = (args, opts = {}) => spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8', timeout: 20_000, ...opts, env: { ...process.env, ...opts.env } });
const ok = (cwd, args) => { const r = run(args, { cwd }); if (r.status !== 0) throw new Error(`${args}: ${r.stderr}`); return r.stdout.trim(); };
const write = (root, name, text) => { fs.mkdirSync(dirname(join(root, name)), { recursive: true }); fs.writeFileSync(join(root, name), text); };
const ref = 'lane/fix';
const overlay = { ref, pr: 123 };
const agentResult = (report = {}) => ({ status: 0, stdout: JSON.stringify({ exitCode: 0, timedOut: false, events: { terminal: 'turn.completed' }, ...report }) });
function fixture({ extraModule = false, workerTest = true, baseFiles = {}, branchFiles = {}, mainFiles = {}, resolvedFiles = {} } = {}) {
  const base = temp(), root = join(base, 'clone'), origin = join(base, 'origin.git');
  fs.mkdirSync(root); fs.mkdirSync(join(root, 'node_modules'));
  ok(base, ['init', '--bare', '-q', origin]);
  ok(root, ['init', '-q', '-b', 'main']);
  write(root, '.gitignore', 'node_modules/\n');
  write(root, 'worker.mjs', 'base\n');
  if (workerTest) write(root, 'worker.test.mjs', "import './worker.mjs';\n");
  for (const [file, content] of Object.entries(baseFiles)) write(root, file, content);
  if (extraModule) {
    write(root, 'extra.mjs', 'original extra module\n');
    write(root, 'extra.test.mjs', "import './extra.mjs';\n");
  }
  ok(root, ['add', '.']); ok(root, ['commit', '-qm', 'base']);
  ok(root, ['remote', 'add', 'origin', origin]); ok(root, ['push', '-qu', 'origin', 'main']);
  const baseSha = ok(root, ['rev-parse', 'HEAD']);
  ok(root, ['checkout', '-qb', ref]); write(root, 'worker.mjs', 'overlay\n');
  for (const [file, content] of Object.entries(branchFiles)) write(root, file, content);
  if (Object.keys(branchFiles).length) ok(root, ['add', '.']);
  ok(root, ['commit', '-qam', 'hotfix']); ok(root, ['push', '-q', 'origin', ref]);
  const oldSha = ok(root, ['rev-parse', 'HEAD']);
  ok(root, ['checkout', '-q', 'main']);
  const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'), WE_DAEMON_STATE_DIR: join(base, 'state'), WE_PLATFORM_PREFERENCES_FILE: join(base, 'missing'), WE_DAEMON_AUTO_REBASE: '1', WE_DAEMON_REBUILD_SKIP_UNRELATED: '0' };
  addOverlay(root, overlay, { env });
  const moveMain = () => {
    for (const [file, content] of Object.entries(mainFiles)) write(root, file, content);
    if (Object.keys(mainFiles).length) ok(root, ['add', '.']);
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
      for (const [file, content] of Object.entries(resolvedFiles)) {
        write(scratch, file, content); ok(scratch, ['add', file]);
      }
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
const needsYouAlerts = f => fs.readFileSync(alertsFilePath(f.root, f.env), 'utf8')
  .trim().split('\n').map(JSON.parse).filter(e => e.kind === 'auto-rebase-needs-you');
const needsYouAlert = f => {
  const alerts = needsYouAlerts(f);
  expect(alerts).toHaveLength(1);
  return alerts[0];
};
const pendingDir = f => `${overlayFilePath(f.root, f.env)}.auto-rebase`;
const job = f => runAutoRebase({ root: f.root, ref, env: f.env, deps: f.deps });
const swaps = f => finishPendingSwaps({ root: f.root, env: f.env, run,
  removeOverlay: (...args) => { f.calls.push('remove'); return removeOverlay(...args); },
  appendOverlayEvent: (...args) => { f.calls.push(args[1].kind); return appendOverlayEvent(...args); } });

describe('established overlay auto rebase', () => {
  describe('test-selection fallback and durable evidence', () => {
    const records = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    const events = f => records(overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl'));
    const assertRule = (f, result, rule) => {
      expect(events(f).filter(e => e.kind === 'auto-rebase-registered')).toEqual([
        expect.objectContaining({ ref, new: result.ref, rule }),
      ]);
      const pending = fs.readdirSync(pendingDir(f)).filter(n => n.endsWith('.json'));
      expect(pending).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(join(pendingDir(f), pending[0]), 'utf8'))).toMatchObject({
        old: ref, new: result.ref, rule,
      });
    };
    const assertUnregistered = f => {
      expect(f.calls).not.toContain('add');
      expect(events(f).some(e => e.kind === 'auto-rebase-registered')).toBe(false);
      expect(readOverlays(f.root, { env: f.env })).toEqual([expect.objectContaining(overlay)]);
      expect(ok(f.root, ['ls-remote', 'origin', `${ref}-auto-*`])).toBe('');
      expect(fs.existsSync(pendingDir(f)) ? fs.readdirSync(pendingDir(f)).filter(n => n.endsWith('.json')) : []).toEqual([]);
      expect(f.scratched).toHaveLength(1);
      expect(f.scratched.every(p => !fs.existsSync(p))).toBe(true);
    };

    it.each(['added', 'changed'])('runs an overlay-%s test even without an import edge to the uncovered conflict', async kind => {
      const f = fixture({
        baseFiles: { 'uncovered.txt': 'base\n', ...(kind === 'changed' ? { 'branch.test.mjs': '// original test\n' } : {}) },
        branchFiles: { 'uncovered.txt': 'overlay\n', 'branch.test.mjs': '// overlay regression test\n' },
        mainFiles: { 'uncovered.txt': 'main\n' },
        resolvedFiles: { 'uncovered.txt': 'overlay + main\n' },
      });
      f.moveMain();
      f.deps.testRunner = vi.fn(async ({ args }) => {
        expect(args.slice(0, 7)).toEqual(['scripts/readiness/heavy-admission.mjs', 'run', '--wait-ms=540000', '--', 'npx', 'vitest', 'run']);
        expect(args.slice(7).sort()).toEqual(['branch.test.mjs', 'worker.test.mjs']);
        return { status: 0 };
      });
      const result = await job(f);
      expect(f.deps.testRunner).toHaveBeenCalledOnce();
      assertRule(f, result, 'overlay-branch-tests+import-graph');
    });

    it('reaches a main-only test through imports of an overlay-changed source module', async () => {
      const f = fixture({
        baseFiles: {
          'uncovered.txt': 'base\n', 'feature.mjs': 'export const value = 1;\n',
          'bridge.mjs': "export { value } from './feature.mjs';\n",
          'feature.test.mjs': "import './bridge.mjs';\n",
        },
        branchFiles: { 'uncovered.txt': 'overlay\n', 'feature.mjs': 'export const value = 2;\n' },
        mainFiles: { 'uncovered.txt': 'main\n' },
        resolvedFiles: { 'uncovered.txt': 'overlay + main\n' },
      });
      f.moveMain();
      // This module is unchanged by the merge; only the overlay's branch diff identifies it.
      expect(ok(f.root, ['diff', '--name-only', f.baseSha, f.oldSha]).split('\n')).not.toContain('feature.test.mjs');
      f.deps.testRunner = vi.fn(async ({ root, args }) => {
        expect(ok(root, ['show', 'HEAD:feature.mjs'])).toBe('export const value = 2;');
        expect(args.slice(7).sort()).toEqual(['feature.test.mjs', 'worker.test.mjs']);
        return { status: 0 };
      });
      const result = await job(f);
      expect(f.deps.testRunner).toHaveBeenCalledOnce();
      assertRule(f, result, 'overlay-branch-tests+import-graph');
    });

    it('requires a Codex review and registers its rule when there are no tests anywhere', async () => {
      const f = fixture({ workerTest: false }); f.moveMain();
      const result = await job(f);
      expect(f.deps.testRunner).not.toHaveBeenCalled();
      expect(f.deps.auditor).toHaveBeenCalledOnce();
      expect(f.deps.auditor.mock.calls[0][0].args).toContain('--review');
      expect(f.calls).toEqual(['codex', 'audit', 'add', 'auto-rebase-registered']);
      assertRule(f, result, 'codex-audit-required');
    });

    it.each(['WEAKENED', 'Probably NOT WEAKENED', undefined])('refuses empty-fallback registration without an exact audit certification: %s', async lastMessage => {
      const f = fixture({ workerTest: false }); f.moveMain();
      f.deps.auditor = vi.fn(async () => agentResult({ lastMessage }));
      await expect(job(f)).rejects.toThrow(/audit/i);
      expect(f.deps.testRunner).not.toHaveBeenCalled();
      expect(f.deps.auditor).toHaveBeenCalledOnce();
      expect(f.deps.auditor.mock.calls[0][0].args).toContain('--review');
      assertUnregistered(f);
    });

    it.each(['NOT WEAKENED', 'WEAKENED', 'Probably NOT WEAKENED', 'NOT WEAKENED\n', undefined])(
      'requires an exact audit certification when the fixer deletes the only related test: %s', async lastMessage => {
        const f = fixture(); f.moveMain();
        const resolveConflicts = f.deps.codex;
        f.deps.codex = async options => {
          const result = await resolveConflicts(options);
          expect(fs.existsSync(join(options.root, 'worker.test.mjs'))).toBe(true);
          fs.unlinkSync(join(options.root, 'worker.test.mjs'));
          return result;
        };
        f.deps.auditor = vi.fn(async ({ root, args, taskFile }) => {
          expect(args).toContain('--review');
          expect(ok(root, ['ls-files']).split('\n')).not.toContain('worker.test.mjs');
          const task = fs.readFileSync(taskFile, 'utf8');
          // \x3c matches the literal opening angle bracket of each material tag.
          const fencedMaterial = task.match(/\x3cmaterial>\n([\s\S]*?)\n\x3c\/material>/);
          expect(fencedMaterial).not.toBeNull();
          const material = JSON.parse(fencedMaterial[1]);
          expect(material).toMatchObject({
            rule: 'codex-audit-required', noTestFiles: ['worker.mjs', 'worker.test.mjs'],
          });
          return agentResult({ lastMessage });
        });
        if (lastMessage === 'NOT WEAKENED') {
          const result = await job(f);
          assertRule(f, result, 'codex-audit-required');
        } else {
          await expect(job(f)).rejects.toThrow(/audit/i);
          assertUnregistered(f);
          expect(needsYouAlert(f)).toMatchObject({ detail: { ref, stage: 'audit' } });
        }
        expect(f.deps.testRunner).not.toHaveBeenCalled();
        expect(f.deps.auditor).toHaveBeenCalledOnce();
      },
    );

    it.each(['evidence only', 'all alerts'])('fails closed at tests when appending %s fails', async failure => {
      const f = fixture(); f.moveMain();
      const alerts = alertsFilePath(f.root, f.env);
      const error = new Error('injected evidence append failure');
      f.deps.io.appendFileSync = vi.fn((file, data, ...args) => {
        if (file === alerts && (failure === 'all alerts' || JSON.parse(data).kind === 'auto-rebase-evidence')) throw error;
        return fs.appendFileSync(file, data, ...args);
      });
      await expect(job(f)).rejects.toBe(error);
      expect(f.deps.io.appendFileSync).toHaveBeenCalledWith(alerts, expect.stringContaining('auto-rebase-evidence'));
      expect(f.deps.testRunner).not.toHaveBeenCalled();
      expect(f.deps.auditor).not.toHaveBeenCalled();
      expect(events(f).filter(e => e.kind === 'auto-rebase-needs-you')).toEqual([
        expect.objectContaining({ ref, stage: 'tests', reason: error.message }),
      ]);
      if (failure === 'evidence only') expect(needsYouAlert(f)).toMatchObject({
        detail: { ref, stage: 'tests', reason: error.message },
      });
      assertUnregistered(f);
    });

    it.each(['success', 'audit failure'])('persists original conflict markers and noTestFiles before audit, surviving cleanup on %s', async outcome => {
      const f = fixture({ workerTest: false }); f.moveMain();
      let conflicted;
      const resolveConflicts = f.deps.codex;
      f.deps.codex = async options => {
        conflicted = fs.readFileSync(join(options.root, 'worker.mjs'), 'utf8');
        expect(conflicted).toContain('<<<<<<<');
        expect(conflicted).toContain('=======');
        expect(conflicted).toContain('>>>>>>>');
        return resolveConflicts(options);
      };
      const evidence = () => records(alertsFilePath(f.root, f.env)).filter(e => e.kind === 'auto-rebase-evidence');
      const assertEvidence = () => expect(evidence()).toEqual([expect.objectContaining({
        detail: { ref, rule: 'codex-audit-required', noTestFiles: ['worker.mjs'], conflicts: { 'worker.mjs': conflicted } },
      })]);
      f.deps.auditor = vi.fn(async ({ root }) => {
        expect(fs.existsSync(root)).toBe(true);
        assertEvidence();
        return agentResult({ lastMessage: outcome === 'success' ? 'NOT WEAKENED' : 'WEAKENED' });
      });
      if (outcome === 'success') await job(f);
      else await expect(job(f)).rejects.toThrow(/audit/i);
      expect(f.deps.auditor).toHaveBeenCalledOnce();
      expect(f.deps.testRunner).not.toHaveBeenCalled();
      expect(f.scratched).toHaveLength(1);
      expect(f.scratched.every(p => !fs.existsSync(p))).toBe(true);
      assertEvidence();
      if (outcome === 'audit failure') assertUnregistered(f);
    });

    it('caps each persisted conflict at 64KB and retains the audit escalation for oversized evidence', async () => {
      const f = fixture({
        workerTest: false,
        baseFiles: { 'large.txt': 'base\n' },
        branchFiles: { 'large.txt': `${'overlay\n'.repeat(10_000)}` },
        mainFiles: { 'large.txt': `${'main\n'.repeat(15_000)}` },
        resolvedFiles: { 'large.txt': 'overlay + main\n' },
      });
      f.moveMain();
      let conflicted;
      const resolveConflicts = f.deps.codex;
      f.deps.codex = async options => {
        conflicted = fs.readFileSync(join(options.root, 'large.txt'), 'utf8');
        expect(Buffer.byteLength(conflicted)).toBeGreaterThan(64 * 1024);
        return resolveConflicts(options);
      };
      await job(f);
      const evidence = records(alertsFilePath(f.root, f.env)).find(e => e.kind === 'auto-rebase-evidence');
      expect(evidence).toBeDefined();
      expect(evidence.detail.rule).toBe('codex-audit-required');
      expect(evidence.detail.noTestFiles.sort()).toEqual(['large.txt', 'worker.mjs']);
      const captured = evidence.detail.conflicts['large.txt'];
      expect(captured).toBe(conflicted.slice(0, 64 * 1024));
      expect(Buffer.byteLength(captured)).toBeLessThanOrEqual(64 * 1024);
      expect(evidence.detail.conflicts['worker.mjs']).toContain('<<<<<<<');
      expect(f.deps.testRunner).not.toHaveBeenCalled();
      expect(f.deps.auditor).toHaveBeenCalledOnce();
    });

    it('never captures an external secret through a conflicted symlink in alerts', async () => {
      const f = fixture();
      const secret = 'EXTERNAL_SECRET_MUST_NEVER_REACH_ALERTS';
      const external = join(f.base, 'external-secret.txt');
      fs.writeFileSync(external, secret);
      ok(f.root, ['checkout', '-q', ref]);
      fs.symlinkSync(external, join(f.root, 'secret.txt'));
      ok(f.root, ['add', 'secret.txt']); ok(f.root, ['commit', '-qm', 'overlay symlink']);
      ok(f.root, ['push', '-q', 'origin', ref]);
      ok(f.root, ['checkout', '-q', 'main']);
      fs.symlinkSync('main-target.txt', join(f.root, 'secret.txt'));
      ok(f.root, ['add', 'secret.txt']);
      f.moveMain();
      f.deps.io.lstatSync = vi.fn(fs.lstatSync);
      f.deps.io.openSync = vi.fn(fs.openSync);
      const resolveConflicts = f.deps.codex;
      f.deps.codex = async options => {
        const path = join(options.root, 'secret.txt');
        expect(ok(options.root, ['diff', '--name-only', '--diff-filter=U']).split('\n')).toContain('secret.txt');
        expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(path)).toBe(external);
        expect(f.deps.io.lstatSync).toHaveBeenCalledWith(path);
        expect(f.deps.io.openSync.mock.calls.some(([file]) => file === path)).toBe(false);
        fs.unlinkSync(path);
        write(options.root, 'secret.txt', 'resolved\n');
        ok(options.root, ['add', 'secret.txt']);
        return resolveConflicts(options);
      };
      await job(f);
      const alerts = alertsFilePath(f.root, f.env);
      expect(fs.readFileSync(alerts, 'utf8')).not.toContain(secret);
      const evidence = records(alerts).find(e => e.kind === 'auto-rebase-evidence');
      expect(evidence.detail.conflicts).not.toHaveProperty('secret.txt');
      expect(evidence.detail.conflicts['worker.mjs']).toContain('<<<<<<<');
      expect(fs.readFileSync(external, 'utf8')).toBe(secret);
      expect(f.deps.auditor).toHaveBeenCalledOnce();
    });

    it('reads at most 64KB per conflict and closes descriptors after read failure', async () => {
      const f = fixture({
        workerTest: false,
        baseFiles: { 'large.txt': 'base\n' },
        branchFiles: { 'large.txt': 'overlay\n'.repeat(10_000) },
        mainFiles: { 'large.txt': 'main\n'.repeat(15_000) },
        resolvedFiles: { 'large.txt': 'overlay + main\n' },
      });
      f.moveMain();
      const captures = [], descriptors = new Map();
      f.deps.io.openSync = (path, flags) => {
        const fd = fs.openSync(path, flags);
        const capture = { path, flags, fd, reads: [], bytes: 0, closed: false };
        captures.push(capture); descriptors.set(fd, capture);
        return fd;
      };
      f.deps.io.readSync = (fd, buffer, offset, length, position) => {
        const capture = descriptors.get(fd);
        capture.reads.push({ offset, length, position, capacity: buffer.length });
        if (capture.path.endsWith('worker.mjs')) throw new Error('injected read failure');
        const bytes = fs.readSync(fd, buffer, offset, Math.min(length, 4096), position);
        capture.bytes += bytes;
        return bytes;
      };
      f.deps.io.closeSync = vi.fn(fd => {
        descriptors.get(fd).closed = true;
        descriptors.delete(fd);
        fs.closeSync(fd);
      });
      await job(f);
      expect(captures).toHaveLength(2);
      for (const capture of captures) {
        expect(capture.flags).toBe(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        expect(capture.bytes).toBeLessThanOrEqual(64 * 1024);
        expect(capture.closed).toBe(true);
        expect(f.deps.io.closeSync).toHaveBeenCalledWith(capture.fd);
        for (const read of capture.reads) {
          expect(read.capacity).toBe(64 * 1024);
          expect(read.offset + read.length).toBeLessThanOrEqual(64 * 1024);
          expect(read.position + read.length).toBeLessThanOrEqual(64 * 1024);
        }
      }
      const large = captures.find(c => c.path.endsWith('large.txt'));
      expect(large.reads.length).toBeGreaterThan(1);
      expect(large.bytes).toBe(64 * 1024);
      const failed = captures.find(c => c.path.endsWith('worker.mjs'));
      expect(failed.reads).toHaveLength(1);
      expect(descriptors.size).toBe(0);
      const evidence = records(alertsFilePath(f.root, f.env)).find(e => e.kind === 'auto-rebase-evidence');
      expect(Buffer.byteLength(evidence.detail.conflicts['large.txt'])).toBe(64 * 1024);
      expect(evidence.detail.conflicts).not.toHaveProperty('worker.mjs');
      expect(f.deps.testRunner).not.toHaveBeenCalled();
      expect(f.deps.auditor).toHaveBeenCalledOnce();
    });

    it('records related-tests in the registration event and pending swap on the existing path', async () => {
      const f = fixture(); f.moveMain();
      const result = await job(f);
      expect(f.deps.testRunner).toHaveBeenCalledOnce();
      assertRule(f, result, 'related-tests');
    });

    it('records related-tests evidence before a failing test run and never registers a pass', async () => {
      const f = fixture(); f.moveMain();
      f.deps.testRunner = vi.fn(async () => ({ status: 1, stderr: 'regression failed' }));
      await expect(job(f)).rejects.toThrow();
      expect(f.deps.testRunner).toHaveBeenCalledOnce();
      expect(f.deps.auditor).not.toHaveBeenCalled();
      assertUnregistered(f);
      expect(records(alertsFilePath(f.root, f.env))).toContainEqual(expect.objectContaining({
        kind: 'auto-rebase-evidence', detail: expect.objectContaining({ ref, rule: 'related-tests', noTestFiles: [] }),
      }));
    });
  });

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

  it.each(['success', 'failure'])('heartbeats a live worker past marker expiry and clears its unrefed timer on %s', async outcome => {
    const f = fixture(); f.moveMain();
    const spawnFn = vi.fn(() => ({ unref() {} }));
    const kick = () => kickAutoRebase({ ...f, lost: [overlay], spawnFn });
    kick();
    const marker = join(pendingDir(f), `${encodeURIComponent(ref)}.lock`);
    const token = fs.readFileSync(marker, 'utf8');
    vi.useFakeTimers({ now: new Date('2026-10-23T00:00:00.000Z') });
    const start = Date.now();
    fs.utimesSync(marker, new Date(start), new Date(start));
    const touch = vi.fn((...args) => fs.utimesSync(...args));
    f.deps.io.utimesSync = touch;
    const interval = vi.spyOn(globalThis, 'setInterval');
    let release;
    const paused = new Promise(resolve => { release = resolve; });
    const original = f.deps.codex;
    f.deps.codex = async options => {
      await paused;
      if (outcome === 'failure') throw new Error('worker failed');
      return original(options);
    };
    const worker = runAutoRebase({ root: f.root, ref, token, env: f.env, deps: f.deps });
    const completed = outcome === 'failure' ? expect(worker).rejects.toThrow('worker failed') : expect(worker).resolves.toMatchObject({ ref: `${ref}-auto-1` });
    try {
      expect(interval).toHaveBeenCalledWith(expect.any(Function), 60_000);
      expect(interval.mock.results[0].value.hasRef()).toBe(false);
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(touch).toHaveBeenCalledTimes(31);
      expect(fs.statSync(marker).mtimeMs).toBe(start + 31 * 60_000);
      expect(kick().skipped).toEqual([ref]);
      expect(spawnFn).toHaveBeenCalledOnce();
      // A replaced marker belongs to another flight and must never be refreshed.
      fs.writeFileSync(marker, 'another-worker');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(touch).toHaveBeenCalledTimes(31);
    } finally {
      release();
      await completed;
    }
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(touch).toHaveBeenCalledTimes(31);
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
    expect(needsYouAlert(f)).toMatchObject({
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
    expect(needsYouAlert(f)).toMatchObject({
      kind: 'auto-rebase-needs-you', detail: { ref, stage: 'swap' },
    });
    const events = fs.readFileSync(overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl'), 'utf8');
    expect(events).toContain('auto-rebase-needs-you'); expect(events).not.toContain('auto-rebase-swapped');
  });

  it.each(['removed registration', 'corrupt list', 'deleted remote', 'rewound remote', 'rewritten remote', 'failed replacement fetch', 'unreadable replacement tip'])(
    'retains the old registration and pending evidence and alerts in both sinks on %s after adoption', async failure => {
      const f = fixture(); f.moveMain(); const replacement = await job(f);
      ok(f.root, ['fetch', 'origin']); ok(f.root, ['reset', '--hard', replacement.newSha]);
      const listFile = overlayFilePath(f.root, f.env);
      if (failure === 'removed registration') removeOverlay(f.root, replacement.ref, { env: f.env });
      if (failure === 'corrupt list') fs.appendFileSync(listFile, '\n{');
      if (failure === 'deleted remote') ok(f.origin, ['update-ref', '-d', `refs/heads/${replacement.ref}`]);
      if (failure === 'rewound remote' || failure === 'rewritten remote') {
        const tip = failure === 'rewound remote' ? f.oldSha : ok(f.root, ['rev-parse', 'origin/main']);
        ok(f.origin, ['update-ref', `refs/heads/${replacement.ref}`, tip]);
      }
      // Cached origin still passes: only a fresh remote read can detect deletion or rewriting.
      expect(ok(f.root, ['rev-parse', `origin/${replacement.ref}`])).toBe(replacement.newSha);
      const pendingFile = join(pendingDir(f), fs.readdirSync(pendingDir(f))[0]);
      const pending = fs.readFileSync(pendingFile, 'utf8'), list = fs.readFileSync(listFile, 'utf8');
      const remove = vi.fn(), probe = vi.fn((args, opts) => {
        if (failure === 'failed replacement fetch' && args[0] === 'fetch' && args.includes(`+refs/heads/${replacement.ref}:refs/remotes/origin/${replacement.ref}`)) return { status: 1 };
        if (failure === 'unreadable replacement tip' && args[0] === 'rev-parse' && args.includes(`refs/remotes/origin/${replacement.ref}`)) return { status: 0, stdout: '' };
        return run(args, opts);
      });
      finishPendingSwaps({ root: f.root, env: f.env, run: probe, removeOverlay: remove });
      expect(remove).not.toHaveBeenCalled();
      expect(fs.readFileSync(listFile, 'utf8')).toBe(list);
      expect(fs.readFileSync(pendingFile, 'utf8')).toBe(pending);
      if (failure !== 'corrupt list') expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toEqual(
        failure === 'removed registration' ? [ref] : [ref, replacement.ref]);
      const events = fs.readFileSync(listFile.replace(/\.json$/, '.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      expect(events.filter(e => e.kind === 'auto-rebase-needs-you')).toEqual([
        expect.objectContaining({ ref, stage: 'swap', reason: expect.any(String) }),
      ]);
      expect(events.some(e => e.kind === 'auto-rebase-swapped')).toBe(false);
      expect(needsYouAlert(f)).toMatchObject({
        kind: 'auto-rebase-needs-you', detail: { ref, stage: 'swap', reason: expect.any(String) },
      });
    },
  );

  it('finishes a pending swap when the registered remote replacement advances beyond newSha', async () => {
    const f = fixture(); f.moveMain(); const replacement = await job(f);
    ok(f.root, ['fetch', 'origin']); ok(f.root, ['reset', '--hard', replacement.newSha]);
    const author = join(f.base, 'author');
    ok(f.base, ['clone', '-q', '--branch', replacement.ref, f.origin, author]);
    write(author, 'followup.txt', 'replacement advanced\n'); ok(author, ['add', '.']);
    ok(author, ['commit', '-qm', 'replacement followup']); ok(author, ['push', '-q', 'origin', replacement.ref]);
    swaps(f);
    expect(ok(f.root, ['rev-parse', `origin/${replacement.ref}`])).toBe(ok(author, ['rev-parse', 'HEAD']));
    expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toEqual([replacement.ref]);
    expect(fs.readdirSync(pendingDir(f))).toEqual([]);
    expect(f.calls.slice(-2)).toEqual(['remove', 'auto-rebase-swapped']);
    expect(needsYouAlerts(f)).toEqual([]);
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
      expect(needsYouAlert(f)).toMatchObject({
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

  it.each(['codex', 'testRunner', 'auditor', 'ambiguous-audit', 'missing-audit', 'unreadable-graph', 'oversized-tests'])('fails closed on %s, alerts needs-you, cleans scratch, and leaves old registration', async failure => {
    const f = fixture(); f.moveMain();
    if (failure === 'ambiguous-audit') f.deps.auditor = async () => agentResult({ lastMessage: 'Probably NOT WEAKENED' });
    else if (failure === 'missing-audit') f.deps.auditor = async () => agentResult();
    else if (failure === 'unreadable-graph') f.deps.io.readFileSync = (p, ...args) => { if (p.endsWith('worker.test.mjs')) throw new Error('unreadable test'); return fs.readFileSync(p, ...args); };
    else if (failure === 'oversized-tests') {
      const original = f.deps.codex;
      f.deps.codex = async o => {
        const r = await original(o);
        for (let n = 0; n < 101; n++) write(o.root, `x${n}.test.mjs`, "import './worker.mjs';\n");
        ok(o.root, ['add', '-A']); return r;
      };
    } else f.deps[failure] = async () => ({ status: 1 });
    await expect(job(f)).rejects.toThrow();
    expect(readOverlays(f.root, { env: f.env })).toEqual([expect.objectContaining(overlay)]);
    expect(f.calls).not.toContain('add'); expect(f.calls).toContain('auto-rebase-needs-you');
    const alert = needsYouAlert(f);
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
      removeOverlay: () => { throw new Error('busy list'); } })).not.toThrow();
    expect(needsYouAlert(f)).toMatchObject({
      kind: 'auto-rebase-needs-you', detail: { ref, stage: 'swap', reason: 'busy list' },
    });
    expect(fs.readFileSync(overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl'), 'utf8')).toContain('auto-rebase-needs-you');
    expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toContain(ref);
    expect(fs.readdirSync(pendingDir(f))).toHaveLength(1);
    swaps(f); expect(f.calls.slice(-2)).toEqual(['remove', 'auto-rebase-swapped']);
  });

  it.each(['malformed JSON', 'invalid swap', 'null swap', 'invalid SHA type', 'removeOverlay failure'])(
    'reports %s in both sinks, retains its evidence and registration, and still finishes another pending file', failure => {
      const f = fixture(), healthy = 'lane/healthy', replacement = `${healthy}-auto-1`;
      ok(f.root, ['reset', '--hard', f.oldSha]);
      ok(f.root, ['push', '-q', 'origin', `${f.oldSha}:refs/heads/${healthy}`, `${f.oldSha}:refs/heads/${replacement}`]);
      for (const r of [healthy, replacement]) addOverlay(f.root, { ref: r, pr: 456 }, { env: f.env });
      fs.mkdirSync(pendingDir(f), { recursive: true });
      const badFile = join(pendingDir(f), '00-bad.json'), goodFile = join(pendingDir(f), '99-good.json');
      const bad = failure === 'malformed JSON' ? '{' : failure === 'invalid swap' ? '{}' : failure === 'null swap' ? 'null'
        : JSON.stringify({ old: ref, new: replacement, newSha: failure === 'invalid SHA type' ? [f.oldSha] : f.oldSha });
      fs.writeFileSync(badFile, bad);
      fs.writeFileSync(goodFile, JSON.stringify({ old: healthy, new: replacement, newSha: f.oldSha }));
      const remove = vi.fn((root, r, opts) => {
        if (r === ref) throw new Error('busy list');
        return removeOverlay(root, r, opts);
      });
      const event = vi.fn((...args) => appendOverlayEvent(...args));
      expect(() => finishPendingSwaps({ root: f.root, env: f.env, run, removeOverlay: remove, appendOverlayEvent: event })).not.toThrow();
      expect(fs.readFileSync(badFile, 'utf8')).toBe(bad);
      expect(fs.existsSync(goodFile)).toBe(false);
      expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toEqual([ref, replacement]);
      expect(remove.mock.calls.map(c => c[1])).toEqual(failure === 'removeOverlay failure' ? [ref, healthy] : [healthy]);
      const failures = fs.readFileSync(overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl'), 'utf8')
        .trim().split('\n').map(JSON.parse).filter(e => e.kind === 'auto-rebase-needs-you');
      expect(failures).toEqual([expect.objectContaining({
        ref: failure === 'removeOverlay failure' ? ref : '00-bad.json', stage: 'swap', reason: expect.any(String),
      })]);
      const alerts = fs.readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(JSON.parse);
      expect(alerts).toEqual([expect.objectContaining({ kind: 'auto-rebase-needs-you', detail: {
        ref: failures[0].ref, stage: 'swap', reason: failures[0].reason,
      } })]);
      expect(event).toHaveBeenCalledWith(f.root, expect.objectContaining({ kind: 'auto-rebase-swapped', old: healthy }), { env: f.env });
    },
  );

  it('reports cleanup failures while preserving the original registration', async () => {
    const f = fixture(); f.moveMain();
    f.deps.io.rmSync = (p, opts) => { fs.rmSync(p, opts); throw new Error('cleanup failed'); };
    await expect(job(f)).rejects.toThrow('cleanup failed');
    expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toContain(ref);
    expect(needsYouAlert(f).detail.stage).toBe('cleanup');
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
    expect(() => swaps(f)).not.toThrow(); expect(f.calls).not.toContain('remove');
    expect(f.calls).toContain('auto-rebase-needs-you');
    expect(needsYouAlert(f)).toMatchObject({
      kind: 'auto-rebase-needs-you', detail: { stage: 'swap', reason: 'invalid pending swap' },
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('{}');
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
    expect(on.alerts).toContainEqual(expect.objectContaining({
      kind: 'auto-rebase-needs-you', detail: { ref: 'pending-swaps', stage: 'swap', reason: 'unavailable' },
    }));
    const alerts = fs.readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(JSON.parse);
    expect(alerts).toContainEqual(expect.objectContaining({ kind: 'auto-rebase-needs-you', detail: { ref: 'pending-swaps', stage: 'swap', reason: 'unavailable' } }));
    const events = fs.readFileSync(overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'auto-rebase-needs-you', ref: 'pending-swaps', stage: 'swap', reason: 'unavailable' }));
  });
});
