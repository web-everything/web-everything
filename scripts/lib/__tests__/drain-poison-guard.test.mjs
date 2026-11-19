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

// A fake git: `added` = files the PR adds, `texts` = file text at the PR head, `main` = grep output lines,
// `mainTexts` = file text on main. `diff` and `grep` answer in their `-z` formats.
function fakeExec({ added = [newCard], texts = { [newCard]: cardText('xgcpm6z') }, main = `origin/main:${mainCard}\0bornAs: xgcpm6z`,
  mainTexts = { [mainCard]: cardText('xgcpm6z') }, fetchFails = false, grepError = false } = {}) {
  return vi.fn((cmd, args) => {
    if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
    if (args[0] === 'fetch') { if (fetchFails) throw new Error('network down'); return ''; }
    if (args[0] === 'diff') return added.map(path => `${path}\0`).join('');
    if (args[0] === 'show') {
      const [rev, ...rest] = args[1].split(':');
      return (rev.startsWith('origin/') ? mainTexts : texts)[rest.join(':')];
    }
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

  // Red-team break on 9c66df06c: `git grep` hits a body example, so a unique card was refused and labelled.
  const exampleBody = (own, example) => `---\nbornAs: ${own}\nkind: story\n---\n# Card\n\n\`\`\`yaml\n---\nbornAs: ${example}\n---\n\`\`\`\n`;
  it('ignores an identity example in the body of a main card', () => {
    const exec = fakeExec({ mainTexts: { [mainCard]: exampleBody('xaaaaaa', 'xgcpm6z') } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ ok: true });
  });
  it('still reports a collision when the same main card also owns the hash in its frontmatter', () => {
    const exec = fakeExec({ mainTexts: { [mainCard]: exampleBody('xgcpm6z', 'xgcpm6z') } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ collision: { hash: 'xgcpm6z', path: newCard, mainCard } });
  });
  it('reads a CRLF or BOM-prefixed main card frontmatter as frontmatter', () => {
    const exec = fakeExec({ main: `origin/main:${mainCard}\0bornAs: xgcpm6z\r`, mainTexts: { [mainCard]: '\uFEFF---\r\nbornAs: xgcpm6z\r\n---\r\nbody\r\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha }).collision?.hash).toBe('xgcpm6z');
  });
  it.each([['no fence', 'bornAs: xgcpm6z\nno frontmatter fence\n'], ['an unclosed fence', '---\nbornAs: xgcpm6z\nbody\n']])(
    'holds a top-level main card hit with %s as unreadable, never as a labelling collision', (_, text) => {
      const exec = fakeExec({ mainTexts: { [mainCard]: text } });
      expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ error: expect.stringContaining(`${mainCard} has no readable frontmatter`) });
    });
  // The standards check reads `bornAs` with gray-matter (YAML); every spelling YAML accepts must mean the same here.
  const spellings = [['a trailing comment', 'bornAs: xgcpm6z # minted twice'], ['a quoted value then a comment', 'bornAs: "xgcpm6z"# copied'],
    ['a quoted key', '"bornAs": xgcpm6z'], ['a space before the colon', 'bornAs : xgcpm6z'], ['padding inside the quotes', 'bornAs: " xgcpm6z "']];
  it.each(spellings)('reads a main card identity written with %s', (_, line) => {
    const exec = fakeExec({ main: `origin/main:${mainCard}\0${line}`, mainTexts: { [mainCard]: `---\n${line}\nkind: story\n---\n` } });
    expect(checkBornAsCollision({ exec, headSha: sha }).collision?.hash).toBe('xgcpm6z');
  });
  it.each(spellings)('reads an added card identity written with %s', (_, line) => {
    const exec = fakeExec({ texts: { [newCard]: `---\n${line}\nkind: story\n---\n` } });
    expect(checkBornAsCollision({ exec, headSha: sha }).collision?.hash).toBe('xgcpm6z');
  });
  it('ignores a main card line YAML does not read as bornAs (no space after the colon)', () => {
    const exec = fakeExec({ mainTexts: { [mainCard]: '---\nbornAs:xgcpm6z\n---\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ ok: true });
  });
  // Self-review break on e551e17b5: a main card whose frontmatter YAML fails fell back to raw identity lines and was
  // labelled, though duplicateBornAs skips such a card. With a mistyped closing fence those lines reach a body example.
  it.each([['a duplicate key', '---\nbornAs: xaaaaaa\nbornAs: xgcpm6z\n---\n'],
    ['a mistyped closing fence that runs into a body example', '---\nbornAs: xaaaaaa\n--\nExample:\nbornAs: xgcpm6z\n---\n']])(
    'holds a main card whose frontmatter is not valid YAML (%s) as unreadable, never as a labelling collision', (_, text) => {
      const exec = fakeExec({ mainTexts: { [mainCard]: text } });
      expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ error: expect.stringContaining(`${mainCard} has no readable frontmatter`) });
    });
  it('reports a readable main duplicate even when an unreadable main card sorts before it', () => {
    const broken = 'backlog/7000-broken.md';
    const exec = fakeExec({ main: `origin/main:${broken}\0bornAs: xgcpm6z\norigin/main:${mainCard}\0bornAs: xgcpm6z`,
      mainTexts: { [broken]: '---\nbornAs: xaaaaaa\n--\nExample:\nbornAs: xgcpm6z\n---\n', [mainCard]: cardText('xgcpm6z') } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ collision: { hash: 'xgcpm6z', path: newCard, mainCard } });
  });
  it('treats an invalid-YAML file below a backlog subdirectory on main as no card', () => {
    const raised = 'backlog/raised-by/7233.md';
    const exec = fakeExec({ main: `origin/main:${raised}\0bornAs: xgcpm6z`, mainTexts: { [raised]: '---\nbornAs: xgcpm6z\nbornAs: xgcpm6z\n---\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ ok: true });
  });
  // Self-review break on 653b7a4c7: an added card's fallback lines (no or invalid frontmatter) reached a labelling
  // collision, though duplicateBornAs reads no bornAs from such a card. They are still searched, but a hit holds.
  it.each([['frontmatter that is not valid YAML', '---\nbornAs: xaaaaaa\nbornAs: xgcpm6z\n---\n'],
    ['no frontmatter and a body example', '# Title\n\n```yaml\nbornAs: xgcpm6z\n```\n'], ['a blank first line', '\n---\nbornAs: xgcpm6z\n---\n']])(
    'holds an added card whose identity comes only from %s, never as a labelling collision', (_, text) => {
      const exec = fakeExec({ texts: { [newCard]: text } });
      expect(checkBornAsCollision({ exec, headSha: sha }))
        .toEqual({ error: `added card ${newCard} carries xgcpm6z outside readable frontmatter, which main card ${mainCard} holds` });
    });
  it('still reports a collision by file name for a hash-named added card without frontmatter', () => {
    const named = 'backlog/xgcpm6z-new.md';
    const exec = fakeExec({ added: [named], texts: { [named]: '# Title\nbornAs: xgcpm6z\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ collision: { hash: 'xgcpm6z', path: named, mainCard } });
  });
  // gray-matter reads a named opener with that language's engine; the guard never runs one, so such a card holds.
  it.each([['---json', '---json\n{"bornAs":"xgcpm6z"}\n---\n'], ['---yaml', '---yaml\nbornAs:\n  xgcpm6z\n---\n'], ['---js', '---js\n({ bornAs: "xgcpm6z" })\n---\n']])(
    'holds an added card opened with %s as unreadable, never admitting it', (_, text) => {
      const exec = fakeExec({ texts: { [newCard]: text } });
      expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ error: `added card ${newCard} has no readable frontmatter` });
    });
  it('holds a main card opened with a named language on any hit, never admitting the PR', () => {
    const exec = fakeExec({ main: `origin/main:${mainCard}\0{"bornAs":"xgcpm6z"}`, mainTexts: { [mainCard]: '---json\n{"bornAs":"xgcpm6z"}\n---\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ error: `main card ${mainCard} has no readable frontmatter` });
  });
  it('closes frontmatter where gray-matter does: at the first later line starting `---`', () => {
    // A `--- note` line ends the block, so the second `bornAs` below it is body text, not a duplicate YAML key.
    const exec = fakeExec({ mainTexts: { [mainCard]: '---\nbornAs: xgcpm6z\n--- note\nbornAs: xaaaaaa\n---\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ collision: { hash: 'xgcpm6z', path: newCard, mainCard } });
  });
  it('reads an unclosed frontmatter block to the end of the file, as gray-matter does', () => {
    const exec = fakeExec({ mainTexts: { [mainCard]: '---\nkind: story\nbornAs: xgcpm6z\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha }).collision?.hash).toBe('xgcpm6z');
  });
  it('never reads a frontmatter `id` as an identity, since the backlog loader replaces it with the file name', () => {
    const exec = fakeExec({ mainTexts: { [mainCard]: '---\nid: xgcpm6z\nbornAs: xzzzzzz\n---\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ ok: true });
    const added = fakeExec({ texts: { [newCard]: '---\nid: xgcpm6z\n---\n' } });
    expect(checkBornAsCollision({ exec: added, headSha: sha })).toEqual({ ok: true });
    expect(added.mock.calls.some(([, a]) => a[0] === 'grep')).toBe(false);
  });
  it('treats a file below a backlog subdirectory as no card, even with readable frontmatter', () => {
    const raised = 'backlog/raised-by/7233.md';
    const exec = fakeExec({ main: `origin/main:${raised}\0bornAs: xgcpm6z`, mainTexts: { [raised]: cardText('xgcpm6z') } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ ok: true });
    const added = fakeExec({ added: ['backlog/raised-by/7274.md'], texts: { 'backlog/raised-by/7274.md': cardText('xgcpm6z') } });
    expect(checkBornAsCollision({ exec: added, headSha: sha })).toEqual({ ok: true });
  });
  it('holds, without reading any main card, when more main cards mention an added hash than the read bound', async () => {
    const { MAX_MAIN_READS } = await import('../drain-poison-guard.mjs');
    const main = Array.from({ length: MAX_MAIN_READS + 1 }, (_, i) => `origin/main:backlog/${i}-c.md\0see xgcpm6z`).join('\n');
    const exec = fakeExec({ main });
    expect(checkBornAsCollision({ exec, headSha: sha }))
      .toEqual({ error: `${MAX_MAIN_READS + 1} main cards mention an added hash, over the ${MAX_MAIN_READS}-card read bound` });
    expect(exec.mock.calls.filter(([, a]) => a[0] === 'show' && a[1].startsWith('origin/'))).toEqual([]);
  });
  it('searches main for the added hashes as plain text, not for an identity key spelling', () => {
    const exec = fakeExec();
    checkBornAsCollision({ exec, headSha: sha });
    const grep = exec.mock.calls.find(([, args]) => args[0] === 'grep')[1];
    expect(grep.slice(0, 6)).toEqual(['grep', '-z', '--text', '-F', '-e', 'xgcpm6z']);
  });
  it('treats a backslash in a card name as no card, since the backlog loader skips such a name', () => {
    const odd = 'backlog/7233-a\\b.md';
    const exec = fakeExec({ main: `origin/main:${odd}\0bornAs: xgcpm6z`, mainTexts: { [odd]: cardText('xgcpm6z') } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ ok: true });
  });
  it('holds when a main path holding a newline splits a grep output line', () => {
    const exec = fakeExec({ main: `origin/main:backlog/7233-a\nb.md\0bornAs: xgcpm6z` });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ error: 'main grep output names a path it cannot delimit' });
  });
  it('reads no main card whose hit only holds the hash inside a longer word', () => {
    const exec = fakeExec({ main: `origin/main:${mainCard}\0see axgcpm6z and xgcpm6z_b` });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ ok: true });
    expect(exec.mock.calls.filter(([, a]) => a[0] === 'show' && a[1].startsWith('origin/'))).toEqual([]);
  });
  // Self-review break on c86b3ae42: Git's `-w` missed a hash right after a YAML escape, which YAML decodes and trims.
  it.each([['\\t', '"\\txgcpm6z"'], ['\\x09', '"\\x09xgcpm6z"'], ['\\u0009', '"\\u0009xgcpm6z"']])(
    'reports a main identity written after a %s escape, which duplicateBornAs reads as the bare hash', (_, value) => {
      const exec = fakeExec({ main: `origin/main:${mainCard}\0bornAs: ${value}`, mainTexts: { [mainCard]: `---\nbornAs: ${value}\n---\n` } });
      expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ collision: { hash: 'xgcpm6z', path: newCard, mainCard } });
    });
  it('treats a frontmatter-less file below a backlog subdirectory as no card', () => {
    const raised = 'backlog/raised-by/7233.md';
    const exec = fakeExec({ main: `origin/main:${raised}\0bornAs: xgcpm6z`, mainTexts: { [raised]: '- Also raised by:\nbornAs: xgcpm6z\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ ok: true });
  });
  it('takes the added card identity from its frontmatter, never from a body example', () => {
    const exec = fakeExec({ texts: { [newCard]: '---\nkind: story\n---\nExample:\nbornAs: xgcpm6z\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ ok: true });
  });
  it.each([['an unclosed fence', '---\nbornAs: xgcpm6z\n'], ['a `...` close', '---\nbornAs: xgcpm6z\n...\n']])(
    'still catches a duplicate in an added card with %s', (_, text) => {
      const exec = fakeExec({ texts: { [newCard]: text } });
      expect(checkBornAsCollision({ exec, headSha: sha }).collision?.hash).toBe('xgcpm6z');
    });
  it('treats an added frontmatter-less file below a backlog subdirectory as no card', () => {
    const raised = 'backlog/raised-by/7274.md';
    const exec = fakeExec({ added: [raised], texts: { [raised]: '- Also raised by:\nbornAs: xgcpm6z\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ ok: true });
  });
  it('checks every identity an added card carries, not only the first', () => {
    const exec = fakeExec({ texts: { [newCard]: '---\nid: xnewnew\nbornAs: xgcpm6z\n---\n' } });
    expect(checkBornAsCollision({ exec, headSha: sha }).collision?.hash).toBe('xgcpm6z');
  });
  it('checks an added card with a non-ASCII path that Git would otherwise quote', () => {
    const odd = 'backlog/7274-é-card.md';
    const exec = fakeExec({ added: [odd], texts: { [odd]: cardText('xgcpm6z') } });
    expect(checkBornAsCollision({ exec, headSha: sha })).toEqual({ collision: { hash: 'xgcpm6z', path: odd, mainCard } });
    expect(exec.mock.calls.filter(([, a]) => ['diff', 'grep'].includes(a[0])).every(([, a]) => a.includes('-z'))).toBe(true);
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

// The red-team scenario on 9c66df06c, in real Git: main holds a card whose body shows an identity example.
describe('checkBornAsCollision against real Git with a body identity example on main', () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (dir, name, text) => { mkdirSync(join(dir, 'backlog'), { recursive: true }); writeFileSync(join(dir, 'backlog', name), text); };
  let root, clone;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'poison-body-'));
    const origin = join(root, 'origin.git'); clone = join(root, 'clone');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, clone);
    write(clone, '1-existing.md', '---\nbornAs: xaaaaaa\n---\nExample card:\n\n```yaml\n---\nbornAs: xbbbbbb\n---\n```\n');
    git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'main'); git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const prAdding = (hash, name = '2-new.md') => {
    git(clone, 'checkout', '-q', '-B', 'pr', 'origin/main');
    write(clone, name, `---\nbornAs: ${hash}\n---\n`);
    git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'pr');
    const head = git(clone, 'rev-parse', 'HEAD');
    git(clone, 'push', '-q', 'origin', `${head}:refs/heads/lane/pr`);
    return head;
  };

  it('admits a card whose identity only appears as an example in a main card body', () => {
    expect(checkBornAsCollision({ exec: execFileSync, headSha: prAdding('xbbbbbb'), cwd: clone })).toEqual({ ok: true });
  });
  it('still refuses a card whose identity a main card owns in its frontmatter', () => {
    expect(checkBornAsCollision({ exec: execFileSync, headSha: prAdding('xaaaaaa'), cwd: clone }))
      .toEqual({ collision: { hash: 'xaaaaaa', path: 'backlog/2-new.md', mainCard: 'backlog/1-existing.md' } });
  });
  it('refuses a duplicate of a CRLF main card', () => {
    write(clone, '3-crlf.md', '---\r\nbornAs: xccccc1\r\n---\r\nbody\r\n');
    git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'crlf'); git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    git(clone, 'fetch', '-q', 'origin');
    expect(checkBornAsCollision({ exec: execFileSync, headSha: prAdding('xccccc1'), cwd: clone }))
      .toEqual({ collision: { hash: 'xccccc1', path: 'backlog/2-new.md', mainCard: 'backlog/3-crlf.md' } });
  });
  it('refuses a duplicate of a main card that holds a NUL byte, which Git greps as binary by default', () => {
    write(clone, '4-binary.md', '---\nbornAs: xddddd1\n---\nbody \0 byte\n');
    git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'binary'); git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    git(clone, 'fetch', '-q', 'origin');
    expect(checkBornAsCollision({ exec: execFileSync, headSha: prAdding('xddddd1'), cwd: clone }))
      .toEqual({ collision: { hash: 'xddddd1', path: 'backlog/2-new.md', mainCard: 'backlog/4-binary.md' } });
  });
  it('refuses a duplicate added under a non-ASCII path that Git quotes by default', () => {
    expect(checkBornAsCollision({ exec: execFileSync, headSha: prAdding('xaaaaaa', '2-é.md'), cwd: clone }))
      .toEqual({ collision: { hash: 'xaaaaaa', path: 'backlog/2-é.md', mainCard: 'backlog/1-existing.md' } });
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
