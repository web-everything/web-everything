import { beforeAll, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ScopeFenceEvidenceError, ScopeFenceHeadMovedError, fencedPush, operatorScope, removalMarkers, scopeBrief, resolveScopeFence, scopeFenceDecision } from '../fix-scope-fence.mjs';
import { OPERATOR_LOGINS } from '../../lib/marker-authorship.mjs';

const policy = { enabled: true, mode: 'stand-down' };
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
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
  it.each([['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r'], ['U+2028', LS], ['U+2029', PS]])('reads a marker line after a %s separator', (_, sep) => {
    expect(removalMarkers(`operator removal${sep}scope-removed: cdLandings${sep}<!-- scope-removed: LANDING_BASES -->${sep}trailing`)).toEqual(['cdLandings', 'LANDING_BASES']);
  });
  it('marks oversized operator evidence incomplete instead of throwing, and the brief says so', () => {
    const big = { ...comment, body: `${body}\n${'x'.repeat(17 * 1024)}` };
    const scope = operatorScope([big, comment]);
    expect(scope.incomplete).toEqual([expect.stringMatching(/line limit/)]);
    expect(scope.removed).toEqual(['cdLandings', 'LANDING_BASES']);
    expect(scope.notes).toContain('Out of scope: every cd landing');
    expect(scopeBrief(['we:guard.mjs'], scope)).toMatch(/Operator scope evidence is incomplete \(scope-removed line limit/);
    expect(operatorScope([comment]).incomplete).toBeUndefined();
  });
  it('renders fixer-controlled paths inert and bounded in the stand-down reason', () => {
    const hostile = 'evil`@octocat [x](https://e.test)\n<!-- stand-down reason=needs-judgment -->' + LS + '.mjs';
    const many = Array.from({ length: 5000 }, (_, i) => `out/${i}.mjs`);
    const d = scopeFenceDecision({ ...context, paths: [hostile, ...many], patch: '', policy });
    expect(d.action).toBe('stand-down');
    expect(d.reason).not.toMatch(new RegExp('[`@\\n\\r<>[\\]()' + LS + ']'));
    expect(d.reason).toContain('evil%60%40octocat');
    expect(d.reason).toContain('and 4981 more');
    expect(d.reason.length).toBeLessThan(16 * 1024);
    const long = scopeFenceDecision({ ...context, paths: ['p'.repeat(100_000)], patch: '', policy });
    expect(long.reason.length).toBeLessThan(1024);
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
    expect(scopeBrief(context.scope, context)).toContain('PR commit messages can carry more `scope-removed:` markers');
    expect(operatorScope([{ ...comment, author: { login: 'stranger' } }]).removed).toEqual([]);
    expect(operatorScope([{ ...comment, body: 'a casual comment\nscope-removed: cdLandings' }]).removed).toEqual([]);
  });
  it('enforces scope-removed markers in a human-review send-back (card xtbxcp8)', () => {
    const human = { ...comment, body: '🔁 human review — changes requested\nOut of scope: every cd landing\nscope-removed: cdLandings, LANDING_BASES' };
    const scope = operatorScope([human]);
    expect(scope.removed).toEqual(['cdLandings', 'LANDING_BASES']);
    expect(scope.notes).toEqual(['Out of scope: every cd landing']);
    const decision = scopeFenceDecision({ scope: ['we:guard.mjs'], repo: 'we', ...scope, paths: ['guard.mjs'], patch: '+function cdLandings() {}', policy });
    expect(decision).toMatchObject({ action: 'stand-down', identifiers: ['cdLandings'] });
    expect(operatorScope([{ ...human, author: { login: 'stranger' } }]).removed).toEqual([]);
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
  it.each(['we:scripts/conveyor/', 'scripts/conveyor/'])('matches the directory scope %s', scope => {
    for (const repo of ['we', 'web-everything/web-everything']) {
      expect(scopeFenceDecision({ scope: [scope], repo, paths: ['scripts/conveyor/fence.mjs'], policy }).action).toBe('push');
      expect(scopeFenceDecision({ scope: [scope], repo, paths: ['scripts/conveyor-other/fence.mjs'], policy }).action).toBe('stand-down');
    }
  });
  it.each(['we:guard.mjs', 'guard.mjs'])('keeps exact-file scope %s exact across a directory replacement', scope => {
    expect(scopeFenceDecision({ ...context, scope: [scope], paths: ['guard.mjs'], policy }).action).toBe('push');
    expect(scopeFenceDecision({ ...context, scope: [scope], paths: ['guard.mjs/child.mjs'], policy }).action).toBe('stand-down');
    expect(scopeFenceDecision({ ...context, scope: [scope], paths: ['guard.mjs-new'], policy }).action).toBe('stand-down');
  });
  it.each(['frontierui', 'frontier-ui/frontierui'])('accepts the canonical Frontier UI fui: scope prefix for repo %s', repo => {
    expect(scopeFenceDecision({ scope: ['fui:src/button.ts'], repo, paths: ['src/button.ts'], policy }).action).toBe('push');
    expect(scopeFenceDecision({ scope: ['fui:src/button.ts'], repo, paths: ['src/other.ts'], policy }).action).toBe('stand-down');
  });
  it.each(['plateau-app', 'plateauapp/plateau-app'])('accepts the canonical Plateau plateau: scope prefix for repo %s', repo => {
    expect(scopeFenceDecision({ scope: ['plateau:src/app.ts'], repo, paths: ['src/app.ts'], policy }).action).toBe('push');
    expect(scopeFenceDecision({ scope: ['plateau:src/app.ts'], repo, paths: ['src/other.ts'], policy }).action).toBe('stand-down');
    expect(scopeFenceDecision({ scope: ['fui:src/app.ts'], repo, paths: ['src/app.ts'], policy }).action).toBe('stand-down');
  });
  it('keeps a literal # in a scoped filename instead of truncating it to a directory', () => {
    const at = paths => scopeFenceDecision({ scope: ['we:scripts#policy.mjs'], repo: 'we', directories: ['scripts'], paths, policy }).action;
    expect(at(['scripts#policy.mjs'])).toBe('push');
    expect(at(['scripts/unrelated.mjs'])).toBe('stand-down');
  });
  it.each(['we:scripts/bin/tool', 'scripts/bin/tool'])('keeps the extensionless file scope %s a FILE scope, never an undeclared subtree', scope => {
    expect(scopeFenceDecision({ ...context, scope: [scope], paths: ['scripts/bin/tool'], policy }).action).toBe('push');
    expect(scopeFenceDecision({ ...context, scope: [scope], paths: ['scripts/bin/tool', 'scripts/bin/tool/payload.mjs'], policy }).action).toBe('stand-down');
    expect(scopeFenceDecision({ ...context, scope: [scope], paths: ['scripts/bin/tool/payload.mjs'], policy }).action).toBe('stand-down');
  });
  it('widens an extensionless scope to a subtree only when the PR head has a directory there', () => {
    const at = paths => scopeFenceDecision({ ...context, scope: ['we:scripts/lib'], directories: ['scripts/lib'], paths, policy }).action;
    expect(at(['scripts/lib/x.mjs'])).toBe('push');
    expect(at(['scripts/lib-other/x.mjs'])).toBe('stand-down');
  });
  it('warn mode logs structured files and identifiers then pushes', () => {
    const r = run({ policy: { ...policy, mode: 'warn' }, readDiff: () => ({ paths: ['other.mjs'], patch: '+cdLandings();' }) });
    expect(r.result.ok).toBe(true); expect(r.push).toHaveBeenCalledOnce(); expect(r.note).toHaveBeenCalledWith(expect.objectContaining({ event: 'fix.scopeFence.would-block', mode: 'warn', files: ['other.mjs'], identifiers: ['cdLandings'] }));
    expect(r.note.mock.invocationCallOrder[0]).toBeLessThan(r.push.mock.invocationCallOrder[0]);
  });
  it.each([
    new Error('offline'),
    new ScopeFenceEvidenceError('oversized marker', context),
    new ScopeFenceHeadMovedError('a'.repeat(40), 'b'.repeat(40)),
  ])('warn never blocks on evidence failure: %s', error => {
    for (const stage of ['readContext', 'readDiff']) {
      const r = run({ policy: { ...policy, mode: 'warn' }, [stage]: () => { throw error; } });
      expect(r.result).toEqual({ ok: true });
      expect(r.push).toHaveBeenCalledOnce();
      expect(r.standDown).not.toHaveBeenCalled();
      expect(r.note).toHaveBeenCalledWith(expect.objectContaining({ event: 'fix.scopeFence.would-block', evidenceUnavailable: true, reason: error.message }));
    }
  });
  it('warn continues even if warning logging fails', () => {
    const r = run({ policy: { ...policy, mode: 'warn' }, readDiff: () => ({ paths: ['other.mjs'] }), note: () => { throw new Error('log failed'); } });
    expect(r.result.ok).toBe(true);
    expect(r.push).toHaveBeenCalledOnce();
    expect(r.standDown).not.toHaveBeenCalled();
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
    expect(defaults.value.scopeFence).toEqual({ enabled: true, mode: 'warn' });
    expect(resolveScopeFence({ env: {} }).value.scopeFence.mode).toBe('warn');
    expect(defaults.sources['scopeFence.enabled']).toBe('standard');
    const invalid = resolveScopeFence({ env: { WE_FIX_SCOPE_FENCE_ENABLED: 'nonsense', WE_FIX_SCOPE_FENCE_MODE: 'push' }, platform: { scopeFence: { mode: 'warn' } }, tool: { scopeFence: { enabled: 'yes', mode: false } } });
    expect(invalid.value.scopeFence).toEqual({ enabled: true, mode: 'warn' }); expect(invalid.invalid).toHaveLength(4);
  });
  it('states the shipped fix.scopeFence.mode default in the fixer brief and testing doc', () => {
    const shipped = resolveScopeFence({ env: {}, platform: {}, tool: {} }).value.scopeFence.mode;
    const settings = JSON.parse(readFileSync(join(process.cwd(), 'scripts/settings/fix-scope-fence.json'), 'utf8'));
    expect(settings.fix.scopeFence.mode).toBe(shipped);
    const brief = readFileSync(join(process.cwd(), 'skills-src/conveyor/fix-agent-brief.md'), 'utf8');
    expect(brief.match(/`fix\.scopeFence\.mode` defaults `([\w-]+)`/)?.[1]).toBe(shipped);
    const doc = readFileSync(join(process.cwd(), 'docs/agent/testing.md'), 'utf8');
    expect(doc.match(/`fix\.scopeFence\.mode` \([^)]*default `([\w-]+)`/)?.[1]).toBe(shipped);
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

describe('the live scope fence adapter', () => {
  const head = 'a'.repeat(40);
  const tsv = s => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  let createScopeFencedPush;
  beforeAll(async () => { ({ createScopeFencedPush } = await import('../fix-scope-fence-io.mjs')); }, 60_000);
  /** One fake `gh`: PR view, the paginated GraphQL commit read (total count line, then one TSV row per commit), and writes. */
  async function liveFence({ commits = [[head, 'build']], total = commits.length, comments = [comment], patch = '+function cdLandings() {}', mode = 'stand-down' } = {}) {
    const writes = [], logs = [], reads = [];
    const exec = (file, args) => {
      expect(file).toBe('gh');
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefName: 'lane/5957-leading-cd', headRefOid: head });
      if (args[0] === 'api' && args[1] === 'graphql') { reads.push(args); return [String(total), ...commits.map(([sha, msg]) => `${sha}\t${tsv(msg)}`)].join('\n') + '\n'; }
      if (args[0] === 'pr' && args[1] === 'diff') return 'guard.mjs\n';
      if (args[0] === 'api') return 'diff --git a/guard.mjs b/guard.mjs\n--- a/guard.mjs\n+++ b/guard.mjs\n';
      writes.push(args); return '';
    };
    const fence = createScopeFencedPush({ root: '.', exec, env: mode ? { WE_FIX_SCOPE_FENCE_MODE: mode } : {}, log: line => logs.push(line),
      loadItems: () => [{ num: '5957', slug: 'leading-cd', scope: ['we:guard.mjs'] }], readComments: () => comments });
    const push = vi.fn(() => ({ ok: true }));
    const git = args => args.includes('merge-base') ? '' : args.includes('--no-merges') ? 'b'.repeat(40) + '\n'
      : args.includes('--merges') ? '' : args.includes('--name-only') ? 'guard.mjs\0' : patch;
    const result = fence({ repo: 'web-everything/web-everything', pr: 5403, sha: 'b'.repeat(40), git, push });
    return { result, push, writes, logs, reads };
  }

  it.each([
    {},
    { total: 2 },
    { comments: [{ ...comment, body: `${body}\n${'x'.repeat(17 * 1024)}` }] },
  ])('default warn logs without PR writes and pushes (case %#)', async over => {
    const r = await liveFence({ ...over, mode: null });
    expect(r.result).toEqual({ ok: true });
    expect(r.push).toHaveBeenCalledOnce();
    expect(r.writes).toEqual([]);
    expect(JSON.parse(r.logs[1])).toMatchObject({ event: 'fix.scopeFence.would-block', mode: 'warn', repo: 'web-everything/web-everything', pr: 5403, sha: 'b'.repeat(40) });
  });
  it('resolves the card and authenticated marker before posting a needs-you stand-down', async () => {
    const { result, push, writes, logs } = await liveFence();
    expect(result).toMatchObject({ ok: false, scopeFence: true });
    expect(push).not.toHaveBeenCalled();
    expect(writes.find(args => args[1] === 'comment')?.at(-1)).toContain('stand-down reason=scope-increase');
    expect(writes.some(args => args.includes('review-status:stood-down'))).toBe(true);
    expect(logs[0]).toMatch(/enabled=true \(tool\).*mode=stand-down \(env\)/);
  });
  it('live adapter blocks identifiers marked only in PR removal commits', async () => {
    const commits = [['c'.repeat(40), 'initial'], [head, 'operator removal\n\nscope-removed: cdLandings, LANDING_BASES']];
    const { result, push, writes, reads } = await liveFence({ commits, comments: [] });
    expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
    expect(result.reason).toContain('re-adds operator-removed identifier: cdLandings');
    expect(push).not.toHaveBeenCalled();
    expect(writes.find(args => args[1] === 'comment')?.at(-1)).toContain('stand-down reason=scope-increase');
    expect(reads[0]).toEqual(expect.arrayContaining(['--paginate']));
    expect((await liveFence({ commits: [[head, 'operator removal\n\nscope-removed: other']], comments: [] })).push).toHaveBeenCalledOnce();
  });
  it('reads commits past the first page and fails closed when the commit list is not complete', async () => {
    const commits = [...Array.from({ length: 150 }, (_, i) => [i.toString(16).padStart(40, '0'), `commit ${i}`]),
      [head, 'late removal\n\nscope-removed: cdLandings']];
    expect((await liveFence({ commits, comments: [] })).result).toMatchObject({ ok: false, terminal: true });
    // A push racing the read (the list no longer ends at the head) is retried; a stable short list goes to a person.
    const raced = await liveFence({ commits: commits.slice(0, 150), comments: [] });
    expect(raced.result).toMatchObject({ ok: false, transient: true });
    expect(raced.result.reason).toMatch(/commit list incomplete/);
    expect(raced.push).not.toHaveBeenCalled();
    const short = await liveFence({ commits: [...commits.slice(0, 99), commits.at(-1)], total: 151, comments: [], patch: '+const safe = 1;' });
    expect(short.result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
    expect(short.result.transient).toBeUndefined();
    expect(short.result.reason).toMatch(/commit list incomplete \(read 100 of 151/);
    expect(short.push).not.toHaveBeenCalled();
    expect(short.writes.find(args => args[1] === 'comment')?.at(-1)).toContain('stand-down reason=scope-increase');
  });
  it.each([
    ['an operator comment', { comments: [{ ...comment, body: `${body}\n${'x'.repeat(17 * 1024)}` }] },
      /operator scope evidence incomplete/],
    ['a commit message', { comments: [], commits: [[head, `removal\n${'x'.repeat(17 * 1024)}`]] }, /line limit/],
  ])('stands down for a person, never a transient retry, when %s is too large to read its markers', async (_, over, why) => {
    const r = await liveFence({ ...over, patch: '+const safe = 1;' });
    expect(r.result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
    expect(r.result.transient).toBeUndefined();
    expect(r.result.reason).toMatch(why);
    expect(r.push).not.toHaveBeenCalled();
    expect(r.writes.find(args => args[1] === 'comment')?.at(-1)).toContain('stand-down reason=scope-increase');
    expect(r.writes.some(args => args.includes('review-status:stood-down'))).toBe(true);
  });
});

describe('the live scope fence adapter over a real repository', () => {
  const ident = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null'];
  let createScopeFencedPush, laneGitConfigArgs;
  beforeAll(async () => {
    ({ createScopeFencedPush } = await import('../fix-scope-fence-io.mjs'));
    ({ laneGitConfigArgs } = await import('../../lib/lane-git-hardening.mjs'));
  }, 60_000);
  /** A real repo plus the daemon-shaped git port (`-C lane` and the lane hardening pins) the fence is handed. */
  function realRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'fix-scope-fence-live-'));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = args => String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env }));
    const port = (args, { env: extra, ...opts } = {}) => String(execFileSync('git', ['-C', dir, ...laneGitConfigArgs(), ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts, env: { ...env, ...extra } }));
    const write = (file, text) => writeFileSync(join(dir, file), text);
    const commit = message => { git(['add', '.']); git([...ident, 'commit', '-qm', message]); return git(['rev-parse', 'HEAD']).trim(); };
    git(['init', '-q', '-b', 'main']);
    return { dir, git, port, write, commit };
  }
  /** The live adapter against a fake GitHub: the PR head and base, one marker commit, and the compare verdict for a merged commit. */
  function liveFence(repo, { head, sha, base = null, compare = 'ahead', port = repo.port, scoped = 'guard.mjs', fork = '',
    loadItems = () => [{ num: '5957', slug: 'leading-cd', scope: ['we:guard.mjs'] }] }) {
    const writes = [], compares = [];
    const exec = (file, args) => {
      expect(file).toBe('gh');
      if (args.includes('.merge_base_commit.sha')) return `${fork}\n`;
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefName: 'lane/scope-fence', headRefOid: head, baseRefOid: base });
      if (args[0] === 'api' && args[1] === 'graphql') return `1\n${head}\tremoval\\n\\nscope-removed: cdLandings\n`;
      if (args[0] === 'api' && /\/compare\//.test(args[1])) {
        compares.push(args[1]);
        const status = typeof compare === 'function' ? compare(args[1]) : compare;
        if (status === 404) throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { status: 1, stderr: 'gh: No commit found for SHA (HTTP 404)' });
        return `${status}\n`;
      }
      if (args[0] === 'api') return `diff --git a/${scoped} b/${scoped}\n--- a/${scoped}\n+++ b/${scoped}\n`;
      if (args[0] === 'pr' && args[1] === 'diff') return `${scoped}\n`;
      writes.push(args); return '';
    };
    const fence = createScopeFencedPush({ root: '.', exec, env: { WE_FIX_SCOPE_FENCE_MODE: 'stand-down' }, log: () => {},
      loadItems, readComments: () => [] });
    const push = vi.fn(() => ({ ok: true }));
    return { result: fence({ repo: 'web-everything/web-everything', pr: 5403, sha, git: port, push }), push, writes, compares };
  }

  it.each([
    ['an info/attributes binary mark', r => r.write('.git/info/attributes', 'guard.mjs binary\n')],
    ['a diff driver declared binary', r => { r.write('.git/info/attributes', '* diff=opaque\n'); r.git(['config', 'diff.opaque.binary', 'true']); }],
    ['a big-file threshold below the file size', r => r.git(['config', 'core.bigFileThreshold', '1'])],
    ['forced colour output', r => { r.git(['config', 'color.ui', 'always']); r.git(['config', 'color.diff', 'always']); }],
    ['NUL bytes that make git sniff the file as binary', () => {}, '\0'],
  ])('still sees a re-added removed identifier under %s', (_, setup, tail = '') => {
    const r = realRepo();
    try {
      r.write('guard.mjs', `function cdLandings() {}\n${tail}`); r.commit('initial');
      r.write('guard.mjs', `// leading cd only\n${tail}`); const head = r.commit('removal');
      setup(r);
      r.write('guard.mjs', `function cdLandings() {}\n${tail}`); const sha = r.commit('fixer re-addition');
      const { result, push } = liveFence(r, { head, sha });
      expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
      expect(result.reason).toContain('re-adds operator-removed identifier: cdLandings');
      expect(push).not.toHaveBeenCalled();
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it('keeps a literal # in a scoped filename and never widens it to the directory before the #', () => {
    const r = realRepo();
    try {
      mkdirSync(join(r.dir, 'scripts')); r.write('scripts/unrelated.mjs', 'a();\n'); r.write('scripts#policy.mjs', 'p();\n'); const head = r.commit('initial');
      r.write('scripts/unrelated.mjs', 'b();\n'); const sha = r.commit('fixer edits an undeclared file');
      const { result, push } = liveFence(r, { head, sha, base: 'f'.repeat(40), fork: head, scoped: 'scripts#policy.mjs' });
      expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
      expect(result.reason).toContain('outside declared scope: scripts/unrelated.mjs');
      expect(push).not.toHaveBeenCalled();
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
  it('withholds the push when the backlog cannot be read instead of falling back to the PR-diff scope', () => {
    const r = realRepo();
    try {
      r.write('guard.mjs', 'safe();\n'); r.write('outside.mjs', 'o();\n'); const head = r.commit('initial');
      r.write('outside.mjs', 'changed();\n'); const sha = r.commit('fixer edits a file only the PR diff names');
      for (const loadItems of [() => { throw new Error('backlog loader failed'); }, () => undefined]) {
        const { result, push } = liveFence(r, { head, sha, scoped: 'outside.mjs', loadItems });
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/backlog unreadable/);
        expect(push).not.toHaveBeenCalled();
      }
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
  it('keeps an extensionless file scope a FILE scope when the fixer replaces that file with an undeclared subtree', () => {
    const r = realRepo();
    try {
      r.write('guard.mjs', 'safe();\n'); r.write('tool', '#!/bin/sh\n'); const head = r.commit('initial');
      r.git(['rm', '-q', 'tool']); mkdirSync(join(r.dir, 'tool')); r.write('tool/payload.mjs', 'payload();\n'); const sha = r.commit('fixer replaces the file with a directory');
      const { result, push } = liveFence(r, { head, sha, scoped: 'tool' });
      expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
      expect(result.reason).toContain('outside declared scope: tool/payload.mjs');
      expect(push).not.toHaveBeenCalled();
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
  it('still lets an extensionless directory scope cover the files under it', () => {
    const r = realRepo();
    try {
      mkdirSync(join(r.dir, 'lib')); r.write('lib/a.mjs', 'a();\n'); const head = r.commit('initial');
      r.write('lib/b.mjs', 'b();\n'); const sha = r.commit('fixer adds a file under the declared directory');
      // The live base tip need not be in the lane: GitHub names the fork commit, an ancestor of the head.
      const { result, push } = liveFence(r, { head, sha, base: 'f'.repeat(40), fork: head, scoped: 'lib' });
      expect(result.ok).toBe(true);
      expect(push).toHaveBeenCalledOnce();
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
  it('keeps an extensionless file scope exact when the PR head already replaced that base file with a directory', () => {
    const r = realRepo();
    try {
      r.write('guard.mjs', 'safe();\n'); r.write('tool', '#!/bin/sh\n'); const base = r.commit('base');
      r.git(['rm', '-q', 'tool']); mkdirSync(join(r.dir, 'tool')); r.write('tool/a.mjs', 'a();\n'); const head = r.commit('build replaced the file');
      r.write('tool/payload.mjs', 'payload();\n'); const sha = r.commit('fixer grows the undeclared subtree');
      for (const fork of [base, '']) {
        const { result, push } = liveFence(r, { head, sha, base: 'f'.repeat(40), fork, scoped: 'tool' });
        expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
        expect(result.reason).toContain('outside declared scope: tool/payload.mjs');
        expect(push).not.toHaveBeenCalled();
      }
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  /** The brief's sanctioned catch-up: repair on the PR head, then `git merge --no-edit <base sha>` of an upstream change. */
  it.each([13, 40])('pushes a one-file fix after main merges bring in %i unrelated files', count => {
    const r = realRepo();
    try {
      r.write('guard.mjs', 'function guard() {}\n');
      for (let i = 0; i < count; i++) r.write(`upstream-${i}.mjs`, 'export const value = 0;\n');
      r.commit('initial');
      r.git(['checkout', '-qb', 'pr']);
      // These files were part of the PR, but the fixer never edits them.
      for (let i = 0; i < count; i++) r.write(`upstream-${i}.mjs`, 'export const value = 0;\n// PR context\n');
      const head = r.commit('PR context');
      for (let round = 1; round <= 2; round++) {
        r.git(['checkout', '-q', 'main']);
        for (let i = 0; i < count; i++) r.write(`upstream-${i}.mjs`, `export const value = ${round};\n`);
        const base = r.commit('upstream');
        r.git(['checkout', '-q', 'pr']);
        // Keep both sides explicitly; upstream changes the first line, the PR adds the second.
        try { r.git([...ident, 'merge', '-q', '--no-edit', base]); } catch {
          for (let i = 0; i < count; i++) r.write(`upstream-${i}.mjs`, `export const value = ${round};\n// PR context\n`);
          r.git(['add', '.']); r.git([...ident, 'commit', '-qm', 'resolve catch-up']);
        }
        if (round === 1) {
          r.write('guard.mjs', 'function guard() { return 2; }\n'); r.commit('one-file fix');
        }
      }
      const sha = r.git(['rev-parse', 'HEAD']).trim();
      const base = r.git(['rev-parse', 'main']).trim();
      expect(r.git(['diff', '--name-only', head, sha]).trim().split('\n')).toHaveLength(count + 1);
      const { result, push } = liveFence(r, { head, sha, base, compare: 'identical' });
      expect(result).toEqual({ ok: true }); expect(push).toHaveBeenCalledOnce();
      r.write('outside.mjs', 'export const outside = true;\n'); r.commit('outside repair');
      // A subsequent revert must not erase evidence that a fixer commit touched an outside path.
      r.git(['rm', '-q', 'outside.mjs']); const proposed = r.commit('revert outside repair');
      const blocked = liveFence(r, { head, sha: proposed, base, compare: 'identical' });
      expect(blocked.result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
      expect(blocked.result.reason).toContain('outside declared scope: outside.mjs');
      expect(blocked.push).not.toHaveBeenCalled();
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  function catchUp(r, { upstream = 'export const other = 2;\n', fixer = 'function guard() { return 2; }\n', smuggle = false, amend } = {}) {
    r.write('guard.mjs', 'function guard() {}\n'); r.write('other.mjs', 'export const other = 1;\n'); r.commit('initial');
    r.git(['checkout', '-qb', 'pr']); r.write('guard.mjs', 'function guard() { return 1; }\n'); const head = r.commit('removal');
    r.git(['checkout', '-q', 'main']); r.write('other.mjs', upstream); const base = r.commit('upstream');
    r.git(['checkout', '-q', 'pr']); r.write('guard.mjs', fixer); r.commit('repair');
    r.git([...ident, 'merge', '-q', '--no-edit', base]);
    if (smuggle) { r.write('other.mjs', `${upstream}export const smuggled = 1;\n`); r.git(['add', 'other.mjs']); r.git([...ident, 'commit', '-q', '--amend', '--no-edit']); }
    if (amend) {
      if (amend === 'delete') r.git(['rm', '-q', 'other.mjs']);
      if (amend === 'mode') r.git(['update-index', '--chmod=+x', 'other.mjs']);
      if (amend === 'in-scope') { r.write('guard.mjs', '// merge repair\n'); r.git(['add', 'guard.mjs']); }
      r.git([...ident, 'commit', '-q', '--amend', '--no-edit']);
    }
    return { head, base, sha: r.git(['rev-parse', 'HEAD']).trim() };
  }
  it.each([
    ['an in-scope repair merged with the base', {}, 'identical', null],
    ['an upstream line that happens to name a removed identifier', { upstream: 'export const cdLandings = 2;\n' }, 'ahead', null],
    ['a merge-only path outside the non-merge repair', { smuggle: true }, 'identical', 'outside declared scope: other.mjs'],
    ['a merge-only deletion outside scope', { amend: 'delete' }, 'identical', 'outside declared scope: other.mjs'],
    ['a merge-only mode change outside scope', { amend: 'mode' }, 'identical', 'outside declared scope: other.mjs'],
    ['an in-scope merge amendment', { amend: 'in-scope' }, 'identical', null],
    ['a merged commit GitHub does not place on the base', {}, 'diverged', 'outside declared scope: other.mjs'],
    ['a merged commit GitHub does not know', {}, 404, 'outside declared scope: other.mjs'],
    ['a removed identifier re-added alongside the catch-up', { fixer: 'function cdLandings() {}\n' }, 'identical', 're-adds operator-removed identifier: cdLandings'],
  ])('a base catch-up merge: %s', (_, shape, compare, violation) => {
    const r = realRepo();
    try {
      const { head, base, sha } = catchUp(r, shape);
      const { result, push, compares } = liveFence(r, { head, sha, base, compare });
      expect(compares).toEqual([`repos/web-everything/web-everything/compare/${base}...${base}`]);
      if (!violation) { expect(result).toEqual({ ok: true }); expect(push).toHaveBeenCalledOnce(); return; }
      expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
      expect(result.reason).toContain(violation);
      expect(push).not.toHaveBeenCalled();
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it.each([[false, 'outside.mjs'], [true, 'outside.mjs'], [true, 'guard.mjs']])('checks an unverified side-branch merge (verified catch-up: %s, repair: %s)', (withBase, file) => {
    const r = realRepo();
    try {
      r.write('guard.mjs', 'function guard() {}\n'); r.commit('initial');
      r.git(['checkout', '-qb', 'pr']); r.write('guard.mjs', '// PR\n'); const head = r.commit('removal');
      r.git(['checkout', '-qb', 'side']); r.write(file, 'export const repair = true;\n'); const side = r.commit('side repair');
      r.git(['checkout', '-q', 'pr']);
      r.git([...ident, 'merge', '-q', '--no-ff', '--no-edit', side]);
      let base = null;
      if (withBase) {
        r.git(['checkout', '-q', 'main']); r.write('upstream.mjs', 'export const upstream = true;\n'); base = r.commit('upstream');
        r.git(['checkout', '-q', 'pr']); r.git([...ident, 'merge', '-q', '--no-edit', base]);
      }
      const sha = r.git(['rev-parse', 'HEAD']).trim();
      const compare = url => url.endsWith(`${base}...${base}`) ? 'identical' : 'diverged';
      const { result, push, writes } = liveFence(r, { head, sha, base, compare });
      if (file === 'guard.mjs') { expect(result).toEqual({ ok: true }); expect(push).toHaveBeenCalledOnce(); return; }
      expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
      expect(result.reason).toContain('outside declared scope: outside.mjs');
      expect(push).not.toHaveBeenCalled();
      expect(writes.find(args => args[1] === 'comment')?.at(-1)).toContain('stand-down reason=scope-increase');
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  /** The PR removed the marked `cdLandings` from guard.mjs, which the base still holds until the PR merges; then a catch-up. */
  function removalStillOnBase(r, { before, after, upstream = ['other.mjs', 'export const other = 2;\n'], resolve, setup = () => {}, strategy = [] }) {
    r.write('guard.mjs', 'function cdLandings() {}\nfunction guard() {}\n'); r.write('other.mjs', 'export const other = 1;\n'); r.commit('initial');
    r.git(['checkout', '-qb', 'pr']); r.write('guard.mjs', 'function guard() {}\n'); const head = r.commit('removal');
    r.git(['checkout', '-q', 'main']); r.write(...upstream); const base = r.commit('upstream');
    r.git(['checkout', '-q', 'pr']);
    setup(r);
    if (before) { r.write('guard.mjs', before); r.commit('repair'); }
    try { r.git([...ident, 'merge', '-q', '--no-edit', ...strategy, base]); } catch {
      r.write('guard.mjs', resolve); r.git(['add', 'guard.mjs']); r.git([...ident, 'commit', '-q', '--no-edit']);
    }
    if (after) { r.write('guard.mjs', after); r.commit('repair'); }
    return { head, base, sha: r.git(['rev-parse', 'HEAD']).trim() };
  }
  const restored = 'function cdLandings() {}\nfunction guard() {}\n';
  const upstreamEdit = ['guard.mjs', 'function cdLandings() { return 2; }\nfunction guard() {}\n'];
  const readded = 're-adds operator-removed identifier: cdLandings';
  /** Daemon environments that switch every pathspec to literal must not empty the fence's path-limited reads. */
  const literalEnv = r => (args, { env: extra, ...opts } = {}) => r.port(args, { ...opts, env: { GIT_LITERAL_PATHSPECS: '1', ...extra } });
  it.each([
    ['blocks restoring a marked PR removal still present in the merged base, before the merge', { before: restored }, readded],
    ['blocks restoring a marked PR removal still present in the merged base, after the merge', { after: restored }, readded],
    ['blocks keeping the base side of a conflict on a marked removal', { upstream: upstreamEdit, resolve: upstreamEdit[1] }, readded],
    ['blocks a lane merge=union attribute that merges the base side in cleanly', { upstream: upstreamEdit, setup: r => r.write('.git/info/attributes', '* merge=union\n') }, readded],
    ['blocks a restore under a literal-pathspec environment', { before: restored, port: literalEnv }, readded],
    ['does not attribute a merge strategy to a non-merge repair', { strategy: ['-s', 'ours'] }, null],
    ['pushes an unrelated repair merged with a base that still holds the removal', { before: 'function guard() { return 2; }\n' }, null],
    ['pushes a conflict resolved by keeping the removal', { upstream: upstreamEdit, resolve: 'function guard() {}\n' }, null],
  ])('a catch-up over a removal the base still holds: %s', (_, { port, ...shape }, violation) => {
    const r = realRepo();
    try {
      const { head, base, sha } = removalStillOnBase(r, shape);
      const { result, push } = liveFence(r, { head, sha, base, compare: 'identical', ...(port ? { port: port(r) } : {}) });
      if (!violation) { expect(result).toEqual({ ok: true }); expect(push).toHaveBeenCalledOnce(); return; }
      expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
      expect(result.reason).toContain(violation);
      expect(push).not.toHaveBeenCalled();
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it.each([
    ['restoring the removal under the new name after a rename-aware merge', false],
    ['keeping the renamed file in a rename/delete conflict over a PR deletion', true],
  ])('a catch-up over an upstream rename of a PR path blocks %s', (_, prDeletes) => {
    const r = realRepo();
    try {
      r.write('guard.mjs', restored); r.commit('initial');
      r.git(['checkout', '-qb', 'pr']);
      if (prDeletes) r.git(['rm', '-q', 'guard.mjs']); else r.write('guard.mjs', 'function guard() {}\n');
      const head = r.commit('removal');
      r.git(['checkout', '-q', 'main']); r.git(['mv', 'guard.mjs', 'moved.mjs']); const base = r.commit('upstream rename');
      r.git(['checkout', '-q', 'pr']);
      try { r.git([...ident, 'merge', '-q', '--no-edit', base]); } catch { r.git(['add', 'moved.mjs']); r.git([...ident, 'commit', '-q', '--no-edit']); }
      r.write('moved.mjs', restored);
      if (r.git(['status', '--porcelain']).trim()) r.commit('repair');
      const sha = r.git(['rev-parse', 'HEAD']).trim();
      const { result, push } = liveFence(r, { head, sha, base, compare: 'identical' });
      expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
      expect(result.reason).toContain(readded);
      expect(push).not.toHaveBeenCalled();
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it('reads the commit the push sends, not a lane replace ref that hides it', () => {
    const r = realRepo();
    try {
      r.write('guard.mjs', 'function cdLandings() {}\n'); r.commit('initial');
      r.write('guard.mjs', '// leading cd only\n'); const head = r.commit('removal');
      r.write('guard.mjs', 'function cdLandings() {}\n'); r.write('other.mjs', 'export const smuggled = 1;\n'); const sha = r.commit('fixer re-addition');
      r.git(['replace', sha, head]);
      expect(r.git(['diff', '--name-only', head, sha]).trim()).toBe('');
      const { result, push } = liveFence(r, { head, sha });
      expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
      expect(result.reason).toContain('outside declared scope: other.mjs');
      expect(result.reason).toContain('re-adds operator-removed identifier: cdLandings');
      expect(push).not.toHaveBeenCalled();
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
  it('does not credit a graft-faked merge of a base commit whose change the base later reverted', () => {
    const r = realRepo();
    try {
      r.write('guard.mjs', 'function guard() {}\n'); r.write('other.mjs', 'export const other = 1;\n'); r.commit('initial');
      r.git(['checkout', '-qb', 'pr']); r.write('guard.mjs', 'function guard() { return 1; }\n'); const head = r.commit('removal');
      r.git(['checkout', '-q', 'main']); r.write('other.mjs', 'export const other = 2;\n'); const side = r.commit('side');
      r.write('other.mjs', 'export const other = 1;\n'); const base = r.commit('revert side');
      r.git(['checkout', '-q', 'pr']); r.write('other.mjs', 'export const other = 2;\n'); const sha = r.commit('repair');
      r.write('.git/info/grafts', `${sha} ${head} ${side}\n`);
      const { result, push, compares } = liveFence(r, { head, sha, base, compare: 'ahead' });
      expect(compares).toEqual([]);
      expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
      expect(result.reason).toContain('outside declared scope: other.mjs');
      expect(push).not.toHaveBeenCalled();
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
  it('sends a fence read too large for its buffer to a person, never a transient retry', () => {
    const r = realRepo();
    try {
      r.write('guard.mjs', 'function cdLandings() {}\n'); r.commit('initial');
      r.write('guard.mjs', '// leading cd only\n'); const head = r.commit('removal');
      r.write('guard.mjs', '// still only a leading cd\n'); const sha = r.commit('repair');
      const opts = [];
      const port = (args, o) => {
        opts.push(o);
        if (args.includes('-U0')) throw Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
        return r.port(args, o);
      };
      const { result, push, writes } = liveFence(r, { head, sha, port });
      expect(opts.every(o => o.maxBuffer >= 32 * 1024 * 1024 && o.timeout > 0 && o.env.GIT_NO_REPLACE_OBJECTS === '1' && o.env.GIT_GRAFT_FILE === '/dev/null')).toBe(true);
      expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
      expect(result.transient).toBeUndefined();
      expect(result.reason).toMatch(/git output exceeds 64 MiB/);
      expect(push).not.toHaveBeenCalled();
      expect(writes.find(args => args[1] === 'comment')?.at(-1)).toContain('stand-down reason=scope-increase');
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
  it('bounds cumulative history reads and stands down instead of retrying an oversized repair', () => {
    const r = realRepo();
    try {
      r.write('guard.mjs', '// initial\n'); const head = r.commit('initial');
      r.write('guard.mjs', '// repair\n'); const sha = r.commit('repair');
      let reads = 0;
      const port = (args, opts) => {
        reads++;
        if (args.includes('rev-list') && args.includes('--no-merges')) return `${sha}\n`.repeat(2100);
        if (args.includes('diff-tree')) return 'guard.mjs\0';
        return r.port(args, opts);
      };
      const { result, push, writes } = liveFence(r, { head, sha, port });
      expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
      expect(result.transient).toBeUndefined();
      expect(result.reason).toContain('repair history exceeds 2000 Git reads or 120 seconds');
      expect(reads).toBe(2000);
      expect(push).not.toHaveBeenCalled();
      expect(writes.find(args => args[1] === 'comment')?.at(-1)).toContain('stand-down reason=scope-increase');
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
});
