import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cardIdOf, decideCardSalvage, hasUntrackedCards, loadCardTriage, salvageUntrackedCards } from '../daemon-clone-card-salvage.mjs';

describe('decideCardSalvage', () => {
  const mainIds = new Set(['7001', 'xaaaaaa']);
  const triaged = { dup: new Set(['xdup1']), stale: new Set(['xstale1']) };

  it('moves a card whose id is on main', () => {
    const r = decideCardSalvage({ untracked: ['backlog/xaaaaaa-landed.md'], mainIds, triaged });
    expect(r.move).toEqual([{ path: 'backlog/xaaaaaa-landed.md', id: 'xaaaaaa', reason: 'on-main' }]);
    expect(r.keep).toEqual([]);
  });

  it('moves a DUP- or STALE-listed card', () => {
    const r = decideCardSalvage({ untracked: ['backlog/xdup1-a.md', 'backlog/xstale1-b.md'], mainIds, triaged });
    expect(r.move.map((m) => m.reason)).toEqual(['triaged-dup', 'triaged-stale']);
  });

  it('keeps an unknown card', () => {
    const r = decideCardSalvage({ untracked: ['backlog/xnew0001-fresh.md'], mainIds, triaged });
    expect(r.move).toEqual([]);
    expect(r.keep).toEqual([{ path: 'backlog/xnew0001-fresh.md', id: 'xnew0001', reason: 'unknown' }]);
  });

  it('keeps everything when the main id set is unreadable (null)', () => {
    const r = decideCardSalvage({ untracked: ['backlog/xaaaaaa-landed.md'], mainIds: null, triaged });
    expect(r.move).toEqual([]);
    expect(r.keep[0].reason).toBe('main-unreadable');
  });

  it('ignores non-card paths and derives the id from the file name', () => {
    expect(cardIdOf('backlog/7001-some-slug.md')).toBe('7001');
    const r = decideCardSalvage({ untracked: ['backlog/README.txt', 'docs/x.md'], mainIds, triaged });
    expect(r).toEqual({ move: [], keep: [] });
  });
});

describe('salvageUntrackedCards', () => {
  it('moves landed and triaged cards to the salvage dir, keeps unknown, never deletes', () => {
    const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
    const origin = mkdtempSync(join(tmpdir(), 'cs-origin-'));
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'config', 'user.email', 't@t'); git(origin, 'config', 'user.name', 't');
    mkdirSync(join(origin, 'backlog'));
    writeFileSync(join(origin, 'backlog', 'xaaaaaa-landed.md'), 'on main\n');
    git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'init');
    const clone = mkdtempSync(join(tmpdir(), 'cs-clone-'));
    git(clone, 'clone', '-q', origin, '.');
    writeFileSync(join(clone, 'backlog', 'xaaaaaa-landed-copy.md'), 'landed elsewhere\n');
    writeFileSync(join(clone, 'backlog', 'xdup1-dup.md'), 'dup\n');
    writeFileSync(join(clone, 'backlog', 'xnew0001-fresh.md'), 'fresh\n');
    const salvageDir = mkdtempSync(join(tmpdir(), 'cs-salv-'));
    const r = salvageUntrackedCards({ root: clone, salvageDir, triaged: { dup: ['xdup1'], stale: [] } });
    expect(r.moved.map((m) => m.id).sort()).toEqual(['xaaaaaa', 'xdup1']);
    expect(r.kept.map((m) => m.id)).toEqual(['xnew0001']);
    expect(existsSync(join(clone, 'backlog', 'xdup1-dup.md'))).toBe(false);
    expect(existsSync(join(clone, 'backlog', 'xnew0001-fresh.md'))).toBe(true);
    expect(readFileSync(r.moved.find((m) => m.id === 'xdup1').to, 'utf8')).toBe('dup\n');
  });

  it('never overwrites an existing salvaged file of the same name', () => {
    const clone = mkdtempSync(join(tmpdir(), 'cs-clone2-'));
    const g = (...a) => execFileSync('git', a, { cwd: clone, encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    mkdirSync(join(clone, 'backlog'));
    writeFileSync(join(clone, 'backlog', 'seed.md'), 's\n'); g('add', '.'); g('commit', '-q', '-m', 'i');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const salvageDir = mkdtempSync(join(tmpdir(), 'cs-salv2-'));
    writeFileSync(join(salvageDir, 'xdup1-dup.md'), 'old\n');
    writeFileSync(join(clone, 'backlog', 'xdup1-dup.md'), 'new\n');
    const r = salvageUntrackedCards({ root: clone, salvageDir, triaged: { dup: ['xdup1'] } });
    expect(r.moved).toHaveLength(1);
    expect(readFileSync(join(salvageDir, 'xdup1-dup.md'), 'utf8')).toBe('old\n');
    expect(readFileSync(r.moved[0].to, 'utf8')).toBe('new\n');
  });
});

describe('guards', () => {
  it('loadCardTriage fails safe to an empty triage', () => {
    expect(loadCardTriage('/nonexistent/triage.json')).toEqual({ dup: [], stale: [] });
  });
  it('hasUntrackedCards is false outside a repo', () => {
    expect(hasUntrackedCards(mkdtempSync(join(tmpdir(), 'cs-norepo-')))).toBe(false);
  });
});
