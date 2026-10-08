/**
 * @file referral-card-readable.test.mjs — xc7ctn1: a `card` ruling may cite a card that exists only on an OPEN (or
 *   merged) PR's head as `we:backlog/<file>.md@pr<N>`; a card that exists nowhere is still refused.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CARD_REF_RE, readCardAtPrHead, referralCardReadable } from '../referral-card-readable.mjs';

const CARD = '---\nstatus: open\n---\n# card\n';
const SHA = 'b'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'card-ro-'));
mkdirSync(join(root, 'backlog'));

/** A fake `gh`: PR 7 is open with the card, PR 8 is closed, PR 9 is merged; everything else does not exist. */
const fakeGh = (cmd, args) => {
  if (args[0] === 'pr') {
    const pr = args[2];
    if (pr === '7') return JSON.stringify({ state: 'OPEN', headRefOid: SHA });
    if (pr === '8') return JSON.stringify({ state: 'CLOSED', headRefOid: SHA });
    if (pr === '9') return JSON.stringify({ state: 'MERGED', headRefOid: SHA });
    throw new Error('no such PR');
  }
  const url = args[args.length - 1];
  if (url === `repos/web-everything/web-everything/contents/backlog/xsjn0uf-gate.md?ref=${SHA}`) return CARD;
  if (url.includes('empty.md')) return 'no frontmatter';
  throw new Error('404');
};
const readOnPr = (file, pr) => readCardAtPrHead(file, pr, { run: fakeGh });
const ok = ref => referralCardReadable(ref, root, { readOnPr });

describe('referralCardReadable @pr<N> (xc7ctn1)', () => {
  it('accepts a card that exists only on an open PR head, and on a merged one', () => {
    expect(ok('we:backlog/xsjn0uf-gate.md@pr7')).toBe(true);
    expect(ok('we:backlog/xsjn0uf-gate.md@pr9')).toBe(true);
  });
  it('still refuses a card that exists nowhere', () => {
    expect(ok('we:backlog/xsjn0uf-gate.md')).toBe(false); // not on main, no @pr
    expect(ok('we:backlog/xnope000-ghost.md@pr7')).toBe(false); // not on the PR head
    expect(ok('we:backlog/xsjn0uf-gate.md@pr8')).toBe(false); // PR closed unmerged
    expect(ok('we:backlog/xsjn0uf-gate.md@pr404')).toBe(false); // PR does not exist
    expect(ok('we:backlog/empty.md@pr7')).toBe(false); // not a card
  });
  it('rejects malformed refs without calling gh', () => {
    const spy = vi.fn();
    for (const bad of ['we:backlog/a.md@pr0', 'we:backlog/a.md@pr', 'we:backlog/a/b.md@pr7', 'we:backlog/a.md@prx']) {
      expect(referralCardReadable(bad, root, { readOnPr: spy })).toBe(false);
      expect(CARD_REF_RE.test(bad)).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it('keeps main-side resolution, including bornAs renumbering, working', () => {
    writeFileSync(join(root, 'backlog', '5100-landed.md'), '---\nbornAs: xvm9vbu\n---\n# c\n');
    expect(ok('we:backlog/5100-landed.md')).toBe(true);
    expect(ok('we:backlog/xvm9vbu-whatever.md')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
