/** LANE-POOL-WRONG-REPO: `lane-pool provision --pool=P` run from another repo's checkout cloned that repo into P's lanes. */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATHS = ['scripts/lane-pool.mjs', 'scripts/lib/lane-pool-origin.mjs'];

/** Replays the live case; returns the origin URL of the lane the pool grew for pool "project". */
export function replayPoolOrigin(root = ROOT) {
  const base = mkdtempSync(join(tmpdir(), 'soak-pool-origin-'));
  const git = (args, cwd = base) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const seed = (name) => {
      const remoteDir = join(base, `${name}-remote`);
      mkdirSync(remoteDir);
      // Ordinary forks share a basename; it cannot identify the selected pool's authority.
      const bare = join(remoteDir, 'project.git'), work = join(base, name);
      git(['init', '--quiet', '--bare', '--initial-branch=main', bare]);
      git(['clone', '--quiet', bare, work]);
      writeFileSync(join(work, 'f.txt'), `${name}\n`);
      git(['add', '.'], work);
      git(['-c', 'user.name=T', '-c', 'user.email=t@t.com', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'seed'], work);
      git(['push', '--quiet', 'origin', 'main'], work);
      return bare;
    };
    const poolOrigin = seed('project');
    seed('caller');
    const poolRoot = join(base, 'pool');
    mkdirSync(poolRoot, { recursive: true });
    const r = spawnSync('node', [join(root, 'scripts/lane-pool.mjs'), 'provision', '--pool=project', '--count=1', '--no-install'], {
      cwd: join(base, 'caller'), encoding: 'utf8', timeout: 60000, env: { ...process.env, LANE_POOL_ROOT: poolRoot },
    });
    let lane = null;
    try { lane = git(['remote', 'get-url', 'origin'], join(poolRoot, 'project', 'lane-1')); } catch { /* nothing cloned */ }
    return { lane, poolOrigin, exit: r.status, out: `${r.stdout}${r.stderr}`.slice(-400) };
  } finally { rmSync(base, { recursive: true, force: true }); }
}

export default {
  id: 'lane-pool-wrong-repo-origin',
  title: '--pool=P from another checkout must never clone the caller repo into P\'s lanes',
  card: 'LANE-POOL-WRONG-REPO (plateau-app lanes 5 to 8 were web-everything clones)',
  fixedBy: { sha: '108c8c30c4d', where: 'lane/lane-pool-wrong-repo', paths: PATHS },
  fixPresent(root) {
    // Decided independently of the replayed behaviour: the origin-check module exists and the CLI uses it.
    try {
      const lib = join(root, 'scripts/lib/lane-pool-origin.mjs');
      return existsSync(lib) && /export\s+function\s+originsDiffer\b/.test(readFileSync(lib, 'utf8'))
        && /lane-pool-origin\.mjs/.test(readFileSync(join(root, 'scripts/lane-pool.mjs'), 'utf8'));
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const r = replayPoolOrigin(sourceRoot);
    const { originsDiffer } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/lane-pool-origin.mjs')).href);
    r.homeRelativeDistinct = originsDiffer('alice@host:repo.git', 'bob@host:repo.git')
      && originsDiffer('ssh://alice@host/~/repo.git', 'ssh://bob@host/~/repo.git');
    log?.(`pool=project lane origin=${r.lane} expected=${r.poolOrigin} exit=${r.exit}\n`);
    return r;
  },
  judge: (r) => [
    ...(r.exit === 0 && r.lane === r.poolOrigin ? []
      : [`pool "project" provision exit=${r.exit}, lane origin=${r.lane}; expected exit 0 and the pool origin ${r.poolOrigin}`]),
    ...(r.homeRelativeDistinct ? [] : ['different SSH accounts must not identify the same home-relative repository']),
  ],
};
