// @vitest-environment node
import {afterEach, expect, it} from 'vitest';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {planArchive, runArchive} from '../forge-receipts-archive.mjs';
import {sweep} from '../forge-exec-sweep.mjs';

let temp;
afterEach(async () => {
  if (temp) await fs.rm(temp, {recursive: true, force: true});
});

it.each(['apply', 'dry-run', 'corrupt-readback'])
('preserves a completed run through sweeper then archiver three days later: %s', async mode => {
  temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'forge-retention-run-')));
  const root = join(temp, 'exec'), receipts = join(temp, 'receipts');
  await fs.mkdir(root);
  await fs.mkdir(receipts);
  const run = `r-${'c'.repeat(32)}`, finished = Date.parse('2026-11-10T12:00:00Z');
  await fs.writeFile(join(receipts, `${run}.running`), 'running');
  await fs.writeFile(join(receipts, `${run}.receipt`), 'completed result');
  await fs.rename(join(receipts, `${run}.receipt`), join(receipts, `${run}.consumed`));
  await fs.unlink(join(receipts, `${run}.running`));
  const records = new Map([[`${run}.consumed`, 'completed result'],
    [`${run}.telemetry`, '{"durationMs":123}'], [`${run}.base`, 'base sha']]);
  for (const [name, data] of records) {
    await fs.writeFile(join(receipts, name), data);
    await fs.utimes(join(receipts, name), finished / 1000, finished / 1000);
  }
  const outside = join(temp, `${run}.telemetry`);
  await fs.writeFile(outside, 'outside sentinel');
  await fs.utimes(outside, finished / 1000, finished / 1000);
  const symlink = `${'r-' + 'd'.repeat(32)}.telemetry`;
  await fs.symlink(outside, join(receipts, symlink));
  const now = finished + 3 * 86400000;
  const swept = await sweep({root, receipts, now, apply: true});
  expect(swept.refusals).toEqual([]);
  expect(swept.counts.receiptFiles).toBe(0);
  for (const [name, data] of records) expect(await fs.readFile(join(receipts, name), 'utf8')).toBe(data);
  const io = mode === 'corrupt-readback' ? {...fs, async readFile(path, ...args) {
    if (String(path).endsWith('.jsonl.gz')) return Buffer.from('corrupt readback');
    return fs.readFile(path, ...args);
  }} : fs;
  const archived = await runArchive({root: receipts, now, apply: mode !== 'dry-run', io});
  expect(archived.plan.archive.flatMap(bucket => bucket.files).sort()).toEqual([...records.keys()].sort());
  expect(archived.ok).toBe(mode !== 'corrupt-readback');
  if (mode === 'apply') {
    expect(archived.counts.archivedFiles).toBe(records.size);
    const bytes = await fs.readFile(join(receipts, archived.plan.archive[0].archiveName));
    const restored = gunzipSync(bytes).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    expect(restored).toHaveLength(records.size);
    for (const record of restored) {
      const data = Buffer.from(record.data, 'base64');
      expect(data.toString()).toBe(records.get(record.name));
      expect(record.sha256).toBe(createHash('sha256').update(data).digest('hex'));
      await expect(fs.lstat(join(receipts, record.name))).rejects.toMatchObject({code: 'ENOENT'});
    }
  } else {
    expect(archived.counts.archivedFiles).toBe(0);
    for (const [name, data] of records) expect(await fs.readFile(join(receipts, name), 'utf8')).toBe(data);
    expect((await fs.readdir(receipts)).filter(name => name.endsWith('.jsonl.gz'))).toEqual([]);
  }
  expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel');
  expect((await fs.lstat(join(receipts, symlink))).isSymbolicLink()).toBe(true);
});

it.each(['forge-receipts-archive.mjs', 'forge-exec-sweep.mjs'])
('importing %s from eval or stdin never invokes its CLI', module => {
  const code = `await import(${JSON.stringify(new URL(`../${module}`, import.meta.url).href)}); process.stdout.write('imported\\n');`;
  for (const mode of ['eval', 'stdin']) {
    const child = spawnSync(process.execPath, ['--input-type=module', ...(mode === 'eval' ? ['-e', code] : ['-'])],
      {input: mode === 'stdin' ? code : undefined, encoding: 'utf8', timeout: 10000});
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe('imported\n');
    expect(child.stderr).toBe('');
  }
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

  // Setup removes the legacy cron and installs the sweeper, which leaves
  // all record and archive retention to forge-receipts-archive.mjs.
  const setup = await fs.readFile(new URL('../forge-setup.sh', import.meta.url), 'utf8');
  expect(setup).toContain('rm -f /etc/cron.daily/forge-exec-prune');
  expect(setup).not.toMatch(/cat\s*>\s*\/etc\/cron\.daily\/forge-exec-prune/);
  expect(setup).toContain('ExecStart=/usr/bin/env node /usr/local/libexec/forge-exec-sweep.mjs --apply');
  expect(setup).toContain('systemctl enable --now forge-exec-sweep.timer');
  const result = await sweep({root, receipts, now: now * 1000, apply: true});
  expect(result.refusals).toEqual([]);
  expect(result.counts.receiptFiles).toBe(0);
  const remaining = await fs.readdir(receipts);
  for (const name of retainedArchives) expect(remaining).toContain(name);
  // Even expired archives belong to the archive script, whose policy uses the day
  // in the filename rather than the publication mtime.
  for (const name of expiredArchives) expect(remaining).toContain(name);
  expect(remaining).toContain('recent.receipt');
  expect(remaining).toContain('.worker-active.writer');
  for (const name of loose) expect(remaining).toContain(name);
  for (const name of expiredSweepFiles) expect(remaining).toContain(name);
  const entries = [...retainedArchives, ...expiredArchives]
    .map(name => ({name, kind: 'file', mtimeMs: (now - 2 * 86400) * 1000}));
  expect(planArchive(entries, now * 1000).deleteArchives).toEqual([...expiredArchives].sort());
  const boundary = Date.parse('2026-12-08T00:00:00Z');
  expect(planArchive(entries, boundary - 1).deleteArchives).toEqual([...expiredArchives].sort());
  expect(planArchive(entries, boundary).deleteArchives)
    .toEqual([...expiredArchives, ...retainedArchives].sort());
});
