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
  resolveNumberingHumanClearanceSetting, MAX_NUMBERING_COMMITS, MAX_NUMBERING_BLOB_BYTES, parseNumberingSubject, isMappedRewrite, checkNumberingCommit, proveNumberingOnlyMove,
  planNumberingRestamp, buildNumberingRestampBody, buildNumberingWithdrawnBody, restampAfterNumbering as restampWithoutGuard,
  _resetNumberingRestampMemo, numberingWithdrawalOwed, strandedNumberingRecords, MAX_WITHDRAWALS_PER_PASS,
} from '../numbering-carry.mjs';
import { decideDrainReviewGate } from '../../merge-ai-prs.mjs';
import { assertMandatoryReferralsCleared } from '../../review-set-label.mjs';

// The writer supplies the referral guard (numbering-carry does not import the label writer: that would close an
// import cycle through the drain). These tests supply the same real guard the sweep does, unless a test overrides it.
const restampAfterNumbering = (o) => restampWithoutGuard({ guardReferrals: assertMandatoryReferralsCleared, ...o });

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
  // Red team #5233: applyLedger never rewrites a `bornAs: <hash>` line, so a numbering commit that does is not one.
  it.each([
    ['modified card', (o) => o.changes.push({ status: 'M', path: 'backlog/9000-existing.md',
      before: '---\nbornAs: xdef456\n---\nsee #xdef456\n', after: '---\nbornAs: 9000\n---\nsee #9000\n' })],
    ['modified card, CRLF', (o) => o.changes.push({ status: 'M', path: 'backlog/9000-existing.md',
      before: '---\r\nbornAs: xdef456\r\n---\r\n', after: '---\r\nbornAs: 9000\r\n---\r\n' })],
    ['modified card, subject hash', (o) => o.changes.push({ status: 'M', path: 'backlog/9000-existing.md',
      before: '---\nbornAs:  xf74q20 \n---\n', after: '---\nbornAs:  6053 \n---\n' })],
    ['renamed card with an existing stamp', (o) => {
      o.changes[1].before = stamp(o.changes[1].before, 'xf74q20');
      o.changes[2].after = o.changes[2].after.replace('bornAs: xf74q20\n', '').replace('---\n', '---\nbornAs: 6053\n');
    }],
    ['renamed card carrying another alias line', (o) => {
      o.changes[1].before = `${stamp(o.changes[1].before, 'xf74q20')}bornAs: xdef456\n`;
      o.changes[2].after += 'bornAs: 9000\n';
    }],
  ])('refuses a rewritten bornAs line: %s', (_name, mutate) => {
    const o = live();
    o.extraMap = new Map([['xdef456', '9000']]);
    mutate(o);
    refused(checkNumberingCommit(o), /bornAs|content|rewrite/);
  });
  it('still permits a reference rewrite beside a preserved bornAs line', () => {
    const o = live();
    o.extraMap = new Map([['xdef456', '9000']]);
    o.changes.push({ status: 'M', path: 'backlog/9000-existing.md',
      before: '---\nbornAs: xdef456\n---\nsee #xdef456\n', after: '---\nbornAs: xdef456\n---\nsee #9000\n' });
    expect(checkNumberingCommit(o).ok).toBe(true);
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
function proofReader({ changes = live().changes, commitSubject = subject, subjects = [commitSubject], trees = {}, failTree, mainAliases = '', modes = {} } = {}) {
  const from = 'a'.repeat(40), numbered = 'b'.repeat(40);
  const heads = [numbered, 'e'.repeat(40)];
  const head = heads[subjects.length - 1];
  const calls = [];
  // Blobs are keyed by object id, as the proof reads them (never by `<rev>:<path>`).
  const blobs = new Map();
  const oids = new Map();
  const oidFor = (key, bytes) => {
    const oid = (blobs.size + 1).toString(16).padStart(40, '0');
    blobs.set(oid, Buffer.from(bytes));
    oids.set(key, oid);
  };
  for (const c of changes) {
    if (c.before !== undefined) oidFor(`before:${c.path}`, c.before);
    if (c.after !== undefined) oidFor(`after:${c.path}`, c.after);
  }
  const zero = '0'.repeat(40);
  const exec = (_cmd, args, opts) => {
    calls.push(args);
    let output = '';
    if (args[0] === 'rev-parse') output = from;
    else if (args[0] === 'rev-list') output = subjects.map((_s, i) => `${heads[i]} ${i ? heads[i - 1] : from}\n`).join('');
    else if (args[0] === 'log') output = `${subjects[heads.indexOf(args.at(-1))]}\n`;
    else if (args[0] === 'grep') output = mainAliases;
    else if (args[0] === 'ls-tree') {
      if (args.includes(failTree)) throw Error('inventory unreadable');
      const ref = args.find((a) => a === from || a === 'origin/main');
      output = (trees[ref] ?? []).map((p) => `${p}\0`).join('');
    } else if (args[0] === 'diff-tree') {
      output = changes.map((c) => {
        const m = modes[c.path] ?? {};
        const beforeMode = c.status === 'A' ? '000000' : (m.beforeMode ?? '100644');
        const afterMode = c.status === 'D' ? '000000' : (m.afterMode ?? '100644');
        return `:${beforeMode} ${afterMode} ${oids.get(`before:${c.path}`) ?? zero} ${oids.get(`after:${c.path}`) ?? zero} ${c.status}\0${c.path}\0`;
      }).join('');
    } else if (args[0] === 'cat-file' && ['blob', '-s', '-t'].includes(args[1])) {
      const bytes = blobs.get(args[2]);
      if (!bytes) throw Error(`missing fixture blob ${args[2]}`);
      output = args[1] === '-t' ? 'blob\n' : args[1] === '-s' ? `${bytes.length}\n` : bytes;
    }
    return opts.encoding === null ? Buffer.from(output) : Buffer.isBuffer(output) ? output.toString('utf8') : output;
  };
  return { calls, exec, from, head, prove: () => proveNumberingOnlyMove({ exec, fromSha: from, toSha: head }) };
}

describe('proveNumberingOnlyMove read-only regressions', () => {
  it('refuses a numbering commit that rewrites an existing card\'s bornAs through a main alias (red team #5233)', () => {
    const existing = { status: 'M', path: 'backlog/9000-existing.md', before: '---\nbornAs: xdef456\n---\nbody\n' };
    const mainAliases = 'origin/main:backlog/9000-existing.md:bornAs: xdef456\n';
    const corrupt = [...live().changes, { ...existing, after: '---\nbornAs: 9000\n---\nbody\n' }];
    refused(proofReader({ changes: corrupt, mainAliases }).prove(), /bornAs|rewrite/);
    const kept = [...live().changes, { ...existing, before: `${existing.before}see #xdef456\n`, after: '---\nbornAs: xdef456\n---\nbody\nsee #9000\n' }];
    expect(proofReader({ changes: kept, mainAliases }).prove().ok).toBe(true);
  });
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
  // Operator send-back (#5233, head 5479d2f): the proof compares exact bytes, so a change that only re-encodes a
  // character (NFC → NFD, the same text to a reader) or only changes line endings is never a numbering rewrite.
  it.each([
    ['NFC → NFD in a modification', 0, 0, (t) => `${t}café\n`, (t) => `${t}café\n`],
    ['NFC → NFD in a rename', 1, 2, (t) => `${t}café\n`, (t) => `${t}café\n`],
    ['LF → CRLF in a modification', 0, 0, (t) => `${t}end\n`, (t) => `${t}end\r\n`],
  ])('refuses a normalisation-only byte change: %s', (_name, beforeIndex, afterIndex, before, after) => {
    const changes = live().changes;
    changes[beforeIndex].before = before(changes[beforeIndex].before);
    changes[afterIndex].after = after(changes[afterIndex].after);
    // The appended text differs only in its bytes, never in what a reader sees.
    expect(Buffer.from(after('')).equals(Buffer.from(before('')))).toBe(false);
    expect(after('').normalize('NFC').replace(/\r\n/g, '\n')).toBe(before(''));
    refused(proofReader({ changes }).prove(), /rewrite/);
  });
  it('accepts the same character in the same encoding on both sides (the control for the case above)', () => {
    const changes = live().changes;
    changes[0].before += 'café\n';
    changes[0].after += 'café\n';
    expect(proofReader({ changes }).prove().ok).toBe(true);
  });
  it.each([
    ['a modification', { 'backlog/4815-a-not-real-ruling.md': { afterMode: '100755' } }],
    ['a rename', { 'backlog/6053-hold-auto-land.md': { afterMode: '100755' } }],
  ])('refuses an executable-bit change riding on %s', (_name, modes) => {
    refused(proofReader({ modes }).prove(), /mode/);
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
    const restamp = restampAfterNumbering({ netPatchSetting: { value: false, source: 'test-numbering-only' }, repo: 'o/n', pr: 5025, exec: r.exec,
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
  // Operator send-back (#5233, head 5479d2f): a mode-only change (same blob, executable bit flipped) on a card the
  // numbering commit does not otherwise touch is still a change the proof must refuse.
  it('refuses numbering combined with a mode-only change to an otherwise untouched card', () => {
    const r = repo();
    r.write('backlog/0002-other.md', 'unrelated\n');
    const fromSha = r.commit('another card');
    r.number();
    r.git(['update-index', '--chmod=+x', 'backlog/0002-other.md']);
    r.git(['commit', '--amend', '--no-edit', '-q']);
    refused(proveNumberingOnlyMove({ exec: execFileSync, cwd: r.cwd, fromSha, toSha: r.git(['rev-parse', 'HEAD']) }), /mode/);
  });
  // Self-review (#5233): a blob read by `<rev>:<path>` goes through git's path handling, which on macOS
  // (core.precomposeunicode) folds an NFD path onto its NFC twin — so the proof read the twin's valid rewrite and
  // never saw the NFD card's real change. Blobs are read by the object ids the raw diff names.
  it('refuses a change to an NFD card hidden behind its NFC twin when git precomposes paths', () => {
    const r = repo();
    const nfc = 'backlog/0003-café.md', nfd = 'backlog/0003-café.md';
    const put = (path, text) => {
      const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: r.cwd, input: text, encoding: 'utf8' }).trim();
      r.git(['-c', 'core.precomposeunicode=false', 'update-index', '--add', '--cacheinfo', `100644,${oid},${path}`]);
    };
    put(nfc, 'see #xabc123\n');
    put(nfd, 'see #xabc123\n');
    r.git(['commit', '-q', '-m', 'twin cards']);
    const fromSha = r.git(['rev-parse', 'HEAD']);
    r.number();
    put(nfc, 'see #7001\n');
    put(nfd, 'anything at all\n');
    r.git(['commit', '--amend', '--no-edit', '-q']);
    const toSha = r.git(['rev-parse', 'HEAD']);
    expect(r.git(['-c', 'core.precomposeunicode=false', 'diff', '--name-only', fromSha, toSha])).toContain('0003-cafe');
    const exec = (cmd, args, opts) => execFileSync(cmd, ['-c', 'core.precomposeunicode=true', ...args], opts);
    refused(proveNumberingOnlyMove({ exec, cwd: r.cwd, fromSha, toSha }), /rewrite/);
  });
  // Self-review (#5233): porcelain `git diff` drops a gitlink when submodules are configured as ignored, so the mode
  // allow-list never saw it. The raw diff is plumbing with --ignore-submodules=none.
  it('refuses a gitlink added beside the numbering even when diff config ignores submodules', () => {
    const r = repo();
    r.number();
    r.git(['update-index', '--add', '--cacheinfo', `160000,${r.base},backlog/sub`]);
    r.git(['commit', '--amend', '--no-edit', '-q']);
    const exec = (cmd, args, opts) => execFileSync(cmd, ['-c', 'diff.ignoreSubmodules=all', ...args], opts);
    refused(r.prove(r.git(['rev-parse', 'HEAD']), exec), /mode/);
  });
  it('refuses numbering combined with an NFC → NFD re-encoding of a card', () => {
    const r = repo();
    r.write('backlog/0001-parent.md', 'see #xabc123 café\n');
    const fromSha = r.commit('accented parent');
    r.number();
    r.write('backlog/0001-parent.md', 'see #7001 café\n');
    r.git(['add', '-A']); r.git(['commit', '--amend', '--no-edit', '-q']);
    refused(proveNumberingOnlyMove({ exec: execFileSync, cwd: r.cwd, fromSha, toSha: r.git(['rev-parse', 'HEAD']) }), /rewrite/);
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
  it.each(['rev-list', 'log', 'diff-tree', 'cat-file'])('fails closed on a %s read error', (operation) => {
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
    expect(planNumberingRestamp(facts())).toEqual({ candidate: true, from: FROM, to: TO, human: true, actor: 'chalbert',
      source: 'at:2026-10-12T10:00:00Z#0' });
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
  it('writes nothing when no referral guard is supplied (fails closed, retryable)', () => {
    const writes = [];
    const result = restampWithoutGuard({ repo: 'o/n', pr: 5025, state: { ...facts(), headRefOid: TO }, reviews: [],
      enabled: true, acceptCarry: 'on', prove: () => ({ ok: true, reason: 'verified' }),
      provider: { postComment: () => writes.push('comment'), setLabels: () => writes.push('labels') } });
    expect(result).toMatchObject({ action: 'retry', reason: 'no mandatory-referral guard supplied' });
    expect(writes).toEqual([]);
  });
  it('keeps the label writer out of the drain import graph (no cycle back through merge-ai-prs)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../numbering-carry.mjs'), 'utf8');
    expect(src).not.toMatch(/from ['"][^'"]*review-set-label\.mjs['"]/);
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
  // The live re-read sees the caller's state plus whatever this run itself posted, unless a test overrides it.
  const run = (over = {}) => {
    const state = over.state ?? { labels: ['review:pending'], headRefOid: TO, comments: liveComments() };
    const reviews = over.reviews ?? [];
    const posted = [];
    const provider = over.provider && { ...over.provider, postComment: (r, n, body) => {
      const out = over.provider.postComment(r, n, body);
      posted.push({ author: { login: 'chalbert' }, body });
      return out;
    } };
    return restampAfterNumbering({ netPatchSetting: { value: false, source: 'test-numbering-only' }, repo: 'o/n', pr: 5025, state, reviews,
      readLiveState: () => ({ state: { ...state, comments: [...state.comments, ...posted] }, reviews }),
      ...over, ...(provider ? { provider } : {}) });
  };
  const objection = { author: { login: 'chalbert' }, body: 'Do not land this. I found a bug and am preparing findings.' };
  const recording = () => {
    const calls = [];
    return { calls, provider: { postComment: (_r, _n, body) => calls.push(body), setLabels: (_r, _n, spec) => calls.push(spec) } };
  };
  it.each([false, true])('human switch off preserves automated acceptance carry (human: %s)', human => {
    const rec = accept();
    if (!human) rec.body = rec.body.replace('✅ review — human cleared', '✅ review — accepted')
      .replace('<!-- cleared-human: chalbert -->', '');
    const { calls, provider } = recording();
    const result = run({ state: { labels: ['review:pending'], headRefOid: TO, comments: [rec] }, provider,
      numberingSetting: { value: false, source: 'tool' }, prove: () => ({ ok: true, reason: 'verified' }) });
    if (human) { expect(result).toBeNull(); expect(calls).toEqual([]); }
    else { expect(result).toMatchObject({ action: 'restamped', human: false }); expect(calls).toHaveLength(2); }
  });
  it('kill switch review.carryAcceptAcrossNumbering=false: an automated accept is not re-stamped across numbering', () => {
    const rec = accept();
    rec.body = rec.body.replace('✅ review — human cleared', '✅ review — accepted').replace('<!-- cleared-human: chalbert -->', '');
    const { calls, provider } = recording();
    const result = run({ state: { labels: ['review:pending'], headRefOid: TO, comments: [rec] }, provider,
      acceptSetting: { value: false, source: 'env' }, prove: () => ({ ok: true, reason: 'verified' }) });
    expect(result?.action).not.toBe('restamped');
    expect(calls).toEqual([]);
  });
  describe('a hold that arrives while the proof runs (red team #5233)', () => {
    const ok = () => ({ ok: true, reason: 'verified' });
    // A live thread with comment node ids: every post and edit lands on it, and every re-read copies it.
    const liveThread = (base = liveComments()) => {
      const thread = base.map((c, i) => ({ ...c, id: `IC_live${i}` }));
      const calls = [];
      let n = 0;
      const provider = {
        postComment: (_r, _n, body) => { calls.push(body); thread.push({ author: { login: 'chalbert' }, body, id: `IC_posted${n++}` }); },
        editComment: (_r, id, body) => { calls.push({ edit: id, body }); thread.find((c) => c.id === id).body = body; },
        setLabels: (_r, _n, spec) => calls.push(spec),
      };
      const labels = ['review:pending'];
      const reviews = [];
      const readLiveState = () => ({ state: { labels: [...labels], headRefOid: TO, comments: thread.map((c) => ({ ...c })) }, reviews: [...reviews] });
      const step = (over = {}) => restampAfterNumbering({ netPatchSetting: { value: false, source: 'test-numbering-only' }, repo: 'o/n', pr: 5025, state: readLiveState().state, reviews: [...reviews],
        provider, readLiveState, prove: ok, ...over });
      return { thread, calls, provider, readLiveState, step, labels, reviews };
    };
    const liveRead = (patch) => () => {
      const read = { state: { labels: ['review:pending'], headRefOid: TO, comments: liveComments() }, reviews: [] };
      patch(read);
      return read;
    };
    it.each([
      ['an operator objection', liveRead((l) => { l.state.comments.push(objection); })],
      ['a formal changes-requested review', liveRead((l) => { l.reviews.push({ state: 'CHANGES_REQUESTED', submittedAt: '2026-10-13T00:00:00Z' }); })],
      ['a review:human label', liveRead((l) => { l.state.labels.push('review:human'); })],
      ['a review:changes label', liveRead((l) => { l.state.labels.push({ name: 'review:changes' }); })],
      ['pending removed', liveRead((l) => { l.state.labels = []; })],
    ])('writes nothing and keeps the head open: %s', (_name, readLiveState) => {
      const { calls, provider } = recording();
      const r = run({ provider, readLiveState, prove: () => ({ ok: true, reason: 'verified' }) });
      expect(r).toMatchObject({ action: 'held' });
      expect(calls).toEqual([]);
      expect(run({ provider, prove: () => ({ ok: true, reason: 'verified' }) }).action).toBe('restamped');
    });
    it.each([
      ['a head move', liveRead((l) => { l.state.headRefOid = 'f'.repeat(40); })],
      ['unreadable reviews', liveRead((l) => { l.reviews = null; })],
      ['a truncated comment read', liveRead((l) => { l.state.comments = null; })],
      ['a failed re-read', () => { throw Error('gh offline'); }],
      ['no re-read result', () => undefined],
    ])('retries without writes after %s', (_name, readLiveState) => {
      const { calls, provider } = recording();
      expect(run({ provider, readLiveState, prove: () => ({ ok: true, reason: 'verified' }) })).toMatchObject({ action: 'retry' });
      expect(calls).toEqual([]);
    });
    // Operator block (#5233, head f3b08989d): the write must carry the FRESH acceptance, never the first plan's clearance.
    const newer = (actor) => ({ author: { login: 'chalbert' }, createdAt: '2026-10-13T10:00:00Z',
      body: `✅ review — accepted\n<!-- reviewed-sha: ${FROM} -->${actor ? `\n<!-- cleared-human: ${actor} -->` : ''}` });
    const plainBase = () => [{ ...accept(), body: accept().body.replace(/\n<!-- cleared-human: chalbert -->/, '') }];
    it.each([
      ['a newer plain acceptance', liveComments, newer(null), false],
      ['a newer clearance by another actor', liveComments, newer('someone-else'), true],
      ['a newer clearance on a plain acceptance', plainBase, newer('chalbert'), true],
      ['a newer record by the same actor', liveComments, newer('chalbert'), true],
    ])('writes nothing when the acceptance changes during the proof: %s', (_name, base, record, human) => {
      const { calls, provider } = recording();
      const thread = [...base(), record];
      const r = run({ provider, state: { labels: ['review:pending'], headRefOid: TO, comments: base() },
        readLiveState: () => ({ state: { labels: ['review:pending'], headRefOid: TO, comments: thread }, reviews: [] }),
        prove: () => ({ ok: true, reason: 'verified' }) });
      expect(r).toMatchObject({ action: 'retry', reason: 'live re-read: the acceptance plan changed' });
      expect(calls).toEqual([]);
      // The next pass plans from the fresh thread and writes that acceptance, not the superseded one.
      const next = run({ provider, state: { labels: ['review:pending'], headRefOid: TO, comments: thread },
        prove: () => ({ ok: true, reason: 'verified' }) });
      expect(next).toMatchObject({ action: 'restamped', human });
      expect(calls).toHaveLength(2);
      if (human) expect(calls[0]).toContain(`cleared-human: ${/cleared-human: (\S+)/.exec(record.body)[1]}`);
      else expect(calls[0]).not.toContain('cleared-human:');
    });
    it('a plain acceptance landing just before our record keeps pending, withdraws our record, and the next pass carries the plain one', async () => {
      const { parseLatestHumanClearedSha } = await import('../review-escalation.mjs');
      const { thread, calls, provider, step } = liveThread();
      // The acceptance lands after the pre-write re-read but before our comment is posted.
      const post = provider.postComment;
      provider.postComment = (r, n, body) => { if (!calls.length) thread.push(newer(null)); post(r, n, body); };
      expect(step()).toMatchObject({ action: 'retry', commentPosted: true, withdrawn: 1 });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('cleared-human:');
      expect(calls[1]).toMatchObject({ edit: 'IC_posted0' });
      // The withdrawn record no longer clears the head; the newer plain acceptance stands.
      expect(parseLatestHumanClearedSha(thread)).toBeNull();
      provider.postComment = post;
      expect(step()).toMatchObject({ action: 'restamped', human: false });
      expect(calls).toHaveLength(4);
      expect(calls[2]).not.toContain('cleared-human:');
      expect(parseLatestHumanClearedSha(thread)).toBeNull();
    });
    it('a labels-only recovery refuses a record whose carried acceptance was superseded before it', () => {
      const body = buildNumberingRestampBody({ fromSha: FROM, toSha: TO, human: true, actor: 'chalbert', proofReason: 'verified', writer: 'review-daemon' });
      const comments = [...liveComments(), newer(null), { author: { login: 'chalbert' }, body }];
      const plan = planNumberingRestamp({ labels: ['review:pending'], headSha: TO, comments, reviews: [] });
      expect(plan).toMatchObject({ candidate: true, from: FROM, to: TO, human: false });
      expect(plan.labelsOnly).toBeUndefined();
    });
    const H2 = 'f'.repeat(40);
    const record = (from = FROM, to = TO) => ({ author: { login: 'chalbert' },
      body: buildNumberingRestampBody({ fromSha: from, toSha: to, human: true, actor: 'chalbert', proofReason: 'verified', writer: 'review-daemon' }) });
    const planAt = (headSha, comments) => planNumberingRestamp({ labels: ['review:pending'], headSha, comments, reviews: [] });
    it('a hold posted just before our record keeps refusing after the head moves again', () => {
      const comments = [...liveComments(), objection, record()];
      expect(planAt(TO, comments).candidate).toBe(false);
      expect(planAt(H2, comments)).toMatchObject({ candidate: false, reason: 'later verdict or unknown comment stands' });
    });
    it('a valid record carries on to the next head, from that record', () => {
      const comments = [...liveComments(), record()];
      expect(planAt(H2, comments)).toMatchObject({ candidate: true, from: TO, to: H2, human: true, actor: 'chalbert' });
      expect(planAt(H2, [...comments, record(TO, H2)])).toMatchObject({ candidate: true, labelsOnly: true, from: TO, to: H2 });
    });
    it('a root acceptance with no time keeps every formal review counting through its records', () => {
      const comments = [{ ...accept(), createdAt: undefined }, { ...record(), createdAt: '2026-10-14T00:00:00Z' }];
      const reviews = [{ state: 'COMMENTED', submittedAt: '2026-10-13T00:00:00Z' }];
      expect(planNumberingRestamp({ labels: ['review:pending'], headSha: TO, comments, reviews }))
        .toMatchObject({ candidate: false, reason: 'formal review hold stands' });
    });
    it.each([
      ['a quoted record', (b) => `🧭 advisory note — changes\n\n${b.split('\n').map((l) => `> ${l}`).join('\n')}`],
      ['markers under another headline', (b) => `🧭 advisory note — changes\n${b.split('\n').slice(1).join('\n')}`],
      ['a marker that is not the last line', (b) => `${b}\nmore text`],
    ])('a trusted comment carrying %s is no re-stamp record', (_name, shape) => {
      const forged = { author: { login: 'chalbert' }, body: shape(record().body) };
      const plan = planAt(TO, [...liveComments(), forged]);
      expect(plan.labelsOnly).toBeUndefined();
      expect(plan.candidate).toBe(false);
    });
    it('a long actor cut at a separator still matches its own record', () => {
      const { calls, provider } = recording();
      const actor = `${'a'.repeat(63)} b`;
      const comments = [{ ...accept(), body: accept().body.replace('cleared-human: chalbert', `cleared-human: ${actor}`) }];
      expect(run({ provider, state: { labels: ['review:pending'], headRefOid: TO, comments },
        prove: () => ({ ok: true, reason: 'verified' }) })).toMatchObject({ action: 'restamped', human: true });
      expect(calls).toHaveLength(2);
    });
    it('compares the actor as the record writes it, so a sanitized name still finishes the labels', () => {
      const { calls, provider } = recording();
      const comments = [{ ...accept(), body: accept().body.replace('cleared-human: chalbert', 'cleared-human: @chal bert') }];
      expect(run({ provider, state: { labels: ['review:pending'], headRefOid: TO, comments },
        prove: () => ({ ok: true, reason: 'verified' }) })).toMatchObject({ action: 'restamped', human: true });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('cleared-human: chal bert');
    });
    it('writes nothing without a live re-read', () => {
      const { calls, provider } = recording();
      expect(run({ provider, readLiveState: undefined, prove: () => ({ ok: true, reason: 'verified' }) })).toMatchObject({ action: 'retry' });
      expect(calls).toEqual([]);
    });
    it('re-checks the referral guard on the re-read state', () => {
      const { calls, provider } = recording();
      let reads = 0;
      const guardReferrals = () => { if (++reads > 2) throw Error('mandatory referral hold: unresolved'); };
      expect(run({ provider, guardReferrals, prove: () => ({ ok: true, reason: 'verified' }) }))
        .toMatchObject({ action: 'retry', reason: 'mandatory referral hold: unresolved' });
      expect(calls).toEqual([]);
      expect(reads).toBe(3);
    });
    it('keeps pending and withdraws our record when the objection lands between the record and the label write', () => {
      const { thread, calls, provider, step } = liveThread();
      const post = provider.postComment;
      provider.postComment = (r, n, body) => { post(r, n, body); thread.push({ ...objection, id: 'IC_objection' }); };
      expect(step()).toMatchObject({ action: 'held', commentPosted: true, withdrawn: 1 });
      expect(calls).toHaveLength(2);
      expect(typeof calls[0]).toBe('string');
      expect(calls[1]).toMatchObject({ edit: 'IC_posted0' });
    });
    it('a labels-only recovery re-reads before removing pending', () => {
      const body = buildNumberingRestampBody({ fromSha: FROM, toSha: TO, human: true, actor: 'chalbert', proofReason: 'verified', writer: 'review-daemon' });
      const { thread, calls, readLiveState, step } = liveThread([...liveComments(), { author: { login: 'chalbert' }, body }]);
      const { state } = readLiveState();
      thread.push({ ...objection, id: 'IC_objection' });
      expect(step({ state, prove: () => { throw Error('no proof is owed for a recorded re-stamp'); } })).toMatchObject({ action: 'held' });
      expect(calls).toEqual([]);
    });
    // Self-review (#5233): a comment AFTER an earlier, valid record is visible to every reader, and any account can post
    // one, so it must never erase that record (and with it a standing human clearance of the head).
    it.each([
      ['an untrusted comment', { author: { login: 'random-user' }, body: 'thanks!' }],
      ['an operator objection', objection],
    ])('never withdraws an earlier valid record for %s posted after it', async (_name, later) => {
      const { parseLatestHumanClearedSha } = await import('../review-escalation.mjs');
      const body = buildNumberingRestampBody({ fromSha: FROM, toSha: TO, human: true, actor: 'chalbert', proofReason: 'verified', writer: 'review-daemon' });
      const { thread, calls, step } = liveThread([...liveComments(), { author: { login: 'chalbert' }, body }]);
      thread.push({ ...later, id: 'IC_later' });
      expect(step()).toBeNull();
      expect(step({ prove: () => { throw Error('no proof is owed'); } })).toBeNull();
      expect(calls).toEqual([]);
      expect(parseLatestHumanClearedSha(thread)).toBe(TO);
    });
    // Operator block (#5233, head 8265716f7): a hold in the window between the pre-write check and the post sits BEFORE
    // our record, so every reader but the numbering planner would read the record as an acceptance on the head.
    describe('a hold landing between the pre-write check and the post (operator block #5233)', () => {
      const readers = async (thread) => {
        const { latestAcceptRecord } = await import('../accept-carry-forward.mjs');
        const { latestHumanClearance } = await import('../human-clearance-carry.mjs');
        const { readDrainAcceptance, reconcileDrainReviewPending } = await import('../../merge-ai-prs.mjs');
        const exec = () => JSON.stringify({ headRefOid: TO, headRefName: 'lane/numbering', comments: thread });
        const spawned = [];
        const reconcile = reconcileDrainReviewPending({ currentLabels: ['review:pending', 'review:accepted'], pr: 5025, repo: 'o/n',
          exec, readReviews: () => [] }, { spawn: (o) => { spawned.push(o); return { ok: true }; } });
        return { record: latestAcceptRecord(thread), clearance: latestHumanClearance(thread),
          drain: readDrainAcceptance({ pr: 5025, repo: 'o/n', exec, readReviews: () => [] }), reconcile, spawned };
      };
      it.each([
        ['an operator objection', (thread) => thread.push({ ...objection, id: 'IC_objection' })],
        ['a newer plain acceptance', (thread) => thread.push({ author: { login: 'chalbert' }, createdAt: '2026-10-13T10:00:00Z', id: 'IC_newer',
          body: `✅ review — accepted\n<!-- reviewed-sha: ${FROM} -->` })],
      ])('withdraws our record so no acceptance reader honours it: %s', async (_name, land) => {
        const { thread, calls, provider, step } = liveThread();
        const post = provider.postComment;
        provider.postComment = (r, n, body) => { if (!calls.length) land(thread); post(r, n, body); };
        const r = step();
        expect(r).toMatchObject({ commentPosted: true, withdrawn: 1 });
        expect(['held', 'retry']).toContain(r.action);
        expect(calls.filter((c) => c?.remove)).toEqual([]);
        const withdrawn = thread.find((c) => c.id === 'IC_posted0');
        expect(calls[1]).toEqual({ edit: 'IC_posted0', body: withdrawn.body });
        expect(withdrawn.body).toContain('<!-- numbering-restamp-withdrawn:');
        expect(withdrawn.body).not.toMatch(/reviewed-sha:|reviewed-diff:|reviewed-contribution:|cleared-human:/);
        const seen = await readers(thread);
        expect(seen.record.sha).toBe(FROM);
        expect(seen.clearance?.sha ?? null).not.toBe(TO);
        expect(seen.drain.acceptedSha).toBe(FROM);
        expect(seen.drain.humanClearedSha ?? null).not.toBe(TO);
        expect(seen.reconcile).toMatchObject({ ok: false });
        expect(seen.spawned).toEqual([]);
      });
      it('the objection case stays held on the next pass, with nothing more to write', () => {
        const { thread, calls, provider, step } = liveThread();
        const post = provider.postComment;
        provider.postComment = (r, n, body) => { if (!calls.length) thread.push({ ...objection, id: 'IC_objection' }); post(r, n, body); };
        step();
        _resetNumberingRestampMemo();
        expect(step()).toBeNull();
        expect(calls).toHaveLength(2);
      });
      it('a record stranded by an earlier pass (its withdrawal never landed) is withdrawn by the next pass', async () => {
        const { thread, calls, step } = liveThread();
        thread.push({ ...objection, id: 'IC_objection' });
        const body = buildNumberingRestampBody({ fromSha: FROM, toSha: TO, human: true, actor: 'chalbert', proofReason: 'verified', writer: 'review-daemon' });
        thread.push({ author: { login: 'chalbert' }, body, id: 'IC_stranded' });
        expect((await readers(thread)).drain.acceptedSha).toBe(TO);
        expect(step({ dryRun: true })).toMatchObject({ action: 'would-withdraw' });
        expect(calls).toEqual([]);
        expect(step({ prove: () => { throw Error('no proof is owed for a withdrawal'); } })).toMatchObject({ action: 'withdrawn', withdrawn: 1 });
        expect(calls).toEqual([{ edit: 'IC_stranded', body: thread[thread.length - 1].body }]);
        const seen = await readers(thread);
        expect(seen.drain.acceptedSha).toBe(FROM);
        expect(seen.spawned).toEqual([]);
        expect(step()).toBeNull();
      });
      it('a failed withdrawal is an error the next pass retries, never a settled head', () => {
        const { thread, calls, provider, step } = liveThread();
        thread.push({ ...objection, id: 'IC_objection' });
        thread.push({ author: { login: 'chalbert' }, id: 'IC_stranded',
          body: buildNumberingRestampBody({ fromSha: FROM, toSha: TO, human: true, actor: 'chalbert', proofReason: 'verified', writer: 'review-daemon' }) });
        const edit = provider.editComment;
        provider.editComment = () => { throw Error('offline'); };
        expect(step()).toMatchObject({ action: 'error', reason: 'withdrawal failed: offline' });
        provider.editComment = edit;
        expect(step()).toMatchObject({ action: 'withdrawn', withdrawn: 1 });
        expect(calls).toHaveLength(1);
      });
      // Operator send-back (#5233): the hold is a label swap the thread cannot show, and the one edit fails.
      it('a withdrawal that failed behind a label-only hold stays owed and is finished by the next pass', async () => {
        const { thread, calls, provider, step, labels } = liveThread();
        const post = provider.postComment;
        provider.postComment = (r, n, body) => { labels.push('review:human'); post(r, n, body); };
        const edit = provider.editComment;
        provider.editComment = () => { throw Error('rate limited'); };
        expect(step()).toMatchObject({ action: 'error', reason: 'withdrawal failed: rate limited', commentPosted: true });
        const record = thread.find((c) => c.id === 'IC_posted0');
        expect(record.body).toContain('reviewed-sha:');
        expect((await readers(thread)).drain.acceptedSha).toBe(TO);
        expect(numberingWithdrawalOwed('o/n', 5025)).toBe(true);
        // The labels, the carry switch and the settled memo no longer matter: the withdrawal is owed.
        provider.editComment = edit;
        expect(step({ enabled: false })).toMatchObject({ action: 'withdrawn', withdrawn: 1 });
        expect(calls[calls.length - 1]).toEqual({ edit: 'IC_posted0', body: record.body });
        expect(record.body).toContain('<!-- numbering-restamp-withdrawn:');
        const seen = await readers(thread);
        expect(seen.drain.acceptedSha).toBe(FROM);
        expect(seen.spawned).toEqual([]);
        expect(numberingWithdrawalOwed('o/n', 5025)).toBe(false);
        expect(numberingWithdrawalOwed(null, 5025)).toBe(false);
        expect(step({ enabled: false })).toBeNull();
      });
      it('an owed withdrawal whose record is gone from the thread is forgiven', () => {
        const { thread, provider, step, labels } = liveThread();
        const post = provider.postComment;
        provider.postComment = (r, n, body) => { labels.push('review:human'); post(r, n, body); };
        provider.editComment = () => { throw Error('offline'); };
        step();
        expect(numberingWithdrawalOwed('o/n', 5025)).toBe(true);
        thread.splice(thread.findIndex((c) => c.id === 'IC_posted0'), 1);
        expect(step()).toBeNull();
        expect(numberingWithdrawalOwed('o/n', 5025)).toBe(false);
      });
      it('a forged withdrawal notice carrying an objection still holds', () => {
        const { thread } = liveThread();
        const notice = buildNumberingWithdrawnBody({ fromSha: FROM, toSha: TO, writer: 'review-daemon' });
        expect(planAt(TO, [...thread, { author: { login: 'chalbert' }, body: notice }]).candidate).toBe(true);
        const forged = notice.replace('\n\n', '\n\nDo not land this.\n\n');
        expect(planAt(TO, [...thread, { author: { login: 'chalbert' }, body: forged }]))
          .toMatchObject({ candidate: false, reason: 'later verdict or unknown comment stands' });
        // Read back with CRLF line endings, the notice is still the same notice.
        expect(planAt(TO, [...thread, { author: { login: 'chalbert' }, body: notice.replace(/\n/g, '\r\n') }]).candidate).toBe(true);
      });
      // Self-review (#5233): the most common objection is a label swap, which also removes review:pending.
      it.each([
        ['a changes verdict', ['review:changes']],
        ['a human park', ['review:human']],
        ['a human park beside pending', ['review:pending', 'review:human']],
        ['a held-mechanical park', ['review:pending', 'review:held-mechanical']],
        ['another writer finishing the labels', ['review:accepted']],
      ])('withdraws our record when %s lands between the pre-write check and the post', async (_name, swapped) => {
        const { thread, calls, provider, step, labels } = liveThread();
        const post = provider.postComment;
        provider.postComment = (r, n, body) => { labels.splice(0, labels.length, ...swapped); post(r, n, body); };
        expect(step()).toMatchObject({ action: 'held', commentPosted: true, withdrawn: 1 });
        expect(calls.filter((c) => c?.remove)).toEqual([]);
        const seen = await readers(thread);
        expect(seen.record.sha).toBe(FROM);
        expect(seen.drain.acceptedSha).toBe(FROM);
        expect(seen.drain.humanClearedSha ?? null).not.toBe(TO);
      });
      it('a formal review submitted in the window (before our record, after the root acceptance) withdraws it', async () => {
        const { thread, calls, provider, step, reviews } = liveThread();
        const post = provider.postComment;
        provider.postComment = (r, n, body) => {
          reviews.push({ state: 'COMMENTED', submittedAt: '2026-10-13T00:00:00Z', user: { login: 'chalbert' } });
          post(r, n, body);
          thread[thread.length - 1].createdAt = '2026-10-13T00:00:05Z';
        };
        expect(step()).toMatchObject({ action: 'held', withdrawn: 1 });
        expect(calls[1]).toMatchObject({ edit: 'IC_posted0' });
      });
      const strandedThread = (count = 1) => {
        const fixture = liveThread();
        fixture.thread.push({ ...objection, id: 'IC_objection' });
        for (let i = 0; i < count; i++) {
          fixture.thread.push({ author: { login: 'chalbert' }, id: `IC_stranded${i}`,
            body: buildNumberingRestampBody({ fromSha: FROM, toSha: TO, human: true, actor: 'chalbert', proofReason: `verified ${i}`, writer: 'review-daemon' }) });
        }
        return fixture;
      };
      it.each([
        ['the carry switched off', { enabled: false }],
        ['accept carry-forward off', { acceptCarry: 'off' }],
      ])('withdraws a stranded record with %s', (_name, over) => {
        const { calls, step } = strandedThread();
        expect(step(over)).toMatchObject({ action: 'withdrawn', withdrawn: 1 });
        expect(calls).toHaveLength(1);
        expect(step(over)).toBeNull();
      });
      it.each([['review:changes'], ['review:human'], ['review:accepted']])('withdraws a stranded record under %s', (label) => {
        const { calls, step, labels } = strandedThread();
        labels.splice(0, labels.length, label);
        expect(step()).toMatchObject({ action: 'withdrawn', withdrawn: 1 });
        expect(calls).toHaveLength(1);
      });
      it('withdraws a stranded record on a head the memo already settled', () => {
        const { thread, calls, step } = liveThread();
        expect(step()).toMatchObject({ action: 'restamped' });
        // A crash left a second record written over an objection (an older pass, a second writer).
        thread.push({ ...objection, id: 'IC_objection' });
        thread.push({ author: { login: 'chalbert' }, id: 'IC_stranded',
          body: buildNumberingRestampBody({ fromSha: FROM, toSha: TO, human: true, actor: 'chalbert', proofReason: 'late', writer: 'review-daemon' }) });
        expect(step()).toMatchObject({ action: 'withdrawn', withdrawn: 1 });
        expect(calls[calls.length - 1]).toMatchObject({ edit: 'IC_stranded' });
      });
      it(`withdraws at most ${MAX_WITHDRAWALS_PER_PASS} records per pass, the rest on the next`, () => {
        const { calls, step } = strandedThread(MAX_WITHDRAWALS_PER_PASS + 2);
        expect(step()).toMatchObject({ action: 'withdrawn', withdrawn: MAX_WITHDRAWALS_PER_PASS });
        expect(step()).toMatchObject({ action: 'withdrawn', withdrawn: 2 });
        expect(calls).toHaveLength(MAX_WITHDRAWALS_PER_PASS + 2);
        expect(step()).toBeNull();
      });
      it('strandedNumberingRecords reads the thread alone, for the sweep pre-filter', () => {
        const { thread } = strandedThread();
        expect(strandedNumberingRecords(thread).map((c) => c.id)).toEqual(['IC_stranded0']);
        expect(strandedNumberingRecords(liveComments())).toEqual([]);
      });
    });
  });
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
    expect(run({ state, prove: () => ({ ok: false, reason: 'unproven' }) })).toMatchObject({ action: 'retry' });
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
    expect(checked).toEqual([FROM]);
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

// #5414: clear-human at 4301480c → the drain's numbering commit 21ce5fcd.
// Use real git objects and the production gate, including its live re-read and writer.
describe('#5414 human clearance through the drain gate', () => {
  function replay({ mixed = false, fingerprint = true, workflow = false, human = true, liveHold = false, numberingSetting } = {}) {
    const r = repo();
    const head = r.number(mixed);
    const comments = [{ author: { login: 'chalbert' }, createdAt: '2026-10-15T23:45:00Z',
      body: `${human ? '✅ review — \`review:human\` cleared via the sanctioned path' : '✅ review — accepted'}\n`
        + `<!-- reviewed-sha: ${r.base} -->\n`
        + (fingerprint ? `<!-- reviewed-diff: ${normalizeDiffFingerprint('old diff')} -->\n` : '')
        + (human ? '<!-- cleared-human: chalbert -->' : '') }];
    const posted = [];
    let views = 0;
    const exec = (cmd, args, opts) => {
      if (cmd === 'git') return execFileSync(cmd, args, { ...opts, cwd: r.cwd });
      if (args[0] === 'api') return args.some(a => a.includes('/comments'))
        ? (liveHold ? [...comments, { author: { login: 'chalbert' }, body: 'Please hold this PR.' }] : comments)
          .map(c => [c.body.replaceAll('\n', '\\n'), c.createdAt || '', c.author.login].join('\t')).join('\n') : '';
      if (args[1] === 'view') {
        views++;
        return JSON.stringify({ headRefOid: head, headRefName: 'lane/5414', comments: views > 1 && liveHold
          ? [...comments, { author: { login: 'chalbert' }, body: 'Please hold this PR.' }] : comments });
      }
      if (args[1] === 'comment') { posted.push(args[args.indexOf('--body') + 1]); return ''; }
      throw Error(`unexpected command ${cmd} ${args}`);
    };
    const result = decideDrainReviewGate({ labels: ['review:accepted'], escalate: true, humanRequired: true, permissionChange: true }, {
      pr: 5414, repo: 'web-everything/web-everything', cwd: r.cwd, local: true, exec,
      files: [workflow ? '.github/workflows/ci.yml' : 'scripts/app.mjs'], filesComplete: true, listedHeadSha: head,
      netDiff: () => ({ scored: true, text: 'numbered diff', rev: head, revSha: head }),
      carry: { log: () => {}, ...(numberingSetting ? { numberingSetting } : {}) },
    });
    return { result, posted, views, from: r.base, head };
  }
  it.each([false, true])('carries clear-human across numbering (workflow: %s)', workflow => {
    const r = replay({ workflow });
    expect(r.result, r.result.reason).toMatchObject({ action: 'merge' });
    expect(r.views).toBeGreaterThan(1);
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0]).toContain('<!-- cleared-human: chalbert -->');
    expect(r.posted[0]).toContain(`from=${r.from} to=${r.head}`);
  });
  it('carries a SHA-only human clearance using the exact numbering proof', () => {
    const r = replay({ fingerprint: false });
    expect(r.result, r.result.reason).toMatchObject({ action: 'merge' });
    expect(r.posted).toHaveLength(1);
  });
  it('refuses numbering plus any other byte', () => {
    const r = replay({ mixed: true });
    expect(r.result.action).not.toBe('merge');
    expect(r.posted).toEqual([]);
  });
  it('refuses a hold arriving during the proof', () => {
    const r = replay({ liveHold: true });
    expect(r.result.action).not.toBe('merge');
    expect(r.posted).toEqual([]);
  });
  it('honours the numbering carry switch', () => {
    const r = replay({ numberingSetting: { value: false, source: 'env' } });
    expect(r.result.action).not.toBe('merge');
    expect(r.posted).toEqual([]);
  });
  it('never grants a human clearance to an automated accept', () => {
    const r = replay({ human: false });
    expect(r.result.action).not.toBe('merge');
    expect(r.posted).toEqual([]);
  });
});

describe('review.carryHumanClearanceAcrossNumbering cascade', () => {
  const key = 'carryHumanClearanceAcrossNumbering';
  const resolve = over => resolveNumberingHumanClearanceSetting({ env: {}, platform: {}, tool: {}, ...over });
  it('defaults true and names the standard source', () => {
    expect(resolve()).toEqual({ value: true, source: 'standard' });
  });
  it('reads the platform preference', () => {
    expect(resolve({ platform: { [key]: false } })).toEqual({ value: false, source: 'platform' });
  });
  it('lets the tool override platform', () => {
    expect(resolve({ platform: { [key]: false }, tool: { [key]: true } })).toEqual({ value: true, source: 'tool' });
  });
  it('lets env override the tool and reports its source', () => {
    expect(resolve({ tool: { [key]: true }, env: { WE_REVIEW_CARRY_HUMAN_CLEARANCE_ACROSS_NUMBERING: 'off' } }))
      .toEqual({ value: false, source: 'env' });
  });
  it('an invalid env cannot override a disabled policy', () => {
    expect(resolve({ tool: { [key]: false }, env: { WE_REVIEW_CARRY_HUMAN_CLEARANCE_ACROSS_NUMBERING: 'maybe' } }))
      .toEqual({ value: false, source: 'tool' });
  });
  it('loads the declared tool setting', () => {
    expect(resolveNumberingHumanClearanceSetting({ env: {}, platform: {} })).toEqual({ value: true, source: 'tool' });
  });
});
