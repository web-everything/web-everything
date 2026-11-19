import { it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { daemonAppEnv } from './fixtures/daemon-app-env.mjs';
import { FAKE_GH } from './fixtures/merge-ai-prs-fake-ports.mjs';

it('real reconcile CLI lists the repo once and filters unlabelled candidates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'listing-dedupe-real-'));
  try {
    const bin = join(dir, 'bin'), log = join(dir, 'calls.jsonl');
    mkdirSync(bin); mkdirSync(join(dir, 'backlog'));
    writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const pr = (number, labeled) => ({ number, title: `t${number}`, body: '', headRefName: `lane/${number}-x`,
      headRefOid: `sha${number}`, baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      isDraft: false, files: [], statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }],
      labels: labeled ? [{ name: 'ready-to-merge' }] : [] });
    const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'),
      '--this-repo', '--label=ready-to-merge', '--dry-run', '--no-drain-lease', '--no-red-main-freeze', '--json'], {
      cwd: dir, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, ...daemonAppEnv(dir), PATH: `${bin}:${process.env.PATH}`, GH_CALL_LOG: log,
        GH_FIXTURE_PRS: JSON.stringify([pr(4503, true), pr(4504, false)]) },
    });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(JSON.parse(r.stdout).considered).toBe(1);
    expect(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
