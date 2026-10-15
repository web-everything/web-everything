
import { it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

it.each([false, true])('scrubs and journals a claimed lane (no-reset=%s)', noReset => {
  const base = mkdtempSync(join(tmpdir(), 'pool-config-scrub-'));
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    const origin = join(base, 'origin.git'), reference = join(base, 'reference'), pool = join(base, 'pool');
    git(['init', '--quiet', '--bare', '--initial-branch=trunk', origin]);
    git(['clone', '--quiet', origin, reference]);
    git(['config', 'user.email', 'test@example.com'], reference);
    git(['config', 'user.name', 'Test'], reference);
    writeFileSync(join(reference, 'file.txt'), 'seed');
    git(['add', '.'], reference);
    git(['commit', '--quiet', '-m', 'seed'], reference);
    git(['push', '--quiet', origin, 'HEAD:refs/heads/lane/seed'], reference);
    git(['update-ref', 'refs/heads/trunk', 'refs/heads/lane/seed'], origin);
    const args = [`--origin=${origin}`, `--reference=${reference}`, '--name=scrub', '--branch=trunk', '--no-install'];
    const run = extra => spawnSync('node', [resolve('scripts/lane-pool.mjs'), ...extra, ...args], {
      encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: pool },
    });
    const provision = run(['provision', '--count=1']);
    expect(provision.status, provision.stderr).toBe(0);
    const lane = join(pool, 'scrub', 'lane-1');
    git(['remote', 'add', 'primary', reference], lane);
    const acquire = run(['acquire', '--lane=1', '--session=scrub-test', ...(noReset ? ['--no-reset'] : [])]);
    expect(acquire.status, acquire.stderr).toBe(0);
    expect(acquire.stdout.trim()).toBe(lane);
    expect(git(['remote'], lane)).toBe('origin');
    const events = readFileSync(join(pool, 'scrub', '.lane-journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(events.find(e => e.action === 'config-scrub')).toMatchObject({ removed: ['remote.primary.url'], kept: ['remote.origin.url'] });
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 60000);
