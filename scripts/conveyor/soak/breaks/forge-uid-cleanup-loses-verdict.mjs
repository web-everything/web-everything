/** A slow uid sweep on a loaded Forge must not discard a finished run's verdict, and must still fence the slot. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

// Stubbed uid: `slow` empties after a few polls (a loaded host reaping late); `stuck` never empties.
const PROBE = `import sys, json, time, types, os as real
cfg=json.loads(sys.argv[2]); code=3; calls=[0]
def uid_processes():
    calls[0]+=1
    return {999} if (cfg['mode']=='stuck' or calls[0] < 4) else set()
def waitpid(*a): raise ChildProcessError()
ns=types.SimpleNamespace(**{n:getattr(real,n) for n in dir(real)})
ns.kill=lambda *a:None
ns.waitpid=waitpid
exec(sys.argv[1], {'os':ns,'time':time,'signal':types.SimpleNamespace(SIGKILL=9),'cfg':cfg,'code':code,'children':lambda:set(),'uid_processes':uid_processes})
`;

export function probeUidCleanup(root = REPO_ROOT) {
  // Synchronous for the shared break registry: read the supervisor source in a subprocess.
  const loaded = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(join(root, 'scripts/readiness/forge-exec-run.mjs')).href)}); process.stdout.write(m.supervisorSource);`],
  { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  if (loaded.status !== 0) return { violations: ['supervisor source unreadable'] };
  const supervisorSource = loaded.stdout;
  const start = supervisorSource.includes('verdict_path =') ? supervisorSource.indexOf('verdict_path =') : supervisorSource.indexOf('deadline = time.monotonic()');
  const end = supervisorSource.indexOf("# Read this scope's counters");
  const block = supervisorSource.slice(start, end);
  const scratch = mkdtempSync(join(process.env.TMPDIR, 'soak-forge-uid-'));
  const violations = [];
  try {
    for (const mode of ['slow', 'stuck']) {
      const status = join(scratch, mode + '-status');
      const result = spawnSync('python3', ['-I', '-c', PROBE, block, JSON.stringify({ mode, status, cleanupWaitMs: mode === 'stuck' ? 300 : 5000 })], { encoding: 'utf8', timeout: 8000 });
      const verdict = existsSync(status + '.verdict') ? readFileSync(status + '.verdict', 'utf8') : null;
      if (verdict !== '3') violations.push(`${mode}: verdict not persisted before the uid sweep`);
      if (mode === 'slow' && (result.status !== 0 || existsSync(status + '.unsafe'))) violations.push('slow: a late-reaping uid was treated as unsafe');
      if (mode === 'stuck' && (result.status === 0 || !existsSync(status + '.unsafe'))) violations.push('stuck: an unconfirmed uid was not fenced');
    }
    return { violations };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export default {
  id: 'forge-uid-cleanup-loses-verdict',
  title: 'a slow Forge uid sweep keeps the run verdict and still fences the slot',
  card: 'Forge exit 124 / uid cleanup unconfirmed, 2026-11-19',
  fixedBy: { sha: 'HEAD', where: 'working tree', paths: ['scripts/readiness/forge-exec-run.mjs'] },
  fixPresent(root) { return probeUidCleanup(root).violations.length === 0; },
  async run() { return probeUidCleanup(); },
  judge: report => report.violations,
};
