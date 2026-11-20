/** Daemon-spawned Apple git exited 69 (Xcode license) without a Command Line Tools pin. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SOURCE = 'scripts/lib/lane-git-hardening.mjs';

function probe(pinDeveloperDir) {
  const clt = '/Library/Developer/CommandLineTools';
  const violations = [];
  for (const [name, env, installed, expected] of [
    ['unset with CLT installed', {}, true, clt],
    ['existing caller value', { DEVELOPER_DIR: '/caller/developer' }, true, '/caller/developer'],
    ['missing CLT directory', {}, false, undefined],
  ]) {
    try {
      pinDeveloperDir(env, { exists: (path) => installed && path === clt });
      if (env.DEVELOPER_DIR !== expected || (expected === undefined && 'DEVELOPER_DIR' in env)) {
        violations.push(`${name}: incorrect DEVELOPER_DIR`);
      }
    } catch { violations.push(`${name}: helper unavailable or threw`); }
  }
  return violations;
}

export default {
  id: 'daemon-git-developer-dir',
  title: 'daemon git pins installed Command Line Tools, preserves caller intent, and omits missing CLT',
  card: 'PR for lane/git-xcode-hardening',
  fixedBy: { sha: '400aa107c6565a25b3970376dc567620f151bf50', where: 'lane/git-xcode-hardening', paths: [SOURCE] },
  fixPresent(root) {
    try {
      // Execute this tree's helper: a matching export or comment is not evidence of the fix.
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        const { pinDeveloperDir } = await import(pathToFileURL(process.argv[1]).href);
        process.stdout.write(JSON.stringify((${probe.toString()})(pinDeveloperDir)));
      `, resolve(root, SOURCE)], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const violations = JSON.parse(output);
      return Array.isArray(violations) && violations.length === 0;
    } catch { return false; }
  },
  async run({ log } = {}) {
    const { pinDeveloperDir } = await import('../../../lib/lane-git-hardening.mjs');
    const violations = probe(pinDeveloperDir);
    log?.(`daemon git developer directory: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
