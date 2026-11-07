/** A long tmp-leak footer must not displace the failed test's stdout identity. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addOverlay } from '../../../lib/daemon-overlays.mjs';
import { runOverlayMainSync } from '../../../lib/daemon-rebuild/overlay-main-sync.mjs';

const SOURCE = 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs';
const FILE = 'worker.test.mjs', TITLE = 'worker > preserves the failing test identity';

export default {
  id: 'overlay-main-sync-tests-stderr-tail',
  title: 'tests-step failure names the failing test ahead of a long tmp-leak stderr footer',
  card: 'overlay main-sync tests-step stderrTail fix',
  fixedBy: { sha: 'ab9738a4bea82c20edd551ba76134fba624a7364', where: 'main', paths: [SOURCE] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('function testStderrTail('); },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-main-sync-tests-stderr-tail-'));
    const root = join(dir, 'daemon'), origin = join(dir, 'origin.git'), ref = 'lane/stderr-tail';
    const env = { ...process.env, TMPDIR: dir, WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'),
      WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_EVENTS: join(dir, 'events.jsonl'),
      WE_NEEDS_YOU_FEED: join(dir, 'needs-you.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(dir, 'missing') };
    const git = (args, opts = {}) => spawnSync('git',
      ['-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', ...args],
      { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, ...opts });
    const ok = args => {
      const result = git(args);
      if (result.status !== 0) throw new Error(`stderr-tail scenario Git failed: ${result.stderr}`);
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
            if (args[0] === 'push') { pushes++; throw new Error('unexpected push'); }
            return git(args, opts);
          },
          appendDaemonEvent: event => { events.push(event); },
          testRunner: async () => {
            testCalls++;
            return { status: 1,
              stdout: `FAIL ${FILE} > ${TITLE}\nAssertionError: expected true to be false\n`,
              stderr: '[tmp-leak] ' + 'temporary directory detail\n'.repeat(100) };
          },
        } });
      } catch (error) { failure = error; }
      if (failure?.step !== 'tests' || testCalls !== 1) violations.push('did not reproduce a tests-step command failure');
      if (pushes) violations.push('failed tests attempted publication');
      const failures = events.filter(event => event.kind === 'overlay-main-sync-failed');
      if (failures.length !== 1) violations.push('expected exactly one overlay-main-sync-failed event');
      const detail = failures[0]?.detail, tail = detail?.stderrTail;
      if (detail?.step !== 'tests' || detail?.ref !== ref || detail?.main !== main) violations.push('failure event lost tests-step context');
      if (typeof tail !== 'string' || !tail.includes(`${FILE} > ${TITLE}`)) violations.push('failure stderrTail lost the failing test identity');
      if (typeof tail !== 'string' || tail.length > 500 || /[\p{Cc}\p{Cf}]/u.test(tail)) violations.push('failure stderrTail is missing, unbounded or unsanitized');
      if (typeof tail !== 'string' || !tail.includes('temporary directory detail')) violations.push('failure stderrTail lost the runner footer');
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
