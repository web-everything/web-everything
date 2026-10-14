/** The #5025 regression: only proven drain numbering can carry a recorded acceptance. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReviewLabelSingleHomeCode } from '../review-skill-guard.mjs';
import { proveHumanClearanceCarry } from '../human-clearance-carry.mjs';
import { normalizeDiffFingerprint } from '../review-escalation.mjs';
import {
  MAX_NUMBERING_COMMITS, MAX_NUMBERING_BLOB_BYTES, parseNumberingSubject, isMappedRewrite, checkNumberingCommit, proveNumberingOnlyMove,
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
    'drain: JIT-number xf74q20→#6053, xztd0mv→#06053 at land (#2288)',
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
  it.each(['scripts/app.mjs', '.github/workflows/run.yml', 'config.json'])('refuses mapped rewrites outside backlog: %s', (path) => {
    const o = live();
    o.changes.push({ status: 'M', path, before: "'xf74q20'", after: "'6053'" });
    refused(checkNumberingCommit(o), /backlog/);
  });
  it('allows main aliases inside renamed cards', () => {
    const o = live();
    o.extraMap = new Map([['xabc123', '7001']]);
    o.changes[1].before += 'see #xabc123';
    o.changes[2].after += 'see #7001';
    expect(checkNumberingCommit(o).ok).toBe(true);
  });
  it('proves the live #5025 shape: one modification and two stamped renames', () => {
    expect(checkNumberingCommit(live())).toEqual({ ok: true, pairs: [...map], renames: [
      { from: 'backlog/xf74q20-hold-auto-land.md', to: 'backlog/6053-hold-auto-land.md' },
      { from: 'backlog/xztd0mv-retire.md', to: 'backlog/6054-retire.md' },
    ] });
  });
  it.each([
    ['merge', (o) => { o.parents.push('other'); }, /parent/],
    ['non-id edit in rename', (o) => { o.changes[2].after += 'author edit'; }, /content|rewrite/],
    ['extra added file', (o) => { o.changes.push({ status: 'A', path: 'backlog/9000-extra.md', after: 'new' }); }, /partner|unpaired/],
    ['added file outside backlog', (o) => { o.changes.push({ status: 'A', path: 'scripts/x.mjs', after: 'new' }); }, /outside backlog/],
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

// Exercise the actual IO shell without writing git state: exec observes the same raw
// bytes cat-file returns, including bytes a permissive UTF-8 decoder would discard.
function proofReader({ changes = live().changes, commitSubject = subject, subjects = [commitSubject], trees = {}, failTree } = {}) {
  const from = 'a'.repeat(40), numbered = 'b'.repeat(40);
  const heads = [numbered, 'e'.repeat(40)];
  const head = heads[subjects.length - 1];
  const calls = [];
  const blobs = new Map();
  for (const c of changes) {
    if (c.before !== undefined) blobs.set(`${from}:${c.path}`, Buffer.from(c.before));
    if (c.after !== undefined) blobs.set(`${numbered}:${c.path}`, Buffer.from(c.after));
  }
  const exec = (_cmd, args, opts) => {
    calls.push(args);
    let output = '';
    if (args[0] === 'rev-parse') output = from;
    else if (args[0] === 'rev-list') output = subjects.map((_s, i) => `${heads[i]} ${i ? heads[i - 1] : from}\n`).join('');
    else if (args[0] === 'log') output = `${subjects[heads.indexOf(args.at(-1))]}\n`;
    else if (args[0] === 'ls-tree') {
      if (args.includes(failTree)) throw Error('inventory unreadable');
      const ref = args.find((a) => a === from || a === 'origin/main');
      output = (trees[ref] ?? []).map((p) => `${p}\0`).join('');
    } else if (args[0] === 'diff') {
      output = changes.map((c) => `:${c.status === 'A' ? '000000' : '100644'} ${c.status === 'D' ? '000000' : '100644'} ${'c'.repeat(40)} ${'d'.repeat(40)} ${c.status}\0${c.path}\0`).join('');
    } else if (args[0] === 'cat-file' && ['blob', '-s'].includes(args[1])) {
      const bytes = blobs.get(args[2]);
      if (!bytes) throw Error(`missing fixture blob ${args[2]}`);
      output = args[1] === '-s' ? `${bytes.length}\n` : bytes;
    }
    return opts.encoding === null ? Buffer.from(output) : Buffer.isBuffer(output) ? output.toString('utf8') : output;
  };
  return { calls, exec, from, head, prove: () => proveNumberingOnlyMove({ exec, fromSha: from, toSha: head }) };
}

describe('proveNumberingOnlyMove read-only regressions', () => {
  it('reads zero blobs for an ordinary subject', () => {
    const r = proofReader({ commitSubject: 'ordinary author change' });
    refused(r.prove(), /subject/);
    expect(r.calls.filter((a) => a[0] === 'cat-file' && a[1] === 'blob')).toHaveLength(0);
  });
  it.each([[subject, 'ordinary author change'], ['ordinary author change', subject]])('preflights every subject before any blob: %j', (...subjects) => {
    const r = proofReader({ subjects });
    refused(r.prove(), /subject/);
    expect(r.calls.filter((a) => a[0] === 'cat-file' && a[1] === 'blob')).toHaveLength(0);
    expect(r.calls.some((a) => a[0] === 'grep')).toBe(false);
  });
  it('caps changed files before reading any blob', () => {
    const changes = Array.from({ length: 257 }, (_, i) => ({ status: 'M', path: `backlog/${i}-ref.md`, before: 'xf74q20', after: '6053' }));
    const r = proofReader({ changes });
    refused(r.prove(), /file.*limit|limit.*file/);
    expect(r.calls.filter((a) => a[0] === 'cat-file' && a[1] === 'blob')).toHaveLength(0);
  });
  it('allows a numbering commit at the changed-file limit', () => {
    const changes = live().changes;
    for (let i = changes.length; i < 256; i++) changes.push({ status: 'M', path: `backlog/${i}-ref.md`, before: '#xf74q20', after: '#6053' });
    expect(proofReader({ changes }).prove().ok).toBe(true);
  });
  it('rejects reuse of a target number across numbering commits', () => {
    const r = proofReader({ subjects: [subject, 'drain: JIT-number xabc123→#6053 at land (#2288)'] });
    refused(r.prove(), /number.*already/);
    expect(r.calls.filter((a) => a[1] === 'blob')).toHaveLength(0);
  });
  it.each(['accepted', 'main', 'leading zero'])('rejects a target number already present on %s', (where) => {
    const ref = where === 'main' ? 'origin/main' : 'a'.repeat(40);
    const r = proofReader({ trees: { [ref]: [`backlog/${where === 'leading zero' ? '06053' : '6053'}-existing.md`] } });
    refused(r.prove(), /number.*already|collision/);
    expect(r.calls.filter((a) => a[0] === 'cat-file' && a[1] === 'blob')).toHaveLength(0);
  });
  it.each(['a'.repeat(40), 'origin/main'])('fails closed when inventory %s is unreadable', (failTree) => {
    expect(proofReader({ failTree }).prove()).toMatchObject({ ok: false, retryable: true });
  });
  it.each(['rename', 'modification'])('refuses numbering combined with invalid UTF-8 byte changes in a %s', (kind) => {
    const changes = live().changes;
    const beforeIndex = kind === 'rename' ? 1 : 0, afterIndex = kind === 'rename' ? 2 : 0;
    changes[beforeIndex].before = Buffer.concat([Buffer.from(changes[beforeIndex].before), Buffer.from([0x80])]);
    changes[afterIndex].after = Buffer.concat([Buffer.from(changes[afterIndex].after), Buffer.from([0x81])]);
    refused(proofReader({ changes }).prove(), /UTF-8/);
  });
  it('preserves a UTF-8 BOM when comparing valid blob content', () => {
    const changes = live().changes;
    changes[1].before += '\ufeff';
    changes[2].after += '\ufeff';
    expect(proofReader({ changes }).prove().ok).toBe(true);
    changes[2].after = changes[2].after.slice(0, -1);
    refused(proofReader({ changes }).prove(), /rewrite/);
  });
  it('refuses removal of a leading UTF-8 BOM from a reference file', () => {
    const changes = live().changes;
    changes[0].before = `\ufeff${changes[0].before}`;
    refused(proofReader({ changes }).prove(), /rewrite/);
  });
  it('refuses an oversized blob before reading it', () => {
    const changes = live().changes;
    changes[1].before += 'a'.repeat(1024 * 1024);
    const r = proofReader({ changes });
    refused(r.prove(), /byte.*limit|limit.*byte/);
    expect(r.calls.some((a) => a[1] === 'blob' && a[2].endsWith('xf74q20-hold-auto-land.md'))).toBe(false);
  });
  it('bounds aggregate blob bytes across a proof', () => {
    const before = 'xf74q20' + 'a'.repeat(900000), after = '6053' + 'a'.repeat(900000);
    const changes = Array.from({ length: 10 }, (_, i) => ({ status: 'M', path: `backlog/${i}-ref.md`, before, after }));
    const r = proofReader({ changes });
    refused(r.prove(), /byte.*limit|limit.*byte/);
    expect(r.calls.filter((a) => a[1] === 'blob').length).toBeLessThan(20);
  });
  it.each(['subject', 'collision', 'bytes'])('keeps a failed %s proof from carrying human clearance or writing acceptance', (kind) => {
    const changes = live().changes;
    if (kind === 'bytes') {
      changes[1].before = Buffer.concat([Buffer.from(changes[1].before), Buffer.from([0x80])]);
      changes[2].after = Buffer.concat([Buffer.from(changes[2].after), Buffer.from([0x81])]);
    }
    const r = proofReader({ changes, commitSubject: kind === 'subject' ? 'ordinary author change' : subject,
      trees: kind === 'collision' ? { 'origin/main': ['backlog/6053-existing.md'] } : {} });
    const headDiff = 'diff --git a/x b/x\n-old\n+numbered\n';
    const carry = proveHumanClearanceCarry({ exec: r.exec, evidence: {
      humanClearance: { sha: r.from, diff: normalizeDiffFingerprint('diff --git a/x b/x\n-old\n+new\n'), actor: 'chalbert' },
      headSha: r.head, headDiffSha: r.head, headDiff,
    } });
    expect(carry).toMatchObject({ carry: false, applicable: true });
    const writes = [];
    const restamp = restampAfterNumbering({ repo: 'o/n', pr: 5025, exec: r.exec,
      state: { labels: ['review:pending'], headRefOid: r.head,
        comments: [{ author: { login: 'chalbert' }, body: `✅ review — human cleared\n<!-- reviewed-sha: ${r.from} -->\n<!-- cleared-human: chalbert -->` }] },
      reviews: [], enabled: true, acceptCarry: 'on', guardReferrals: () => {},
      provider: { postComment: () => writes.push('comment'), setLabels: () => writes.push('labels') },
    });
    expect(restamp.action).toBe('refused');
    expect(writes).toEqual([]);
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
  it('refuses numbering combined with invalid UTF-8 byte changes', () => {
    const r = repo();
    r.write('backlog/xabc123-foo.md', Buffer.concat([Buffer.from('---\nkind: story\n---\n'), Buffer.from([0x80])]));
    const fromSha = r.commit('card with invalid UTF-8');
    r.number();
    r.write('backlog/7001-foo.md', Buffer.concat([Buffer.from('---\nbornAs: xabc123\nkind: story\n---\n'), Buffer.from([0x81])]));
    r.git(['add', '-A']); r.git(['commit', '--amend', '--no-edit', '-q']);
    refused(proveNumberingOnlyMove({ exec: execFileSync, cwd: r.cwd, fromSha, toSha: r.git(['rev-parse', 'HEAD']) }), /UTF-8/);
  });
  it.each(['backlog/0001-parent.md', 'backlog/7001-foo.md'])('refuses numbering combined with an executable-bit change: %s', (path) => {
    const r = repo(); r.number();
    r.git(['update-index', '--chmod=+x', path]);
    r.git(['commit', '--amend', '--no-edit', '-q']);
    refused(r.prove(r.git(['rev-parse', 'HEAD'])), /mode/);
  });
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
  it('reads extraMap from main and refuses an unreadable main inventory', () => {
    const r = repo();
    r.write('backlog/8000-previous.md', '---\nbornAs: xghi789\n---\n');
    const main = r.commit('previous numbering on main');
    r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['reset', '--hard', r.base]);
    r.write('backlog/0001-parent.md', 'see #xabc123 and #xghi789\n');
    r.write('backlog/xabc123-foo.md', '---\nkind: story\n---\nsee #xdef456 and #xghi789\n');
    const fromSha = r.commit('parent with reference');
    r.number();
    r.write('backlog/0001-parent.md', 'see #7001 and #8000\n');
    r.write('backlog/7001-foo.md', '---\nbornAs: xabc123\nkind: story\n---\nsee #7002 and #8000\n');
    r.git(['add', '-A']); r.git(['commit', '--amend', '--no-edit', '-q']);
    const toSha = r.git(['rev-parse', 'HEAD']);
    expect(proveNumberingOnlyMove({ exec: execFileSync, cwd: r.cwd, fromSha, toSha }).ok).toBe(true);
    const unavailable = (cmd, args, opts) => {
      if (args[0] === 'grep') throw Error('temporary alias read failure');
      return execFileSync(cmd, args, opts);
    };
    expect(proveNumberingOnlyMove({ exec: unavailable, cwd: r.cwd, fromSha, toSha })).toMatchObject({ ok: false, retryable: true });
    expect(proveNumberingOnlyMove({ exec: execFileSync, cwd: r.cwd, fromSha, toSha, mainRef: 'missing' })).toMatchObject({ ok: false, retryable: true });
    const plain = repo();
    const head = plain.number();
    expect(proveNumberingOnlyMove({ exec: execFileSync, cwd: plain.cwd, fromSha: plain.base, toSha: head, mainRef: 'missing' }))
      .toMatchObject({ ok: false, retryable: true });
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
      expect(opts.maxBuffer).toBe(args[0] === 'cat-file' && args[1] === 'blob' ? MAX_NUMBERING_BLOB_BYTES : 8 * 1024 * 1024);
      expect(opts.encoding).toBeNull();
      expect(opts.timeout).toBe(5000);
      if (args[0] === 'cat-file' && args[1] === '-e' && unreadable) {
        unreadable = false;
        throw new Error('simulated missing object');
      }
      if (args[0] === 'fetch') return Buffer.alloc(0);
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
  it('retries a transient proof read failure on the same head', () => {
    const r = repo(); const head = r.number();
    let fail = true;
    const calls = [];
    const opts = { cwd: r.cwd, state: { labels: ['review:pending'], headRefOid: head, comments: [accept(r.base)] },
      exec: (cmd, args, opts) => {
        if (fail) throw Error('fetch unavailable');
        return execFileSync(cmd, args, opts);
      }, provider: {
      postComment: () => calls.push('comment'), setLabels: () => calls.push('labels') },
    };
    expect(run(opts).action).toBe('retry');
    fail = false;
    expect(run(opts).action).toBe('restamped');
    expect(calls).toEqual(['comment', 'labels']);
  });
  it('refuses an unsatisfied mandatory referral through the shared guard', () => {
    const state = { labels: ['review:pending'], headRefOid: TO,
      comments: [{ author: { login: 'chalbert' }, body: '<!-- mandatory-referrals-v1: truncated -->' }, ...liveComments()] };
    expect(run({ state, prove: () => { throw Error('unexpected proof'); } })).toMatchObject({ action: 'retry' });
  });
  it.each([{ enabled: false }, { acceptCarry: 'off' }])('writes nothing with a disabled carry setting: %j', (settings) => {
    expect(run({ ...settings, prove: () => { throw Error('unexpected proof'); } })).toBeNull();
  });
  it.each([false, true])('checks the shared referral guard before writes (labelsOnly: %s)', (labelsOnly) => {
    const body = buildNumberingRestampBody({ fromSha: FROM, toSha: TO, human: true, actor: 'chalbert' });
    const state = { labels: ['review:pending'], headRefOid: TO,
      comments: labelsOnly ? [...liveComments(), { author: { login: 'chalbert' }, body }] : liveComments() };
    const checked = [];
    expect(run({ state, prove: () => ({ ok: true }),
      guardReferrals: (s) => { checked.push(s.headRefOid); throw Error('mandatory referral hold: unresolved'); },
      provider: { postComment: () => { throw Error('unexpected write'); }, setLabels: () => { throw Error('unexpected write'); } } }))
      .toMatchObject({ action: 'retry', reason: 'mandatory referral hold: unresolved' });
    expect(checked).toEqual([TO]);
  });
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
