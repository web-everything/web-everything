import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pinDeveloperDir } from '../lane-git-hardening.mjs';

// Exercise the CLI's actual reader and history traversal without dispatching its top-level command.
const source = readFileSync(resolve('scripts/lane-pool.mjs'), 'utf8');
const section = source.slice(source.indexOf('export const HOST_WIDE_GIT_FAILURE_PATTERNS'), source.indexOf('function requireReadableLaneHistory'));
const load = new Function('join', 'readFileSync', 'unlinkSync', 'git', 'laneDir', 'journalLaneEvent', 'releaseEvidenceEnv',
  section.replaceAll('export ', '') + '; return { historyQuarantine, isHostWideGitFailure, HOST_WIDE_GIT_FAILURE_PATTERNS };');
const env = pinDeveloperDir({ ...process.env });
const git = (args, cwd, opts = {}) => execFileSync('git', args, {
  cwd, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...opts,
}).trim();
let root, repo, dir, file, evidence, journal, api;
beforeEach(() => {
  root = mkdtempSync(join(process.env.TMPDIR, 'quarantine-host-'));
  repo = { poolDir: join(root, 'pool') };
  dir = join(repo.poolDir, 'lane-1');
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(['init', '-q', '--initial-branch=main'], seed);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'seed'], seed);
  mkdirSync(repo.poolDir);
  git(['clone', '-q', '--no-hardlinks', seed, dir], root);
  mkdirSync(join(repo.poolDir, '.quarantine-state'));
  file = join(repo.poolDir, '.quarantine-state', 'lane-1.json');
  evidence = file.replace('.json', '.evidence.jsonl');
  writeFileSync(evidence, 'original evidence\n');
  journal = vi.fn();
  api = load(join, readFileSync, unlinkSync, git, (r, n) => join(r.poolDir, `lane-${n}`), journal, () => env);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function record(reason = 'history unreadable after two probes', firstError = 'You have not agreed to the Xcode license agreements') {
  const value = { lane: 1, reason, firstError, at: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(value));
  return value;
}
it('releases a license-text quarantine only after git and healthy clone history pass; keeps evidence and journals', () => {
  record();
  expect(api.historyQuarantine(repo, 1)).toBeNull();
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(evidence, 'utf8')).toBe('original evidence\n');
  expect(journal).toHaveBeenCalledWith(dir, expect.objectContaining({ action: 'quarantine-auto-released' }));
});
it('keeps a license-text quarantine when a history object is missing', () => {
  const saved = record();
  const sha = git(['rev-parse', 'HEAD'], dir);
  unlinkSync(join(dir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)));
  expect(api.historyQuarantine(repo, 1)).toEqual(saved);
  expect(existsSync(file)).toBe(true);
  expect(journal).not.toHaveBeenCalled();
});
it.each(['local history tip missing or not a commit', 'missing objects'])('never releases real corruption even with a healthy clone: %s', reason => {
  const saved = record(reason, reason);
  expect(api.historyQuarantine(repo, 1)).toEqual(saved);
  expect(existsSync(file)).toBe(true);
  expect(journal).not.toHaveBeenCalled();
});
it('keeps quarantine when git --version fails, without probing history', () => {
  const saved = record();
  const failGit = vi.fn(() => { throw Error('exit code 69'); });
  const failing = load(join, readFileSync, unlinkSync, failGit, () => dir, journal, () => env);
  expect(failing.historyQuarantine(repo, 1)).toEqual(saved);
  expect(failGit).toHaveBeenCalledTimes(1);
  expect(failGit).toHaveBeenCalledWith(['--version'], dir);
  expect(existsSync(file)).toBe(true);
});
it.each(['{bad json', '{}', 'null'])('keeps unreadable or incomplete records quarantined: %s', text => {
  writeFileSync(file, text);
  expect(api.historyQuarantine(repo, 1).reason).toMatch(/unreadable/);
  expect(existsSync(file)).toBe(true);
});
it('an absent quarantine is clear', () => {
  expect(api.historyQuarantine(repo, 1)).toBeNull();
});
it.each([
  'exit 69', 'exit status 69', 'status: 69', 'code=69', 'exit code 69',
  'You have not agreed to the Xcode license agreements', 'xcodebuild -license', 'xcode-select',
  'Xcode license', 'Library not loaded', 'dyld: failure', 'No space left on device',
  'Too many open files', 'cannot fork', 'Resource temporarily unavailable',
])('classifies host-wide git failure: %s', text => {
  expect(api.isHostWideGitFailure(text)).toBe(true);
});
it.each(['exit 690', 'local history tip missing or not a commit', 'missing objects', '', 'unknown failure'])('does not classify corruption or unknown failure: %s', text => {
  expect(api.isHostWideGitFailure(text)).toBe(false);
});
