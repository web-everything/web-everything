/**
 * @file breaks/await-verify-lane-config-executes.mjs — review finding on PR 4151 (card we:backlog/5137, slices 2+3).
 * The harness's verdict pass re-requests a verify by spawning `verify-lane.mjs request --repo=<lane>` from the fix
 * daemon. The lane is agent-writable and every other daemon-side git call in the pass was already pinned, but that
 * child ran git against the lane with the lane's own `.git/config` in force: a `core.fsmonitor=<cmd>` (or a
 * `diff.external=<cmd>`) set by a compromised or prompt-injected fixer ran inside the daemon, with the host user's
 * credentials, outside the guard-bash sandbox — reachable just by not producing a verify marker.
 *
 * FIX — the child is spawned with the code-executing config keys pinned through git's environment, and its own git
 * helper never runs an external diff / textconv / clean filter (`scripts/lib/lane-git-hardening.mjs`).
 *
 * SCENARIO: a REAL git lane (origin/main + one local commit + a dirty file) whose config names a touch-script as
 * `core.fsmonitor` and `diff.external`, and the tree's own production `rerequest` port. RED = the script ran.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const PASS = 'scripts/conveyor/await-verify-pass.mjs';
const HARDENING = 'scripts/lib/lane-git-hardening.mjs';

export async function replay(root = REPO_ROOT) {
  if (!existsSync(join(root, PASS))) return { harness: false };
  const { defaultAwaitVerifyIo } = await import(pathToFileURL(join(root, PASS)).href);
  const tmp = mkdtempSync(join(tmpdir(), 'soak-await-lanecfg-'));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, maxBuffer: 64 * 1024 * 1024 });
    const id = ['-c', 'user.name=s', '-c', 'user.email=s@s', '-c', 'commit.gpgsign=false'];
    const origin = join(tmp, 'origin.git'); const lane = join(tmp, 'lane');
    git(tmp, ['init', '--bare', '-b', 'main', origin]);
    git(tmp, ['clone', origin, lane]);
    writeFileSync(join(lane, 'a.txt'), 'one\n');
    git(lane, ['add', 'a.txt']); git(lane, [...id, 'commit', '-m', 'one']); git(lane, ['push', 'origin', 'HEAD:main']);
    writeFileSync(join(lane, 'a.txt'), 'one\ntwo\n');
    git(lane, ['add', 'a.txt']); git(lane, [...id, 'commit', '-m', 'two']);
    writeFileSync(join(lane, 'a.txt'), 'one\ntwo\nthree\n'); // dirty: git must consult the index (fsmonitor) and diff (external)
    const driver = join(tmp, 'driver.sh');
    writeFileSync(driver, `#!/bin/sh\ntouch ${join(tmp, 'ran')}-$$\ncat\n`, { mode: 0o755 });
    for (const key of ['core.fsmonitor', 'diff.external', 'filter.x.clean']) git(lane, ['config', key, driver]);
    writeFileSync(join(lane, '.git', 'info', 'attributes'), '* filter=x\n'); // a clean filter cannot be pinned off from the environment

    const io = await defaultAwaitVerifyIo({ weRoot: root, poolRoot: tmp, env });
    const result = io.rerequest(lane);
    return { harness: true, ran: readdirSync(tmp).filter((f) => f.startsWith('ran-')).length, status: result?.status ?? null };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export default {
  id: 'await-verify-lane-config-executes',
  title: 'the harness re-request ran a lane-config command (core.fsmonitor / diff.external) inside the fix daemon',
  card: 'we:backlog/5137 (slices 2+3) — PR 4151 review',
  fixedBy: { sha: '34e05d1bc', where: 'lane/5137-s2-s3', paths: [PASS, 'scripts/verify-lane.mjs'] },
  fixPresent(root) { return existsSync(join(root, HARDENING)); },
  async run({ log } = {}) {
    try {
      const report = await replay();
      log?.(JSON.stringify(report));
      const violations = [];
      if (!report.harness) violations.push({ invariant: 'model-owns-wait', detail: 'no harness verdict pass' });
      else if (report.ran > 0) violations.push({ invariant: 'lane-config-executed', detail: `a lane-config command ran ${report.ran}× during rerequest (status ${report.status})` });
      return { violations, report };
    } catch (e) {
      return { violations: [{ invariant: 'crash', detail: String(e?.stack || e).split('\n').slice(0, 3).join(' ') }] };
    }
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
