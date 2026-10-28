// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';

// Register cases before loading the implementation, which is absent in this red phase.
let checkBornAsCollision, guardEnqueue, enqueueOutcomeEvent;
beforeAll(async () => {
  ({ checkBornAsCollision, guardEnqueue, enqueueOutcomeEvent } = await import('../drain-poison-guard.mjs'));
});

const sha = 'b'.repeat(40);
const newCard = 'backlog/7274-new-card.md';
const mainCard = 'backlog/7233-old-card.md';
const cardText = (hash) => `---\nid: 7274\nbornAs: ${hash}\n---\nbody\n`;

// A fake git: `added` = files the PR adds, `texts` = file text at the PR head, `main` = grep output lines.
function fakeExec({ added = [newCard], texts = { [newCard]: cardText('xgcpm6z') }, main = `origin/main:${mainCard}:bornAs: xgcpm6z`, fetchFails = false, grepError = false } = {}) {
  return vi.fn((cmd, args) => {
    if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
    if (args[0] === 'fetch') { if (fetchFails) throw new Error('network down'); return ''; }
    if (args[0] === 'diff') return added.join('\n');
    if (args[0] === 'show') return texts[args[1].split(':').slice(1).join(':')];
    if (args[0] === 'grep') {
      if (grepError) throw Object.assign(new Error('fatal: bad object'), { status: 128 });
      if (!main) throw Object.assign(new Error('no match'), { status: 1 });
      return main;
    }
    throw new Error(`unexpected git ${args[0]}`);
  });
}

describe('checkBornAsCollision', () => {
  it('reports the hash and the card main already holds', () => {
    expect(checkBornAsCollision({ exec: fakeExec(), headSha: sha })).toEqual({ collision: { hash: 'xgcpm6z', path: newCard, mainCard } });
  });
  it('passes a PR whose new cards are unique on main', () => {
    expect(checkBornAsCollision({ exec: fakeExec({ main: '' }), headSha: sha })).toEqual({ ok: true });
  });
  it('passes a PR that adds no backlog cards after refreshing main', () => {
    const exec = fakeExec({ added: [] });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ ok: true });
    expect(exec.mock.calls.map(([, a]) => a[0])).toEqual(['fetch', 'diff']);
  });
  it('catches a hash-named card by its file name when bornAs is not in the text', () => {
    const exec = fakeExec({ added: ['backlog/xgcpm6z-new.md'], texts: { 'backlog/xgcpm6z-new.md': '---\nid: x\n---\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha }).collision.hash).toBe('xgcpm6z');
  });
  it('fails closed when main cannot be fetched', () => {
    expect(checkBornAsCollision({ exec: fakeExec({ fetchFails: true }), headSha: sha })).toEqual({ error: expect.stringContaining('network down') });
  });
  it('fails closed when main cannot be searched (not just "no match")', () => {
    expect(checkBornAsCollision({ exec: fakeExec({ grepError: true }), headSha: sha })).toEqual({ error: expect.stringContaining('bad object') });
  });
});

describe('guardEnqueue', () => {
  const c = { num: 5969, repo: 'o/r' };
  it('refuses a collision, emits enqueue-refused and comments', () => {
    const emit = vi.fn(); const comment = vi.fn();
    const out = guardEnqueue({ c, headSha: sha, repo: 'o/r', exec: fakeExec(), emit, comment });
    expect(out).toMatchObject({ enqueued: false, deferred: true, kind: 'bornas-collision' });
    expect(out.reason).toContain('xgcpm6z');
    expect(emit).toHaveBeenCalledWith({ kind: 'enqueue-refused', repo: 'o/r', pr: 5969,
      detail: { pr: 5969, reason: 'bornas-collision', hash: 'xgcpm6z', mainCard } });
    expect(comment).toHaveBeenCalledTimes(1);
    expect(comment.mock.calls[0][0]).toContain(mainCard);
  });
  it('refuses (does not enqueue) when main is unreadable', () => {
    const emit = vi.fn();
    const out = guardEnqueue({ c, headSha: sha, repo: 'o/r', exec: fakeExec({ fetchFails: true }), emit, comment: vi.fn() });
    expect(out).toMatchObject({ enqueued: false, deferred: true, kind: 'bornas-unreadable' });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'enqueue-refused', detail: expect.objectContaining({ reason: 'bornas-unreadable' }) }));
  });
  it('returns null (proceed) when clean, with no event', () => {
    const emit = vi.fn();
    expect(guardEnqueue({ c, headSha: sha, repo: 'o/r', exec: fakeExec({ main: '' }), emit, comment: vi.fn() })).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
  it('does not comment twice for the same head and hash', () => {
    const comment = vi.fn(); const seen = new Set();
    for (let i = 0; i < 2; i++) guardEnqueue({ c, headSha: sha, repo: 'o/r', exec: fakeExec(), emit: vi.fn(), comment, seen });
    expect(comment).toHaveBeenCalledTimes(1);
  });
  it('retries a failed notification for the same head', () => {
    const comment = vi.fn().mockImplementationOnce(() => { throw new Error('outage'); }).mockReturnValue(true);
    const seen = new Set();
    for (let i = 0; i < 3; i++) guardEnqueue({ c, headSha: sha, repo: 'o/r', exec: fakeExec(), comment, seen });
    expect(comment).toHaveBeenCalledTimes(2);
  });
  it.each(['false', 'rejection'])('retries delivery after a callback reports %s', async mode => {
    const seen = new Set();
    const comment = vi.fn().mockImplementationOnce(() => mode === 'false' ? false : Promise.reject(new Error('outage'))).mockReturnValue(true);
    guardEnqueue({ c, headSha: sha, repo: 'o/r', exec: fakeExec(), comment, seen });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.size).toBe(0);
    guardEnqueue({ c, headSha: sha, repo: 'o/r', exec: fakeExec(), comment, seen });
    expect(comment).toHaveBeenCalledTimes(2);
    expect(seen.size).toBe(1);
  });
  it('keeps raw Git errors out of the public refusal reason and posts no comment', () => {
    const comment = vi.fn();
    const exec = () => { throw new Error('https://secret-token@example.invalid /private/clone'); };
    const out = guardEnqueue({ c, headSha: sha, repo: 'o/r', exec, comment, seen: new Set() });
    expect(out.reason).not.toContain('secret-token');
    expect(comment).not.toHaveBeenCalled();
  });
  it('holds an unreadable check with a note and never calls the PR delivery callback', () => {
    const comment = vi.fn();
    for (let i = 0; i < 2; i++) {
      expect(guardEnqueue({ c, headSha: sha, repo: 'o/r', exec: fakeExec({ fetchFails: true }), comment, seen: new Set() }))
        .toEqual({ enqueued: false, deferred: true, kind: 'bornas-unreadable', reason: expect.stringContaining('check unreadable') });
    }
    expect(comment).not.toHaveBeenCalled();
  });
});

describe('checkBornAsCollision corruption self-heal', () => {
  const corrupt = () => Object.assign(new Error('Command failed: git fetch'),
    { status: 128, stderr: 'fatal: You are attempting to fetch 9c7274dc, which is in the commit-graph file but not in the object database.' });
  const healingExec = (failures, base = fakeExec({ main: '' })) => vi.fn((cmd, args, options) => {
    if (failures[args[0]] > 0) { failures[args[0]]--; throw corrupt(); }
    return base(cmd, args, options);
  });

  // Real directories: the heal requires the clone to be proven distinct from a located primary checkout.
  let clone, primary, worktree;
  beforeAll(() => {
    clone = mkdtempSync(join(tmpdir(), 'poison-clone-'));
    primary = mkdtempSync(join(tmpdir(), 'poison-primary-'));
    for (const dir of [clone, primary]) mkdirSync(join(dir, '.git'));
    mkdirSync(join(primary, 'scripts'));
    worktree = join(primary, 'worktree');
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(primary, '.git', 'worktrees', 'x')}\n`);
  });
  afterAll(() => { for (const dir of [clone, primary]) rmSync(dir, { recursive: true, force: true }); });

  it.each(['fetch', 'diff', 'show', 'grep'])('heals once and retries a corrupt %s', op => {
    const heal = vi.fn(() => ({ actions: ['removed stale objects/info/commit-graph cache'] }));
    const log = vi.fn();
    const exec = healingExec({ [op]: 1 });
    expect(checkBornAsCollision({ exec, headSha: sha, cwd: clone, primary, heal, log }))
      .toEqual({ ok: true, healed: ['removed stale objects/info/commit-graph cache'] });
    expect(heal).toHaveBeenCalledOnce();
    expect(heal).toHaveBeenCalledWith(clone, { log });
    expect(exec.mock.calls.filter(([, args]) => args[0] === op)).toHaveLength(2);
  });
  it('heals at most once per check, even when corruption survives the heal', () => {
    const heal = vi.fn(() => ({ actions: [] }));
    const out = checkBornAsCollision({ exec: healingExec({ fetch: 2 }), headSha: sha, cwd: clone, primary, heal });
    expect(out).toEqual({ error: expect.stringContaining('Command failed'), healed: [] });
    expect(heal).toHaveBeenCalledOnce();
  });
  it('does not heal a network-style failure', () => {
    const heal = vi.fn(() => ({ actions: [] }));
    expect(checkBornAsCollision({ exec: fakeExec({ fetchFails: true }), headSha: sha, cwd: clone, primary, heal }))
      .toEqual({ error: expect.stringContaining('network down') });
    expect(heal).not.toHaveBeenCalled();
  });
  it('judges git stderr, not a PR-controlled path in the command line', () => {
    const heal = vi.fn(() => ({ actions: [] }));
    const exec = vi.fn((cmd, args) => {
      if (args[0] === 'show') throw Object.assign(new Error(`Command failed: git show ${args[1]}`), { status: 128, stderr: 'fatal: path not found' });
      return fakeExec({ added: ['backlog/9-corrupt-index-file.md'] })(cmd, args);
    });
    expect(checkBornAsCollision({ exec, headSha: sha, cwd: clone, primary, heal }).error).toContain('corrupt');
    expect(heal).not.toHaveBeenCalled();
  });
  it('treats grep exit status 1 as no matches, never as corruption', () => {
    const heal = vi.fn(() => ({ actions: [] }));
    expect(checkBornAsCollision({ exec: fakeExec({ main: '' }), headSha: sha, cwd: clone, primary, heal })).toEqual({ ok: true });
    expect(heal).not.toHaveBeenCalled();
  });
  it.each([
    ['no clone directory', () => ({ primary })],
    ['an unknown primary', () => ({ cwd: clone, primary: null })],
    ['the primary checkout itself', () => ({ cwd: primary, primary })],
    ['a primary that does not exist', () => ({ cwd: clone, primary: join(primary, 'missing') })],
    ['a subdirectory of the primary', () => ({ cwd: join(primary, 'scripts'), primary })],
    ['a worktree of the primary (.git file)', () => ({ cwd: worktree, primary })],
  ])('never heals %s', (_name, where) => {
    const heal = vi.fn(() => ({ actions: [] }));
    expect(checkBornAsCollision({ exec: healingExec({ fetch: 1 }), headSha: sha, heal, ...where() }).error).toContain('Command failed');
    expect(heal).not.toHaveBeenCalled();
  });
  it('reports heal actions on the unreadable refusal event without commenting', () => {
    const emit = vi.fn(); const comment = vi.fn();
    const heal = () => ({ actions: ['set core.commitGraph=false'] });
    const out = guardEnqueue({ c: { num: 5998, repo: 'o/r' }, headSha: sha, repo: 'o/r', exec: healingExec({ fetch: 2 }), cwd: clone, primary, heal, emit, comment });
    expect(out).toMatchObject({ kind: 'bornas-unreadable' });
    expect(emit.mock.calls[0][0].detail).toMatchObject({ reason: 'bornas-unreadable', healed: ['set core.commitGraph=false'] });
    expect(comment).not.toHaveBeenCalled();
  });
});

// The live incident (2026-10-27 21:26Z): a commit-graph naming an object missing from the drain clone's object
// store made `git fetch` fail. Plant the same corruption in a real temporary clone.
describe('checkBornAsCollision on a clone with a corrupt commit-graph', () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const card = (dir, name, hash) => { mkdirSync(join(dir, 'backlog'), { recursive: true }); writeFileSync(join(dir, 'backlog', name), `---\nbornAs: ${hash}\n---\n`); };
  let root, clone, seed, head;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'poison-graph-'));
    const origin = join(root, 'origin.git'); seed = join(root, 'seed'); clone = join(root, 'clone');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'init', '-q', '-b', 'main', seed);
    card(seed, '1-old.md', 'xaaaaaa');
    git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'seed'); git(seed, 'push', '-q', origin, 'main');
    git(root, 'clone', '-q', origin, clone);
    git(clone, 'checkout', '-q', '-b', 'work');
    writeFileSync(join(clone, 'main-only.txt'), 'x\n'); git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'main tip');
    const tip = git(clone, 'rev-parse', 'HEAD');
    card(clone, '2-new.md', 'xbbbbbb'); git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'pr head');
    head = git(clone, 'rev-parse', 'HEAD');
    git(clone, 'push', '-q', 'origin', `${tip}:refs/heads/main`, `${head}:refs/heads/lane/pr`);
    git(clone, 'commit-graph', 'write', '--reachable');
    git(clone, 'checkout', '-q', 'main'); git(clone, 'branch', '-qD', 'work');
    git(clone, 'update-ref', '-d', 'refs/remotes/origin/main');
    git(clone, 'reflog', 'expire', '--expire=now', '--all');
    for (const oid of [tip, head]) rmSync(join(clone, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reproduces the incident: without a heal the planted graph makes the check unreadable', () => {
    const out = checkBornAsCollision({ exec: execFileSync, headSha: head, cwd: clone, primary: seed, heal: () => ({ actions: [] }) });
    expect(out.error).toMatch(/commit-graph|commit graph/);
  });
  it('heals the clone, retries the fetch once and reads the evidence', () => {
    const lines = [];
    expect(checkBornAsCollision({ exec: execFileSync, headSha: head, cwd: clone, primary: seed, log: line => lines.push(line) }))
      .toEqual({ ok: true, healed: expect.arrayContaining([expect.stringContaining('commit-graph')]) });
    expect(lines.join('\n')).toContain('lane-repair');
  });
  it('leaves a corrupt primary checkout untouched and holds the check unreadable', () => {
    const graph = join(clone, '.git', 'objects', 'info', 'commit-graph');
    const out = checkBornAsCollision({ exec: execFileSync, headSha: head, cwd: clone, primary: clone });
    expect(out.error).toMatch(/commit-graph|commit graph/);
    expect(out.healed).toBeUndefined();
    expect(existsSync(graph)).toBe(true);
  });
});

describe('enqueueOutcomeEvent', () => {
  it('names the reason for a skipped enqueue', () => {
    expect(enqueueOutcomeEvent({ repo: 'o/r', outcome: { num: 5974, outcome: 'not-enqueued', kind: 'batching-deferred', reason: 'queue holds 1 group(s) (max 1)' } }))
      .toEqual({ kind: 'enqueue-skipped', repo: 'o/r', pr: 5974, detail: { kind: 'batching-deferred', reason: 'queue holds 1 group(s) (max 1)' } });
  });
  it('names the reason for an enqueue', () => {
    expect(enqueueOutcomeEvent({ repo: 'o/r', outcome: { num: 5974, outcome: 'enqueued', already: false } }))
      .toEqual({ kind: 're-enqueued', repo: 'o/r', pr: 5974, detail: { reason: 'cleared by the pass', already: false } });
  });
  it('gives a fallback reason when none is supplied', () => {
    expect(enqueueOutcomeEvent({ repo: 'o/r', outcome: { num: 1, outcome: 'not-enqueued' } }).detail.reason).toBe('no reason reported');
  });
});
