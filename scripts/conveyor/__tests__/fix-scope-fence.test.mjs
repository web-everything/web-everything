import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { fencedPush, operatorScope, removalMarkers, scopeBrief, resolveScopeFence, scopeFenceDecision } from '../fix-scope-fence.mjs';
import { OPERATOR_LOGINS } from '../../lib/marker-authorship.mjs';

const policy = { enabled: true, mode: 'stand-down' };
const body = '🔁 review — changes requested\nOut of scope: every cd landing\n- subshell walks\nx5tbryq carries landing budgets\nscope-removed: cdLandings, LANDING_BASES';
const comment = { body, author: { login: OPERATOR_LOGINS[0] } };
const context = { scope: ['we:guard.mjs'], repo: 'we', ...operatorScope([comment]) };
function run(over = {}) {
  const push = vi.fn(() => ({ ok: true })), standDown = vi.fn(), note = vi.fn();
  const result = fencedPush({ readContext: () => context, readDiff: () => ({ paths: ['guard.mjs'], patch: '+const leadingCd = true;' }),
    policy, push, standDown, note, ...over });
  return { result, push, standDown, note };
}

describe('fix scope fence', () => {
  it('rejects oversized marker evidence within a bounded time', () => {
    const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/conveyor/fix-scope-fence.mjs')).href;
    const probe = `import { removalMarkers } from ${JSON.stringify(moduleUrl)};
      import assert from 'node:assert/strict';
      for (const text of ['scope-removed: a' + ' '.repeat(100_000) + 'b', ('x' + String.fromCharCode(10)).repeat(600_000)]) {
        assert.throws(() => removalMarkers(text), /scope-removed.*limit/);
      }`;
    expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', probe], { timeout: 3000, stdio: 'pipe' })).not.toThrow();
  });
  it('parses plain and HTML markers across line endings without normalizing identifier text', () => {
    expect(removalMarkers('  scope-removed: one, two\r\n <!-- scope-removed: $three _four -->\r\nscope-removed: one')).toEqual(['one', 'two', '$three', '_four', 'one']);
    expect(removalMarkers('quoted scope-removed: ignored\nscope-removed: --flag ../path `quoted` "name" ｎame')).toEqual([]);
    const r = run({ readContext: () => ({ ...context, removed: removalMarkers('scope-removed: a' + ' '.repeat(100_000) + 'b') }) });
    expect(r.result).toMatchObject({ ok: false, scopeFence: true });
    expect(r.push).not.toHaveBeenCalled();
  });
  it('checks added prefix increments inside hunks while ignoring file headers', () => {
    const patch = 'diff --git a/guard.mjs b/guard.mjs\n--- a/guard.mjs\n+++ b/guard.mjs\n@@ -1 +1 @@\n-old\n+++ cdLandings;\n';
    expect(run({ readDiff: () => ({ paths: ['guard.mjs'], patch }) }).result).toMatchObject({ ok: false, scopeFence: true });
    expect(scopeFenceDecision({ ...context, removed: ['guard'], paths: ['guard.mjs'], patch: patch.replace('+++ cdLandings;', '+safe();'), policy }).action).toBe('push');
  });
  it('preserves operator scope lines verbatim and ignores untrusted or ordinary review comments', () => {
    expect(context.notes).toEqual(['Out of scope: every cd landing', '- subshell walks', 'x5tbryq carries landing budgets']);
    for (const line of context.notes) expect(scopeBrief(context.scope, context)).toContain(line);
    expect(scopeBrief(context.scope, context)).toContain('Stay inside this scope; anything else → stand down with a scope-increase request.');
    expect(operatorScope([{ ...comment, author: { login: 'stranger' } }]).removed).toEqual([]);
    expect(operatorScope([{ ...comment, body: 'a casual comment\nscope-removed: cdLandings' }]).removed).toEqual([]);
  });
  it('blocks the #5403 reintroduction before calling the push sink', () => {
    const r = run({ readDiff: () => ({ paths: ['guard.mjs'], patch: '+function cdLandings() {}' }) });
    expect(r.result).toMatchObject({ ok: false, scopeFence: true });
    expect(r.push).not.toHaveBeenCalled();
    expect(r.standDown).toHaveBeenCalledWith(expect.stringContaining('scope-increase request: proposed repair re-adds operator-removed identifier: cdLandings'), context);
  });
  it('pushes an in-scope repair', () => {
    const r = run(); expect(r.result.ok).toBe(true); expect(r.push).toHaveBeenCalledOnce(); expect(r.standDown).not.toHaveBeenCalled();
  });
  it('blocks a new file outside scope', () => {
    const r = run({ readDiff: () => ({ paths: ['new-subsystem.mjs'], patch: '+const subsystem = true;' }) });
    expect(r.result.reason).toContain('new-subsystem.mjs'); expect(r.push).not.toHaveBeenCalled(); expect(r.standDown).toHaveBeenCalledOnce();
  });
  it('warn mode posts a note then pushes', () => {
    const r = run({ policy: { ...policy, mode: 'warn' }, readDiff: () => ({ paths: ['other.mjs'], patch: '' }) });
    expect(r.result.ok).toBe(true); expect(r.push).toHaveBeenCalledOnce(); expect(r.note).toHaveBeenCalledWith(expect.stringContaining('scope-increase request'), context);
    expect(r.note.mock.invocationCallOrder[0]).toBeLessThan(r.push.mock.invocationCallOrder[0]);
  });
  it('fails closed on unavailable evidence and honors disabled policy', () => {
    expect(run({ readContext: () => { throw new Error('offline'); } }).result).toMatchObject({ ok: false, transient: true });
    expect(run({ policy: { enabled: false }, readContext: () => { throw new Error('unused'); } }).result.ok).toBe(true);
  });
  it('matches identifiers exactly, ignores removed/context lines, supports globs and repo boundaries', () => {
    expect(removalMarkers('operator removal\n<!-- scope-removed: cdLandings, LANDING_BASES -->')).toEqual(['cdLandings', 'LANDING_BASES']);
    expect(scopeFenceDecision({ ...context, paths: ['guard.mjs'], patch: '-cdLandings\n cdLandings\n+cdLandingsExtra', policy }).action).toBe('push');
    expect(scopeFenceDecision({ ...context, scope: ['we:scripts/**/*.mjs'], paths: ['scripts/conveyor/fence.mjs'], policy }).action).toBe('push');
    expect(scopeFenceDecision({ ...context, scope: ['fui:guard.mjs'], paths: ['guard.mjs'], policy }).action).toBe('stand-down');
  });
  it('resolves both settings independently through every cascade layer with sources', () => {
    const r = resolveScopeFence({ env: { WE_FIX_SCOPE_FENCE_MODE: 'warn' }, platform: { scopeFence: { enabled: false, mode: 'stand-down' } }, tool: { scopeFence: { enabled: true } } });
    expect(r.value.scopeFence).toEqual({ enabled: true, mode: 'warn' });
    expect(r.sources).toEqual({ 'scopeFence.enabled': 'tool', 'scopeFence.mode': 'env' });
    const defaults = resolveScopeFence({ env: {}, platform: {}, tool: {} });
    expect(defaults.value.scopeFence).toEqual(policy);
    expect(defaults.sources['scopeFence.enabled']).toBe('standard');
    const invalid = resolveScopeFence({ env: { WE_FIX_SCOPE_FENCE_ENABLED: 'nonsense', WE_FIX_SCOPE_FENCE_MODE: 'push' }, platform: { scopeFence: { mode: 'warn' } }, tool: { scopeFence: { enabled: 'yes', mode: false } } });
    expect(invalid.value.scopeFence).toEqual({ enabled: true, mode: 'warn' }); expect(invalid.invalid).toHaveLength(4);
  });
  it('observes a real git diff re-adding a function after a marked removal commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-scope-fence-'));
    const git = args => String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }));
    const commit = message => { git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message]); };
    try {
      git(['init', '-q']); writeFileSync(join(dir, 'guard.mjs'), 'function cdLandings() {}\n'); commit('initial');
      writeFileSync(join(dir, 'guard.mjs'), '// leading cd only\n'); commit('operator removal\n\nscope-removed: cdLandings, LANDING_BASES');
      const head = git(['rev-parse', 'HEAD']).trim();
      const removed = removalMarkers(git(['log', '-1', '--format=%B']));
      writeFileSync(join(dir, 'guard.mjs'), 'function cdLandings() {}\n'); commit('fixer re-addition');
      const r = run({ readContext: () => ({ ...context, removed }), readDiff: () => ({ paths: git(['diff', '--name-only', head, 'HEAD']).trim().split('\n'), patch: git(['diff', '-U0', head, 'HEAD']) }) });
      expect(r.result.ok).toBe(false); expect(r.push).not.toHaveBeenCalled(); expect(r.result.reason).toContain('cdLandings');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

it('the live adapter resolves the card and authenticated marker before posting a needs-you stand-down', async () => {
  const { createScopeFencedPush } = await import('../fix-scope-fence-io.mjs');
  const head = 'a'.repeat(40), writes = [], logs = [];
  const exec = (file, args) => {
    expect(file).toBe('gh');
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefName: 'lane/5957-leading-cd', headRefOid: head, commits: [] });
    if (args[0] === 'api') return 'diff --git a/guard.mjs b/guard.mjs\n--- a/guard.mjs\n+++ b/guard.mjs\n';
    writes.push(args); return '';
  };
  const fence = createScopeFencedPush({ root: '.', exec, env: {}, log: line => logs.push(line),
    loadItems: () => [{ num: '5957', slug: 'leading-cd', scope: ['we:guard.mjs'] }], readComments: () => [comment] });
  const push = vi.fn(() => ({ ok: true }));
  const git = args => args[0] === 'merge-base' ? '' : args.includes('--name-only') ? 'guard.mjs\0' : '+function cdLandings() {}';
  const result = fence({ repo: 'web-everything/web-everything', pr: 5403, sha: 'b'.repeat(40), git, push });
  expect(result).toMatchObject({ ok: false, scopeFence: true });
  expect(push).not.toHaveBeenCalled();
  expect(writes.find(args => args[1] === 'comment')?.at(-1)).toContain('stand-down reason=scope-increase');
  expect(writes.some(args => args.includes('review-status:stood-down'))).toBe(true);
  expect(logs[0]).toMatch(/enabled=true \(tool\).*mode=stand-down \(tool\)/);
});
