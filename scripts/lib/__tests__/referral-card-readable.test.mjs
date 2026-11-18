/**
 * @file referral-card-readable.test.mjs — xc7ctn1: a `card` ruling may cite a card that exists only on an OPEN (or
 *   merged) PR's head as `we:backlog/<file>.md@pr<N>`; a card that exists nowhere is still refused.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSTELLATION_REPOS } from '../constellation-repos.mjs';
import { execFileSync } from 'node:child_process';
import { CARD_REF_RE, cardResolvesFinding, readCardAtPrHead, readMainCardByBornAs, referralCardReadable } from '../referral-card-readable.mjs';

const CARD = '---\nstatus: open\n---\n# card\n';
const SHA = 'b'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'card-ro-'));
mkdirSync(join(root, 'backlog'));

/**
 * A fake `gh`: PR 7 is open with the card, PR 8 is closed, PR 9 is merged (all into main); PR 10 is open and PR 11
 * merged, both into a side branch; everything else does not exist. Every `pr view` must name the one fixed repo and a
 * plain decimal PR number: a call that does not is a test failure, not a lookup of some other repo or branch.
 */
const calls = [];
const fakeGh = (cmd, args) => {
  calls.push(args);
  if (args[0] === 'pr') {
    const pr = args[2];
    expect(args.slice(0, 2)).toEqual(['pr', 'view']);
    expect(args[3]).toBe('--repo');
    expect(args[4]).toBe(CONSTELLATION_REPOS.we.slug);
    expect(pr).toMatch(/^[1-9]\d{0,8}$/);
    expect(args[6]).toMatch(/baseRefName/);
    if (pr === '7') return JSON.stringify({ state: 'OPEN', headRefOid: SHA, baseRefName: 'main' });
    if (pr === '8') return JSON.stringify({ state: 'CLOSED', headRefOid: SHA, baseRefName: 'main' });
    if (pr === '9') return JSON.stringify({ state: 'MERGED', headRefOid: SHA, baseRefName: 'main' });
    if (pr === '10') return JSON.stringify({ state: 'OPEN', headRefOid: SHA, baseRefName: 'feature/stack' });
    if (pr === '11') return JSON.stringify({ state: 'MERGED', headRefOid: SHA, baseRefName: 'feature/stack' });
    throw new Error('no such PR');
  }
  const url = args[args.length - 1];
  if (url === `repos/${CONSTELLATION_REPOS.we.slug}/contents/backlog/xsjn0uf-gate.md?ref=${SHA}`) return CARD;
  if (url.includes('empty.md')) return 'no frontmatter';
  throw new Error('404');
};
const readOnPr = (file, pr) => readCardAtPrHead(file, pr, { run: fakeGh });
const ok = ref => referralCardReadable(ref, root, { readOnPr });

describe('referralCardReadable @pr<N> (xc7ctn1)', () => {
  it.each([
    'title: "a multiline title\nstatus: open\nend"',
    "title: 'a multiline title\nstatus: open\nend'",
    'title: |\n  status: open',
    'title: >\n  status: open',
    'nested:\n  status: open',
    '  status: open',
    'title: "unterminated\nstatus: open',
  ])('refuses a longshore card without a real top-level status: %s', frontmatter => {
    expect(referralCardReadable('longshore:backlog/xabcdef-card.md@pr7', root, {
      fingerprint: 'finding-123', head: SHA, readOnPr: () => `---\n${frontmatter}\n---\nfinding-123 ${SHA}\n`,
    })).toBe(false);
  });

  it.each(['resolved', '"closed"', "'folded'"])('accepts a terminal Longshore card naming the fingerprint: %s', status => {
    expect(referralCardReadable('longshore:backlog/xabcdef-card.md@pr7', root, {
      fingerprint: 'finding-123', head: SHA, readOnPr: () => `---\nstatus: ${status}\n---\nfinding-123 ${SHA}`,
    })).toBe(true);
  });

  it.each([undefined, null, '', 'bad', 'a'.repeat(39), 'a'.repeat(40) + '\n'])('fails closed for Longshore without a valid head: %s', head => {
    expect(referralCardReadable('longshore:backlog/xabcdef-card.md@pr7', root, {
      fingerprint: 'finding-123', head, readOnPr: () => `---\nstatus: resolved\n---\nfinding-123 ${SHA}`,
    })).toBe(false);
  });

  it.each(['', 'a'.repeat(40)])('rejects the same fingerprint with absent or different head: %s', citedHead => {
    const text = `---\nstatus: resolved\n---\nfinding-123 ${citedHead}`;
    expect(cardResolvesFinding(text, 'finding-123', { head: SHA })).toBe(false);
    for (const prefix of ['we', 'longshore']) {
      expect(referralCardReadable(`${prefix}:backlog/xabcdef-card.md@pr7`, root, {
        fingerprint: 'finding-123', head: SHA, readOnPr: () => text, readMainByBornAs: () => null,
      })).toBe(false);
    }
  });

  it.each([SHA, SHA.slice(0, 12)])('accepts terminal fingerprint proof bound to head %s, including published bornAs fallback', citedHead => {
    const text = `---\nbornAs: xabcdef\nstatus: resolved\n---\nfinding-123 ${citedHead}`;
    expect(cardResolvesFinding(text, 'finding-123', { head: SHA })).toBe(true);
    const ref = 'we:backlog/xabcdef-card.md@pr7';
    for (const proof of [text, text.replace(citedHead, 'a'.repeat(40))]) {
      expect(referralCardReadable(ref, root, { fingerprint: 'finding-123', head: SHA,
        readOnPr: () => null, readMainByBornAs: () => proof })).toBe(proof === text);
    }
  });

  it.each(['open', 'resolved', 'closed', 'folded'])('fails closed without a fingerprint option: %s', status => {
    expect(referralCardReadable('longshore:backlog/xabcdef-card.md@pr7', root, {
      head: SHA, readOnPr: () => `---\nstatus: ${status}\n---\n${SHA}`,
    })).toBe(false);
  });

  it.each([
    'status: resolved\nstatus: closed', 'status: open', 'title: "start\nstatus: resolved\nend"',
    "title: 'start\nstatus: resolved\nend'", 'title: |\n  status: resolved',
    'status: resolved\nignored garbage', 'status: resolved\n  nested: value',
    'status: resolved\n# ignored comment', 'status: resolved\n\nextra: value',
  ])('rejects malformed, nonterminal or scalar-contained status: %s', frontmatter => {
    expect(cardResolvesFinding(`---\n${frontmatter}\n---\nfinding-123`, 'finding-123')).toBe(false);
  });

  it('requires a nonempty literal fingerprint and accepts it in body or frontmatter', () => {
    const text = '---\nstatus: resolved\n---\nfinding-123';
    for (const fingerprint of [undefined, null, '', 123, 'different']) expect(cardResolvesFinding(text, fingerprint)).toBe(false);
    expect(cardResolvesFinding(text, 'finding-123')).toBe(true);
    expect(cardResolvesFinding('---\nstatus: resolved\nfinding: finding-123\n---\n', 'finding-123')).toBe(true);
  });

  it('preserves WE @pr callers without a fingerprint, but checks supplied fingerprints including main fallback', () => {
    const ref = 'we:backlog/xabcdef-card.md@pr7';
    const readOnPr = () => CARD;
    expect(referralCardReadable(ref, root, { readOnPr })).toBe(true);
    expect(referralCardReadable(ref, root, { readOnPr, fingerprint: 'finding-123', readMainByBornAs: () => null })).toBe(false);
    const published = '---\nbornAs: xabcdef\nstatus: resolved\n---\n';
    expect(referralCardReadable(ref, root, { readOnPr: () => null, fingerprint: 'finding-123', readMainByBornAs: () => published })).toBe(false);
    expect(referralCardReadable(ref, root, { readOnPr: () => null, fingerprint: 'finding-123', readMainByBornAs: () => published + 'finding-123' })).toBe(true);
  });

  it.each(['null', 'throw', 'no frontmatter'])('resolves a merged, renumbered PR card through bornAs when the PR read returns %s', failure => {
    const landedRoot = mkdtempSync(join(tmpdir(), 'card-landed-'));
    const readOnPr = vi.fn(() => {
      if (failure === 'throw') throw new Error('404 after rename');
      return failure === 'null' ? null : 'not a card';
    });
    try {
      mkdirSync(join(landedRoot, 'backlog'));
      writeFileSync(join(landedRoot, 'backlog', '8271-x.md'), '---\nbornAs: xl95sq8\n---\n# card\n');
      const readMainByBornAs = born => (born === 'xl95sq8' ? '---\nbornAs: xl95sq8\n---\n# card\n' : null); // published on origin/main
      expect(referralCardReadable('we:backlog/xl95sq8-x.md@pr6815', landedRoot, { readOnPr, readMainByBornAs })).toBe(true);
      expect(readOnPr).toHaveBeenCalledWith('xl95sq8-x.md', '6815');
      // an explicit numbered @pr cite never falls back to the checkout's same-named file (record-red-team-ruling-io guarantee)
      expect(referralCardReadable('we:backlog/8271-x.md@pr6815', landedRoot, { readOnPr, readMainByBornAs })).toBe(false);
      expect(referralCardReadable('we:backlog/xabcdef-missing.md@pr6815', landedRoot, { readOnPr, readMainByBornAs })).toBe(false);
    } finally { rmSync(landedRoot, { recursive: true, force: true }); }
  });
  it('does not resolve an @pr cite through an UNPUBLISHED checkout card: only published origin/main counts (red-team 652e333)', () => {
    const landedRoot = mkdtempSync(join(tmpdir(), 'card-unpub-'));
    try {
      mkdirSync(join(landedRoot, 'backlog'));
      writeFileSync(join(landedRoot, 'backlog', '8271-x.md'), '---\nbornAs: xl95sq8\n---\n# card\n');
      for (const pr of [() => null, () => { throw new Error('404'); }]) {
        // PR unreadable (closed unmerged / side-branch) and main has no such card: the checkout file must not discharge it
        const readMainByBornAs = vi.fn(() => null);
        expect(referralCardReadable('we:backlog/xl95sq8-follow-up.md@pr6815', landedRoot, { readOnPr: pr, readMainByBornAs })).toBe(false);
        expect(readMainByBornAs).toHaveBeenCalledWith('xl95sq8', landedRoot);
      }
      // published on main under the renumbered name: readable
      const published = () => '---\nbornAs: xl95sq8\n---\n# card\n';
      expect(referralCardReadable('we:backlog/xl95sq8-follow-up.md@pr6815', landedRoot, { readOnPr: () => null, readMainByBornAs: published })).toBe(true);
      // a main read that throws, or returns a non-card / a card with another bornAs, fails closed
      expect(referralCardReadable('we:backlog/xl95sq8-f.md@pr6815', landedRoot, { readOnPr: () => null, readMainByBornAs: () => { throw new Error('git'); } })).toBe(false);
      expect(referralCardReadable('we:backlog/xl95sq8-f.md@pr6815', landedRoot, { readOnPr: () => null, readMainByBornAs: () => 'no frontmatter' })).toBe(false);
      expect(referralCardReadable('we:backlog/xl95sq8-f.md@pr6815', landedRoot, { readOnPr: () => null, readMainByBornAs: () => '---\nbornAs: xzzzzzz\n---\n' })).toBe(false);
    } finally { rmSync(landedRoot, { recursive: true, force: true }); }
  });
  it('default main reader (git) finds a card committed on origin/main by bornAs and ignores working-tree-only cards', () => {
    const repo = mkdtempSync(join(tmpdir(), 'card-git-'));
    const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
    try {
      git('init', '-q');
      mkdirSync(join(repo, 'backlog'));
      writeFileSync(join(repo, 'backlog', '8271-x.md'), '---\nbornAs: xl95sq8\n---\n# card\n');
      git('add', '.');
      git('commit', '-q', '-m', 'published');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      writeFileSync(join(repo, 'backlog', '9000-unpub.md'), '---\nbornAs: xunpub1\n---\n# card\n'); // checkout only
      expect(readMainCardByBornAs('xl95sq8', repo)).toMatch(/bornAs: xl95sq8/);
      expect(readMainCardByBornAs('xunpub1', repo)).toBeNull();
      expect(readMainCardByBornAs('xl95sq8', join(repo, 'nowhere'))).toBeNull();
      expect(referralCardReadable('we:backlog/xunpub1-f.md@pr6815', repo, { readOnPr: () => null })).toBe(false);
      expect(referralCardReadable('we:backlog/xl95sq8-f.md@pr6815', repo, { readOnPr: () => null })).toBe(true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  it.each(['\n', '\r\n'].flatMap(eol => [
    'xl95sq8', '"xl95sq8"', "'xl95sq8'", '\t"xl95sq8" \t',
  ].map(value => ({ eol, value }))))('finds a published card with line ending $eol and bornAs $value', ({ eol, value }) => {
    const publishedRoot = mkdtempSync(join(tmpdir(), 'card-eol-'));
    const path = 'backlog/8271-x.md';
    const card = ['---', `bornAs: ${value}`, '---', '# card', ''].join(eol);
    try {
      mkdirSync(join(publishedRoot, 'backlog'));
      writeFileSync(join(publishedRoot, path), card);
      // Exercise the emitted POSIX ERE with real Git grep, without writing Git objects or refs.
      const run = (cmd, args) => {
        expect(cmd).toBe('git');
        expect(args.slice(0, 2)).toEqual(['-C', publishedRoot]);
        if (args[2] === 'grep') {
          expect(args.slice(2, 5)).toEqual(['grep', '-l', '-E']);
          expect(args.slice(6)).toEqual(['origin/main', '--', 'backlog/']);
          execFileSync('git', ['grep', '--no-index', '-l', '-E', args[5], '--', path], {
            cwd: publishedRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 1 << 20,
          });
          return `origin/main:${path}\n`;
        }
        expect(args.slice(2)).toEqual(['show', `origin/main:${path}`]);
        return card;
      };
      const readMainByBornAs = (born, checkout) => readMainCardByBornAs(born, checkout, { run });
      expect(readMainByBornAs('xl95sq8', publishedRoot)).toBe(card);
      for (const readOnPr of [() => null, () => 'not a card', () => { throw new Error('404 after rename'); }]) {
        expect(referralCardReadable('we:backlog/xl95sq8-x.md@pr6815', publishedRoot, { readOnPr, readMainByBornAs })).toBe(true);
      }
    } finally { rmSync(publishedRoot, { recursive: true, force: true }); }
  });
  it('accepts a card that exists only on an open PR head, and on a merged one', () => {
    expect(ok('we:backlog/xsjn0uf-gate.md@pr7')).toBe(true);
    expect(ok('we:backlog/xsjn0uf-gate.md@pr9')).toBe(true);
  });
  it.each(['null', 'throw', 'no frontmatter'])('refuses a missing card when the PR read returns %s', failure => {
    const readOnPr = () => {
      if (failure === 'throw') throw new Error('404');
      return failure === 'null' ? null : 'not a card';
    };
    expect(referralCardReadable('we:backlog/xabcdef-missing.md@pr6815', root, { readOnPr })).toBe(false);
  });
  it('still refuses a card that exists nowhere', () => {
    expect(ok('we:backlog/xsjn0uf-gate.md')).toBe(false); // not on main, no @pr
    expect(ok('we:backlog/xnope000-ghost.md@pr7')).toBe(false); // not on the PR head
    expect(ok('we:backlog/xsjn0uf-gate.md@pr8')).toBe(false); // PR closed unmerged
    expect(ok('we:backlog/xsjn0uf-gate.md@pr404')).toBe(false); // PR does not exist
    expect(ok('we:backlog/empty.md@pr7')).toBe(false); // not a card
  });
  it('refuses a card on a PR that does not target main (open or merged): it would never reach the main backlog', () => {
    expect(ok('we:backlog/xsjn0uf-gate.md@pr10')).toBe(false);
    expect(ok('we:backlog/xsjn0uf-gate.md@pr11')).toBe(false);
    expect(readCardAtPrHead('xsjn0uf-gate.md', '10', { run: fakeGh })).toBeNull();
    // A missing base fails closed too, rather than being read as "main".
    const noBase = (cmd, args) => (args[0] === 'pr' ? JSON.stringify({ state: 'OPEN', headRefOid: SHA }) : CARD);
    expect(readCardAtPrHead('xsjn0uf-gate.md', '7', { run: noBase })).toBeNull();
  });
  it('asks gh only about the fixed repo, with the PR number as the original digit string', () => {
    calls.length = 0;
    expect(ok('we:backlog/xsjn0uf-gate.md@pr7')).toBe(true);
    expect(calls.map(a => a[0])).toEqual(['pr', 'api']);
    expect(calls[0].slice(2, 5)).toEqual(['7', '--repo', CONSTELLATION_REPOS.we.slug]);
    // The reader is the last line of defense: it refuses a PR number gh could read as a branch name, with no gh call.
    calls.length = 0;
    for (const pr of [0, -1, 1.5, 1e22, NaN, '7x', '07', '1e+22', '9'.repeat(10), '7 ', 'main', '']) {
      expect(() => readCardAtPrHead('xsjn0uf-gate.md', pr, { run: fakeGh }), String(pr)).toThrow(/PR number/);
    }
    expect(calls).toEqual([]);
  });
  it('rejects malformed refs without calling gh', () => {
    const spy = vi.fn();
    const bad9 = '9'.repeat(10);
    for (const bad of ['we:backlog/a.md@pr0', 'we:backlog/a.md@pr', 'we:backlog/a/b.md@pr7', 'we:backlog/a.md@prx',
      `we:backlog/a.md@pr${bad9}`, 'we:backlog/a.md@pr' + '9'.repeat(25), 'we:backlog/a.md@pr01']) {
      expect(referralCardReadable(bad, root, { readOnPr: spy })).toBe(false);
      expect(CARD_REF_RE.test(bad)).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it('rejects hostile file names (URL query/fragment/escape/traversal shapes) without calling gh or reading disk', () => {
    const spy = vi.fn();
    const hostile = [
      'x.md?ref=other-branch&unused=.md', 'x.md?ref=main&p=.md', 'x.md#frag.md', 'x%2f..%2fREADME.md', '..%2f..%2fREADME.md',
      'x%2e%2e.md', '%2e%2e.md', 'x{branch}.md', 'x y.md', 'x\n.md', 'x\r.md', 'x\t.md', 'x\\y.md', 'x:y.md', 'x;y.md',
      'x=y.md', 'x&y.md', 'x+y.md', '.md', '-x.md', '.x.md', 'x∕y.md', 'x\u0000.md', 'ｘ.md', 'x.md.md?a=1.md',
    ];
    for (const name of hostile) {
      for (const bad of [`we:backlog/${name}`, `we:backlog/${name}@pr7`]) {
        expect(CARD_REF_RE.test(bad), JSON.stringify(bad)).toBe(false);
        expect(referralCardReadable(bad, root, { readOnPr: spy }), JSON.stringify(bad)).toBe(false);
      }
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it('asks gh for exactly the verified sha: filename is one encoded path segment, ref is the sole query parameter', () => {
    const urls = [];
    const run = (cmd, args) => { if (args[0] !== 'api') return fakeGh(cmd, args); urls.push(args[args.length - 1]); return CARD; };
    // The reader itself is the last line of defense: hand it a name the regex would never admit.
    readCardAtPrHead('x.md?ref=other&p=.md', '7', { run });
    readCardAtPrHead('x/../../README.md#f', '7', { run });
    expect(urls).toHaveLength(2);
    for (const raw of urls) {
      const u = new URL(raw, 'https://api.github.com/');
      expect([...u.searchParams.keys()]).toEqual(['ref']);
      expect(u.searchParams.get('ref')).toBe(SHA);
      expect(u.hash).toBe('');
      expect(u.pathname.startsWith(`/repos/${CONSTELLATION_REPOS.we.slug}/contents/backlog/`)).toBe(true);
      expect(u.pathname.slice(u.pathname.indexOf('/backlog/') + 9)).not.toMatch(/\/|\.\.\//); // one segment, no traversal
    }
  });
  it('keeps main-side resolution, including bornAs renumbering, working', () => {
    writeFileSync(join(root, 'backlog', '5100-landed.md'), '---\nbornAs: xvm9vbu\n---\n# c\n');
    expect(ok('we:backlog/5100-landed.md')).toBe(true);
    expect(ok('we:backlog/xvm9vbu-whatever.md')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
