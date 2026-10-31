/** PR #5848: detached repairs require executed tests and must respect concurrent operator unloads. */
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAutoRebase, finishPendingSwaps } from '../../../lib/daemon-rebuild/auto-rebase.mjs';
import { addOverlay, removeOverlay, readOverlays, overlayFilePath, persistStackBases } from '../../../lib/daemon-overlays.mjs';

const REPO = resolve(fileURLToPath(import.meta.url), '../../../../..');
const WORKER = 'scripts/lib/daemon-rebuild/auto-rebase.mjs';
const REF = 'lane/fix';
const success = stdout => ({ status: 0, stdout: stdout ?? '' });
const agent = lastMessage => success(JSON.stringify({ exitCode: 0, events: { terminal: 'turn.completed' }, lastMessage }));

// The worker is real; Git is virtual so this probe never mutates repository metadata.
// realRunner exercises Vitest's actual file-filter/exclude behavior with the reported paths.
export async function runTestInventoryCase({ mode = 'excluded', realRunner = false, rewriteBases, pendingFailure } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'soak-auto-inventory-'));
  const root = join(dir, 'clone');
  fs.mkdirSync(root);
  const integration = 'scripts/operations/__tests__/dispatch-spawn-live.test.mjs';
  const unit = 'scripts/operations/__tests__/dispatch-lane-io.test.mjs';
  const files = mode === 'all-excluded' ? [integration] : [integration, unit];
  const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'), WE_DAEMON_STATE_DIR: join(dir, 'state') };
  addOverlay(root, { ref: REF, pr: 123 }, { env });
  let failure, pushed = false, registered = false, audited = false, runnerResult;
  const events = [], scratches = [];
  const deps = {
    io: {
      ...fs,
      mkdtempSync(prefix) { const path = fs.mkdtempSync(prefix); scratches.push(path); return path; },
      writeFileSync: (file, ...args) => {
        if (pendingFailure === 'write' && file.endsWith('.tmp')) throw new Error('pending persistence failed');
        return file.includes('/.git/') ? undefined : fs.writeFileSync(file, ...args);
      },
      renameSync: (from, to) => {
        if (pendingFailure === 'rename' && from.endsWith('.tmp')) throw new Error('pending persistence failed');
        return fs.renameSync(from, to);
      },
      appendFileSync: (file, ...args) => file.includes('/.git/') ? undefined : fs.appendFileSync(file, ...args),
      readFileSync: (file, ...args) => files.some(f => file.endsWith(`/${f}`)) ? '// selected test\n' : fs.readFileSync(file, ...args),
      statSync: file => file.endsWith('/node_modules') ? {} : fs.statSync(file),
      symlinkSync: (_target, link) => realRunner ? fs.symlinkSync(join(REPO, 'node_modules'), link, 'dir') : undefined,
    },
    git(args) {
      if (args[0] === 'remote') return success(root);
      if (args[0] === 'diff') return success(args.includes('--diff-filter=U') ? '' : `${files.join('\0')}\0`);
      if (args[0] === 'ls-tree') return success(`${files.join('\0')}\0`);
      if (args[0] === 'rev-parse') return args.includes('MERGE_HEAD') ? { status: 1 } : success('a'.repeat(40));
      if (args[0] === 'push') pushed = true;
      return success();
    },
    async testRunner({ root: scratch, args }) {
      if (realRunner) {
        for (const file of files) {
          fs.mkdirSync(join(scratch, 'scripts/operations/__tests__'), { recursive: true });
          fs.writeFileSync(join(scratch, file), `import { it, expect } from 'vitest'; it('assertion', () => expect(${file === integration ? 'false' : 'true'}).toBe(true));\n`);
        }
        // Same exclusion as the repository's unit config; no project setup or external state.
        fs.writeFileSync(join(scratch, 'vitest.config.mjs'), `export default { test: { exclude: [${JSON.stringify(integration)}], poolOptions: { threads: { minThreads: 1, maxThreads: 1 } } } };\n`);
        runnerResult = spawnSync(process.execPath, [join(REPO, 'node_modules/vitest/vitest.mjs'), ...args.slice(args.indexOf('--') + 3)], {
          cwd: scratch, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
        });
        return runnerResult;
      }
      const reportArg = args.find(a => a.startsWith('--outputFile.json='));
      if (reportArg && mode !== 'missing') {
        const reported = mode === 'excluded' ? [unit] : mode === 'all-excluded' ? [] : files;
        const report = { testResults: reported.map(file => ({
          name: join(mode === 'wrong-root' ? '/other-clone' : fs.realpathSync(scratch), file),
          assertionResults: mode === 'empty-assertions' ? [] : [{ status: mode === 'unknown-status' ? 'unknown' : mode === 'skipped' && file === integration ? 'pending' : 'passed' }],
        })) };
        fs.writeFileSync(reportArg.slice('--outputFile.json='.length), mode === 'malformed' ? '{' : mode === 'oversized' ? ' '.repeat(8 * 1024 * 1024 + 1) : JSON.stringify(report));
      }
      return { status: mode === 'failed' ? 1 : 0 };
    },
    async auditor() {
      if (rewriteBases === 'audit') persistStackBases(root, new Map([[123, ['lane/base']]]), { env });
      audited = true; return agent('NOT WEAKENED');
    },
    addOverlay(...args) {
      if (rewriteBases === 'register') persistStackBases(root, new Map([[123, ['lane/base']]]), { env });
      const result = addOverlay(...args); registered = true; return result;
    },
    appendOverlayEvent(_root, event) { events.push(event); },
  };
  try {
    try { await runAutoRebase({ root, ref: REF, env, deps }); } catch (error) { failure = error.message; }
    const pending = `${overlayFilePath(root, env)}.auto-rebase`;
    return { failure, pushed, registered, audited, events, runnerResult,
      remaining: fs.existsSync(pending) ? fs.readdirSync(pending) : [],
      overlays: readOverlays(root, { env }).map(o => o.ref),
      cleaned: scratches.every(p => !fs.existsSync(p)),
    };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export default {
  id: 'auto-rebase-operator-withdrawal',
  title: 'a detached repair requires executed tests and respects operator withdrawal',
  card: 'PR #5848 send-back 5726 (selected test execution, detached repair and adoption cleanup)',
  fixedBy: { sha: 'launcher-pending', where: 'lane/loader-auto-rebase-r2', paths: [WORKER, 'scripts/lib/daemon-overlays.mjs'] },
  fixPresent(root) {
    const worker = fs.readFileSync(join(root, WORKER), 'utf8');
    return worker.includes('expectedOverlay: old') && worker.includes('requireRef: swap.new') && worker.includes('alwaysRunInventory');
  },
  async run({ log } = {}) {
    const violations = [];
    for (const rewriteBases of ['audit', 'register']) {
      const result = await runTestInventoryCase({ mode: 'complete', rewriteBases });
      if (result.failure || !result.registered || result.remaining.length !== 1) {
        violations.push({ invariant: 'stack-base-cache-rewrite', detail: `${rewriteBases}: ${JSON.stringify(result)}` });
      }
    }
    for (const pendingFailure of ['write', 'rename']) {
      const result = await runTestInventoryCase({ mode: 'complete', pendingFailure });
      if (result.failure !== 'pending persistence failed' || result.registered || result.overlays.join(',') !== REF || result.remaining.length) {
        violations.push({ invariant: 'pending-persistence', detail: `${pendingFailure}: ${JSON.stringify(result)}` });
      }
    }
    const inventory = await runTestInventoryCase();
    if (!inventory.failure?.includes('selected tests did not execute') || inventory.pushed || inventory.registered || inventory.audited) {
      violations.push({ invariant: 'selected-test-inventory', detail: 'an excluded integration test authorized repair' });
    }
    const operatorRemove = (root, env, ref) => {
      const result = spawnSync(process.execPath, [join(REPO, 'scripts/daemon-overlay.mjs'), 'remove', `--clone=${root}`, `--ref=${ref}`, '--json'], { env, encoding: 'utf8', timeout: 20_000 });
      if (result.status !== 0) throw new Error(`operator remove failed: ${result.stderr}`);
      if (readOverlays(root, { env }).some(o => o.ref === ref)) throw new Error('operator removal did not reach overlay state');
    };
    // Real worker + real list mutex + real operator CLI. Git and agents are injected:
    // no network, repository mutation, Codex or heavy test process is needed for this race.
    for (const phase of ['fixer', 'tests', 'audit', 'push', 'register']) {
      const dir = fs.mkdtempSync(join(tmpdir(), 'soak-auto-withdraw-'));
      const root = join(dir, 'clone');
      fs.mkdirSync(root);
      const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'), WE_DAEMON_STATE_DIR: join(dir, 'state') };
      addOverlay(root, { ref: REF, pr: 123 }, { env });
      let resolved = false, pushed = false, registered = false, failure;
      const withdraw = () => operatorRemove(root, env, REF);
      const deps = {
        io: {
          ...fs,
          // Only virtual repository paths are intercepted; overlay state and evidence use real IO.
          writeFileSync: (file, ...args) => file.includes('/.git/') ? undefined : fs.writeFileSync(file, ...args),
          appendFileSync: (file, ...args) => file.includes('/.git/') ? undefined : fs.appendFileSync(file, ...args),
          readFileSync: (file, ...args) => file.endsWith('/worker.test.mjs') ? "import './worker.mjs';\n" : file.endsWith('/worker.mjs') ? 'export const worker = 1;\n' : fs.readFileSync(file, ...args),
          statSync: file => file.endsWith('/node_modules') ? {} : fs.statSync(file),
          symlinkSync() {},
        },
        git(args) {
          if (args[0] === 'ls-remote') return success();
          if (args[0] === 'remote') return success(root);
          if (['clone', 'fetch', 'checkout', 'add', 'merge-base'].includes(args[0])) return success();
          if (args[0] === 'merge') return { status: 1 };
          if (args[0] === 'diff') return success(args.includes('--diff-filter=U') && resolved ? '' : 'worker.mjs\0');
          if (args[0] === 'ls-tree') return success('worker.mjs\0worker.test.mjs\0');
          if (args[0] === 'rev-parse') return args.includes('MERGE_HEAD') ? { status: 1 } : success((args.includes('origin/main') ? 'c' : resolved ? 'a' : 'b').repeat(40));
          if (args[0] === 'status') return success();
          if (args[0] === 'push') { if (phase === 'push') withdraw(); pushed = true; return success(); }
          throw new Error(`unexpected Git operation: ${args[0]}`);
        },
        async codex() { if (phase === 'fixer') withdraw(); resolved = true; return agent(); },
        async testRunner({ root: scratch, args }) {
          if (phase === 'tests') withdraw();
          const report = args.find(a => a.startsWith('--outputFile.json='));
          fs.writeFileSync(report.slice('--outputFile.json='.length), JSON.stringify({ testResults: [{
            name: join(fs.realpathSync(scratch), 'worker.test.mjs'), assertionResults: [{ status: 'passed' }],
          }] }));
          return success();
        },
        async auditor() { if (phase === 'audit') withdraw(); return agent('NOT WEAKENED'); },
        addOverlay(...args) { if (phase === 'register') withdraw(); return addOverlay(...args); },
        appendOverlayEvent(_root, event) { if (event.kind === 'auto-rebase-registered') registered = true; },
      };
      try {
        try { await runAutoRebase({ root, ref: REF, env, deps }); } catch (error) { failure = error; }
        const pending = `${overlayFilePath(root, env)}.auto-rebase`;
        const swaps = fs.existsSync(pending) ? fs.readdirSync(pending).filter(n => n.endsWith('.json')) : [];
        if (!failure || !/registration.*(unavailable|changed)/i.test(failure.message) || readOverlays(root, { env }).length || registered || swaps.length) {
          violations.push({ invariant: 'operator-withdrawal', detail: `${phase}: rejected=${Boolean(failure)}, registered=${registered}, pending=${swaps.length}, reason=${failure?.message ?? 'none'}` });
        }
        if (!['push', 'register'].includes(phase) && pushed) violations.push({ invariant: 'unnecessary-push', detail: phase });
        log?.(`${phase}: ${failure?.message ?? 'replacement registered'}`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    // Adoption cleanup: the operator withdraws the adopted replacement after cleanup read the list, just before the
    // removal of the original takes the list mutex. The original and the pending evidence must both survive.
    const dir = fs.mkdtempSync(join(tmpdir(), 'soak-auto-withdraw-'));
    try {
      const root = join(dir, 'clone'), next = `${REF}-auto-1`;
      fs.mkdirSync(root);
      const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'), WE_DAEMON_STATE_DIR: join(dir, 'state') };
      addOverlay(root, { ref: REF, pr: 123 }, { env });
      addOverlay(root, { ref: next, pr: 123, stackBases: [REF] }, { env });
      const pending = `${overlayFilePath(root, env)}.auto-rebase`;
      fs.mkdirSync(pending, { recursive: true });
      const oldOverlay = readOverlays(root, { env }).find(o => o.ref === REF);
      fs.writeFileSync(join(pending, `${encodeURIComponent(REF)}.json`), JSON.stringify({ old: REF, oldOverlay, new: next, newSha: 'a'.repeat(40) }));
      finishPendingSwaps({
        root, env,
        run: args => success(args[0] === 'rev-parse' ? 'a'.repeat(40) : ''),
        removeOverlay(r, ref, opts) { operatorRemove(r, env, next); return removeOverlay(r, ref, opts); },
      });
      const kept = readOverlays(root, { env }).map(o => o.ref), swaps = fs.readdirSync(pending).filter(n => n.endsWith('.json'));
      if (!kept.includes(REF) || swaps.length !== 1) {
        violations.push({ invariant: 'cleanup-withdrawal', detail: `registered=[${kept.join(',')}], pending=${swaps.length}` });
      }
      log?.(`cleanup: registered=[${kept.join(',')}], pending=${swaps.length}`);
      // An already absent original completes cleanup without entering the removal writer.
      // Re-register at the next write boundary, whichever path cleanup chooses.
      addOverlay(root, { ref: next, pr: 123, stackBases: [REF] }, { env });
      operatorRemove(root, env, REF);
      let removals = 0, completed = false;
      const registerAgain = () => addOverlay(root, { ref: REF, pr: 999, reason: 'operator re-registration' }, { env });
      finishPendingSwaps({
        root, env,
        run: args => success(args[0] === 'rev-parse' ? 'a'.repeat(40) : ''),
        removeOverlay(r, ref, opts) { removals++; registerAgain(); return removeOverlay(r, ref, opts); },
        appendOverlayEvent(_root, event) {
          if (event.kind === 'auto-rebase-swapped') { registerAgain(); completed = true; }
        },
      });
      const survived = readOverlays(root, { env }).some(o => o.ref === REF && o.pr === 999);
      const remaining = fs.readdirSync(pending).filter(n => n.endsWith('.json')).length;
      if (removals !== 0 || !completed || !survived || remaining !== 0) {
        violations.push({ invariant: 'cleanup-absent-original', detail: `removals=${removals}, completed=${completed}, survived=${survived}, pending=${remaining}` });
      }
      log?.(`absent original: removals=${removals}, completed=${completed}, survived=${survived}, pending=${remaining}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations.map(v => `[${v.invariant}] ${v.detail}`),
};
