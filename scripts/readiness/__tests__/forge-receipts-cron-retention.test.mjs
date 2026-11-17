// @vitest-environment node
import {afterEach, expect, it} from 'vitest';
import * as fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planArchive} from '../forge-receipts-archive.mjs';

let temp;
afterEach(async () => {
  if (temp) await fs.rm(temp, {recursive: true, force: true});
});

it('installed daily cron preserves receipt archives for the archive retention owner', async () => {
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
  for (const name of [...retainedArchives, ...expiredArchives, ...loose]) {
    await fs.writeFile(join(receipts, name), name);
    await fs.utimes(join(receipts, name), now - 2 * 86400, now - 2 * 86400);
  }
  await fs.writeFile(join(receipts, 'recent.receipt'), 'recent');
  await fs.utimes(join(receipts, 'recent.receipt'), now, now);

  // Execute the actual installed cron body with only its roots and clock redirected.
  const setup = await fs.readFile(new URL('../forge-setup.sh', import.meta.url), 'utf8');
  const body = setup.match(/<<'PRUNE_PY'\n([\s\S]*?)\nPRUNE_PY/)[1]
    .replace("root, receipts = '/srv/forge-exec', '/srv/forge-receipts'",
      'root, receipts = sys.argv[1:3]')
    .replace('now = time.time()', 'now = float(sys.argv[3])');
  const result = spawnSync('python3', ['-I', '-c', body, root, receipts, String(now)],
    {encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024});
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const remaining = await fs.readdir(receipts);
  for (const name of retainedArchives) expect(remaining).toContain(name);
  // Even expired archives belong to the archive script, whose policy uses the day
  // in the filename rather than the publication mtime used by this daily cron.
  for (const name of expiredArchives) expect(remaining).toContain(name);
  expect(remaining).toContain('recent.receipt');
  expect(remaining).toContain('.worker-active.writer');
  for (const name of loose) expect(remaining).not.toContain(name);
  const entries = [...retainedArchives, ...expiredArchives]
    .map(name => ({name, kind: 'file', mtimeMs: (now - 2 * 86400) * 1000}));
  expect(planArchive(entries, now * 1000).deleteArchives).toEqual([...expiredArchives].sort());
  const boundary = Date.parse('2026-12-08T00:00:00Z');
  expect(planArchive(entries, boundary - 1).deleteArchives).toEqual([...expiredArchives].sort());
  expect(planArchive(entries, boundary).deleteArchives)
    .toEqual([...expiredArchives, ...retainedArchives].sort());
});
