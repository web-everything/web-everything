/** The #5025 regression: only proven drain numbering can carry a recorded acceptance. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReviewLabelSingleHomeCode } from '../review-skill-guard.mjs';
import {
  MAX_NUMBERING_COMMITS, parseNumberingSubject, isMappedRewrite, checkNumberingCommit, proveNumberingOnlyMove,
  planNumberingRestamp, buildNumberingRestampBody, restampAfterNumbering, _resetNumberingRestampMemo,
} from '../numbering-carry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const subject = 'drain: JIT-number xf74q20→#6053, xztd0mv→#6054 at land (#2288)';
it('keeps numbering acceptance writes in the shared review-label provider', () => {
  const files = ['scripts/lib/numbering-carry.mjs', 'scripts/lib/review-label-provider.mjs'].map((file) => ({
    file, content: readFileSync(join(ROOT, file), 'utf8'),
  }));
  expect(checkReviewLabelSingleHomeCode(files).errors).toEqual([]);
});
const map = new Map([['xf74q20', '6053'], ['xztd0mv', '6054']]);
const rewrite = (text, pairs = map) => text.replace(/\bx[0-9a-z]{6}\b/g, (hash) => pairs.get(hash) ?? hash);
const stamp = (text, hash) => text.replace(/^---\n/, `---\nbornAs: ${hash}\n`);
function live() {
  const changes = [{ status: 'M', path: 'backlog/4815-a-not-real-ruling.md',
    before: '#xztd0mv. and #xf74q20.', after: '#6054. and #6053.' }];
  for (const [hash, number] of map) {
    const slug = hash === 'xf74q20' ? 'hold-auto-land' : 'retire';
    const before = `---\nkind: story\n---\nsee \`${hash === 'xf74q20' ? 'xztd0mv' : 'xf74q20'}\`\n`;
    changes.push({ status: 'D', path: `backlog/${hash}-${slug}.md`, before });
    changes.push({ status: 'A', path: `backlog/${number}-${slug}.md`, after: stamp(rewrite(before), hash) });
  }
  return { subject, parents: ['parent'], changes };
}
function refused(result, reason) {
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(reason);
}

describe('parseNumberingSubject', () => {
  it('parses the live subject', () => expect([...parseNumberingSubject(subject)]).toEqual([...map]));
  it.each([
    'drain: JIT-number xf74q20 duplicate dropped (existing) at land (#2288)',
    'ordinary author change', 'drain: JIT-number  at land (#2288)',
    'drain: JIT-number xf74q20→#6053, xf74q20→#6054 at land (#2288)',
    'drain: JIT-number xf74q20→#6053, xztd0mv→#6053 at land (#2288)',
    `${subject}\n`, subject.replace(', ', ','),
  ])('refuses malformed or repeated pairs: %s', (value) => expect(parseNumberingSubject(value)).toBeNull());
});

describe('isMappedRewrite', () => {
  it('allows full and partial swaps', () => {
    expect(isMappedRewrite('#xf74q20 / xztd0mv', '#6053 / 6054', map)).toBe(true);
    expect(isMappedRewrite('#xf74q20 / xztd0mv', '#6053 / xztd0mv', map)).toBe(true);
  });
  it('refuses unrelated replacements, changed characters and leftovers', () => {
    expect(isMappedRewrite('xabc123', '7001', map)).toBe(false);
    expect(isMappedRewrite('#xf74q20.', '#6053!', map)).toBe(false);
    expect(isMappedRewrite('xf74q20', '6053extra', map)).toBe(false);
    expect(isMappedRewrite('axf74q20', 'a6053', map)).toBe(false);
  });
});

describe('checkNumberingCommit', () => {
  it('proves the live #5025 shape: one modification and two stamped renames', () => {
    expect(checkNumberingCommit(live())).toEqual({ ok: true, pairs: [...map], renames: [
      { from: 'backlog/xf74q20-hold-auto-land.md', to: 'backlog/6053-hold-auto-land.md' },
      { from: 'backlog/xztd0mv-retire.md', to: 'backlog/6054-retire.md' },
    ] });
  });
  it.each([
    ['merge', (o) => { o.parents.push('other'); }, /parent/],
    ['non-id edit in rename', (o) => { o.changes[2].after += 'author edit'; }, /content|rewrite/],
    ['extra added file', (o) => { o.changes.push({ status: 'A', path: 'scripts/x.mjs', after: 'new' }); }, /partner|unpaired/],
    ['code change', (o) => { o.changes.push({ status: 'M', path: 'scripts/app.mjs', before: 'old', after: 'new' }); }, /rewrite/],
    ['unused subject pair', (o) => { o.subject = o.subject.replace(' at land', ', xabc123→#7001 at land'); }, /rename/],
    ['wrong target number', (o) => { o.changes[2].path = 'backlog/9999-hold-auto-land.md'; }, /partner|unpaired/],
    ['unsupported status', (o) => { o.changes[0].status = 'T'; }, /status/],
    ['no changes', (o) => { o.changes = []; }, /change/],
    ['unchanged M', (o) => { o.changes[0].after = o.changes[0].before; }, /unchanged/],
    ['wrong bornAs', (o) => { o.changes[2].after = o.changes[2].after.replace('bornAs: xf74q20', 'bornAs: xabc123'); }, /content|rewrite/],
  ])('refuses %s', (_name, mutate, reason) => {
    const o = live();
    mutate(o);
    refused(checkNumberingCommit(o), reason);
  });
  it('extraMap proves reference rewrites, never renames', () => {
    const o = live();
    o.extraMap = new Map([['xabc123', '7001']]);
    o.changes.push({ status: 'M', path: 'backlog/0001-parent.md', before: '#xabc123', after: '#7001' });
    expect(checkNumberingCommit(o).ok).toBe(true);
    o.changes.push({ status: 'D', path: 'backlog/xabc123-extra.md', before: 'card' });
    o.changes.push({ status: 'A', path: 'backlog/7001-extra.md', after: 'card' });
    refused(checkNumberingCommit(o), /partner|unpaired|subject/);
  });
  it('refuses renames outside backlog and missing blobs', () => {
    const o = live();
    o.changes[1].path = 'scripts/xf74q20-hold-auto-land.md';
    o.changes[2].path = 'scripts/6053-hold-auto-land.md';
    refused(checkNumberingCommit(o), /backlog/);
    const missing = live();
    delete missing.changes[1].before;
    refused(checkNumberingCommit(missing), /blob|content/);
  });
  it('preserves existing bornAs and refuses adding a second stamp', () => {
    const o = live();
    o.changes[1].before = stamp(o.changes[1].before, 'xf74q20');
    expect(checkNumberingCommit(o).ok).toBe(true);
    o.changes[2].after = stamp(o.changes[2].after, 'xf74q20');
    refused(checkNumberingCommit(o), /content|rewrite/);
  });
});

const repos = [];
afterEach(() => { for (const cwd of repos.splice(0)) rmSync(cwd, { recursive: true, force: true }); });
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'numbering-carry-'));
  repos.push(cwd);
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, text) => writeFileSync(join(cwd, path), text);
  const commit = (message) => { git(['add', '-A']); git(['commit', '-q', '-m', message]); return git(['rev-parse', 'HEAD']); };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Numbering Test']);
  mkdirSync(join(cwd, 'backlog'));
  mkdirSync(join(cwd, 'scripts'));
  write('backlog/xabc123-foo.md', '---\nkind: story\n---\nsee #xdef456\n');
  write('backlog/xdef456-bar.md', '---\nkind: story\n---\nsee #xabc123\n');
  write('backlog/0001-parent.md', 'see #xabc123\n');
  write('scripts/app.mjs', 'export const value = 1;\n');
  const base = commit('base');
  git(['update-ref', 'refs/remotes/origin/main', base]);
  const number = (mixed = false) => {
    const pairs = new Map([['xabc123', '7001'], ['xdef456', '7002']]);
    for (const [hash, n] of pairs) {
      const slug = hash === 'xabc123' ? 'foo' : 'bar';
      const old = `backlog/${hash}-${slug}.md`;
      const target = `backlog/${n}-${slug}.md`;
      const content = readFileSync(join(cwd, old), 'utf8');
      git(['mv', old, target]);
      write(target, stamp(rewrite(content, pairs), hash));
    }
    write('backlog/0001-parent.md', 'see #7001\n');
    if (mixed) write('scripts/app.mjs', 'export const value = 2;\n');
    return commit('drain: JIT-number xabc123→#7001, xdef456→#7002 at land (#2288)');
  };
  const author = () => { write('scripts/app.mjs', 'export const value = 3;\n'); return commit('ordinary author change'); };
  const prove = (head, exec = execFileSync) => proveNumberingOnlyMove({ exec, cwd, fromSha: base, toSha: head });
  return { cwd, git, write, commit, base, number, author, prove };
}

describe('proveNumberingOnlyMove (real git)', () => {
  it('proves a single numbering commit', () => {
    const r = repo();
    const head = r.number();
    expect(r.prove(head)).toMatchObject({ ok: true, commits: [head], pairs: [['xabc123', '7001'], ['xdef456', '7002']] });
    expect(r.prove(head).reason).toContain('card renames and id rewrites only');
  });
  it('a numbering commit mixed with any other change must NOT re-stamp', () => {
    const r = repo();
    refused(r.prove(r.number(true)), /rewrite/);
  });
  it('refuses valid numbering followed by an ordinary author commit', () => {
    const r = repo(); r.number(); refused(r.prove(r.author()), /subject/);
  });
  it('refuses an ordinary author commit followed by numbering', () => {
    const r = repo(); r.author(); refused(r.prove(r.number()), /subject/);
  });
  it('refuses no head move', () => { const r = repo(); refused(r.prove(r.base), /no head move/); });
  it('reads extraMap from main and tolerates missing mainRef', () => {
    const r = repo();
    r.write('backlog/8000-previous.md', '---\nbornAs: xghi789\n---\n');
    const main = r.commit('previous numbering on main');
    r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['reset', '--hard', r.base]);
    r.write('backlog/0001-parent.md', 'see #xabc123 and #xghi789\n');
    const fromSha = r.commit('parent with reference');
    r.number();
    r.write('backlog/0001-parent.md', 'see #7001 and #8000\n');
    r.git(['add', '-A']); r.git(['commit', '--amend', '--no-edit', '-q']);
    const toSha = r.git(['rev-parse', 'HEAD']);
    expect(proveNumberingOnlyMove({ exec: execFileSync, cwd: r.cwd, fromSha, toSha }).ok).toBe(true);
    refused(proveNumberingOnlyMove({ exec: execFileSync, cwd: r.cwd, fromSha, toSha, mainRef: 'missing' }), /rewrite/);
    const plain = repo();
    const head = plain.number();
    expect(proveNumberingOnlyMove({ exec: execFileSync, cwd: plain.cwd, fromSha: plain.base, toSha: head, mainRef: 'missing' }).ok)
      .toBe(true);
  });
  it('refuses unreadable commits without throwing, fetching only once', () => {
    const r = repo();
    const calls = [];
    const exec = (cmd, args, opts) => { calls.push(args); return execFileSync(cmd, args, opts); };
    refused(r.prove('abcdef0123456789abcdef0123456789abcdef0123', exec), /failed|readable/);
    expect(calls.filter((args) => args[0] === 'fetch')).toHaveLength(1);
  });
  it('proves successive numbering commits and refuses a chain beyond the limit', () => {
    const r = repo();
    const hashes = ['xghi789', 'xjkl012', 'xmno345', 'xpqr678', 'xstu901'];
    for (const hash of hashes) r.write(`backlog/${hash}-next.md`, '---\nkind: story\n---\n');
    const fromSha = r.commit('additional pending cards');
    const commits = [r.number()];
    for (const [i, hash] of hashes.entries()) {
      const path = `backlog/${8001 + i}-next.md`;
      r.git(['mv', `backlog/${hash}-next.md`, path]);
      r.write(path, `---\nbornAs: ${hash}\nkind: story\n---\n`);
      commits.push(r.commit(`drain: JIT-number ${hash}→#${8001 + i} at land (#2288)`));
      const result = proveNumberingOnlyMove({ exec: execFileSync, cwd: r.cwd, fromSha, toSha: commits.at(-1) });
      if (commits.length <= MAX_NUMBERING_COMMITS) expect(result).toMatchObject({ ok: true, commits });
      else refused(result, /limit/);
    }
  });
  it('refuses a numbering commit on a different base', () => {
    const r = repo();
    const fromSha = r.author();
    r.git(['reset', '--hard', r.base]);
    const toSha = r.number();
    refused(proveNumberingOnlyMove({ exec: execFileSync, cwd: r.cwd, fromSha, toSha }), /linear/);
  });
  it('rechecks after fetching once and passes cwd and the blob buffer limit to every call', () => {
    const r = repo();
    const head = r.number();
    const calls = [];
    let unreadable = true;
    const exec = (cmd, args, opts) => {
      calls.push(args);
      expect(opts.cwd).toBe(r.cwd);
      expect(opts.maxBuffer).toBe(64 * 1024 * 1024);
      if (args[0] === 'cat-file' && args[1] === '-e' && unreadable) {
        unreadable = false;
        throw new Error('simulated missing object');
      }
      if (args[0] === 'fetch') return '';
      return execFileSync(cmd, args, opts);
    };
    expect(r.prove(head, exec).ok).toBe(true);
    expect(calls.slice(0, 3)).toEqual([
      ['cat-file', '-e', `${r.base}^{commit}`],
      ['fetch', '--no-tags', '-q', 'origin', r.base],
      ['cat-file', '-e', `${r.base}^{commit}`],
    ]);
  });
  it.each(['rev-list', 'log', 'diff', 'cat-file'])('fails closed on a %s read error', (operation) => {
    const r = repo();
    const head = r.number();
    const exec = (cmd, args, opts) => {
      if (args[0] === operation && (operation !== 'cat-file' || args[1] === 'blob')) throw new Error('read failed');
      return execFileSync(cmd, args, opts);
    };
    refused(r.prove(head, exec), /failed/);
  });
  it('exports the bounded chain limit', () => expect(MAX_NUMBERING_COMMITS).toBe(5));
});

const FROM = '8'.repeat(40);
const TO = 'e'.repeat(40);
const accept = (sha = FROM) => ({ author: { login: 'chalbert' }, createdAt: '2026-10-12T10:00:00Z',
  body: `✅ review — human cleared\n<!-- reviewed-sha: ${sha} -->\n<!-- reviewed-diff: ${'a'.repeat(64)} -->\n`
    + `<!-- reviewed-contribution: ${'b'.repeat(64)} -->\n<!-- cleared-human: chalbert -->` });
const liveComments = () => [accept(),
  { body: '<!-- drain-skip-reason -->\nskipped' },
  { body: '<!-- drain-park-reason -->\n⏸ **Parked for review by the drain**\nreview:accepted is STALE — head moved' },
  { body: '🔔 conveyor — needs your decision\nreview cap' },
  { body: '**`review:accepted` removed — stale acceptance beside `review:pending`.**\nold head' }];
const facts = () => ({ labels: ['review:pending'], headSha: TO, comments: liveComments(), reviews: [] });
afterEach(_resetNumberingRestampMemo);
describe('numbering acceptance restamp', () => {
  it('recovers the exact #5025 thread without losing its actor', () => {
    expect(planNumberingRestamp(facts())).toEqual({ candidate: true, from: FROM, to: TO, human: true, actor: 'chalbert' });
  });
  it.each(['🔁 review — changes requested', 'Please wait for me'])('refuses a later objection: %s', (body) => {
    const f = facts(); f.comments.push({ body });
    expect(planNumberingRestamp(f).candidate).toBe(false);
  });
  it('refuses formal objections, human holds and already-bound records; retries unreadable reviews', () => {
    expect(planNumberingRestamp({ ...facts(), reviews: [{ state: 'CHANGES_REQUESTED' }] }).candidate).toBe(false);
    expect(planNumberingRestamp({ ...facts(), labels: ['review:pending', 'review:human'] }).candidate).toBe(false);
    expect(planNumberingRestamp({ ...facts(), headSha: FROM }).candidate).toBe(false);
    expect(planNumberingRestamp({ ...facts(), reviews: null })).toMatchObject({ candidate: false, retryable: true });
  });
  it('writes a record every acceptance reader recognizes, with the original human actor', async () => {
    const { latestHumanClearance } = await import('../human-clearance-carry.mjs');
    const { latestAcceptRecord } = await import('../accept-carry-forward.mjs');
    const body = buildNumberingRestampBody({ fromSha: FROM, toSha: TO, human: true, actor: 'chalbert',
      headDiffText: 'diff --git a/x b/x\n-old\n+new\n', proofReason: 'verified', writer: 'review-daemon' });
    const comments = [...liveComments(), { author: { login: 'chalbert' }, body }];
    expect(latestHumanClearance(comments)).toMatchObject({ sha: TO, actor: 'chalbert' });
    expect(latestAcceptRecord(comments).sha).toBe(TO);
    expect(buildNumberingRestampBody({ fromSha: FROM, toSha: TO, human: false })).not.toContain('cleared-human:');
  });
  const run = (over = {}) => restampAfterNumbering({ repo: 'o/n', pr: 5025,
    state: { labels: ['review:pending'], headRefOid: TO, comments: liveComments() }, reviews: [], ...over });
  it('posts before labels, then remembers the settled head', () => {
    const calls = [];
    const provider = { postComment: () => calls.push('comment'), setLabels: (_r, _n, spec) => calls.push(spec) };
    const opts = { provider, prove: () => ({ ok: true, reason: 'verified' }) };
    expect(run(opts).action).toBe('restamped');
    expect(calls).toEqual(['comment', { add: 'review:accepted', remove: ['review:pending'] }]);
    expect(run(opts)).toBeNull();
  });
  it('refuses mixed changes without writes and remembers the refusal', () => {
    const provider = { postComment: () => { throw Error('unexpected write'); }, setLabels: () => { throw Error('unexpected write'); } };
    const opts = { provider, prove: () => ({ ok: false, reason: 'a numbering commit mixed with another change' }) };
    expect(run(opts).action).toBe('refused');
    expect(run(opts)).toBeNull();
  });
  it('dry run writes nothing and does not settle a successful proof', () => {
    const opts = { dryRun: true, prove: () => ({ ok: true, reason: 'verified' }) };
    expect(run(opts).action).toBe('would-restamp');
    expect(run(opts).action).toBe('would-restamp');
  });
  it('retries a comment failure without changing labels', () => {
    const calls = [];
    const opts = { prove: () => ({ ok: true, reason: 'verified' }), provider: {
      postComment: () => { calls.push('comment'); throw Error('offline'); }, setLabels: () => calls.push('labels') } };
    expect(run(opts)).toEqual({ action: 'error', reason: 'offline' });
    expect(run(opts).action).toBe('error');
    expect(calls).toEqual(['comment', 'comment']);
  });
  it('reports a posted comment when the label write fails and leaves the head retryable', () => {
    const opts = { prove: () => ({ ok: true, reason: 'verified' }), provider: {
      postComment: () => {}, setLabels: () => { throw Error('offline'); } } };
    expect(run(opts)).toEqual({ action: 'error', reason: 'offline', commentPosted: true });
    expect(run(opts).action).toBe('error');
  });
  it.each([false, true])('finishes only the labels after a recorded re-stamp (accepted already present: %s)', (accepted) => {
    const body = buildNumberingRestampBody({ fromSha: FROM, toSha: TO, human: true, actor: 'chalbert', proofReason: 'verified', writer: 'review-daemon' });
    const calls = [];
    const r = run({ state: { labels: ['review:pending', ...(accepted ? [{ name: 'review:accepted' }] : [])], headRefOid: TO, comments: [...liveComments(), { author: { login: 'chalbert' }, body }] },
      prove: () => { throw Error('no proof is owed for a recorded re-stamp'); },
      provider: { postComment: () => calls.push('comment'), setLabels: (_r, _n, spec) => calls.push(spec) } });
    expect(r).toMatchObject({ action: 'restamped', labelsOnly: true, from: FROM, to: TO, actor: 'chalbert' });
    expect(calls).toEqual([{ add: accepted ? undefined : 'review:accepted', remove: ['review:pending'] }]);
  });
  it('an ordinary accept already bound to the head is not a candidate', () => {
    expect(planNumberingRestamp({ ...facts(), comments: [accept(TO)] })).toMatchObject({ candidate: false, reason: 'already bound' });
  });
  it('omits diff markers after an unscored read and does not add an already-present accepted label', () => {
    const calls = [];
    expect(run({ state: { labels: ['review:pending', { name: 'review:accepted' }], headRefOid: TO, comments: liveComments() },
      prove: () => ({ ok: true, reason: 'verified' }), readNetDiff: () => ({ scored: false, text: 'unscored' }),
      provider: { postComment: (_r, _n, body) => calls.push(body), setLabels: (_r, _n, spec) => calls.push(spec) } }).action)
      .toBe('restamped');
    expect(calls[0]).not.toContain('reviewed-diff:');
    expect(calls[1]).toEqual({ add: undefined, remove: ['review:pending'] });
  });
  it('refuses a real numbering commit that also edits code without writes', () => {
    const r = repo(); const head = r.number(true);
    const writes = [];
    expect(run({ cwd: r.cwd, state: { labels: ['review:pending'], headRefOid: head, comments: [accept(r.base)] },
      provider: { postComment: () => writes.push('comment'), setLabels: () => writes.push('labels') } }).action).toBe('refused');
    expect(writes).toEqual([]);
  });
});
