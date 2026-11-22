/** Related tests fit the per-run budget by using small sequential chunks. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { addOverlay } from '../../../lib/daemon-overlays.mjs';
const SOURCE = 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs';
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const FILES = Array.from({ length: 30 }, (_, i) => `worker${i}.test.mjs`);

export default {
  id: 'overlay-main-sync-chunked-run-budget',
  title: '30 overlay tests complete in chunks within the heavy-admission run budget',
  card: 'overlay main-sync chunked run budget',
  fixedBy: { sha: 'pending', where: 'lane/overlay-main-sync-chunked-run-budget', paths: [SOURCE] },
  fixPresent(root) {
    // Run the actual scenario against the requested tree: source text cannot prove chunking completes.
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
    const dir = mkdtempSync(join(tmpdir(), 'soak-main-sync-chunked-budget-'));
    const root = join(dir, 'daemon'), origin = join(dir, 'origin.git'), ref = 'lane/chunked-run-budget';
    const env = { ...process.env, TMPDIR: dir, WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'),
      WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_EVENTS: join(dir, 'events.jsonl'),
      WE_NEEDS_YOU_FEED: join(dir, 'needs-you.jsonl'), WE_OVERLAY_MAIN_SYNC_CHUNK_FILES: '',
      WE_HEAVY_ADMISSION_FAST_MAX_FILES: '30', WE_PLATFORM_PREFERENCES_FILE: join(dir, 'missing') };
    const git = (args, opts = {}) => spawnSync('git',
      ['-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', ...args],
      { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, ...opts });
    const ok = args => {
      const result = git(args);
      if (result.status !== 0) throw new Error(`chunked-run-budget scenario Git failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    const violations = [], events = [], reports = [], chunks = [];
    let testCalls = 0, pushes = 0;
    try {
      mkdirSync(root); mkdirSync(join(root, 'node_modules'));
      ok(['init', '-q', '-b', 'main']);
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
      writeFileSync(join(root, 'worker.mjs'), 'export default 0;\n');
      ok(['add', '.']); ok(['commit', '-qm', 'base']);
      ok(['checkout', '-qb', ref]);
      for (const file of FILES) writeFileSync(join(root, file), "import './worker.mjs';\n");
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
          appendOverlayEvent: () => {},
          // Inventory includes every selected test; the runner models the host per-run budget.
          testListRunner: (_command, _args, { cwd }) => ({ status: 0,
            stdout: `\n${VITEST_INVENTORY_MARK}${JSON.stringify(FILES.map(file => join(realpathSync(cwd), file)))}\n`, stderr: '' }),
          testRunner: async ({ root: scratch, args, testReport }) => {
            testCalls++; reports.push(testReport);
            const files = args.filter(arg => arg.endsWith('.test.mjs'));
            chunks.push(files);
            if (files.length > 10) return { status: 124, stdout: '',
              stderr: 'run exceeded 480000ms and was stopped.' };
            writeFileSync(testReport, JSON.stringify({ testResults: files.map(file => ({
              name: join(realpathSync(scratch), file), assertionResults: [{ status: 'passed' }],
            })) }));
            return { status: 0, stdout: '', stderr: '' };
          },
        } });
      } catch (error) { failure = error; }
      if (failure || !result?.pushed) violations.push(`30-file fixture did not complete: ${failure?.message ?? 'no publication'}`);
      if (testCalls !== 3 || chunks.some(files => files.length !== 10)) violations.push('expected three chunks of ten files');
      if (new Set(chunks.flat()).size !== 30 || result?.tests?.length !== 30) violations.push('not all 30 selected files executed');
      if (new Set(reports).size !== 3) violations.push('chunk reports were not distinct');
      if (pushes !== 1) violations.push('expected exactly one publication after all chunks passed');
      if (events.some(event => event.kind === 'overlay-main-sync-failed')) violations.push('chunked run emitted failure');
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
