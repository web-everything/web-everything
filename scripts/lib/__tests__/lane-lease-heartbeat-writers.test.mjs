import { it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withLaneLeaseMutation } from '../lane-lease-lock.mjs';
import { defaultRenewLease as landRenew } from '../../operations/poc-land.mjs';
import { defaultRenewLease as fixRenew } from '../../operations/fix-run.mjs';
import { leasePool } from '../../conveyor/soak/breaks/lease-keeps-while-renewed.mjs';
it.each(['landing', 'fix'])('%s renewal refuses the heartbeat mutation lock without changing the lease', writer => {
  const pool = leasePool();
  try {
    const lease = { session: 'a', holder: 'h', acquiredAt: new Date().toISOString(), ttlMinutes: 240 };
    writeFileSync(pool.marker, JSON.stringify(lease));
    withLaneLeaseMutation(pool.marker, () => {
      const result = writer === 'landing' ? landRenew({ cwd: pool.dir, run: () => ({ status: 0, stdout: pool.dir + '/.git' }) }) : fixRenew({ lanePath: pool.dir, holder: 'h' });
      expect(result).toBe(false);
      expect(JSON.parse(readFileSync(pool.marker))).toEqual(lease);
    });
  } finally { pool.close(); }
});
it('same-session reacquire validates ownership under the mutation lock', () => {
  const pool = leasePool();
  try {
    const lease = { session: 'a', holder: 'h', acquiredAt: new Date().toISOString(), ttlMinutes: 240 };
    writeFileSync(pool.marker, JSON.stringify(lease));
    const lockModule = pathToFileURL(resolve('scripts/lib/lane-lease-lock.mjs')).href;
    const preload = `import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { withLaneLeaseMutation } from ${JSON.stringify(lockModule)};
      const original = fs.readFileSync; let changed = false; let reads = 0;
      fs.readFileSync = (file, ...args) => {
        const value = original(file, ...args);
        if (!changed && String(file) === ${JSON.stringify(pool.marker)} && new Error().stack.split(String.fromCharCode(10)).some(line => line.startsWith('    at withLaneLeaseMutation ('))) {
          changed = true; reads += 1;
          try { withLaneLeaseMutation(file, () => { fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(value), workerSession: 'replacement-worker' })); fs.writeFileSync(${JSON.stringify(pool.base + '/race-won')}, 'won'); }); }
          catch (e) { if (e.code !== 'ELEASEBUSY') throw e; }
        }
        return value;
      }; process.on('exit', () => fs.writeFileSync(${JSON.stringify(pool.base + '/reads')}, String(reads))); syncBuiltinESMExports();`;
    pool.env.NODE_OPTIONS = '--import=data:text/javascript,' + encodeURIComponent(preload);
    const result = pool.run('acquire', '--session=a', '--no-reset', '--no-reap');
    expect(result.status, result.stderr).toBe(0);
    expect(Number(readFileSync(pool.base + '/reads', 'utf8'))).toBe(1);
    expect(JSON.parse(readFileSync(pool.marker)).workerSession).toBeUndefined();
    // The competitor must have been excluded, rather than overwritten after its write.
    expect(existsSync(pool.base + '/race-won')).toBe(false);
  } finally { pool.close(); }
});
