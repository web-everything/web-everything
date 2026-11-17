// @vitest-environment node
import {afterEach, expect, it} from 'vitest';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planArchive} from '../forge-receipts-archive.mjs';
import {sweep} from '../forge-exec-sweep.mjs';

let temp;
afterEach(async () => {
  if (temp) await fs.rm(temp, {recursive: true, force: true});
});

it('installed sweeper replaces the daily cron and preserves archives for the archive retention owner', async () => {
  temp = await fs.mkdtemp(join(tmpdir(), 'forge-receipts-cron-'));
  const root = join(temp, 'exec'), receipts = join(temp, 'receipts');
  await fs.mkdir(root);
  await fs.mkdir(receipts);
  const now = Date.parse('2026-11-20T00:00:00Z') / 1000;
  const archived = 'receipts-2026-11-08.jsonl.gz';
  const expired = 'receipts-2026-10-01.jsonl.gz';
  const retainedArchives = [archived, 'receipts-2026-11-08-1.jsonl.gz', 'receipts-2026-11-08-12.jsonl.gz'];
  const expiredArchives = [expired, 'receipts-2026-10-01-1.jsonl.gz'];
  const loose = ['old.receipt', 'receipts-2026-11-08.jsonl.gz.bak', 'receipts-other.jsonl.gz',
    'receipts-2026-11-08-0.jsonl.gz', 'prefix-receipts-2026-11-08.jsonl.gz'];
  const expiredSweepFiles = ['r-' + 'a'.repeat(32) + '.telemetry', 'r-' + 'b'.repeat(32) + '.consumed'];
  for (const name of [...retainedArchives, ...expiredArchives, ...loose, ...expiredSweepFiles]) {
    await fs.writeFile(join(receipts, name), name);
    await fs.utimes(join(receipts, name), now - 3 * 86400, now - 3 * 86400);
  }
  await fs.writeFile(join(receipts, '.worker-active.writer'), '', {mode: 0o600});
  await fs.writeFile(join(receipts, 'recent.receipt'), 'recent');
  await fs.utimes(join(receipts, 'recent.receipt'), now, now);

  // Setup removes the legacy cron and installs the sweeper, whose receipt
  // allowlist leaves archive retention to forge-receipts-archive.mjs.
  const setup = await fs.readFile(new URL('../forge-setup.sh', import.meta.url), 'utf8');
  expect(setup).toContain('rm -f /etc/cron.daily/forge-exec-prune');
  expect(setup).not.toMatch(/cat\s*>\s*\/etc\/cron\.daily\/forge-exec-prune/);
  expect(setup).toContain('ExecStart=/usr/bin/env node /usr/local/libexec/forge-exec-sweep.mjs --apply');
  expect(setup).toContain('systemctl enable --now forge-exec-sweep.timer');
  const result = await sweep({root, receipts, now: now * 1000, apply: true});
  expect(result.refusals).toEqual([]);
  expect(result.counts.receiptFiles).toBe(expiredSweepFiles.length);
  const remaining = await fs.readdir(receipts);
  for (const name of retainedArchives) expect(remaining).toContain(name);
  // Even expired archives belong to the archive script, whose policy uses the day
  // in the filename rather than the publication mtime.
  for (const name of expiredArchives) expect(remaining).toContain(name);
  expect(remaining).toContain('recent.receipt');
  expect(remaining).toContain('.worker-active.writer');
  for (const name of loose) expect(remaining).toContain(name);
  for (const name of expiredSweepFiles) expect(remaining).not.toContain(name);
  const entries = [...retainedArchives, ...expiredArchives]
    .map(name => ({name, kind: 'file', mtimeMs: (now - 2 * 86400) * 1000}));
  expect(planArchive(entries, now * 1000).deleteArchives).toEqual([...expiredArchives].sort());
  const boundary = Date.parse('2026-12-08T00:00:00Z');
  expect(planArchive(entries, boundary - 1).deleteArchives).toEqual([...expiredArchives].sort());
  expect(planArchive(entries, boundary).deleteArchives)
    .toEqual([...expiredArchives, ...retainedArchives].sort());
});
