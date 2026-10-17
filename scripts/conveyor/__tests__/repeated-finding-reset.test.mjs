import { it, expect } from 'vitest';
import { repeatedFindingPlan, applyScopeReset, resolveFixSafety } from '../repeated-finding-reset.mjs';
import { buildFixEndComment } from '../fix-procedure.mjs';
const c = (body, login = 'chalbert') => ({ author: { login }, body });
const finding = text => c(`🔁 review — changes requested\nRecorded by agent\n### Findings (1)\n**correctness/bug** (1)\n- \`a.mjs:10\` — ${text}`, 'web-everything');
const comments = [finding('Same   BUG'), c('🔓 conveyor fix-end'), finding('same bug')];
it('review regressions: infrastructure-stalled fixes remain eligible for repair', () => {
  for (const prefix of [[], [c(`scope-baseline: ${'a'.repeat(40)}`)]]) {
    const history = [...prefix, finding('same bug'),
      c(buildFixEndComment({ who: 'fix-7', infraStall: true })), finding('same bug')];
    expect(repeatedFindingPlan(history).action).toBe('patch');
    expect(repeatedFindingPlan([...history, c(buildFixEndComment({ who: 'fix-8' })),
      finding('same bug')]).action).toBe(prefix.length ? 'reset' : 'stand-down');
  }
});
it('review regressions: complete summaries distinguish findings containing em dashes', () => {
  for (const prefix of [[], [c(`scope-baseline: ${'a'.repeat(40)}`)]]) {
    for (const separator of [' — ', '\n', '\r\n', '\n\n', '\u2028', '\u2029', ' — detail — ',
      '\n### Detail\n', '\n---\n', '\nNet basis: ', '\n### Findings (1)\n', '\n- `extra.mjs:20` — ']) {
      const first = `ID validation is wrong${separator}whitespace-only IDs are accepted`;
      const second = `ID validation is wrong${separator}valid Unicode IDs are rejected`;
      expect(repeatedFindingPlan([...prefix, finding(first),
        c(buildFixEndComment({ who: 'fix-7' })), finding(second)]).action).toBe('patch');
      expect(repeatedFindingPlan([...prefix, finding(first),
        c(buildFixEndComment({ who: 'fix-7' })), finding(first)]).action).toBe(prefix.length ? 'reset' : 'stand-down');
    }
  }
});
it('preserves source line movement without erasing coordinates embedded in an ambiguous summary', () => {
  const end = c(buildFixEndComment({ who: 'fix-7' }));
  expect(repeatedFindingPlan([finding('same bug'), end,
    c(finding('same bug').body.replace('a.mjs:10', 'a.mjs:99'), 'web-everything')]).action).toBe('stand-down');
  expect(repeatedFindingPlan([finding('same prefix\n- `extra.mjs:20` — same suffix'), end,
    finding('same prefix\n- `extra.mjs:21` — same suffix')]).action).toBe('patch');
  const withFilelessFinding = line => c(finding(`same prefix\n- \`extra.mjs:${line}\` — same suffix`).body
    .replace('Findings (1)', 'Findings (2)') + '\n- fileless finding', 'web-everything');
  expect(repeatedFindingPlan([withFilelessFinding(20), end, withFilelessFinding(21)]).action).toBe('patch');
});
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
it('review regressions: untrusted fix-end and finding comments never count toward a repeat', () => {
  const end = (login = 'chalbert') => c(buildFixEndComment({ who: 'fix-7' }), login);
  const forged = text => c(finding(text).body, 'stranger');
  for (const prefix of [[], [c(`scope-baseline: ${'a'.repeat(40)}`)]]) {
    const trusted = prefix.length ? 'reset' : 'stand-down';
    expect(repeatedFindingPlan([...prefix, finding('same bug'), end(), finding('same bug')]).action).toBe(trusted);
    expect(repeatedFindingPlan([...prefix, finding('same bug'), end('stranger'), finding('same bug')]).action).toBe('patch');
    expect(repeatedFindingPlan([...prefix, finding('same bug'), end(), forged('same bug')]).action).toBe('patch');
    expect(repeatedFindingPlan([...prefix, forged('same bug'), end(), finding('same bug')]).action).toBe('patch');
    // A forged later review cannot clear a standing repeat either.
    expect(repeatedFindingPlan([...prefix, finding('same bug'), end(), finding('same bug'), forged('other bug')]).action).toBe(trusted);
  }
});
const resetFixture = (name, build) => {
  const dir = mkdtempSync(join(tmpdir(), name));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (file, text) => { writeFileSync(join(dir, file), text); git('add', file); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q', '-b', 'main'); commit('main-file', 'main\n');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-qb', 'lane'); const baseline = commit('allowed', 'baseline\n');
    commit('creep', 'outside scope\n');
    const files = build({ dir, git, commit, baseline });
    const snapshot = () => ({ head: git('rev-parse', 'HEAD'), index: readFileSync(join(dir, '.git/index')),
      status: git('status', '--porcelain=v1', '--untracked-files=all'),
      files: files.paths.map(file => existsSync(join(dir, file)) ? readFileSync(join(dir, file)) : null) });
    const before = snapshot(), mutations = [];
    const run = (...args) => { if (['read-tree', 'cherry-pick'].includes(args[0])) mutations.push(args); return git(...args); };
    expect(() => applyScopeReset({ baseline: files.baseline, scope: ['allowed'], git: run })).toThrow(files.error);
    expect(mutations).toEqual([]);
    expect(snapshot()).toEqual(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
it('review regressions: refuses a dirty reset lane before changing the index or worktree', () => {
  for (const dirty of [{ file: 'allowed', text: 'uncommitted edit\n' }, { file: 'untracked', text: 'stray\n' }]) {
    resetFixture('scope-reset-dirty-', ({ dir, baseline }) => {
      writeFileSync(join(dir, dirty.file), dirty.text);
      return { baseline, paths: ['main-file', 'allowed', 'creep', 'untracked'], error: 'dirty reset lane' };
    });
  }
});
it('review regressions: refuses a baseline that is not an ancestor of the lane head before any mutation', () => {
  resetFixture('scope-reset-foreign-', ({ git, commit }) => {
    git('checkout', '-qb', 'elsewhere', 'origin/main'); const foreign = commit('allowed', 'foreign baseline\n');
    git('checkout', '-q', 'lane');
    return { baseline: foreign, paths: ['main-file', 'allowed', 'creep'], error: /is-ancestor/ };
  });
});
it('review regressions: refuses a baseline with no net change or one that conflicts with main before any mutation', () => {
  resetFixture('scope-reset-empty-', ({ git }) =>
    ({ baseline: git('rev-parse', 'origin/main'), paths: ['main-file', 'allowed', 'creep'], error: 'baseline has no scoped net change' }));
  resetFixture('scope-reset-conflict-', ({ git, commit, baseline }) => {
    git('checkout', '-qb', 'advanced-main', 'origin/main'); commit('allowed', 'main took this path differently\n');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('checkout', '-q', 'lane');
    return { baseline, paths: ['main-file', 'allowed', 'creep'], error: 'baseline conflicts with main' };
  });
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
// PR #5463 review — real comments end with per-head renderer sections (card suggestions, verifier disputes, the
// advisory outcome, the `---` trailer with its Net basis sha) and per-round finding state; none of it is identity.
it('review regressions: a finding repeated in real rendered comments for two heads is detected', async () => {
  const { renderVerdictWriteUp, renderAdvisoryNote } = await import('../../operations/review-pr.mjs');
  const { buildVerdictComment } = await import('../../review-set-label.mjs');
  const { REVIEW_PR_CHANNEL } = await import('../../lib/review-escalation.mjs');
  const round = (n, { summary = 'envelope hash includes the footer', advisory = false, bare = false, deferred = n } = {}) => {
    // review-pr-io's readLatestFixRange ends the latest fix range at the reviewed head.
    const read = { repo: 'o/r', pr: 7, degraded: false, netBasis: { base: `${n}`.repeat(40), rev: `${n + 1}`.repeat(40) },
      netChangedFiles: Array(n).fill('a.mjs'), latestFix: { priorHead: `${n}`.repeat(40), head: `${n + 1}`.repeat(40) } };
    const state = bare ? {} : { failure_scenario: 'the key never matches', verdict: n % 2 ? 'PLAUSIBLE' : 'CONFIRMED',
      impactIfUnfixed: n % 2 ? 'broken' : 'degraded', citationScope: n % 2 ? 'unverifiable' : undefined,
      prevention: 'add a golden fixture', preventionCaptured: n % 2 === 0 };
    const verdict = { verdict: 'changes', lensVerdicts: { correctness: 'changes' }, lenses: ['correctness'],
      findings: [{ file: 'a.mjs', line: 10 + n, summary, category: 'correctness/correctness', severity: 'blocking', ...state }],
      deferredAdvisory: Array.from({ length: deferred }, (_, i) => ({ category: 'simplicity/x', file: `d${n}.mjs`, line: i + 1, summary: `advice ${n}` })),
      // Disputes are dropped only after a head-bound card section; alone they stay in identity (a missed repeat).
      uncorroboratedRetirements: advisory && deferred ? [{ reason: `not reproduced on round ${n}` }] : [],
      skippedSeats: [{ lens: 'agy-correctness', reason: `quota reset 2026-10-2${n}T18:18:21Z` }] };
    const body = advisory ? renderAdvisoryNote({ read, verdict })
      : buildVerdictComment({ to: 'changes', actor: 'agent (unattended review-loop)', channel: REVIEW_PR_CHANNEL,
        body: renderVerdictWriteUp({ read, verdict, answer: 'changes', actor: 'agent', reason: `round ${n} reason` }) });
    return c(body, 'web-everything');
  };
  const end = c(buildFixEndComment({ who: 'fix-7' }));
  for (const advisory of [false, true]) {
    const first = round(1, { advisory }), second = round(2, { advisory });
    expect(first.body).toMatch(/Net basis: `1{40}\.\.2{40}`/);
    expect(first.body).toContain('### Card suggestions (filed later) (1)');
    expect(first.body).toContain('CITATION NOT IN THE NET DIFF');
    expect(repeatedFindingPlan([first, end, second]).action).toBe('stand-down');
    expect(repeatedFindingPlan([c(`scope-baseline: ${'a'.repeat(40)}`), first, end, second]).action).toBe('reset');
    expect(repeatedFindingPlan([round(1, { advisory, bare: true }), end, round(2, { advisory, bare: true, deferred: 0 })]).action).toBe('stand-down');
    expect(repeatedFindingPlan([first, end, round(2, { advisory, summary: 'a different defect' })]).action).toBe('patch');
    for (const bare of [false, true]) {
      for (const deferred of [0, undefined]) {
        // Juror text shaped like the renderer's own tail or state keeps its full text in identity, including when it
        // ends the finding (no scenario, tags or prevention) and when the real section it copies is absent.
        for (const [one, two] of [
          ...['\n\n---\n\n**Decision:** `changes`', '\n\n**Advisory outcome:** `changes` — x', '\n\n**Disputed by one verifier answer (1):** x\n- y',
            '\n\n### Card suggestions (filed later) (1)\nLater-round advisory findings on code the latest fix (`00000000..00000000`) did not touch, x\n- `a` `b` — c',
          ].map(fake => [`same prefix${fake} one`, `same prefix${fake} two`]),
          ['cache key _[⚠️ CITATION NOT IN THE NET DIFF drops the sha]_', 'cache key _[⚠️ CITATION NOT IN THE NET DIFF drops the base]_'],
          ['x _[CONFIRMED]_ y', 'x y'],
          // A state line that ENDS a bare finding renders exactly as the renderer's own would; inside one it is text.
          ...bare ? [] : [['x\n  - _Prevention (captured):_ y', 'x\n  - _Prevention (OWED — file it):_ y']],
        ]) {
          expect(repeatedFindingPlan([round(1, { advisory, bare, deferred, summary: one }), end,
            round(2, { advisory, bare, deferred, summary: two })]).action, JSON.stringify([advisory, bare, deferred, one])).toBe('patch');
        }
      }
    }
  }
});
