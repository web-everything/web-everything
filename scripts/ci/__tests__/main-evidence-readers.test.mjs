// @vitest-environment node
import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { REPO_ROOT } from '../shard-assign.mjs';
import { downloadReports, downloadRuns, expectedUnitShards } from '../refresh-timings.mjs';
it('timings selects full queue/schedule runs past a skipped-success push, for latest and rolling downloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'main-evidence-'));
  const downloads = [];
  const exec = (_, args) => {
    if (args[1] === 'list') return JSON.stringify([
      { databaseId: 103, event: 'push', headBranch: 'main' },
      { databaseId: 102, event: 'schedule', headBranch: 'main' },
      { databaseId: 101, event: 'merge_group', headBranch: 'gh-readonly-queue/main/pr-1', headSha: 'a'.repeat(40) },
    ]);
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'api') { const id = Number(/runs\/(\d+)/.exec(args[1])[1]);
      return JSON.stringify({ total_count: id === 103 ? 0 : expectedUnitShards().length, artifacts: id === 103 ? [] : expectedUnitShards().map(n => ({ name: `timing-unit-${n}`, expired: false })) }); }
    if (args.includes('--pattern=quarantine-reuse-*')) {
      const target = args[args.indexOf('--dir') + 1];
      const jobs = yaml.safeLoad(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')).jobs;
      for (const [suite, job, key] of [['unit', 'test-shard', 'shard'], ['integration', 'integration-part', 'group'], ['soak', 'soak-shard', 'shard']]) {
        for (const id of jobs[job].strategy.matrix[key]) {
          const folder = join(target, `quarantine-reuse-${suite}-${id}`);
          mkdirSync(folder);
          writeFileSync(join(folder, 'quarantine-reuse'), 'unquarantined\n');
        }
      }
      return '';
    }
    if (args[1] === 'download') { downloads.push(args[2]); return ''; }
    throw Error('unexpected IO');
  };
  try {
    await downloadReports('latest', dir, { exec }); expect(downloads).toEqual(['102']);
    downloads.length = 0; await downloadRuns(2, dir, { exec }); expect(downloads).toEqual(['102', '101']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it('timing search refuses an oversized inventory with an explicit-run fallback before downloading', async () => {
  const exec = (_, args) => {
    expect(args[1]).toBe('list');
    return JSON.stringify(Array.from({ length: 101 }, (_, n) => ({ databaseId: n + 1, event: 'push', headBranch: 'main' })));
  };
  await expect(downloadReports('latest', 'unused', { exec })).rejects.toThrow(/supply --run=<id>/);
});

it('timing artifact search stops at twenty reads and names the explicit-run fallback', async () => {
  let reads = 0;
  const exec = (_, args) => {
    if (args[1] === 'list') return JSON.stringify(Array.from({ length: 21 }, (_, n) => ({ databaseId: n + 1, event: 'push', headBranch: 'main' })));
    expect(args[0]).toBe('api'); reads++;
    return JSON.stringify({ total_count: 0, artifacts: [] });
  };
  await expect(downloadReports('latest', 'unused', { exec })).rejects.toThrow(/search bound reached; supply --run=<id>/);
  expect(reads).toBe(20);
});
