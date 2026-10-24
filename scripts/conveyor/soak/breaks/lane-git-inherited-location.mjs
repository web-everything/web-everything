/** PR #5806: inherited Git locations must not redirect lane operations into another repository. */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));
const SOURCE = 'scripts/lib/lane-git-hardening.mjs';
export default {
  id: 'lane-git-inherited-location',
  title: 'inherited Git locations cannot redirect lane calls and cleanup discards injected config',
  card: 'PR #5806',
  fixedBy: { sha: '4012fc0ad5b7682f3506531471898d9c8b4af258', where: 'lane/lane-git-diet-cleanup', paths: [SOURCE, 'scripts/lane-pool.mjs'] },
  fixPresent(root) {
    try { return readFileSync(join(root, SOURCE), 'utf8').includes('export function scrubGitLocationEnv('); }
    catch { return false; }
  },
  async run({ log } = {}) {
    const { scrubGitLocationEnv, scrubGitRepoEnv, laneGitHardeningEnv } = await import('../../../lib/lane-git-hardening.mjs');
    const violations = [];
    // Independent inputs: do not derive the attack list from the scrubber's own key list.
    const inherited = { ...process.env, GIT_DIR: join(ROOT, 'nonexistent-soak-git-dir'),
      GIT_WORK_TREE: '/', GIT_INDEX_FILE: '/dev/null', GIT_OBJECT_DIRECTORY: '/dev/null',
      GIT_REFERENCE_BACKEND: 'reftable', GIT_REF_PARANOIA: '0',
      GIT_CONFIG_PARAMETERS: "'soak.parameter=inherited'", GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'soak.counted', GIT_CONFIG_VALUE_0: 'inherited' };
    for (const [name, scrub, keepsConfig] of [['lane', scrubGitLocationEnv, true], ['cleanup', scrubGitRepoEnv, false]]) {
      try {
        const env = laneGitHardeningEnv(scrub(inherited));
        const git = (args) => execFileSync('git', ['--no-optional-locks', ...args],
          { cwd: ROOT, env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== ROOT) violations.push(`${name}: repository redirected`);
        const config = git(['config', '--list']);
        for (const key of ['soak.parameter', 'soak.counted']) {
          if (config.includes(`${key}=inherited`) !== keepsConfig) violations.push(`${name}: wrong inherited config policy for ${key}`);
        }
        if (env.GIT_REFERENCE_BACKEND !== undefined || env.GIT_REF_PARANOIA !== '1') violations.push(`${name}: unsafe ref environment`);
        // A second scrub must retain the repository protection.
        const again = laneGitHardeningEnv(scrub(env));
        if (again.GIT_DIR !== undefined || again.GIT_REF_PARANOIA !== '1') violations.push(`${name}: retry lost repository protection`);
      } catch { violations.push(`${name}: read-only Git probe failed`); }
    }
    log?.(`lane Git environment replay: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
