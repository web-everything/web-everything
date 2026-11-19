// @vitest-environment node
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { netDiffFingerprint } from '../net-diff-fingerprint.mjs';
import { contributionPatchId } from '../rebase-verdict-carry.mjs';
import { checkCanonicalAuditForOpen } from '../../operations/canonical-audit-gate.mjs';
import { QUESTION_HASH } from '../../operations/codex-audit.mjs';
import { createReviewJobIo } from '../../operations/review-job.mjs';
import { computeNetDiffChangedFiles, computeNetDiffText, resolveNetDiffBasis } from '../../merge-ai-prs.mjs';

// Expose the nested review-job proof callback without running settlement's label/comment effects.
vi.mock('../red-team-carry-io.mjs', () => ({ createRedTeamCarryIo: options => options }));
vi.mock('../red-team-skip-outcome.mjs', async importOriginal => ({
  ...await importOriginal(), settleRedTeamSkip: input => input.io.carry,
}));

let repo, base, head, alternate;
const hostile = () => ({ ...process.env, GIT_NO_REPLACE_OBJECTS: undefined,
  GIT_GRAFT_FILE: 'forged-grafts', GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.commitGraph', GIT_CONFIG_VALUE_0: 'true' });
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'carry-proof-hardening-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  const commit = text => {
    writeFileSync(join(repo, 'code.txt'), text);
    git('add', 'code.txt'); git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', text);
    return git('rev-parse', 'HEAD');
  };
  base = commit('base\n'); head = commit('head\n'); alternate = commit('alternate\n');
  git('update-ref', 'refs/remotes/origin/main', base);
  git('update-ref', 'refs/remotes/origin/proof', head);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function reader() {
  const calls = [];
  return { calls, exec(file, args, options) {
    calls.push({ file, args, options });
    // No network: all objects and tracking refs are already present in the fixture.
    if (args.includes('fetch')) return '';
    return execFileSync(file, args, { ...options, cwd: repo });
  } };
}
function hardened(calls) {
  expect(calls.length).toBeGreaterThan(0);
  for (const { file, options: { env } } of calls) {
    expect(file).toBe('git');
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe('1');
    expect(env.GIT_GRAFT_FILE).toBe('/dev/null');
    const pins = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) =>
      [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    expect(pins.filter(([key]) => key === 'core.commitGraph').at(-1)).toEqual(['core.commitGraph', 'false']);
  }
}

it.each([undefined, '0'])('netDiffFingerprint hardens every reader call with replacement override %s', replace => {
  const io = reader();
  expect(netDiffFingerprint(repo, base, head, { exec: io.exec, env: { ...hostile(), GIT_NO_REPLACE_OBJECTS: replace } })).toMatch(/^[a-f0-9]{64}$/);
  expect(io.calls).toHaveLength(4);
  hardened(io.calls);
});

it('canonical audit hardens its git runner and nested fingerprint reader', () => {
  const io = reader(), env = { ...hostile(), HOME: repo, WE_PLATFORM_PREFERENCES_FILE: join(repo, 'prefs.json') };
  const green = { head, base, questionHash: QUESTION_HASH, at: '2026-11-17T00:00:00Z', verdict: 'NOT WEAKENED', findings: [] };
  const result = checkCanonicalAuditForOpen({ repo, ref: 'lane/proof', sha: head, env, exec: io.exec,
    readFile(path) {
      if (String(path).endsWith('prototype-load.json')) return JSON.stringify({ auditRecordPath: '~/audit.jsonl' });
      if (path === env.WE_PLATFORM_PREFERENCES_FILE) return '{}';
      if (path === join(repo, 'audit.jsonl')) return [green, { ...green, head: alternate, fingerprint: 'd'.repeat(64) }].map(JSON.stringify).join('\n');
      throw Object.assign(Error('absent'), { code: 'ENOENT' });
    },
  });
  expect(result.ok).toBe(true);
  expect(io.calls.some(c => c.args.includes('fetch'))).toBe(true);
  expect(io.calls.some(c => c.args.includes('--is-ancestor'))).toBe(true);
  expect(io.calls.some(c => c.args.includes('diff'))).toBe(true);
  hardened(io.calls);
});

it.each(['basis', 'changed files', 'text', 'shared changed files', 'shared text'])('merge net-diff %s hardens every git call', mode => {
  for (const [key, value] of Object.entries(hostile())) {
    if (key.startsWith('GIT_')) vi.stubEnv(key, value);
  }
  const io = reader(), input = { exec: io.exec, rev: 'proof' };
  if (mode.startsWith('shared')) input.basis = resolveNetDiffBasis(input);
  io.calls.length = 0;
  const result = mode === 'basis' ? resolveNetDiffBasis(input)
    : mode.includes('changed files') ? computeNetDiffChangedFiles({ ...input, baseRev: base })
      : computeNetDiffText({ ...input, pinRev: true });
  expect(result.ok ?? result.scored).toBe(true);
  hardened(io.calls);
});

it('rebase verdict contribution proof hardens all git calls', () => {
  const io = reader();
  expect(contributionPatchId({ exec: io.exec, sha: head, env: hostile() })).toMatch(/^[a-f0-9]{40}$/);
  expect(io.calls.some(c => c.args.includes('patch-id'))).toBe(true);
  hardened(io.calls);
});

it.each(['direct card move', 'settlement card move', 'contribution'])('review-job %s proof hardens caller env', mode => {
  const io = reader();
  // The card proof refuses unreadable evidence; the environment still must be hardened on every attempted read.
  const exec = mode === 'contribution' ? io.exec : (file, args, options) => {
    io.calls.push({ file, args, options }); throw Error('history unavailable');
  };
  const review = createReviewJobIo({ root: repo, env: hostile(), exec });
  if (mode === 'contribution') {
    // This call binds a production lane cwd; the injected reader uses our isolated fixture instead.
    expect(review.contributionPatchId({ sha: head, repo: 'web-everything/web-everything' })).toMatch(/^[a-f0-9]{40}$/);
  } else {
    const move = { fromSha: base, toSha: head, lanePath: repo };
    const result = mode === 'direct card move' ? review.proveCardOnlyHeadMove(move)
      : review.settleRedTeamSkip({ carry: { lanePath: repo } }).proveMove({ ...move, cwd: repo });
    expect(result.ok).toBe(false);
  }
  hardened(io.calls);
});

it('unreadable hardened fingerprint proof fails closed', () => {
  const calls = [];
  expect(netDiffFingerprint(repo, base, head, { env: hostile(), exec(file, args, options) {
    calls.push({ file, args, options }); throw Error('history unavailable');
  } })).toBeNull();
  hardened(calls);
});

it('a real git replace object cannot change netDiffFingerprint', () => {
  const before = netDiffFingerprint(repo, base, head);
  expect(before).toMatch(/^[a-f0-9]{64}$/);
  const originalTree = git('rev-parse', `${head}^{tree}`);
  git('replace', head, alternate);
  try {
    expect(git('rev-parse', `${head}^{tree}`)).not.toBe(originalTree);
    expect(netDiffFingerprint(repo, base, head, { env: hostile() })).toBe(before);
  } finally { git('replace', '-d', head); }
});
