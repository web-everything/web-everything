import { beforeAll, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { fencedPush, operatorScope, removalMarkers, scopeBrief, resolveScopeFence, scopeFenceDecision } from '../fix-scope-fence.mjs';
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

describe('the live scope fence adapter', () => {
  const head = 'a'.repeat(40);
  const tsv = s => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  let createScopeFencedPush;
  beforeAll(async () => { ({ createScopeFencedPush } = await import('../fix-scope-fence-io.mjs')); }, 60_000);
  /** One fake `gh`: PR view, the paginated GraphQL commit read (total count line, then one TSV row per commit), and writes. */
  async function liveFence({ commits = [[head, 'build']], total = commits.length, comments = [comment], patch = '+function cdLandings() {}' } = {}) {
    const writes = [], logs = [], reads = [];
    const exec = (file, args) => {
      expect(file).toBe('gh');
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefName: 'lane/5957-leading-cd', headRefOid: head });
      if (args[0] === 'api' && args[1] === 'graphql') { reads.push(args); return [String(total), ...commits.map(([sha, msg]) => `${sha}\t${tsv(msg)}`)].join('\n') + '\n'; }
      if (args[0] === 'api') return 'diff --git a/guard.mjs b/guard.mjs\n--- a/guard.mjs\n+++ b/guard.mjs\n';
      writes.push(args); return '';
    };
    const fence = createScopeFencedPush({ root: '.', exec, env: {}, log: line => logs.push(line),
      loadItems: () => [{ num: '5957', slug: 'leading-cd', scope: ['we:guard.mjs'] }], readComments: () => comments });
    const push = vi.fn(() => ({ ok: true }));
    const git = args => args[0] === 'merge-base' ? '' : args.includes('--name-only') ? 'guard.mjs\0' : patch;
    const result = fence({ repo: 'web-everything/web-everything', pr: 5403, sha: 'b'.repeat(40), git, push });
    return { result, push, writes, logs, reads };
  }

  it('resolves the card and authenticated marker before posting a needs-you stand-down', async () => {
    const { result, push, writes, logs } = await liveFence();
    expect(result).toMatchObject({ ok: false, scopeFence: true });
    expect(push).not.toHaveBeenCalled();
    expect(writes.find(args => args[1] === 'comment')?.at(-1)).toContain('stand-down reason=scope-increase');
    expect(writes.some(args => args.includes('review-status:stood-down'))).toBe(true);
    expect(logs[0]).toMatch(/enabled=true \(tool\).*mode=stand-down \(tool\)/);
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
  function liveFence(repo, { head, sha, base = null, compare = 'ahead', port = repo.port }) {
    const writes = [], compares = [];
    const exec = (file, args) => {
      expect(file).toBe('gh');
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefName: 'lane/scope-fence', headRefOid: head, baseRefOid: base });
      if (args[0] === 'api' && args[1] === 'graphql') return `1\n${head}\tremoval\\n\\nscope-removed: cdLandings\n`;
      if (args[0] === 'api' && /\/compare\//.test(args[1])) {
        compares.push(args[1]);
        if (compare === 404) throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { status: 1, stderr: 'gh: No commit found for SHA (HTTP 404)' });
        return `${compare}\n`;
      }
      if (args[0] === 'api') return 'diff --git a/guard.mjs b/guard.mjs\n--- a/guard.mjs\n+++ b/guard.mjs\n';
      if (args[0] === 'pr' && args[1] === 'diff') return 'guard.mjs\n';
      writes.push(args); return '';
    };
    const fence = createScopeFencedPush({ root: '.', exec, env: {}, log: () => {},
      loadItems: () => [{ num: '5957', slug: 'leading-cd', scope: ['we:guard.mjs'] }], readComments: () => [] });
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

  /** The brief's sanctioned catch-up: repair on the PR head, then `git merge --no-edit <base sha>` of an upstream change. */
  function catchUp(r, { upstream = 'export const other = 2;\n', fixer = 'function guard() { return 2; }\n', smuggle = false } = {}) {
    r.write('guard.mjs', 'function guard() {}\n'); r.write('other.mjs', 'export const other = 1;\n'); r.commit('initial');
    r.git(['checkout', '-qb', 'pr']); r.write('guard.mjs', 'function guard() { return 1; }\n'); const head = r.commit('removal');
    r.git(['checkout', '-q', 'main']); r.write('other.mjs', upstream); const base = r.commit('upstream');
    r.git(['checkout', '-q', 'pr']); r.write('guard.mjs', fixer); r.commit('repair');
    r.git([...ident, 'merge', '-q', '--no-edit', base]);
    if (smuggle) { r.write('other.mjs', `${upstream}export const smuggled = 1;\n`); r.git(['add', 'other.mjs']); r.git([...ident, 'commit', '-q', '--amend', '--no-edit']); }
    return { head, base, sha: r.git(['rev-parse', 'HEAD']).trim() };
  }
  it.each([
    ['an in-scope repair merged with the base', {}, 'identical', null],
    ['an upstream line that happens to name a removed identifier', { upstream: 'export const cdLandings = 2;\n' }, 'ahead', null],
    ['an out-of-scope edit smuggled into the merge commit', { smuggle: true }, 'identical', 'outside declared scope: other.mjs'],
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

  /** The PR removed the marked `cdLandings` from guard.mjs, which the base still holds until the PR merges; then a catch-up. */
  function removalStillOnBase(r, { before, after, upstream = ['other.mjs', 'export const other = 2;\n'], resolve }) {
    r.write('guard.mjs', 'function cdLandings() {}\nfunction guard() {}\n'); r.write('other.mjs', 'export const other = 1;\n'); r.commit('initial');
    r.git(['checkout', '-qb', 'pr']); r.write('guard.mjs', 'function guard() {}\n'); const head = r.commit('removal');
    r.git(['checkout', '-q', 'main']); r.write(...upstream); const base = r.commit('upstream');
    r.git(['checkout', '-q', 'pr']);
    if (before) { r.write('guard.mjs', before); r.commit('repair'); }
    try { r.git([...ident, 'merge', '-q', '--no-edit', base]); } catch {
      r.write('guard.mjs', resolve); r.git(['add', 'guard.mjs']); r.git([...ident, 'commit', '-q', '--no-edit']);
    }
    if (after) { r.write('guard.mjs', after); r.commit('repair'); }
    return { head, base, sha: r.git(['rev-parse', 'HEAD']).trim() };
  }
  const restored = 'function cdLandings() {}\nfunction guard() {}\n';
  const upstreamEdit = ['guard.mjs', 'function cdLandings() { return 2; }\nfunction guard() {}\n'];
  it.each([
    ['blocks restoring a marked PR removal still present in the merged base, before the merge', { before: restored }, true],
    ['blocks restoring a marked PR removal still present in the merged base, after the merge', { after: restored }, true],
    ['blocks keeping the base side of a modify/delete conflict on a marked removal', { upstream: upstreamEdit, resolve: upstreamEdit[1] }, true],
    ['pushes an unrelated repair merged with a base that still holds the removal', { before: 'function guard() { return 2; }\n' }, false],
    ['pushes a conflict resolved by keeping the removal', { upstream: upstreamEdit, resolve: 'function guard() {}\n' }, false],
  ])('a catch-up over a removal the base still holds: %s', (_, shape, refused) => {
    const r = realRepo();
    try {
      const { head, base, sha } = removalStillOnBase(r, shape);
      const { result, push } = liveFence(r, { head, sha, base, compare: 'identical' });
      if (!refused) { expect(result).toEqual({ ok: true }); expect(push).toHaveBeenCalledOnce(); return; }
      expect(result).toMatchObject({ ok: false, scopeFence: true, terminal: true });
      expect(result.reason).toContain('re-adds operator-removed identifier: cdLandings');
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
});
