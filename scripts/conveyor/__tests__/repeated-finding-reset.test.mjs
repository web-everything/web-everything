import { it, expect } from 'vitest';
import { repeatedFindingPlan, applyScopeReset, resolveFixSafety } from '../repeated-finding-reset.mjs';
const c = (body, login = 'chalbert') => ({ author: { login }, body });
const finding = text => c(`🔁 review — changes requested\nRecorded by agent\n### Findings (1)\n**correctness/bug** (1)\n- \`a.mjs:10\` — ${text}`, 'web-everything');
const comments = [finding('Same   BUG'), c('🔓 conveyor fix-end'), finding('same bug')];
it('stands down on the second identical finding after a fix, without a baseline', () => {
  expect(repeatedFindingPlan(comments)).toMatchObject({ action: 'stand-down', reason: 'repeated finding' });
});
it('requires an operator baseline and ignores line movement and whitespace', () => {
  const baseline = 'a'.repeat(40);
  expect(repeatedFindingPlan([...comments, c(`scope-baseline: ${baseline}`, 'stranger')]).action).toBe('stand-down');
  expect(repeatedFindingPlan([c(`scope-baseline: ${baseline}`), ...comments])).toMatchObject({ action: 'reset', baseline });
  expect(repeatedFindingPlan([finding('same bug'), finding('same bug')]).action).toBe('patch');
});
it('defaults both safety switches on and records sources', () => {
  expect(resolveFixSafety({ env: {}, tool: {}, platform: {} })).toMatchObject({ value: { alertAtRoundCap: true, resetOnRepeatedFinding: true } });
});
it('refuses reset before mutations when scope or history is unknown', () => {
  const calls = [];
  expect(() => applyScopeReset({ baseline: 'a'.repeat(40), scope: [], git: (...args) => calls.push(args) })).toThrow();
  expect(calls).toEqual([]);
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishAttention, replay } from '../../operations/needs-you-feed.mjs';
it('real reset removes scope creep, preserves later scoped commits and published ancestry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-reset-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q'); writeFileSync(join(dir, 'main-file'), 'main\n'); commit(); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(dir, 'allowed'), 'baseline\n'); const baseline = commit();
    writeFileSync(join(dir, 'creep'), 'outside scope\n'); commit();
    writeFileSync(join(dir, 'allowed'), 'later scoped improvement\n'); const originalHead = commit();
    const laneBranch = git('branch', '--show-current');
    git('checkout', '-qb', 'advanced-main', 'origin/main');
    writeFileSync(join(dir, 'main-file'), 'new main content\n'); commit();
    git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('checkout', '-q', laneBranch);
    const result = applyScopeReset({ baseline, scope: ['allowed'], git });
    expect(result.replay).toHaveLength(1);
    expect(readFileSync(join(dir, 'allowed'), 'utf8')).toBe('later scoped improvement\n');
    expect(existsSync(join(dir, 'creep'))).toBe(false);
    expect(readFileSync(join(dir, 'main-file'), 'utf8')).toBe('new main content\n');
    expect(git('rev-parse', 'HEAD')).toBe(originalHead);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('refuses non-main merges before changing the index or worktree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-reset-merge-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (file, text) => { writeFileSync(join(dir, file), text); git('add', file); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q', '-b', 'main'); commit('main-file', 'main\n');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-qb', 'lane'); const baseline = commit('allowed', 'baseline\n');
    git('checkout', '-qb', 'side'); commit('side-file', 'side work\n');
    git('checkout', '-q', 'lane'); commit('allowed', 'later scoped work\n');
    git('merge', '--no-ff', '--no-edit', 'side');
    const snapshot = () => ({ head: git('rev-parse', 'HEAD'), index: readFileSync(join(dir, '.git/index')),
      status: git('status', '--porcelain=v1', '--untracked-files=all'),
      files: ['main-file', 'allowed', 'side-file'].map(file => readFileSync(join(dir, file))) });
    const before = snapshot(), mutations = [];
    const run = (...args) => { if (['read-tree', 'cherry-pick'].includes(args[0])) mutations.push(args); return git(...args); };
    expect(() => applyScopeReset({ baseline, scope: ['allowed'], git: run })).toThrow('non-main merge needs operator');
    expect(mutations).toEqual([]);
    expect(snapshot()).toEqual(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('publishes caps during quiet hours once, retaining the opening time for morning idle duration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-feed-')), path = join(dir, 'events.jsonl');
  const event = { repo: 'owner/repo', pr: 5403, head: 'a'.repeat(40), kind: 'at-round-limit', reason: 'round cap exhausted' };
  try {
    publishAttention(event, { path, now: '2026-10-16T03:00:00Z' });
    publishAttention(event, { path, now: '2026-10-16T11:00:00Z' });
    expect(replay({ path })).toEqual([expect.objectContaining({ at: '2026-10-16T03:00:00.000Z', pr: 5403 })]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('does not conflate changed lenses, files, or long claims with matching prefixes', () => {
  const long = 'x'.repeat(230);
  for (const second of [finding('same bug').body.replace('correctness/bug', 'security/bug'),
    finding('same bug').body.replace('a.mjs:10', 'b.mjs:10'), finding(`${long} changed`).body]) {
    const first = second.includes(long) ? finding(`${long} original`) : finding('same bug');
    expect(repeatedFindingPlan([first, c('🔓 conveyor fix-end'), c(second, 'web-everything')]).action).toBe('patch');
  }
});
it('the reset switch and environment provenance are honored', () => {
  expect(repeatedFindingPlan(comments, { enabled: false }).action).toBe('patch');
  const policy = resolveFixSafety({ env: { WE_FIX_RESET_ON_REPEATED_FINDING: 'false' }, tool: {}, platform: {} });
  expect(policy.value.resetOnRepeatedFinding).toBe(false);
  expect(policy.sources.resetOnRepeatedFinding).toBe('env');
});
