import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveRequiredCheck, classifyPr, isRequiredCheckGreen, isRequiredCheckFailed,
  planLabelDrain, revalidateForMerge,
} from '../merge-ai-prs.mjs';
import { aiPr } from './fixtures/merge-ai-prs-fixtures.mjs';

const repo = 'web-everything/web-everything';
const sha = '07a3f88b3754b6d514d839a671ca102d770b92d0';
const reviews = (n) => Array.from({ length: n }, () => ({ __typename: 'CheckRun', name: 'review-gate', conclusion: 'SUCCESS' }));
const pr = (statusCheckRollup = reviews(100)) => aiPr({
  number: 3432, headRefOid: sha, headRefName: 'lane/3432', baseRefName: 'main',
  labels: [{ name: 'ready-to-merge' }], statusCheckRollup,
});
const run = (extra = {}) => ({ id: 110975231933, head_sha: sha, name: 'test', status: 'completed', conclusion: 'success', ...extra });
const response = (...pages) => ({ stdout: JSON.stringify(pages.map((check_runs) => ({ check_runs }))) });

describe('required checks beyond the gh listing context cap (#3432)', () => {
  it('makes a PR with exactly 100 contexts and no test merge-eligible from its head check', async () => {
    const listed = pr();
    expect(classifyPr(listed).reason).toBe('required check "test" is not green');
    const exec = vi.fn().mockResolvedValue(response([run()]));
    const resolved = await resolveRequiredCheck(listed, { repo, exec });
    expect(classifyPr(resolved).decision).toBe('merge');
    expect(exec).toHaveBeenCalledWith('gh', ['api',
      `repos/${repo}/commits/${sha}/check-runs?check_name=test&filter=latest&per_page=100`, '--paginate', '--slurp'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(listed.statusCheckRollup).toHaveLength(100);
  });

  it.each([0, 99, 101, 112])('resolves a missing check with %i listed contexts', async (count) => {
    const resolved = await resolveRequiredCheck(pr(reviews(count)), { repo, exec: async () => response([run()]) });
    expect(isRequiredCheckGreen(resolved)).toBe(true);
  });

  it('replaces a visible stale green at the cap with the newest failed REST run across pages', async () => {
    const listed = pr([...reviews(99), { name: 'test', conclusion: 'SUCCESS' }]);
    const resolved = await resolveRequiredCheck(listed, { repo,
      exec: async () => response([run({ id: 200, conclusion: 'failure' })], [run({ id: 100 })]),
    });
    expect(isRequiredCheckFailed(resolved)).toBe(true);
    expect(classifyPr(resolved).decision).toBe('skip');
  });

  it('uses later pages and never substitutes a branch or another repository', async () => {
    const exec = vi.fn().mockResolvedValue(response([], [run({ name: 'unit / test' })]));
    const resolved = await resolveRequiredCheck(pr([]), { repo: 'owner/other', requiredCheck: 'unit / test', exec });
    expect(isRequiredCheckGreen(resolved, 'unit / test')).toBe(true);
    expect(exec.mock.calls[0][1][1]).toBe(`repos/owner/other/commits/${sha}/check-runs?check_name=unit%20%2F%20test&filter=latest&per_page=100`);
  });

  describe('required commit-status (StatusContext) evidence survives the direct read', () => {
    const status = (state) => ({ __typename: 'StatusContext', context: 'test', state });

    it.each([
      ['SUCCESS', isRequiredCheckGreen, isRequiredCheckFailed],
      ['FAILURE', isRequiredCheckFailed, isRequiredCheckGreen],
    ])('keeps a listed %s status when the head has no check-run of that name', async (state, expected, other) => {
      const resolved = await resolveRequiredCheck(pr([...reviews(99), status(state)]), { repo, exec: async () => response([]) });
      expect(resolved.requiredCheckReadError).toBeUndefined();
      expect(expected(resolved)).toBe(true);
      expect(other(resolved)).toBe(false);
    });

    it('still lets a REST check-run outrank a listed status of the same name', async () => {
      const resolved = await resolveRequiredCheck(pr([...reviews(99), status('SUCCESS')]), {
        repo, exec: async () => response([run({ conclusion: 'failure' })]),
      });
      expect(isRequiredCheckFailed(resolved)).toBe(true);
    });

    it('does not carry a listed check-run of that name over the REST read', async () => {
      const resolved = await resolveRequiredCheck(pr([...reviews(98), status('SUCCESS'), { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' }]), {
        repo, exec: async () => response([run({ conclusion: 'failure' })]),
      });
      expect(isRequiredCheckFailed(resolved)).toBe(true);
    });
  });

  it('does not read directly when the required check is present below the cap', async () => {
    const exec = vi.fn();
    const listed = pr([{ name: 'test', conclusion: 'FAILURE' }]);
    expect(await resolveRequiredCheck(listed, { exec })).toBe(listed);
    expect(exec).not.toHaveBeenCalled();
  });

  it('treats a successful empty read as absent, never green or failed', async () => {
    const resolved = await resolveRequiredCheck(pr(), { exec: async () => response([]) });
    expect(resolved.requiredCheckReadError).toBeUndefined();
    expect(isRequiredCheckGreen(resolved)).toBe(false);
    expect(isRequiredCheckFailed(resolved)).toBe(false);
  });

  it.each(['SUCCESS', 'FAILURE'])('defers a failed direct read without trusting listed %s or marking CI red', async (conclusion) => {
    const onDeferred = vi.fn();
    const resolved = await resolveRequiredCheck(pr([...reviews(99), { name: 'test', conclusion }]), {
      repo, exec: async () => { throw new Error('HTTP 503'); }, onDeferred,
    });
    expect(isRequiredCheckGreen(resolved)).toBe(false);
    expect(isRequiredCheckFailed(resolved)).toBe(false);
    const verdict = classifyPr(resolved);
    expect(verdict).toMatchObject({ decision: 'skip', reason: expect.stringContaining('deferred this pass: HTTP 503') });
    expect(onDeferred).toHaveBeenCalledWith(verdict.reason);
    expect(planLabelDrain([verdict])).toMatchObject({ ready: [], deferred: [{ num: 3432, waitOn: ['required-check-read'], reason: verdict.reason }] });
    expect(revalidateForMerge(resolved, { expectedHeadSha: sha }).decision).toBe('skip');
    const retried = await resolveRequiredCheck(resolved, { repo, exec: async () => response([run()]) });
    expect(classifyPr(retried).decision).toBe('merge');
  });

  it.each([
    'not json', '{}', '[]', '[{}]', '{"outcome":"deferred-low-budget"}',
    JSON.stringify([{ check_runs: [run({ head_sha: 'other-head' })] }]),
  ])('defers unusable direct evidence: %s', async (stdout) => {
    const resolved = await resolveRequiredCheck(pr(), { exec: async () => ({ stdout }) });
    expect(resolved.requiredCheckReadError).toContain('direct read failed');
    expect(isRequiredCheckFailed(resolved)).toBe(false);
  });
});

describe('drain CLI required-check fallback wiring', () => {
  let root;
  let bin;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'drain-check-read-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'backlog'));
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const pr = JSON.parse(process.env.CHECK_PR);
let out = [];
if (a[0] === 'repo') out = 'main';
else if (a[0] === 'pr' && a[1] === 'list') out = [pr];
else if (a[0] === 'pr' && a[1] === 'view') out = { commits: pr.commits };
else if (a[0] === 'api' && a[1].includes('/check-runs?')) {
  if (process.env.CHECK_FAIL) { fs.writeSync(2, 'HTTP 503'); process.exit(1); }
  out = [{ check_runs: JSON.parse(process.env.CHECK_RUNS) }];
}
fs.writeSync(1, typeof out === 'string' ? out : JSON.stringify(out));
`, { mode: 0o755 });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const cli = (fail = false) => spawnSync(process.execPath, [
    join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'),
    '--this-repo', '--label=ready-to-merge', '--dry-run', '--json',
    '--no-drain-lease', '--no-red-main-freeze', '--no-rebase-drop', '--no-heal-collision', '--no-review-escalation', '--no-overlap-yield',
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
    LANE_POOL_ROOT: root, CHECK_PR: JSON.stringify(pr()), CHECK_RUNS: JSON.stringify([run()]), CHECK_FAIL: fail ? '1' : '',
  } });

  it('admits the exactly-100-context listing through the real CLI', () => {
    const result = cli();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.toMerge).toEqual([expect.objectContaining({ num: 3432 })]);
    expect(report.skipped).toEqual([]);
  });

  it('logs and defers a failed direct read, with no lifecycle reconciliation or merge', () => {
    const result = cli(true);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.toMerge).toEqual([]);
    expect(report.deferred).toEqual([expect.objectContaining({ num: 3432, waitOn: ['required-check-read'] })]);
    expect(report.reconciledLabels).toEqual([]);
    expect(result.stderr).toContain('direct read failed; deferred this pass');
  });
});
