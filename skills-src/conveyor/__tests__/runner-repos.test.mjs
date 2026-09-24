import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { makeCliMechanicalPasses } from '../runner.mjs';
import { CONSTELLATION_REPOS } from '../../../scripts/lib/constellation-repos.mjs';
import { readUnsupported, recordUnsupported } from '../../../scripts/conveyor/unsupported-repo.mjs';

const dirs = [];
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
const perRepo = ['reconcile-fix-dispatch', 'parked-pr-conflict-watch', 'advisory-label-sweep', 'review-hold-reconcile', 'parked-pr-progress-watch', 'ci-queue-watch', 'reconcile-pass', 'review-dispatch', 'review-round-tag', 'review-status-tag'];
const once = ['infra-blocked', 'lease-reaper', 'session-reaper', 'branch-drift', 'lane-pool-health-watch', 'duplicate-pr-watch'];
async function sweep(repo = null, fail = null) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-repos-')); dirs.push(dir);
  const unsupportedPath = join(dir, 'unsupported.json');
  const files = new Set();
  const exec = vi.fn((_, args) => {
    const flag = args.find((arg) => arg.startsWith('--prs-file='));
    if (flag) { const file = flag.slice(11); files.add(file); expect(JSON.parse(readFileSync(file))).toEqual([{ number: 7 }]); }
    if (fail?.(args)) throw new Error('unsupported-repo: checkout missing');
    return JSON.stringify({ dispatch: [{ kind: 'review', prNumber: 7 }], refusals: [] });
  });
  const fetchOpenPrs = vi.fn(() => [{ number: 7 }]);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await makeCliMechanicalPasses({ scriptsDir: '/scripts', repo, exec, fetchOpenPrs, unsupportedPath })();
  for (const file of files) expect(existsSync(file)).toBe(false);
  return { exec, fetchOpenPrs, files, stderr, unsupportedPath };
}
it('sweeps all three repo slugs with separate snapshots and runs WE passes once', async () => {
  const { exec, fetchOpenPrs, files } = await sweep();
  expect(fetchOpenPrs.mock.calls).toEqual(Object.values(CONSTELLATION_REPOS).map(({ slug }) => [{ repo: slug }]));
  expect(files.size).toBe(3);
  for (const pass of perRepo) {
    const calls = exec.mock.calls.filter(([, args]) => basename(args[0]) === `${pass}.mjs`);
    expect(calls).toHaveLength(3);
    expect(calls.map(([, args]) => args.find((arg) => arg.startsWith('--repo=')))).toEqual(Object.values(CONSTELLATION_REPOS).map(({ slug }) => `--repo=${slug}`));
  }
  for (const pass of once) expect(exec.mock.calls.filter(([, args]) => basename(args[0]) === `${pass}.mjs`)).toHaveLength(1);
});
it('isolates child failures and records unsupported review work', async () => {
  const { exec, stderr, unsupportedPath } = await sweep(null, (args) => args[0].endsWith('review-dispatch.mjs') && args.includes('--repo=chalbert/frontierui'));
  expect(exec.mock.calls.filter(([, args]) => args[0].endsWith('review-dispatch.mjs'))).toHaveLength(3);
  expect(stderr.mock.calls.flat().join('')).toContain('operations/review-dispatch.mjs [frontierui] failed (non-fatal)');
  expect(readUnsupported({ path: unsupportedPath })).toEqual([expect.objectContaining({ repo: 'frontierui', prNumber: 7, action: 'review' })]);
  recordUnsupported({ repo: 'frontierui', rows: [{ action: 'fix', prNumber: 8 }, { action: 'review', prNumber: 7 }], path: unsupportedPath });
  await makeCliMechanicalPasses({ scriptsDir: '/scripts', repo: 'frontierui', exec: () => JSON.stringify({ dispatch: [], refusals: [] }), fetchOpenPrs: () => [], unsupportedPath })();
  expect(readUnsupported({ path: unsupportedPath })).toEqual([expect.objectContaining({ action: 'fix', prNumber: 8 })]);
});
it('limits an explicit repo and refuses unknown explicit repos', async () => {
  const { exec, fetchOpenPrs } = await sweep('chalbert/frontierui');
  expect(fetchOpenPrs.mock.calls).toEqual([[{ repo: 'chalbert/frontierui' }]]);
  for (const pass of perRepo) expect(exec.mock.calls.filter(([, args]) => basename(args[0]) === `${pass}.mjs`)).toHaveLength(1);
  const unknown = await sweep('other/repo');
  expect(unknown.fetchOpenPrs).not.toHaveBeenCalled();
  for (const pass of perRepo) expect(unknown.exec.mock.calls.filter(([, args]) => basename(args[0]) === `${pass}.mjs`)).toHaveLength(0);
  expect(unknown.stderr.mock.calls.flat().join('')).toContain('unsupported-repo: other/repo');
});
