/** Import-graph selection must intersect the runnable Vitest inventory. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addOverlay } from '../../../lib/daemon-overlays.mjs';
import * as sync from '../../../lib/daemon-rebuild/overlay-main-sync.mjs';
// Absent on trees from before the marked-inventory protocol, which the replay must still be able to load.
const { runOverlayMainSync, VITEST_INVENTORY_MARK = '' } = sync;

const SOURCE = 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs';
const FILE = 'worker.test.mjs', OUTSIDE = 'outside/ignored.test.mjs', EXCLUDED = 'excluded.test.mjs';

export default {
  id: 'overlay-main-sync-unrunnable-selection',
  title: 'main sync filters files outside Vitest include and files in exclude',
  card: 'overlay main-sync runnable test selection',
  fixedBy: { sha: 'working-tree', where: 'lane/overlay-main-sync-unrunnable-selection', paths: [SOURCE] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('async function runnableTestFiles('); },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-main-sync-unrunnable-'));
    const root = join(dir, 'daemon'), origin = join(dir, 'origin.git'), ref = 'lane/unrunnable-selection';
    const env = { ...process.env, TMPDIR: dir, WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'),
      WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_EVENTS: join(dir, 'events.jsonl'),
      WE_NEEDS_YOU_FEED: join(dir, 'needs-you.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(dir, 'missing') };
    const git = (args, opts = {}) => spawnSync('git',
      ['-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', ...args],
      { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, ...opts });
    const ok = args => {
      const result = git(args);
      if (result.status !== 0) throw new Error(`unrunnable-selection scenario Git failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    const violations = [], events = [];
    let testCalls = 0, pushes = 0;
    try {
      mkdirSync(root); mkdirSync(join(root, 'node_modules'));
      ok(['init', '-q', '-b', 'main']);
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
      writeFileSync(join(root, 'worker.mjs'), 'export default 0;\n');
      ok(['add', '.']); ok(['commit', '-qm', 'base']);
      ok(['checkout', '-qb', ref]);
      writeFileSync(join(root, FILE), "import './worker.mjs';\n");
      mkdirSync(join(root, 'outside'));
      writeFileSync(join(root, OUTSIDE), "import '../worker.mjs';\n");
      writeFileSync(join(root, EXCLUDED), "import './worker.mjs';\n");
      ok(['add', '.']); ok(['commit', '-qm', 'overlay test']);
      const tip = ok(['rev-parse', 'HEAD']);
      ok(['checkout', '-q', 'main']);
      writeFileSync(join(root, 'main.mjs'), 'export default 1;\n');
      ok(['add', '.']); ok(['commit', '-qm', 'main advanced']);
      const main = ok(['rev-parse', 'HEAD']);
      ok(['clone', '-q', '--bare', root, origin]);
      ok(['remote', 'add', 'origin', origin]);
      ok(['update-ref', 'refs/remotes/origin/main', main]);
      ok(['update-ref', `refs/remotes/origin/${ref}`, tip]);
      addOverlay(root, { ref }, { env });
      let failure;
      try {
        await runOverlayMainSync({ root, ref, env, deps: {
          git: (args, opts) => {
            // Both heads already exist locally. Never fetch or publish from the replay.
            if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
            if (args[0] === 'push') { pushes++; return { status: 0, stdout: '', stderr: '' }; }
            return git(args, opts);
          },
          appendDaemonEvent: event => { events.push(event); },
          appendOverlayEvent: (_root, event) => { events.push(event); },
          testListRunner: (_command, _args, { cwd }) => ({ status: 0,
            stdout: `\n${VITEST_INVENTORY_MARK}${JSON.stringify([join(realpathSync(cwd), FILE)])}\n`, stderr: '' }),
          testRunner: async ({ root: scratch, args, testReport }) => {
            testCalls++;
            const selected = args.filter(arg => arg.endsWith('.test.mjs'));
            if (selected.join(',') !== FILE) violations.push('runner received files Vitest would not run');
            writeFileSync(testReport, JSON.stringify({ testResults: [{ name: join(realpathSync(scratch), FILE),
              assertionResults: [{ status: 'passed' }] }] }));
            return { status: 0, stdout: '', stderr: '' };
          },
        } });
      } catch (error) { failure = error; }
      if (failure || testCalls !== 1 || pushes !== 1) violations.push('runnable passing selection did not sync exactly once');
      if (!events.some(event => event.kind === 'overlay-main-test-selection' && event.filteredNotRunnable === 2)) {
        violations.push('selection did not log two unrunnable files');
      }
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
