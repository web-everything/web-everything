/** A heavy-admission kill gets one fresh attempt before operator escalation. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { addOverlay } from '../../../lib/daemon-overlays.mjs';
const SOURCE = 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs';
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const FILE = 'worker.test.mjs';

export default {
  id: 'overlay-main-sync-killed-run-cause',
  title: 'a killed overlay test chunk retries once with fresh evidence and proceeds when green',
  card: 'overlay main-sync killed-run cause and retry',
  fixedBy: { sha: 'pending', where: 'lane/overlay-main-sync-killed-run-cause', paths: [SOURCE] },
  fixPresent(root) {
    // Run the actual scenario against the requested tree: source text cannot prove the retry works.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { default: scenario } = await import(process.argv[1]);
      const report = await scenario.run({ sourceRoot: process.argv[2] });
      process.exitCode = scenario.judge(report).length ? 1 : 0;
    `, import.meta.url, root], { cwd: root, env: process.env, encoding: 'utf8',
      timeout: 30_000, maxBuffer: 1024 * 1024 });
    return !probe.error && probe.status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) {
    const { runOverlayMainSync, VITEST_INVENTORY_MARK = '' } = await import(pathToFileURL(join(sourceRoot, SOURCE)).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-main-sync-killed-run-'));
    const root = join(dir, 'daemon'), origin = join(dir, 'origin.git'), ref = 'lane/killed-run';
    const env = { ...process.env, TMPDIR: dir, WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'),
      WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_EVENTS: join(dir, 'events.jsonl'),
      WE_NEEDS_YOU_FEED: join(dir, 'needs-you.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(dir, 'missing') };
    const git = (args, opts = {}) => spawnSync('git',
      ['-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', ...args],
      { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, ...opts });
    const ok = args => {
      const result = git(args);
      if (result.status !== 0) throw new Error(`killed-run scenario Git failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    const violations = [], events = [], overlayEvents = [], reports = [];
    let testCalls = 0, pushes = 0;
    try {
      mkdirSync(root); mkdirSync(join(root, 'node_modules'));
      ok(['init', '-q', '-b', 'main']);
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
      writeFileSync(join(root, 'worker.mjs'), 'export default 0;\n');
      ok(['add', '.']); ok(['commit', '-qm', 'base']);
      ok(['checkout', '-qb', ref]);
      writeFileSync(join(root, FILE), "import './worker.mjs';\n");
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
      let failure, result;
      try {
        result = await runOverlayMainSync({ root, ref, env, deps: {
          git: (args, opts) => {
            // Both heads already exist locally. Never fetch or publish from the replay.
            if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
            if (args[0] === 'push') { pushes++; return { status: 0, stdout: '', stderr: '' }; }
            return git(args, opts);
          },
          appendDaemonEvent: event => { events.push(event); },
          appendOverlayEvent: (_root, event) => { overlayEvents.push(event); },
          // Vitest inventory: the committed overlay test is runnable, so selection reaches the runner below.
          testListRunner: (_command, _args, { cwd }) => ({ status: 0,
            stdout: `\n${VITEST_INVENTORY_MARK}${JSON.stringify([join(realpathSync(cwd), FILE)])}\n`, stderr: '' }),
          testRunner: async ({ root: scratch, testReport }) => {
            testCalls++; reports.push(testReport);
            if (testCalls === 1) return { status: 124, stdout: '',
              stderr: 'heavy-command admission: run exceeded 480000ms and was stopped.\n'
                + '(node:123) [DEP0040] DeprecationWarning: punycode is deprecated\n'.repeat(30) };
            writeFileSync(testReport, JSON.stringify({ testResults: [{
              name: join(realpathSync(scratch), FILE), assertionResults: [{ status: 'passed' }],
            }] }));
            return { status: 0, stdout: '', stderr: '' };
          },
        } });
      } catch (error) { failure = error; }
      if (failure || !result?.pushed) violations.push(`killed-once run did not proceed: ${failure?.message ?? 'no publication'}`);
      if (testCalls !== 2 || new Set(reports).size !== 2) violations.push('expected exactly two attempts with distinct report paths');
      if (pushes !== 1) violations.push('expected exactly one publication after the green retry');
      if (events.some(event => event.kind === 'overlay-main-sync-failed')) violations.push('green retry emitted failure');
      const retry = overlayEvents.filter(event => event.kind === 'overlay-main-timeout-retried');
      if (retry.length !== 1 || retry[0].ref !== ref || retry[0].files !== 1) violations.push('missing retry event with ref and files count');
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
