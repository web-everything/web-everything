/** PR #5848: the detached repair must respect an operator's concurrent unload. */
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAutoRebase, finishPendingSwaps } from '../../../lib/daemon-rebuild/auto-rebase.mjs';
import { addOverlay, removeOverlay, readOverlays, overlayFilePath } from '../../../lib/daemon-overlays.mjs';

const REPO = resolve(fileURLToPath(import.meta.url), '../../../../..');
const WORKER = 'scripts/lib/daemon-rebuild/auto-rebase.mjs';
const REF = 'lane/fix';
const success = stdout => ({ status: 0, stdout: stdout ?? '' });
const agent = lastMessage => success(JSON.stringify({ exitCode: 0, events: { terminal: 'turn.completed' }, lastMessage }));

export default {
  id: 'auto-rebase-operator-withdrawal',
  title: 'a detached repair never re-registers an overlay removed by the operator',
  card: 'PR #5848 send-back x1b8hlo items 1 and 2 (detached repair, then adoption cleanup)',
  fixedBy: { sha: 'launcher-pending', where: 'lane/loader-auto-rebase-r2', paths: [WORKER, 'scripts/lib/daemon-overlays.mjs'] },
  fixPresent(root) {
    const worker = fs.readFileSync(join(root, WORKER), 'utf8');
    return worker.includes('expectedOverlay: old') && worker.includes('requireRef: swap.new');
  },
  async run({ log } = {}) {
    const violations = [];
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
        async testRunner() { if (phase === 'tests') withdraw(); return success(); },
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
      fs.writeFileSync(join(pending, `${encodeURIComponent(REF)}.json`), JSON.stringify({ old: REF, new: next, newSha: 'a'.repeat(40) }));
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
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations.map(v => `[${v.invariant}] ${v.detail}`),
};
