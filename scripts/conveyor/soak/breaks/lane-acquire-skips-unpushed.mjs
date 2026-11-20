import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

// Real acquire against a private origin: an unsafe free-list hint must not poison growth.
export async function replay(root = REPO_ROOT) {
  const base = mkdtempSync(join(tmpdir(), 'soak-acquire-unpushed-'));
  try {
    const git = (args, cwd = base) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const reference = join(base, 'reference'), origin = join(base, 'origin.git'), pool = join(base, 'pool');
    const bin = join(base, 'bin'), trace = join(base, 'fetches');
    mkdirSync(reference); mkdirSync(bin); writeFileSync(trace, '');
    git(['init', '-q', '-b', 'main'], reference);
    writeFileSync(join(reference, 'file.txt'), 'base\n'); git(['add', '.'], reference);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], reference);
    git(['clone', '-q', '--bare', reference, origin]);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n` +
      `const cp=require('node:child_process'),fs=require('node:fs'),args=process.argv.slice(2);\n` +
      `if(process.cwd().endsWith('/lane-1')&&args.includes('fetch'))fs.appendFileSync(process.env.SOAK_FETCH_TRACE,'fetch\\n');\n` +
      `process.exit(cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'}).status??1);\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const args = [`--origin=${origin}`, `--reference=${reference}`, '--name=skipsoak', '--branch=main', '--no-install', '--no-reap'];
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SOAK_FETCH_TRACE: trace,
      LANE_POOL_ROOT: pool, LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS: '0', LANE_POOL_NO_RECOVER: '1',
      WE_NEEDS_YOU_FEED: join(base, 'needs-you.jsonl') };
    const cli = argv => spawnSync(process.execPath, [join(root, 'scripts/lane-pool.mjs'), ...argv, ...args], { env, encoding: 'utf8', timeout: 30_000 });
    const provision = cli(['provision', '--count=1']);
    if (provision.status !== 0) throw new Error(`fixture provision: ${provision.stderr}`);
    const dir = join(pool, 'skipsoak', 'lane-1');
    git(['checkout', '-qb', 'local/lane'], dir);
    writeFileSync(join(dir, 'local.txt'), 'never published\n'); git(['add', '.'], dir);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'local work'], dir);
    const head = git(['rev-parse', 'HEAD'], dir);
    const { buildFreeLaneList, writeFreeLaneListAtomic, resolveFreeLaneListPath } = await import(pathToFileURL(join(root, 'scripts/lib/free-lane-list.mjs')));
    const poolDir = join(pool, 'skipsoak');
    writeFreeLaneListAtomic(resolveFreeLaneListPath({ repoName: 'skipsoak', poolDir }), buildFreeLaneList({
      repoName: 'skipsoak', poolDir, writtenAt: Date.now(), lanes: [{ lane: 1, path: dir, head, branch: 'local/lane' }],
    }));
    writeFileSync(trace, '');
    const acquired = cli(['acquire', '--session=soak-picker', '--hard-max=2', '--growth-max-new=1', '--json']);
    let picked = null;
    try { picked = JSON.parse(acquired.stdout).lane; } catch { /* failed acquire is recorded below */ }
    return { code: acquired.status, picked, preserved: git(['rev-parse', 'HEAD'], dir) === head, fetches: readFileSync(trace, 'utf8') };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export default {
  id: 'lane-acquire-skips-unpushed',
  title: 'auto-pick skips unpushed free-list hints without blocking bounded growth',
  card: 'we:lane/autopick-skip-unpushed',
  fixedBy: { sha: 'HEAD', where: 'lane/autopick-skip-unpushed', paths: ['scripts/lane-pool.mjs'] },
  // This regression is always enforced; source text must never turn it into an expected failure.
  fixPresent: () => true,
  run: ({ root = REPO_ROOT } = {}) => replay(root),
  judge: r => [
    ...(r.code === 0 && r.picked === 2 ? [] : ['acquire failed to skip the unsafe hint and grow']),
    ...(r.preserved ? [] : ['unpushed HEAD changed']),
    ...(r.fetches === '' ? [] : ['unsafe hint reached provisioning']),
  ],
};
