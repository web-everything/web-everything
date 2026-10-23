// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planCardGroups, overlapReasonIsCardOnly, buildCombined, verifyUnion, sourceLanded, cardGroupHold, readCardGroupSettings,
  readGroupState, groupId, cardOnlyFiles, readReferenceMap, createCardGrouping, combinedPrBody, CARD_GROUP_MARKER,
  resolveCardGroupStatePath, cardGroupStatePath, isSubsequence, inCardGroup, queueBlocksGroup,
  cardGroupCandidates, runCardGroupPass,
} from '../card-group.mjs';
import { planLabelDrain, isRequiredCheckFailed } from '../../merge-ai-prs.mjs';
import { overlapRowKey } from '../../conveyor/land-overlap-yield.mjs';
import { withLandWriteLock } from '../../readiness/drain-lock.mjs';
import { createDrainMergeStrategy } from '../drain-merge-strategy.mjs';
import { resolveMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'card-group-test-')); dirs.push(d); return d; };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const CARD = 'backlog/5360-prevention-card.md';
const entry = n => `- Also raised by web-everything/web-everything#${n} (finding 1: \`we:backlog/6000-x.md:1\` — gate it.)`;
const card = (entries, status = 'open') => `---\nstatus: ${status}\n---\n\n# Card\n\nBody.\n\n## Also raised by\n\n${entries.map(entry).join('\n')}\n`;

function repo() {
  const cwd = tmp();
  git(cwd, 'init', '-q', '-b', 'main');
  mkdirSync(join(cwd, 'backlog'));
  writeFileSync(join(cwd, CARD), card([1, 2]));
  writeFileSync(join(cwd, 'backlog/5473-other.md'), card([7]));
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  const branch = (name, edit) => {
    git(cwd, 'checkout', '-q', '-b', name, base);
    edit();
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', name);
    const sha = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'checkout', '-q', 'main');
    return sha;
  };
  return { cwd, base, branch };
}

describe('planCardGroups', () => {
  const sha = c => c.repeat(40);
  it('groups PRs sharing a card file (connected components, oldest first, capped)', () => {
    const plans = planCardGroups({ maxSize: 3, candidates: [
      { num: 5, headSha: sha('a'), files: ['backlog/1-a.md'] },
      { num: 3, headSha: sha('b'), files: ['backlog/1-a.md', 'backlog/2-b.md'] },
      { num: 9, headSha: sha('c'), files: ['backlog/2-b.md'] },
      { num: 7, headSha: sha('d'), files: ['backlog/1-a.md'] },
      { num: 11, headSha: sha('e'), files: ['backlog/9-z.md'] },
    ] });
    expect(plans).toHaveLength(1);
    expect(plans[0].sources.map(s => s.num)).toEqual([3, 5, 7]);
  });
  it('never groups a candidate with a non-card file', () => {
    const plans = planCardGroups({ candidates: [
      { num: 1, headSha: sha('a'), files: ['backlog/1-a.md', 'scripts/x.mjs'] },
      { num: 2, headSha: sha('b'), files: ['backlog/1-a.md'] },
    ] });
    expect(plans).toEqual([]);
  });
  it('reads the overlap reason as card-only only when every shared path is a card', () => {
    expect(overlapReasonIsCardOnly('#5663 share backlog/5360-a.md')).toBe(true);
    expect(overlapReasonIsCardOnly('#5736 share scripts/lib/x.test.mjs')).toBe(false);
    expect(overlapReasonIsCardOnly('#1,#2 share backlog/1-a.md, scripts/x.mjs')).toBe(false);
    expect(cardOnlyFiles(['backlog/1-a.md'])).toBe(true);
    expect(cardOnlyFiles(['backlog/1-a.md', 'docs/x.md'])).toBe(false);
    expect(cardOnlyFiles([])).toBe(false);
  });
});

describe('buildCombined + verifyUnion (real git)', () => {
  it('unions conflicting Also-raised-by appends from 3 PRs and proves no line is lost', () => {
    const { cwd, base, branch } = repo();
    const a = branch('a', () => writeFileSync(join(cwd, CARD), card([1, 2, 10])));
    const b = branch('b', () => writeFileSync(join(cwd, CARD), card([1, 2, 11])));
    const c = branch('c', () => { writeFileSync(join(cwd, CARD), card([1, 2, 12])); writeFileSync(join(cwd, 'backlog/5473-other.md'), card([7, 13])); });
    const sources = [{ num: 10, headSha: a }, { num: 11, headSha: b }, { num: 12, headSha: c }];
    const built = buildCombined({ base, sources, cwd, resolveEnabled: true });
    expect(built.ok).toBe(true);
    expect(built.steps.map(s => s.resolved.length)).toEqual([0, 1, 1]);
    const text = git(cwd, 'show', `${built.commit}:${CARD}`);
    for (const n of [1, 2, 10, 11, 12]) expect(text).toContain(entry(n));
    expect(text).not.toMatch(/<<<<<<<|>>>>>>>/);
    const proof = verifyUnion({ base, combined: built.commit, sources, cwd });
    expect(proof).toMatchObject({ ok: true, missing: [], extra: [], deleted: [], resurrected: [], disagree: [], order: [], outside: [] });
    for (const s of sources) expect(sourceLanded({ ref: built.commit, source: s, cwd }).ok).toBe(true);
  });

  it('refuses a conflict outside the list (both PRs change the status line)', () => {
    const { cwd, base, branch } = repo();
    const a = branch('a', () => writeFileSync(join(cwd, CARD), card([1, 2], 'active')));
    const b = branch('b', () => writeFileSync(join(cwd, CARD), card([1, 2], 'resolved')));
    const built = buildCombined({ base, sources: [{ num: 1, headSha: a }, { num: 2, headSha: b }], cwd, resolveEnabled: true });
    expect(built.ok).toBe(false);
    expect(built.reason).toMatch(/#2: backlog\/5360-prevention-card\.md: conflict outside Also raised by list/);
  });

  it('refuses a non-card conflict', () => {
    const { cwd, base, branch } = repo();
    const a = branch('a', () => writeFileSync(join(cwd, 'README.md'), 'one\n'));
    const b = branch('b', () => writeFileSync(join(cwd, 'README.md'), 'two\n'));
    const built = buildCombined({ base, sources: [{ num: 1, headSha: a }, { num: 2, headSha: b }], cwd, resolveEnabled: true });
    expect(built).toMatchObject({ ok: false });
    expect(built.reason).toMatch(/non-card conflict \(README\.md\)/);
  });

  it('honours cardConflicts.autoResolveRaisedBy: disabled → a card conflict refuses the group', () => {
    const { cwd, base, branch } = repo();
    const a = branch('a', () => writeFileSync(join(cwd, CARD), card([1, 2, 10])));
    const b = branch('b', () => writeFileSync(join(cwd, CARD), card([1, 2, 11])));
    const built = buildCombined({ base, sources: [{ num: 10, headSha: a }, { num: 11, headSha: b }], cwd, resolveEnabled: false });
    expect(built.ok).toBe(false);
    expect(built.reason).toMatch(/autoResolveRaisedBy disabled/);
    // Default is fail closed too.
    expect(buildCombined({ base, sources: [{ num: 10, headSha: a }, { num: 11, headSha: b }], cwd }).ok).toBe(false);
  });

  it('refuses when the union dedup drops a duplicate entry no source deleted (multiset, not set)', () => {
    const { cwd, branch } = repo();
    const base2 = branch('dup', () => writeFileSync(join(cwd, CARD), card([1, 1, 2])));
    git(cwd, 'checkout', '-q', 'dup');
    const mk = (name, n) => { git(cwd, 'checkout', '-q', '-b', name, base2); writeFileSync(join(cwd, CARD), card([1, 1, 2, n])); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', name); const sha = git(cwd, 'rev-parse', 'HEAD'); git(cwd, 'checkout', '-q', 'main'); return sha; };
    const a = mk('a2', 10), b = mk('b2', 11);
    const sources = [{ num: 10, headSha: a }, { num: 11, headSha: b }];
    const built = buildCombined({ base: base2, sources, cwd, resolveEnabled: true });
    expect(built.ok).toBe(true);
    const proof = verifyUnion({ base: base2, combined: built.commit, sources, cwd });
    expect(proof.ok).toBe(false);
    expect(proof.deleted.map(d => d.line)).toContain(entry(1));
  });

  it('checks order: a source line moved out of order refuses; isSubsequence is ordered', () => {
    expect(isSubsequence(['a', 'b'], ['a', 'x', 'b'])).toBe(true);
    expect(isSubsequence(['b', 'a'], ['a', 'x', 'b'])).toBe(false);
    const { cwd, base, branch } = repo();
    const a = branch('a', () => writeFileSync(join(cwd, CARD), card([1, 2, 10, 11])));
    const swapped = branch('sw', () => writeFileSync(join(cwd, CARD), card([1, 2, 11, 10])));
    const proof = verifyUnion({ base, combined: swapped, sources: [{ num: 1, headSha: a }], cwd });
    expect(proof.ok).toBe(false);
    expect(proof.order.length).toBeGreaterThan(0);
    expect(sourceLanded({ ref: swapped, source: { num: 1, headSha: a }, cwd }).ok).toBe(false);
  });

  it('a reorder a source made is protected: the union keeping the old order refuses', () => {
    const { cwd, base, branch } = repo();
    const a = branch('a', () => writeFileSync(join(cwd, CARD), card([2, 1])));          // reorders existing entries
    const b = branch('b', () => writeFileSync(join(cwd, CARD), card([1, 2, 11])));
    const sources = [{ num: 1, headSha: a }, { num: 2, headSha: b }];
    const built = buildCombined({ base, sources, cwd, resolveEnabled: true });
    if (built.ok) expect(verifyUnion({ base, combined: built.commit, sources, cwd }).ok).toBe(false);
    const undone = branch('undone', () => writeFileSync(join(cwd, CARD), card([1, 2, 11])));  // keeps the old order
    expect(verifyUnion({ base, combined: undone, sources, cwd }).order.length).toBeGreaterThan(0);
    expect(sourceLanded({ ref: undone, source: { num: 1, headSha: a }, cwd }).ok).toBe(false);
  });

  it('a git read error is never read as "file absent" (deleted-file source is not declared landed)', () => {
    const { cwd, base, branch } = repo();
    const del = branch('del', () => { rmSync(join(cwd, 'backlog/5473-other.md')); });
    const run = (cmd, args, o = {}) => {
      if (args[0] === 'ls-tree' && args.includes(base)) return { status: 128, stdout: '', stderr: 'fatal: read error' };
      try { return { status: 0, stdout: execFileSync(cmd, args, { cwd, encoding: 'utf8', input: o.input }), stderr: '' }; }
      catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
    };
    expect(sourceLanded({ ref: base, source: { num: 1, headSha: del }, cwd, run })).toMatchObject({ ok: false });
    expect(sourceLanded({ ref: base, source: { num: 1, headSha: del }, cwd })).toMatchObject({ ok: false, reason: expect.stringMatching(/still on main/) });
    expect(sourceLanded({ ref: del, source: { num: 1, headSha: del }, cwd }).ok).toBe(true);
  });

  describe('a change with no line difference (file mode, final newline) is part of the source', () => {
    const noEol = () => writeFileSync(join(cwd0(), CARD), card([1, 2]).replace(/\n$/, ''));
    let cwd0;
    it.each([
      ['only the file mode changes', (cwd) => chmodSync(join(cwd, CARD), 0o755), /file mode/],
      ['only the final newline changes', () => noEol(), /final newline/],
      ['a new file is added executable', (cwd) => { writeFileSync(join(cwd, 'backlog/7000-new.md'), card([5])); chmodSync(join(cwd, 'backlog/7000-new.md'), 0o755); }, /file mode/],
    ])('source closure and the union proof refuse when %s and main lacks it', (_, edit, why) => {
      const r = repo();
      git(r.cwd, 'config', 'core.fileMode', 'true');
      cwd0 = () => r.cwd;
      const src = r.branch('src', () => edit(r.cwd));
      // Main as it was: the source's only change is not there, so the source has NOT landed and stays open.
      const lacking = /new file/.test(_) ? r.branch('lacking', () => writeFileSync(join(r.cwd, 'backlog/7000-new.md'), card([5]))) : r.base;
      expect(sourceLanded({ ref: lacking, source: { num: 1, headSha: src }, cwd: r.cwd })).toMatchObject({ ok: false, reason: expect.stringMatching(why) });
      // A combined commit that drops it is refused by the union proof, for that reason.
      const proof = verifyUnion({ base: r.base, combined: lacking, sources: [{ num: 1, headSha: src }], cwd: r.cwd });
      expect(proof.ok).toBe(false);
      expect(proof.missing.map(m => m.line).join(' ')).toMatch(why);
      // The real combined build carries it, so both checks pass there.
      const other = r.branch('other', () => writeFileSync(join(r.cwd, 'backlog/5473-other.md'), card([7, 13])));
      const sources = [{ num: 1, headSha: src }, { num: 2, headSha: other }];
      const built = buildCombined({ base: r.base, sources, cwd: r.cwd, resolveEnabled: true });
      expect(built.ok).toBe(true);
      expect(verifyUnion({ base: r.base, combined: built.commit, sources, cwd: r.cwd }).ok).toBe(true);
      for (const s of sources) expect(sourceLanded({ ref: built.commit, source: s, cwd: r.cwd }).ok).toBe(true);
    });
    it.each([
      ['a non-ASCII path (git C-quotes it in line output)', 'backlog/7001-café.md'],
      ['a path with a glob character', 'backlog/7002-st*r.md'],
    ])('a source changing %s has not landed while main lacks the change', (_, path) => {
      const r = repo();
      const seeded = r.branch('seed', () => writeFileSync(join(r.cwd, path), card([1])));
      const src = (() => { git(r.cwd, 'checkout', '-q', '-b', 'src2', seeded); writeFileSync(join(r.cwd, path), card([1, 9])); git(r.cwd, 'add', '--', path); git(r.cwd, 'commit', '-qm', 'src2'); const s = git(r.cwd, 'rev-parse', 'HEAD'); git(r.cwd, 'checkout', '-q', 'main'); return s; })();
      expect(sourceLanded({ ref: seeded, source: { num: 1, headSha: src }, cwd: r.cwd })).toMatchObject({ ok: false, reason: expect.stringContaining('is not on main') });
      expect(sourceLanded({ ref: src, source: { num: 1, headSha: src }, cwd: r.cwd }).ok).toBe(true);
      const proof = verifyUnion({ base: seeded, combined: seeded, sources: [{ num: 1, headSha: src }], cwd: r.cwd });
      expect(proof.missing.map(m => m.line)).toContain(entry(9));
    });
    it('a byte change in non-UTF-8 content is never read as unchanged (refuses)', () => {
      const r = repo();
      const bin = 'backlog/7003-bytes.md';
      const seeded = r.branch('seed', () => writeFileSync(join(r.cwd, bin), Buffer.from([0x61, 0xff, 0x0a])));
      const src = (() => { git(r.cwd, 'checkout', '-q', '-b', 'src3', seeded); writeFileSync(join(r.cwd, bin), Buffer.from([0x61, 0xfe, 0x0a])); git(r.cwd, 'add', '--', bin); git(r.cwd, 'commit', '-qm', 'src3'); const s = git(r.cwd, 'rev-parse', 'HEAD'); git(r.cwd, 'checkout', '-q', 'main'); return s; })();
      expect(sourceLanded({ ref: seeded, source: { num: 1, headSha: src }, cwd: r.cwd })).toMatchObject({ ok: false, reason: expect.stringMatching(/not valid UTF-8/) });
      expect(() => verifyUnion({ base: seeded, combined: seeded, sources: [{ num: 1, headSha: src }], cwd: r.cwd })).toThrow(/not valid UTF-8/);
    });
    it.each([['removes', true], ['adds', false]])('a source that only %s a UTF-8 BOM has not landed while main lacks the change', (_, baseHasBom) => {
      const r = repo();
      const bom = Buffer.from([0xef, 0xbb, 0xbf]), body = Buffer.from(card([1, 2]));
      // The repo's base already holds the card without a BOM.
      const seeded = baseHasBom ? r.branch('seed', () => writeFileSync(join(r.cwd, CARD), Buffer.concat([bom, body]))) : r.base;
      const src = (() => { git(r.cwd, 'checkout', '-q', '-b', 'bom', seeded); writeFileSync(join(r.cwd, CARD), baseHasBom ? body : Buffer.concat([bom, body])); git(r.cwd, 'add', '--', CARD); git(r.cwd, 'commit', '-qm', 'bom'); const s = git(r.cwd, 'rev-parse', 'HEAD'); git(r.cwd, 'checkout', '-q', 'main'); return s; })();
      expect(sourceLanded({ ref: seeded, source: { num: 1, headSha: src }, cwd: r.cwd }).ok).toBe(false);
      expect(sourceLanded({ ref: src, source: { num: 1, headSha: src }, cwd: r.cwd }).ok).toBe(true);
      expect(verifyUnion({ base: seeded, combined: seeded, sources: [{ num: 1, headSha: src }], cwd: r.cwd }).ok).toBe(false);
      expect(verifyUnion({ base: seeded, combined: src, sources: [{ num: 1, headSha: src }], cwd: r.cwd }).ok).toBe(true);
    });
    it('two sources that set different modes on one file disagree', () => {
      const r = repo();
      git(r.cwd, 'config', 'core.fileMode', 'true');
      const a = r.branch('a', () => { writeFileSync(join(r.cwd, CARD), card([1, 2, 10])); chmodSync(join(r.cwd, CARD), 0o755); });
      const b = r.branch('b', () => writeFileSync(join(r.cwd, CARD), card([1, 2, 10])));
      const combined = r.branch('c', () => { writeFileSync(join(r.cwd, CARD), card([1, 2, 10])); chmodSync(join(r.cwd, CARD), 0o755); });
      // b leaves the mode alone, so a's mode change is the union: accepted. A mode NO source set is refused.
      expect(verifyUnion({ base: r.base, combined, sources: [{ num: 1, headSha: a }, { num: 2, headSha: b }], cwd: r.cwd }).ok).toBe(true);
      expect(verifyUnion({ base: r.base, combined, sources: [{ num: 2, headSha: b }], cwd: r.cwd }).ok).toBe(false);
    });
  });

  it('verifyUnion catches a lost line, an extra line and a resurrected deletion', () => {
    const { cwd, base, branch } = repo();
    const a = branch('a', () => writeFileSync(join(cwd, CARD), card([1, 10])));      // deletes 2, adds 10
    const bad = branch('bad', () => writeFileSync(join(cwd, CARD), card([1, 2, 99]))); // keeps 2, no 10, adds 99
    const proof = verifyUnion({ base, combined: bad, sources: [{ num: 1, headSha: a }], cwd });
    expect(proof.ok).toBe(false);
    expect(proof.missing.map(m => m.line)).toContain(entry(10));
    expect(proof.extra.map(m => m.line)).toContain(entry(99));
    expect(proof.resurrected.map(m => m.line)).toContain(entry(2));
    expect(sourceLanded({ ref: bad, source: { num: 1, headSha: a }, cwd }).ok).toBe(false);
  });
});

describe('readReferenceMap', () => {
  it('leaves an ambiguous bornAs out of the map and reports it', () => {
    const { cwd } = repo();
    writeFileSync(join(cwd, 'backlog/7001-a.md'), '---\nbornAs: xaaaaaa\n---\n');
    writeFileSync(join(cwd, 'backlog/7002-b.md'), '---\nbornAs: xaaaaaa\n---\n');
    writeFileSync(join(cwd, 'backlog/7003-c.md'), '---\nbornAs: xbbbbbb\n---\n');
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'refs');
    const r = readReferenceMap({ base: git(cwd, 'rev-parse', 'HEAD'), cwd });
    expect(r.ok).toBe(true);
    expect([...r.ambiguous]).toEqual(['xaaaaaa']);
    expect(r.map.has('xaaaaaa')).toBe(false);
    expect(r.map.get('xbbbbbb')).toBe('7003');
  });
});

describe('cardGroupHold / state', () => {
  it.each([undefined, null, '', '   '])('empty repository identity %j never grants a group exemption and holds before enqueue', repo => {
    const state = { groups: [{ id: 'empty', repo, pr: 9, branch: 'lane/card-group-empty', sources: [{ num: 5 }] }] };
    expect(inCardGroup(state, { num: 5, repo })).toBe(false);
    expect(inCardGroup(state, { num: 9, repo, headRef: 'lane/card-group-empty' })).toBe(false);
    expect(cardGroupHold(state, { num: 5, repo })).toMatchObject({ kind: 'card-grouped', reason: expect.stringContaining('repository identity missing') });
  });

  const state = { groups: [{ id: 'g1', repo: 'o/r', pr: 9, sources: [{ num: 5, headSha: 'a'.repeat(40) }] }], failed: {} };
  it.each([
    ['a URL', 'https://github.com/O/R.git'], ['an ssh remote', 'git@github.com:o/r.git'], ['a host prefix', 'github.com/o/r'],
    ['a trailing slash and case', ' O/R/ '],
  ])('one repository spelled as %s is the same repository (membership and hold)', (_, spelling) => {
    const st = { groups: [{ id: 'g', repo: 'o/r', pr: 9, branch: 'lane/card-group-g', sources: [{ num: 5, headSha: 'a'.repeat(40) }] }] };
    expect(inCardGroup(st, { num: 5, repo: spelling })).toBe(true);
    expect(cardGroupHold(st, { num: 5, repo: spelling })).toMatchObject({ kind: 'card-grouped' });
  });
  it('a legacy owner or a repo key reaches the current slug', () => {
    const st = { groups: [{ id: 'g', repo: 'web-everything/web-everything', pr: 9, sources: [{ num: 5 }] }] };
    for (const spelling of ['chalbert/webeverything', 'we', 'https://github.com/chalbert/webeverything.git'])
      expect(inCardGroup(st, { num: 5, repo: spelling }), spelling).toBe(true);
    expect(inCardGroup(st, { num: 5, repo: 'web-everything/frontierui' })).toBe(false);
  });
  it('holds a source, not a stranger, not another repo', () => {
    expect(cardGroupHold(state, { num: 5, repo: null, localSlug: 'o/r' })).toMatchObject({ kind: 'card-grouped', reason: expect.stringContaining('#9') });
    expect(cardGroupHold(state, { num: 6, repo: null, localSlug: 'o/r' })).toBeNull();
    expect(cardGroupHold(state, { num: 5, repo: 'o/other', localSlug: 'o/r' })).toBeNull();
  });
  it('fails closed on an unreadable state file', () => {
    const d = tmp();
    const p = join(d, 'state.json');
    writeFileSync(p, '{not json');
    expect(readGroupState(p).unreadable).toBe(true);
    expect(cardGroupHold(readGroupState(p), { num: 1, localSlug: 'o/r' })).toMatchObject({ kind: 'card-grouped' });
  });
  it('group id is order-free; body references every source and carries the marker', () => {
    const s = [{ num: 2, headSha: 'b'.repeat(40) }, { num: 1, headSha: 'a'.repeat(40) }];
    expect(groupId(s)).toBe(groupId([...s].reverse()));
    const body = combinedPrBody({ id: 'x', sources: s, files: ['backlog/1-a.md'], base: 'c'.repeat(40) });
    expect(body).toContain('#2'); expect(body).toContain('#1'); expect(body).toContain(CARD_GROUP_MARKER);
  });
});

describe('resolveCardGroupStatePath (one resolver for grouping and enqueue)', () => {
  it('override wins everywhere; test runs without an override get no live path; production gets the coordination file', () => {
    expect(resolveCardGroupStatePath({ WE_DRAIN_CARD_GROUP_STATE: '/x/s.json', VITEST: '1' })).toBe('/x/s.json');
    expect(resolveCardGroupStatePath({ VITEST: '1' })).toBeNull();
    const prod = { HOME: '/h' };
    expect(resolveCardGroupStatePath(prod)).toBe(cardGroupStatePath(prod));
  });
  it('grouping with no state path is off', () => {
    const g = createCardGrouping({ localSlug: 'o/r', env: { VITEST: '1' }, settings: { enabled: true, maxSize: 8, eligibility: 'card-only', reconcileSec: 120, retryMin: 30, sources: {} }, log: { write() {} } });
    expect(g.form({ outcomes: [] }).reason).toBe('disabled');
    expect(g.holdFor({ num: 1 })).toBeNull();
  });
});

describe('reservation, membership, queue wait', () => {
  const state = { groups: [{ id: 'g', repo: 'o/r', pr: 9, files: ['backlog/1-a.md'], sources: [{ num: 5, headSha: 'a'.repeat(40) }] }], failed: {} };
  it('an open group reserves its card files against every other PR; the combined PR itself is not held', () => {
    expect(cardGroupHold(state, { num: 7, localSlug: 'o/r', files: ['backlog/1-a.md', 'scripts/x.mjs'] })).toMatchObject({ kind: 'card-grouped', reason: expect.stringMatching(/reserved by open card group #9/) });
    expect(cardGroupHold(state, { num: 7, localSlug: 'o/r', files: [{ path: 'backlog/2-b.md' }] })).toBeNull();
    expect(cardGroupHold(state, { num: 9, localSlug: 'o/r', files: ['backlog/1-a.md'] })).toBeNull();
  });
  it('never holds the published main-red repair PR: not for a reserved card, not as a source, not on unreadable state', () => {
    // Red main holds the combined PR, so a group hold on the repair would deadlock both (red team, PR 5762).
    expect(cardGroupHold(state, { num: 7, localSlug: 'o/r', files: ['backlog/1-a.md'], mainFix: true })).toBeNull();
    expect(cardGroupHold(state, { num: 5, localSlug: 'o/r', mainFix: true })).toBeNull();
    expect(cardGroupHold({ unreadable: true }, { num: 7, localSlug: 'o/r', mainFix: true })).toBeNull();
    // Only a real `true` exempts.
    expect(cardGroupHold(state, { num: 7, localSlug: 'o/r', files: ['backlog/1-a.md'], mainFix: 'yes' })).toMatchObject({ kind: 'card-grouped' });
    const dir = tmp(), statePath = join(dir, 's.json');
    writeFileSync(statePath, JSON.stringify(state));
    const st = { groups: [{ ...state.groups[0], branch: 'lane/card-group-g' }], failed: {} };
    writeFileSync(statePath, JSON.stringify(st));
    const live = new Set([7, 5]); // this pass's live red-main signal
    const g = createCardGrouping({ localSlug: 'o/r', cwd: dir, statePath, settings: { enabled: true, maxSize: 8, eligibility: 'card-only', reconcileSec: 120, retryMin: 30, sources: {} }, quiet: true,
      isMainFix: c => live.has(c.num) });
    expect(g.holdFor({ num: 7, listedFilesComplete: true, listedFiles: ['backlog/1-a.md'] })).toBeNull();
    // A repair that is a SOURCE is not shielded from rebase/repair either: it must become landable.
    expect(g.inGroup({ num: 5 })).toBe(false);
    expect(g.holdFor({ num: 5 })).toBeNull();
    // Main green again: the same PRs are held and members once more. A stale candidate field never exempts.
    live.clear();
    expect(g.holdFor({ num: 7, listedFilesComplete: true, listedFiles: ['backlog/1-a.md'], redMainFixPr: true })).toMatchObject({ kind: 'card-grouped' });
    expect(g.inGroup({ num: 5, redMainFixPr: true })).toBe(true);
  });
  it('membership (an exemption) needs proof: recorded source, or combined PR number AND recorded branch', () => {
    const st = { groups: [{ ...state.groups[0], branch: 'lane/card-group-g' }], failed: {} };
    expect(inCardGroup(st, { num: 5, localSlug: 'o/r' })).toBe(true);
    expect(inCardGroup(st, { num: 9, localSlug: 'o/r', headRef: 'lane/card-group-g' })).toBe(true);
    expect(inCardGroup(st, { num: 9, localSlug: 'o/r', headRef: 'lane/other' })).toBe(false);
    expect(inCardGroup(st, { num: 1, localSlug: 'o/r', headRef: 'lane/card-group-forged' })).toBe(false); // branch name alone
    expect(inCardGroup({ unreadable: true }, { num: 5, localSlug: 'o/r' })).toBe(false);                 // unreadable never exempts
    expect(inCardGroup({ groups: [], failed: {} }, { num: 5, localSlug: 'o/r' })).toBe(false);          // dissolved
  });
  it('a queued PR sharing a group card (or unknown files, or a queued source) makes the group wait', () => {
    const g = { sources: [{ num: 5 }], files: ['backlog/1-a.md'] };
    expect(queueBlocksGroup({ entries: [{ num: 3, files: ['backlog/1-a.md'] }] }, g)).toMatch(/queued #3 still shares backlog\/1-a\.md/);
    expect(queueBlocksGroup({ entries: [{ num: 3, files: null }] }, g)).toMatch(/unknown file list/);
    expect(queueBlocksGroup({ entries: [{ num: 5, files: [] }] }, g)).toMatch(/#5 is already in the merge queue/);
    expect(queueBlocksGroup({ entries: [], error: 'x' }, g)).toMatch(/unreadable/);
    expect(queueBlocksGroup({ entries: [{ num: 3, files: ['backlog/2-b.md'] }] }, g)).toBeNull();
  });
});

describe('readCardGroupSettings (cascade)', () => {
  it('standard is off; tool turns it on; env wins; invalid eligibility never enables code grouping', () => {
    expect(readCardGroupSettings({ env: { VITEST: '1' }, tool: {} })).toMatchObject({ enabled: false, maxSize: 8, sources: { enabled: 'standard' } });
    expect(readCardGroupSettings({ env: { VITEST: '1' }, tool: { enabled: true } })).toMatchObject({ enabled: true, sources: { enabled: 'tool' } });
    expect(readCardGroupSettings({ env: { VITEST: '1', WE_DRAIN_GROUP_ENABLED: 'off' }, tool: { enabled: true } })).toMatchObject({ enabled: false, sources: { enabled: 'env' } });
    expect(readCardGroupSettings({ env: { VITEST: '1' }, tool: { enabled: true, eligibility: 'all', maxSize: 99 } })).toMatchObject({ enabled: true, eligibility: 'card-only', maxSize: 8 });
  });
});

describe('createCardGrouping.form (fail closed)', () => {
  const settings = { enabled: true, maxSize: 8, eligibility: 'card-only', reconcileSec: 120, retryMin: 30, sources: {} };
  it('does nothing when disabled, or with fewer than 2 card-only deferrals', () => {
    const d = tmp();
    const g = createCardGrouping({ localSlug: 'o/r', statePath: join(d, 's.json'), settings: { ...settings, enabled: false }, exec: () => { throw new Error('no gh'); }, log: { write() {} } });
    expect(g.form({ outcomes: [] }).reason).toBe('disabled');
    const g2 = createCardGrouping({ localSlug: 'o/r', statePath: join(d, 's.json'), settings, exec: () => { throw new Error('no gh'); }, log: { write() {} } });
    const r = g2.form({ outcomes: [
      { num: 1, kind: 'queue-file-overlap', reason: '#9 share backlog/1-a.md' },
      { num: 2, kind: 'queue-file-overlap', reason: '#9 share scripts/x.mjs' },
    ] });
    expect(r.reason).toMatch(/1 card-only overlap deferral/);
    expect(existsSync(join(d, 's.json'))).toBe(false);
  });
  it('leaves a member out when no admission check is wired (never groups unchecked)', () => {
    const { cwd, base, branch } = repo();
    const a = branch('a', () => writeFileSync(join(cwd, CARD), card([1, 2, 10])));
    const b = branch('b', () => writeFileSync(join(cwd, CARD), card([1, 2, 11])));
    const d = tmp();
    const run = (cmd, args, o = {}) => {
      if (args[0] === 'ls-remote') return { status: 0, stdout: `${base}\trefs/heads/main\n`, stderr: '' };
      try { return { status: 0, stdout: execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...(o.env ?? {}) }, input: o.input }), stderr: '' }; }
      catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
    };
    const view = sha => JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: sha, headRefName: 'lane/x', baseRefName: 'main', labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }] });
    const exec = (cmd, args) => { if (args[0] === 'pr' && args[1] === 'view') return view(args[2] === '1' ? a : b); throw new Error(`unexpected ${args.join(' ')}`); };
    const g = createCardGrouping({ localSlug: 'o/r', cwd, run, exec, statePath: join(d, 's.json'), settings, log: { write() {} }, prestage: null });
    const verdicts = [1, 2].map(n => ({ num: n, repo: null, listedHeadSha: n === 1 ? a : b, prLabels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }] }));
    const outcomes = [1, 2].map(n => ({ num: n, kind: 'queue-file-overlap', reason: `#9 share ${CARD}` }));
    expect(g.form({ outcomes, verdicts }).reason).toMatch(/live re-check left fewer than 2/);
    // Dry run with an admission check: builds and proves, pushes nothing, writes no group.
    const dry = createCardGrouping({ localSlug: 'o/r', cwd, run, exec, statePath: join(d, 's2.json'), settings, log: { write() {} }, dryRun: true, prestage: () => ({ allowed: true }), readQueueFiles: () => ({ entries: [] }) });
    const r = dry.form({ outcomes, verdicts });
    expect(r.dryRun).toBe(true);
    expect(r.proof.ok).toBe(true);
    expect(existsSync(join(d, 's2.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(d, 's.json'), 'utf8')).groups).toEqual([]);
  });
});

describe('createCardGrouping — claim under the land mutex, close on current heads', () => {
  const settings = { enabled: true, maxSize: 8, eligibility: 'card-only', reconcileSec: 120, retryMin: 30, sources: {} };
  const accepted = [{ name: 'ready-to-merge' }, { name: 'review:accepted' }];
  const runIn = (cwd, mainSha) => (cmd, args, o = {}) => {
    if (args[0] === 'ls-remote') return { status: 0, stdout: args.at(-1) === 'refs/heads/main' ? `${mainSha()}\trefs/heads/main\n` : '', stderr: '' };
    if (args[0] === 'push') return { status: 0, stdout: '', stderr: '' };
    try { return { status: 0, stdout: execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...(o.env ?? {}) }, input: o.input }), stderr: '' }; }
    catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
  };
  function setup() {
    const { cwd, base, branch } = repo();
    const a = branch('a', () => writeFileSync(join(cwd, CARD), card([1, 2, 10])));
    const b = branch('b', () => writeFileSync(join(cwd, CARD), card([1, 2, 11])));
    const heads = { 1: a, 2: b };
    const calls = [];
    const exec = (cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: heads[args[2]], headRefName: 'lane/x', baseRefName: 'main', labels: accepted });
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/o/r/pull/77\n';
      if (args[0] === 'pr' && ['comment', 'close'].includes(args[1])) return '';
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    const verdicts = [1, 2].map(n => ({ num: n, repo: null, listedHeadSha: heads[n], prLabels: accepted }));
    const outcomes = [1, 2].map(n => ({ num: n, kind: 'queue-file-overlap', reason: `#9 share ${CARD}` }));
    return { cwd, base, a, b, heads, calls, exec, verdicts, outcomes };
  }
  const cc = { value: { autoResolveRaisedBy: true }, sources: { autoResolveRaisedBy: 'standard' } };

  it.each([
    ['before planning', null], ['inside claim', null],
    ['before planning', 'branch collision'], ['inside claim', 'push failed'],
  ])('formation ignores foreign source numbers %s and preserves a colliding group ID on %s', (timing, failure) => {
    const t = setup();
    const statePath = join(tmp(), 's.json');
    const sources = [1, 2].map(num => ({ num, headSha: t.heads[num] }));
    const foreign = { id: groupId(sources), repo: 'o/foreign', pr: null, sources };
    writeFileSync(statePath, JSON.stringify({ groups: timing === 'before planning' ? [foreign] : [], failed: {} }));
    const withLock = fn => {
      if (timing === 'inside claim') writeFileSync(statePath, JSON.stringify({ groups: [foreign], failed: {} }));
      return { ran: true, result: fn() };
    };
    const run = (cmd, args, opts) => {
      if (failure === 'branch collision' && args[0] === 'ls-remote' && args.at(-1) !== 'refs/heads/main') return { status: 0, stdout: 'f'.repeat(40) };
      if (failure === 'push failed' && args[0] === 'push') return { status: 1, stdout: '', stderr: 'push refused' };
      return runIn(t.cwd, () => t.base)(cmd, args, opts);
    };
    const g = createCardGrouping({ localSlug: 'o/r', cwd: t.cwd, run, exec: t.exec,
      statePath, settings, log: { write() {} }, prestage: () => ({ allowed: true }), cardConflictSettings: cc,
      withLock, readQueueFiles: () => ({ entries: [] }) });
    const result = g.form({ outcomes: t.outcomes, verdicts: t.verdicts });
    const groups = readGroupState(statePath).groups;
    expect(groups[0]).toEqual(foreign);
    if (failure) {
      expect(result.formed).toBeUndefined();
      expect(result.reason).toMatch(/already exists at another commit|push failed/);
      expect(groups).toEqual([foreign]);
    } else {
      expect(result.formed).toMatchObject({ pr: 77 });
      expect(groups).toHaveLength(2);
      expect(groups[1]).toMatchObject({ repo: 'o/r', pr: 77 });
    }
  });

  it.each([
    ['combined PR closed without merging', { state: 'CLOSED', labels: [] }],
    ['combined PR sent back', { state: 'OPEN', labels: [{ name: 'review:changes' }] }],
  ])('a group dissolved because its %s is not rebuilt by the next form (retry memo)', (_, combined) => {
    const t = setup();
    const statePath = join(tmp(), 's.json');
    let pr77 = null;
    const exec = (cmd, args) => (args[0] === 'pr' && args[1] === 'view' && args[2] === '77' && pr77 ? JSON.stringify(pr77) : t.exec(cmd, args));
    const g = createCardGrouping({ localSlug: 'o/r', cwd: t.cwd, run: runIn(t.cwd, () => t.base), exec, settings, log: { write() {} }, prestage: () => ({ allowed: true }),
      cardConflictSettings: cc, statePath, withLock: fn => ({ ran: true, result: fn() }), readQueueFiles: () => ({ entries: [] }) });
    expect(g.form({ outcomes: t.outcomes, verdicts: t.verdicts }).formed).toMatchObject({ pr: 77 });
    pr77 = combined;
    expect(g.reconcile({ force: true })).toMatchObject({ dissolved: [expect.any(String)] });
    expect(Object.keys(readGroupState(statePath).failed)).toEqual([`1@${t.heads[1]},2@${t.heads[2]}`]);
    const creates = t.calls.filter(c => c.startsWith('pr create')).length;
    expect(g.form({ outcomes: t.outcomes, verdicts: t.verdicts }).reason).toMatch(/retry backoff/);
    expect(t.calls.filter(c => c.startsWith('pr create'))).toHaveLength(creates);
    expect(readGroupState(statePath).groups).toEqual([]);
  });

  it('refuses without the land mutex, and when a source is already queued at claim time', () => {
    const t = setup();
    const d = tmp();
    const base = () => t.base;
    const opts = { localSlug: 'o/r', cwd: t.cwd, run: runIn(t.cwd, base), exec: t.exec, settings, log: { write() {} }, prestage: () => ({ allowed: true }), cardConflictSettings: cc };
    expect(createCardGrouping({ ...opts, statePath: join(d, 'a.json') }).form({ outcomes: t.outcomes, verdicts: t.verdicts }).reason).toMatch(/no queue file read wired/);
    expect(createCardGrouping({ ...opts, statePath: join(d, 'a2.json'), readQueueFiles: () => ({ entries: [] }) }).form({ outcomes: t.outcomes, verdicts: t.verdicts }).reason).toMatch(/no land mutex/);
    // A queued PR still sharing the card: wait, build nothing, memo nothing.
    const waiting = createCardGrouping({ ...opts, statePath: join(d, 'w.json'), withLock: fn => ({ ran: true, result: fn() }), readQueueFiles: () => ({ entries: [{ num: 99, files: [CARD] }] }) });
    expect(waiting.form({ outcomes: t.outcomes, verdicts: t.verdicts })).toMatchObject({ waiting: true, reason: expect.stringMatching(/queued #99 still shares/) });
    expect(existsSync(join(d, 'w.json'))).toBe(false);
    let locked = false;
    const withLock = fn => { locked = true; try { return { ran: true, result: fn() }; } finally { locked = false; } };
    const queued = createCardGrouping({ ...opts, statePath: join(d, 'b.json'), withLock, readQueueFiles: () => (locked ? { entries: [{ num: 2, files: [CARD] }] } : { entries: [] }) });
    expect(queued.form({ outcomes: t.outcomes, verdicts: t.verdicts }).reason).toMatch(/#2 is already in the merge queue/);
    expect(readGroupState(join(d, 'b.json')).groups ?? []).toEqual([]);
    const busy = createCardGrouping({ ...opts, statePath: join(d, 'c.json'), withLock: () => ({ ran: false }), readQueueFiles: () => ({ entries: [] }) });
    expect(busy.form({ outcomes: t.outcomes, verdicts: t.verdicts }).reason).toMatch(/land mutex held/);
    // A clean claim records the group inside the lock and opens the PR.
    const ok = createCardGrouping({ ...opts, statePath: join(d, 'e.json'), withLock, readQueueFiles: () => ({ entries: [] }) });
    const r = ok.form({ outcomes: t.outcomes, verdicts: t.verdicts });
    expect(r.formed).toMatchObject({ pr: 77 });
    // overlap-yield holds are a waiting kind too (the git card-only check still decides).
    const t2 = setup();
    const y = createCardGrouping({ ...opts, cwd: t2.cwd, run: runIn(t2.cwd, () => t2.base), exec: t2.exec, statePath: join(d, 'y.json'), withLock, readQueueFiles: () => ({ entries: [] }) });
    expect(y.form({ outcomes: [1, 2].map(n => ({ num: n, kind: 'overlap-yield', reason: 'overlap-yield:#9' })), verdicts: t2.verdicts }).formed).toMatchObject({ pr: 77 });
    expect(ok.holdFor({ num: 1 })).toMatchObject({ kind: 'card-grouped' });
    expect(t.calls.some(c => c.startsWith('pr create') && c.includes('review:pending'))).toBe(true);
  });

  describe('drain pass step (runCardGroupPass)', () => {
    const lockOpts = { withLock: fn => ({ ran: true, result: fn() }), readQueueFiles: () => ({ entries: [] }) };

    it('the planner\'s overlap-yield deferrals reach form() and form a group with no enqueue outcome', () => {
      const t = setup();
      // The real planner: both card PRs yield to #40, so neither is ready and neither reaches the enqueue loop.
      const octx = new Map([1, 2].map(n => [overlapRowKey({ repo: null, number: n }), { yieldTo: 40, repo: null, files: [CARD], untilMs: 1_000, windowMinutes: 45 }]));
      const { ready, deferred } = planLabelDrain([1, 2].map(n => ({ num: n, item: null, blockedBy: [], decision: 'merge', repo: null })), { overlapContext: octx });
      expect(ready).toEqual([]);
      // #40 (the PR both yield to) is listed too; it has no verdict here, so form() leaves it out.
      expect(cardGroupCandidates({ enqueueOutcomes: [], deferred }).map(o => [o.num, o.outcome])).toEqual([[1, 'deferred'], [2, 'deferred'], [40, 'yield-target']]);
      const g = createCardGrouping({ localSlug: 'o/r', cwd: t.cwd, run: runIn(t.cwd, () => t.base), exec: t.exec, statePath: join(tmp(), 's.json'),
        settings, log: { write() {} }, prestage: () => ({ allowed: true }), cardConflictSettings: cc, ...lockOpts });
      const verdicts = t.verdicts.map(v => ({ ...v, decision: 'merge' }));
      const r = runCardGroupPass({ grouping: g, enqueues: true, enqueueOutcomes: [], deferred, verdicts, log: { write() {} } });
      expect(r.grouping.formed).toMatchObject({ pr: 77 });
    });

    it('a deferral from the pass-start plan whose verdict was since held or pre-staged with CI pending stays out', () => {
      const deferred = [1, 2].map(n => ({ num: n, item: null, waitOn: ['overlap-yield:#40'], overlapYield: { pr: 40, repo: null } }));
      for (const late of [{ decision: 'skip' }, { decision: 'merge', prestagePendingCi: true }]) {
        const t = setup();
        const verdicts = t.verdicts.map(v => ({ ...v, decision: 'merge', ...(v.num === 2 ? late : {}) }));
        const g = createCardGrouping({ localSlug: 'o/r', cwd: t.cwd, run: runIn(t.cwd, () => t.base), exec: t.exec, statePath: join(tmp(), 's.json'),
          settings, log: { write() {} }, prestage: () => ({ allowed: true }), cardConflictSettings: cc, ...lockOpts });
        expect(runCardGroupPass({ grouping: g, enqueues: true, deferred, verdicts, log: { write() {} } }).grouping.reason).toMatch(/fewer than 2 accepted card candidates/);
      }
    });

    it('keys yield targets by repository: a sibling repo\'s PR with the same number never suppresses or claims a local target', () => {
      const wait = (num, repo, pr) => ({ num, repo, waitOn: [`overlap-yield:#${pr}`], overlapYield: { pr, repo } });
      const targets = d => cardGroupCandidates({ deferred: d }).filter(o => o.yieldTarget).map(o => [o.num, o.repo]);
      // A sibling deferral numbered #57 is not the local #57 that local #12 yields to.
      expect(targets([wait(12, 'o/r', 57), wait(57, 'sib/x', 3)])).toEqual([[57, 'o/r'], [3, 'sib/x']]);
      // A sibling target #40 registered first does not stand in for the local target #40.
      expect(targets([wait(9, 'sib/x', 40), wait(1, 'o/r', 40)])).toEqual([[40, 'sib/x'], [40, 'o/r']]);
      // Within one repository a target that is itself waiting is still not a separate target.
      expect(targets([wait(1, 'o/r', 2), wait(2, 'O/R', 3)])).toEqual([[3, 'O/R']]);
    });

    it('the ready PR the others yield to joins the group (two approved card PRs on one card), only when it would land now', () => {
      // #1 yields to #2; #2 is READY, so without joining it would be queued ahead and the group would never form.
      const octx = new Map([[overlapRowKey({ repo: null, number: 1 }), { yieldTo: 2, repo: null, files: [CARD], untilMs: 1_000, windowMinutes: 45 }]]);
      const { ready, deferred } = planLabelDrain([1, 2].map(n => ({ num: n, item: null, blockedBy: [], decision: 'merge', repo: null })), { overlapContext: octx });
      expect(ready.map(c => c.num)).toEqual([2]);
      expect(cardGroupCandidates({ deferred }).map(o => [o.num, o.outcome])).toEqual([[1, 'deferred'], [2, 'yield-target']]);
      for (const [decision, formed] of [['merge', true], ['skip', false]]) {
        const t = setup();
        const verdicts = t.verdicts.map(v => ({ ...v, decision: v.num === 2 ? decision : 'merge' }));
        const g = createCardGrouping({ localSlug: 'o/r', cwd: t.cwd, run: runIn(t.cwd, () => t.base), exec: t.exec, statePath: join(tmp(), 's.json'),
          settings, log: { write() {} }, prestage: () => ({ allowed: true }), cardConflictSettings: cc, ...lockOpts });
        const r = runCardGroupPass({ grouping: g, enqueues: true, deferred, verdicts, log: { write() {} } });
        if (formed) {
          expect(r.grouping.formed.sources.map(s => s.num)).toEqual([1, 2]);
          // The cascade's hold (run right after formation) now keeps the yield target out of the queue.
          expect(g.holdFor({ num: 2 })).toMatchObject({ kind: 'card-grouped' });
        } else expect(r.grouping.reason).toMatch(/fewer than 2 accepted card candidates/);
      }
    });

    it('a candidate touching a card an open group reserves is left out (formation runs before the cascade hold)', () => {
      const t = setup();
      const statePath = join(tmp(), 's.json');
      writeFileSync(statePath, JSON.stringify({ groups: [{ id: 'old', repo: 'o/r', pr: 70, branch: 'lane/card-group-old', files: [CARD], sources: [{ num: 5, headSha: 'c'.repeat(40) }] }], failed: {} }));
      const g = createCardGrouping({ localSlug: 'o/r', cwd: t.cwd, run: runIn(t.cwd, () => t.base), exec: t.exec, statePath,
        settings, log: { write() {} }, prestage: () => ({ allowed: true }), cardConflictSettings: cc, ...lockOpts });
      expect(g.form({ outcomes: t.outcomes, verdicts: t.verdicts }).reason).toMatch(/no group of 2\+ sharing a card/);
      expect(readGroupState(statePath).groups.map(x => x.id)).toEqual(['old']);
    });

    it('only a deferral whose every wait is an overlap-yield is a candidate', () => {
      const deferred = [
        { num: 1, waitOn: ['overlap-yield:#40'], overlapYield: { pr: 40, repo: 'o/r' } },
        { num: 2, waitOn: [7, 'overlap-yield:#40'] }, { num: 3, waitOn: ['couple-carrier:9', 'overlap-yield:#40'] },
        { num: 4, waitOn: ['required-check-read'] }, { num: 5, waitOn: [] }, { num: 6 },
      ];
      expect(cardGroupCandidates({ enqueueOutcomes: [{ num: 8, kind: 'merge-lock-held' }], deferred }))
        .toEqual([{ num: 8, kind: 'merge-lock-held' }, { num: 1, repo: 'o/r', outcome: 'deferred', kind: 'overlap-yield', reason: 'overlap-yield:#40' },
          { num: 40, repo: 'o/r', outcome: 'yield-target', kind: 'overlap-yield', reason: 'yielded to by #1', yieldTarget: true }]);
    });

    it('reconciles under any strategy (forms only under the queue); a single-PR pass does neither', () => {
      const calls = [];
      const grouping = { reconcile: () => { calls.push('reconcile'); return {}; }, form: () => { calls.push('form'); return { reason: 'disabled' }; } };
      runCardGroupPass({ grouping, enqueues: false });
      expect(calls).toEqual(['reconcile']);
      runCardGroupPass({ grouping, enqueues: true });
      expect(calls).toEqual(['reconcile', 'reconcile', 'form']);
      runCardGroupPass({ grouping, onlyPr: 5, enqueues: true });
      expect(calls).toHaveLength(3);
    });

    it('after a switch to direct merging, a closed combined PR dissolves its group and releases every hold', () => {
      const t = setup();
      const statePath = join(tmp(), 's.json');
      writeFileSync(statePath, JSON.stringify({ groups: [{ id: 'g', repo: 'o/r', pr: 77, branch: 'lane/card-group-g', files: [CARD],
        sources: [{ num: 1, headSha: t.a }, { num: 2, headSha: t.b }] }], failed: {} }));
      const calls = [];
      const exec = (cmd, args) => {
        calls.push(args.join(' '));
        if (args[0] === 'pr' && args[1] === 'view') return args[2] === '77' ? JSON.stringify({ state: 'CLOSED', labels: [] }) : t.exec(cmd, args);
        return '';
      };
      const g = createCardGrouping({ localSlug: 'o/r', cwd: t.cwd, run: runIn(t.cwd, () => t.base), exec, statePath, settings, log: { write() {} } });
      expect(g.holdFor({ num: 1 })).toMatchObject({ kind: 'card-grouped' });
      expect(g.holdFor({ num: 9, listedFilesComplete: true, listedFiles: [CARD] })).toMatchObject({ kind: 'card-grouped' });
      const r = runCardGroupPass({ grouping: g, enqueues: false, log: { write() {} } });
      expect(r.reconciled.dissolved).toEqual(['g']);
      expect(r.grouping).toBeNull();
      expect(g.holdFor({ num: 1 })).toBeNull();
      expect(g.holdFor({ num: 9, listedFilesComplete: true, listedFiles: [CARD] })).toBeNull();
    });
  });

  it('after the combined PR merged: closes a source only when its CURRENT head is on main, else releases it', () => {
    const t = setup();
    const d = tmp();
    const statePath = join(d, 's.json');
    // Main after the merge carries entries 10 and 11 (both sources at their recorded heads).
    git(t.cwd, 'checkout', '-q', '-b', 'merged', t.base);
    writeFileSync(join(t.cwd, CARD), card([1, 2, 10, 11])); git(t.cwd, 'add', '-A'); git(t.cwd, 'commit', '-qm', 'merged');
    const mainAfter = git(t.cwd, 'rev-parse', 'HEAD');
    // Source 2 was pushed to since grouping: its current head adds 12, which is NOT on main.
    git(t.cwd, 'checkout', '-q', '-b', 'b-new', t.b);
    writeFileSync(join(t.cwd, CARD), card([1, 2, 11, 12])); git(t.cwd, 'add', '-A'); git(t.cwd, 'commit', '-qm', 'b-new');
    const bNew = git(t.cwd, 'rev-parse', 'HEAD');
    git(t.cwd, 'checkout', '-q', 'main');
    writeFileSync(statePath, JSON.stringify({ groups: [{ id: 'g', repo: 'o/r', pr: 77, branch: 'lane/card-group-g', sources: [{ num: 1, headSha: t.a }, { num: 2, headSha: t.b }] }], failed: {} }));
    const heads = { 1: t.a, 2: bNew };
    const calls = [];
    const exec = (cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') return args[2] === '77' ? JSON.stringify({ state: 'MERGED', labels: [] })
        : JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: heads[args[2]], headRefName: 'lane/x', baseRefName: 'main', labels: accepted });
      if (args[0] === 'pr' && ['comment', 'close'].includes(args[1])) return '';
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    const g = createCardGrouping({ localSlug: 'o/r', cwd: t.cwd, run: runIn(t.cwd, () => mainAfter), exec, statePath, settings, log: { write() {} } });
    const r = g.reconcile({ force: true });
    expect(r.done).toEqual(['g']);
    expect(calls.filter(c => c.startsWith('pr close'))).toEqual([expect.stringMatching(/^pr close 1 /)]);
    expect(calls.some(c => c.startsWith('pr comment 2 '))).toBe(true);
    expect(readGroupState(statePath).groups).toEqual([]);
  });

  // One source per `edits` entry: a string is the new CARD text, an object maps paths to texts. `baseFiles` are
  // committed on main first. Every PR live-reads OPEN + accepted at its head unless the test changes it.
  function formRepo(edits, { baseFiles } = {}) {
    const { cwd } = repo();
    if (baseFiles) {
      for (const [p, text] of Object.entries(baseFiles)) writeFileSync(join(cwd, p), text);
      git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'base2');
    }
    const base = git(cwd, 'rev-parse', 'HEAD');
    const heads = {};
    for (const [n, spec] of Object.entries(edits)) {
      git(cwd, 'checkout', '-q', '-b', `s${n}`, base);
      for (const [p, text] of Object.entries(typeof spec === 'string' ? { [CARD]: spec } : spec)) writeFileSync(join(cwd, p), text);
      git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', `s${n}`);
      heads[n] = git(cwd, 'rev-parse', 'HEAD');
      git(cwd, 'checkout', '-q', 'main');
    }
    const labels = Object.fromEntries(Object.keys(heads).map(n => [n, accepted]));
    const fails = new Set();
    const calls = [];
    const exec = (cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view' && fails.has(args[2])) throw new Error('gh: 502');
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: heads[args[2]], headRefName: 'lane/x', baseRefName: 'main', labels: labels[args[2]] });
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/o/r/pull/77\n';
      if (args[0] === 'pr' && ['comment', 'close'].includes(args[1])) return '';
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    const nums = Object.keys(heads).map(Number);
    const verdicts = nums.map(n => ({ num: n, repo: null, listedHeadSha: heads[n], prLabels: accepted }));
    const outcomes = nums.map(n => ({ num: n, kind: 'queue-file-overlap', reason: `#9 share ${CARD}` }));
    const out = [];
    const opts = { localSlug: 'o/r', cwd, run: runIn(cwd, () => base), exec, settings, log: { write: l => out.push(l) }, prestage: () => ({ allowed: true }), cardConflictSettings: cc, readQueueFiles: () => ({ entries: [] }) };
    return { cwd, base, heads, labels, fails, calls, exec, verdicts, outcomes, out, opts };
  }

  describe('form: admission and eligibility', () => {
    it.each(['ls-remote', 'push'])('a stale %s failure never rolls back a replacement claim', failure => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]) });
      const statePath = join(tmp(), 's.json');
      let replacement;
      const run = (cmd, args, opts) => {
        if (args[0] === failure && (failure === 'push' || args.at(-1).startsWith('refs/heads/lane/card-group-'))) {
          const original = readGroupState(statePath).groups[0];
          replacement = { ...original, createdAt: original.createdAt + 1 };
          writeFileSync(statePath, JSON.stringify({ groups: [replacement], failed: {} }));
          return { status: 1, stdout: '', stderr: 'remote unavailable' };
        }
        return t.opts.run(cmd, args, opts);
      };
      const result = createCardGrouping({ ...t.opts, run, statePath, withLock: fn => ({ ran: true, result: fn() }) })
        .form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(result.formed).toBeUndefined();
      expect(result.reason).toMatch(/ls-remote failed|push failed/);
      expect(readGroupState(statePath).groups).toEqual([replacement]);
      expect(t.calls.some(c => c.startsWith('pr create'))).toBe(false);
    });

    it('the real land mutex excludes an enqueue during a group claim, then the enqueue re-reads its hold', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]) });
      const statePath = join(tmp(), 's.json'), lockRoot = tmp();
      const locked = (owner, fn) => withLandWriteLock(fn, { lockRoot, owner, waitMs: 0, runUnlockedOnContention: false });
      let enqueueCalls = 0, during;
      const strategy = createDrainMergeStrategy({
        localSlug: 'o/r', resolved: { policy: resolveMergeDeliveryPolicy({ tool: { strategy: 'github-merge-queue' } }) },
        env: { ...process.env, WE_DRAIN_CARD_GROUP_STATE: statePath }, log: { write() {} }, quiet: true,
        exec: () => { enqueueCalls++; throw new Error('held source must never reach GitHub'); },
      });
      const enqueue = () => locked('enqueue', () => strategy.enqueue({ num: 1 }, t.heads[1], { comments: [] }));
      const withLock = fn => locked('group', () => { during = enqueue(); return fn(); });
      const r = createCardGrouping({ ...t.opts, statePath, withLock }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(during).toMatchObject({ ran: false, contended: true });
      expect(r.formed?.pr).toBe(77);
      expect(enqueue()).toMatchObject({ ran: true, result: { enqueued: false, kind: 'card-grouped' } });
      expect(enqueueCalls).toBe(0);
    });

    it('the real land mutex excludes a claim during enqueue, then queue membership refuses the next claim', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]) });
      const statePath = join(tmp(), 's.json'), lockRoot = tmp();
      const locked = (owner, fn) => withLandWriteLock(fn, { lockRoot, owner, waitMs: 0, runUnlockedOnContention: false });
      let queued = false, during;
      const grouping = createCardGrouping({ ...t.opts, statePath, withLock: fn => locked('group', fn),
        readQueueFiles: () => ({ entries: queued ? [{ num: 1, files: [CARD] }] : [] }) });
      const form = () => grouping.form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(locked('enqueue', () => { during = form(); queued = true; }).ran).toBe(true);
      expect(during.reason).toMatch(/land mutex held/);
      expect(form().formed).toBeUndefined();
      expect(readGroupState(statePath).groups).toEqual([]);
      expect(t.calls.some(c => c.startsWith('pr create'))).toBe(false);
    });

    it.each(['item', 'couple', 'coupleKey'])('keeps an item-resolving or coupled candidate serial (%s)', field => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]), 3: card([1, 2, 12]) });
      t.verdicts[1][field] = 'xabc123';
      const r = createCardGrouping({ ...t.opts, statePath: join(tmp(), 's.json'), dryRun: true })
        .form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.plan.sources.map(s => s.num)).toEqual([1, 3]);
      expect(t.calls.some(c => c.startsWith('pr view 2 '))).toBe(false);
    });

    it.each(['outcome', 'verdict'])('excludes a sibling repo with a colliding PR number (%s)', foreign => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]), 3: card([1, 2, 12]) });
      if (foreign === 'outcome') t.outcomes[1].repo = 'sibling/repo';
      else t.verdicts[1].repo = 'sibling/repo';
      // A foreign verdict comes first: it must never lend labels/head to the local outcome.
      t.verdicts.unshift({ ...t.verdicts[0], repo: 'sibling/repo', listedHeadSha: 'f'.repeat(40) });
      const r = createCardGrouping({ ...t.opts, statePath: join(tmp(), 's.json'), dryRun: true })
        .form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.plan.sources.map(s => s.num)).toEqual([1, 3]);
      expect(r.plan.sources[0].headSha).toBe(t.heads[1]);
      expect(t.calls.some(c => c.startsWith('pr view 2 '))).toBe(false);
    });

    it('leaves out a source the admission check refuses, and passes it the judged head', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]), 3: card([1, 2, 12]) });
      const seen = [];
      const prestage = (c, headSha) => { seen.push([c.num, headSha]); return c.num === 2 ? { allowed: false, reason: 'red-team hold' } : { allowed: true }; };
      const r = createCardGrouping({ ...t.opts, statePath: join(tmp(), 's.json'), prestage, dryRun: true }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.plan.sources.map(s => s.num)).toEqual([1, 3]);
      expect(r.proof.ok).toBe(true);
      expect(seen).toEqual([[1, t.heads[1]], [2, t.heads[2]], [3, t.heads[3]]]);
      expect(t.out.join('')).toMatch(/#2 left out \(admission: red-team hold\)/);
    });

    it('a refused admission that leaves fewer than 2 forms nothing and memos the set (retry backoff)', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]) });
      const statePath = join(tmp(), 's.json');
      const g = createCardGrouping({ ...t.opts, statePath, prestage: c => (c.num === 1 ? { allowed: false } : { allowed: true }) });
      expect(g.form({ outcomes: t.outcomes, verdicts: t.verdicts }).reason).toMatch(/live re-check left fewer than 2/);
      expect(t.out.join('')).toMatch(/#1 left out \(admission: refused\)/);
      expect(Object.keys(readGroupState(statePath).failed)).toHaveLength(1);
      expect(g.form({ outcomes: t.outcomes, verdicts: t.verdicts }).reason).toMatch(/retry backoff/);
      expect(t.calls.some(c => c.startsWith('pr create'))).toBe(false);
    });

    it.each([
      ['head moved', t => { t.heads[2] = 'f'.repeat(40); }, /#2 left out \(head moved\)/],
      ['review hold', t => { t.labels[2] = [...accepted, { name: 'review:pending' }]; }, /#2 left out \(holds review:pending\)/],
      ['approval gone', t => { t.labels[2] = [{ name: 'ready-to-merge' }]; }, /#2 left out \(not review:accepted\)/],
    ])('live re-check before building leaves out a source whose eligibility changed (%s)', (_, change, logged) => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]), 3: card([1, 2, 12]) });
      change(t);
      const r = createCardGrouping({ ...t.opts, statePath: join(tmp(), 's.json'), dryRun: true }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.plan.sources.map(s => s.num)).toEqual([1, 3]);
      expect(t.out.join('')).toMatch(logged);
    });

    it.each([
      ['head moved', t => { t.heads[2] = 'f'.repeat(40); }, /claim refused: #2 head moved/],
      ['approval gone', t => { t.labels[2] = [{ name: 'ready-to-merge' }]; }, /claim refused: #2 not review:accepted/],
      ['sent back', t => { t.labels[1] = [...accepted, { name: 'review:changes' }]; }, /claim refused: #1 holds review:changes/],
      ['re-read fails', t => { t.fails.add('2'); }, /claim refused: #2 re-read failed \(gh: 502\)/],
    ])('eligibility that changes between the build and the claim refuses the claim (%s): no group, no push, no PR', (_, change, refused) => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]) });
      const statePath = join(tmp(), 's.json');
      const pushes = [];
      const run = (cmd, args, o) => { if (args[0] === 'push') pushes.push(args); return t.opts.run(cmd, args, o); };
      const withLock = fn => { change(t); return { ran: true, result: fn() }; };
      const r = createCardGrouping({ ...t.opts, run, statePath, withLock, readQueueFiles: () => ({ entries: [] }) }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.reason).toMatch(refused);
      expect(r.formed).toBeUndefined();
      expect(readGroupState(statePath).groups ?? []).toEqual([]);
      expect(pushes).toEqual([]);
      expect(t.calls.some(c => c.startsWith('pr create') || c.startsWith('pr comment'))).toBe(false);
    });

    it('an unreadable merge queue at claim time refuses (fail closed)', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]) });
      const statePath = join(tmp(), 's.json');
      let locked = false;
      const withLock = fn => { locked = true; try { return { ran: true, result: fn() }; } finally { locked = false; } };
      // Readable before the build (no wait), unreadable inside the land mutex at claim time.
      const r = createCardGrouping({ ...t.opts, statePath, withLock, readQueueFiles: () => (locked ? { entries: [], error: 'gh down' } : { entries: [] }) }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.reason).toMatch(/claim refused: merge queue unreadable \(gh down\)/);
      expect(readGroupState(statePath).groups ?? []).toEqual([]);
    });

    it('a source that joined another group between the build and the claim refuses the claim', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]) });
      const statePath = join(tmp(), 's.json');
      const other = { id: 'other', repo: 'o/r', pr: 5, branch: 'lane/card-group-other', sources: [{ num: 2, headSha: t.heads[2] }, { num: 9, headSha: 'e'.repeat(40) }] };
      const withLock = fn => { writeFileSync(statePath, JSON.stringify({ groups: [other], failed: {} })); return { ran: true, result: fn() }; };
      const r = createCardGrouping({ ...t.opts, statePath, withLock, readQueueFiles: () => ({ entries: [] }) }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.reason).toMatch(/claim refused: a source joined another group meanwhile/);
      expect(readGroupState(statePath).groups.map(g => g.id)).toEqual(['other']);
      expect(t.calls.some(c => c.startsWith('pr create'))).toBe(false);
    });

    it('two concurrent passes planning disjoint pairs on the same card: only one group forms, the other waits', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]), 3: card([1, 2, 12]), 4: card([1, 2, 13]) });
      const statePath = join(tmp(), 's.json');
      const only = nums => t.outcomes.filter(o => nums.includes(o.num));
      const passA = createCardGrouping({ ...t.opts, statePath, withLock: fn => ({ ran: true, result: fn() }) });
      let a;
      // Pass B planned {3,4} before A claimed; A claims {1,2} on the same card between B's pre-check and B's claim.
      const withLock = fn => { a = passA.form({ outcomes: only([1, 2]), verdicts: t.verdicts }); return { ran: true, result: fn() }; };
      const b = createCardGrouping({ ...t.opts, statePath, withLock }).form({ outcomes: only([3, 4]), verdicts: t.verdicts });
      expect(a.formed).toBeDefined();
      expect(b.formed).toBeUndefined();
      expect(b.reason).toMatch(/claim refused: backlog\/5360-prevention-card\.md is reserved by open card group/);
      const st = readGroupState(statePath);
      expect(st.groups.map(g => g.sources.map(s => s.num))).toEqual([[1, 2]]);
      // Waiting, not failed: no retry-backoff memo for {3,4}, and the next pass leaves them out while the card is reserved.
      expect(Object.keys(st.failed)).toEqual([]);
      const next = createCardGrouping({ ...t.opts, statePath, withLock: fn => ({ ran: true, result: fn() }) }).form({ outcomes: only([3, 4]), verdicts: t.verdicts });
      expect(next.formed).toBeUndefined();
      expect(readGroupState(statePath).groups).toHaveLength(1);
    });

    it('a record dropped while the PR was being opened closes the untracked combined PR (no reservation-less group)', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]) });
      const statePath = join(tmp(), 's.json');
      // Another pass's reconcile drops the pr:null record (15-minute rule) while `pr create` is in flight.
      const exec = (cmd, args) => {
        if (args[0] === 'pr' && args[1] === 'create') writeFileSync(statePath, JSON.stringify({ groups: [], failed: {} }));
        return t.exec(cmd, args);
      };
      const r = createCardGrouping({ ...t.opts, exec, statePath, withLock: fn => ({ ran: true, result: fn() }) }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.formed).toBeUndefined();
      expect(r.reason).toMatch(/group record dropped while opening — combined PR #77 closed/);
      expect(t.calls.filter(c => c.startsWith('pr close'))).toEqual([expect.stringMatching(/^pr close 77 --repo o\/r /)]);
      expect(t.calls.some(c => c.startsWith('pr comment'))).toBe(false);
      expect(readGroupState(statePath).groups).toEqual([]);
    });

    it('a dropped record whose combined PR cannot be closed is re-recorded for the reconcile, never left untracked', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]) });
      const statePath = join(tmp(), 's.json');
      const exec = (cmd, args) => {
        if (args[0] === 'pr' && args[1] === 'create') writeFileSync(statePath, JSON.stringify({ groups: [], failed: {} }));
        if (args[0] === 'pr' && args[1] === 'close') throw new Error('gh: 502');
        return t.exec(cmd, args);
      };
      const r = createCardGrouping({ ...t.opts, exec, statePath, withLock: fn => ({ ran: true, result: fn() }) }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.formed).toBeUndefined();
      expect(readGroupState(statePath).groups.map(g => [g.pr, g.sources.map(s => s.num), g.files])).toEqual([[77, [1, 2], [CARD]]]);
      expect(t.out.join('')).toMatch(/close of untracked combined PR #77 failed \(gh: 502\) — re-recorded for the reconcile/);
    });

    it('a claim refuses (fail closed) while an open group has no recorded file list', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]) });
      const statePath = join(tmp(), 's.json');
      const other = { id: 'other', repo: 'o/r', pr: 5, branch: 'lane/card-group-other', sources: [{ num: 8, headSha: 'd'.repeat(40) }, { num: 9, headSha: 'e'.repeat(40) }] };
      const withLock = fn => { writeFileSync(statePath, JSON.stringify({ groups: [other], failed: {} })); return { ran: true, result: fn() }; };
      const r = createCardGrouping({ ...t.opts, statePath, withLock }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.reason).toMatch(/claim refused: open card group #5 has no file list/);
      expect(readGroupState(statePath).groups.map(g => g.id)).toEqual(['other']);
    });
  });

  describe('form: leave-out of a source the build or the proof pins a failure on', () => {
    it('a source whose build conflicts outside the list is left out; the rest still group', () => {
      const t = formRepo({ 1: card([1, 2, 10], 'active'), 2: card([1, 2, 11]), 3: card([1, 2, 12], 'resolved') });
      const r = createCardGrouping({ ...t.opts, statePath: join(tmp(), 's.json'), dryRun: true }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.plan.sources.map(s => s.num)).toEqual([1, 2]);
      expect(r.proof.ok).toBe(true);
      expect(t.out.join('')).toMatch(/#3 left out of the group \(#3: backlog\/5360-prevention-card\.md: conflict outside Also raised by list/);
    });

    it('a source the union proof fails on (its duplicate entry deduped away) is left out; the rest still group', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11, 11]), 3: card([1, 2, 12]) });
      const r = createCardGrouping({ ...t.opts, statePath: join(tmp(), 's.json'), dryRun: true }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.plan.sources.map(s => s.num)).toEqual([1, 3]);
      expect(r.proof.ok).toBe(true);
      expect(t.out.join('')).toMatch(/#2 left out of the group \(union check failed \(missing 1/);
    });

    it('a dissolved group formed from a TRIMMED plan is not rebuilt from the wider plan (memo checked per built set)', () => {
      // #3 conflicts outside the list, so the plan {1,2,3} forms {1,2}. After {1,2} dissolves, the next form()
      // plans {1,2,3} again: the memo for {1,2} must still stop the rebuild.
      const t = formRepo({ 1: card([1, 2, 10], 'active'), 2: card([1, 2, 11]), 3: card([1, 2, 12], 'resolved') });
      const statePath = join(tmp(), 's.json');
      let closed = false;
      const exec = (cmd, args) => (closed && args[0] === 'pr' && args[1] === 'view' && args[2] === '77' ? JSON.stringify({ state: 'CLOSED', labels: [] }) : t.exec(cmd, args));
      const g = createCardGrouping({ ...t.opts, exec, statePath, withLock: fn => ({ ran: true, result: fn() }) });
      const first = g.form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(first.formed?.sources.map(s => s.num)).toEqual([1, 2]);
      closed = true;
      expect(g.reconcile({ force: true }).dissolved).toHaveLength(1);
      const creates = t.calls.filter(c => c.startsWith('pr create')).length;
      expect(g.form({ outcomes: t.outcomes, verdicts: t.verdicts }).reason).toMatch(/#1,#2 is in retry backoff/);
      expect(t.calls.filter(c => c.startsWith('pr create'))).toHaveLength(creates);
      expect(readGroupState(statePath).groups).toEqual([]);
    });

    it('leaving out the only offender of two forms nothing, memos the original set, and backs off', () => {
      const t = formRepo({ 1: card([1, 2, 10], 'active'), 2: card([1, 2, 11], 'resolved') });
      const statePath = join(tmp(), 's.json');
      const g = createCardGrouping({ ...t.opts, statePath, withLock: fn => ({ ran: true, result: fn() }), readQueueFiles: () => ({ entries: [] }) });
      const r = g.form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.reason).toMatch(/fewer than 2 left after leaving out #2/);
      expect(Object.keys(readGroupState(statePath).failed)).toEqual([`1@${t.heads[1]},2@${t.heads[2]}`]);
      expect(readGroupState(statePath).groups).toEqual([]);
      expect(g.form({ outcomes: t.outcomes, verdicts: t.verdicts }).reason).toMatch(/retry backoff/);
    });

    it('a proof failure no single source owns (a base duplicate deleted) refuses the whole group, leaving nobody out', () => {
      // #3 shares only the other card with #1; its list conflict there unions cleanly, so nothing pins on #3.
      const t = formRepo({
        1: { [CARD]: card([1, 1, 2, 10]), 'backlog/5473-other.md': card([7, 13]) },
        2: card([1, 1, 2, 11]),
        3: { 'backlog/5473-other.md': card([7, 14]) },
      }, { baseFiles: { [CARD]: card([1, 1, 2]) } });
      const r = createCardGrouping({ ...t.opts, statePath: join(tmp(), 's.json'), dryRun: true }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.plan).toBeUndefined();
      expect(r.reason).toMatch(/^union check failed \(.*unexpected deletions [1-9]/);
      expect(r.reason).not.toMatch(/fewer than 2 left/);
      expect(t.out.join('')).not.toMatch(/left out of the group/);
    });

    it('a proof failure every source shares refuses the whole group, leaving nobody out', () => {
      const t = formRepo({ 1: card([1, 2, 10, 10]), 2: card([1, 2, 11, 11]) });
      const r = createCardGrouping({ ...t.opts, statePath: join(tmp(), 's.json'), dryRun: true }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.plan).toBeUndefined();
      expect(r.reason).toMatch(/^union check failed \(missing 2/);
      expect(r.reason).not.toMatch(/fewer than 2 left/);
      expect(t.out.join('')).not.toMatch(/left out of the group/);
    });

    it('autoResolveRaisedBy disabled is never blamed on one source: the whole group refuses', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]), 3: card([1, 2, 12]) });
      const off = { value: { autoResolveRaisedBy: false }, sources: { autoResolveRaisedBy: 'tool' } };
      const r = createCardGrouping({ ...t.opts, statePath: join(tmp(), 's.json'), dryRun: true, cardConflictSettings: off }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.reason).toMatch(/autoResolveRaisedBy disabled .*autoResolveRaisedBy=false \(tool\)/);
      expect(r.reason).not.toMatch(/fewer than 2 left/);
      expect(t.out.join('')).not.toMatch(/left out of the group/);
    });

    it('a source whose change mentions an ambiguous JIT reference is left out; the rest still group', () => {
      const t = formRepo({ 1: card([1, 2, 10]).replace('Body.', 'Body. See xaaaaaa.'), 2: card([1, 2, 11]), 3: card([1, 2, 12]) },
        { baseFiles: { 'backlog/7001-a.md': '---\nbornAs: xaaaaaa\n---\n', 'backlog/7002-b.md': '---\nbornAs: xaaaaaa\n---\n' } });
      const r = createCardGrouping({ ...t.opts, statePath: join(tmp(), 's.json'), dryRun: true }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.plan.sources.map(s => s.num)).toEqual([2, 3]);
      expect(t.out.join('')).toMatch(/#1 left out of the group \(mentions ambiguous JIT reference xaaaaaa\)/);
    });

    it('a git read error inside the union proof refuses the whole group (never read as "absent")', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]) });
      const statePath = join(tmp(), 's.json');
      const run = (cmd, args, o) => (args[0] === 'ls-tree' && args.includes(t.base) ? { status: 128, stdout: '', stderr: 'fatal: read error' } : t.opts.run(cmd, args, o));
      const r = createCardGrouping({ ...t.opts, run, statePath }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.reason).toMatch(/^union check error \(ls-tree /);
      expect(Object.keys(readGroupState(statePath).failed)).toHaveLength(1);
      expect(() => verifyUnion({ base: t.base, combined: t.heads[1], sources: [{ num: 1, headSha: t.heads[1] }], cwd: t.cwd, run })).toThrow(/ls-tree/);
    });
  });

  describe('reconcile: dissolve and interrupted creation', () => {
    const A = 'a'.repeat(40), B = 'b'.repeat(40);
    const T0 = 1_000_000;
    // A live combined PR carries ready-to-merge + review:pending (it is re-reviewed); that alone must never dissolve it.
    const waiting = [{ name: 'ready-to-merge' }, { name: 'review:pending' }];
    function reconcileCase({ combined = { state: 'OPEN', labels: waiting }, sources = {}, readFails = [], closeFails = false, pr = 77, list = [], listThrows = false, at = T0,
      repo = 'o/r', localSlug = 'o/r', extraGroups = [], files = undefined, mainFixPrs = undefined, force = true, stamp = undefined, requiredCheck = undefined, checkRuns = undefined } = {}) {
      const statePath = join(tmp(), 's.json');
      writeFileSync(statePath, JSON.stringify({ groups: [{ id: 'g', repo, pr, branch: 'lane/card-group-g', createdAt: T0, ...(files ? { files } : {}), sources: [{ num: 1, headSha: A }, { num: 2, headSha: B }] }, ...extraGroups], failed: {},
        ...(stamp ? { lastReconcileAt: { [String(localSlug).toLowerCase()]: stamp } } : {}) }));
      const before = readFileSync(statePath, 'utf8');
      const live = { 1: { state: 'OPEN', isDraft: false, headRefOid: A, headRefName: 'lane/x', baseRefName: 'main', labels: accepted, ...sources[1] },
        2: { state: 'OPEN', isDraft: false, headRefOid: B, headRefName: 'lane/x', baseRefName: 'main', labels: accepted, ...sources[2] } };
      const calls = [];
      const exec = (cmd, args) => {
        calls.push(args.join(' '));
        if (args[0] === 'pr' && args[1] === 'view') {
          if (args[2] === '77') { if (combined === 'throw') throw new Error('gh: 502'); return JSON.stringify(combined); }
          if (readFails.includes(Number(args[2]))) throw new Error('gh: 502');
          return JSON.stringify(live[args[2]]);
        }
        if (args[0] === 'pr' && args[1] === 'list') { if (listThrows) throw new Error('gh: 502'); return JSON.stringify(list); }
        if (args[0] === 'api' && checkRuns !== undefined) { if (checkRuns === 'throw') throw new Error('gh: 502'); return JSON.stringify(checkRuns); }
        if (args[0] === 'pr' && args[1] === 'close' && closeFails) throw new Error('gh: 502');
        if (args[0] === 'pr' && ['comment', 'close'].includes(args[1])) return '';
        throw new Error(`unexpected ${args.join(' ')}`);
      };
      const out = [];
      const g = createCardGrouping({ localSlug, cwd: tmp(), run: () => { throw new Error('no git on this path'); }, exec, statePath, settings, log: { write: l => out.push(l) }, now: () => at,
        ...(requiredCheck ? { requiredCheck } : {}) });
      const r = g.reconcile({ force, ...(mainFixPrs ? { mainFixPrs } : {}) });
      return { r, calls, out: out.join(''), state: readGroupState(statePath), g, unchanged: readFileSync(statePath, 'utf8') === before };
    }

    describe('a published main-red repair PR the group would block', () => {
      // Healthy group (#77 awaiting review, checks green): red main holds #77, so the group must give way to the repair.
      it.each([
        ['needs a reserved card', { files: [CARD], mainFixPrs: [{ num: 99, files: [CARD] }] }, /main-red repair PR #99 needs reserved backlog\/5360-prevention-card\.md/],
        ['needs a reserved card (object file rows)', { files: [CARD], mainFixPrs: [{ num: 99, files: [{ path: CARD }] }] }, /repair PR #99 needs reserved/],
        ['is itself a source', { files: [CARD], mainFixPrs: [{ num: 2, files: null }] }, /main-red repair PR #2 is a source/],
        ['arrives inside the throttle window', { files: [CARD], mainFixPrs: [{ num: 99, files: [CARD] }], force: false, stamp: T0 - 1_000 }, /repair PR #99 needs reserved/],
      ])('dissolves the group when the repair %s', (_, c, why) => {
        const t = reconcileCase(c);
        expect(t.r).toMatchObject({ dissolved: ['g'] });
        expect(t.state.groups).toEqual([]);
        expect(t.calls.some(x => x.startsWith('pr close 77 --repo o/r ') && why.test(x))).toBe(true);
        expect(t.out).toMatch(why);
        expect(t.calls.filter(x => x.startsWith('pr comment '))).toHaveLength(2);
      });
      it.each([
        ['touches no reserved card', { files: [CARD], mainFixPrs: [{ num: 99, files: ['scripts/x.mjs'] }] }],
        ['has an unknown file list', { files: [CARD], mainFixPrs: [{ num: 99, files: null }] }],
        ['is absent (main green)', { files: [CARD], mainFixPrs: [] }],
        ['is the combined PR itself', { files: [CARD], mainFixPrs: [{ num: 77, files: [CARD] }] }],
      ])('keeps the group when the repair %s', (_, c) => {
        const t = reconcileCase(c);
        expect(t.r).toMatchObject({ checked: 1, dissolved: [] });
        expect(t.state.groups).toHaveLength(1);
        expect(t.calls.some(x => x.startsWith('pr close') || x.startsWith('pr comment'))).toBe(false);
      });
      it('a foreign repository\'s repair never dissolves this repo\'s group', () => {
        const t = reconcileCase({ files: [CARD], mainFixPrs: [{ num: 99, repo: 'o/foreign', files: [CARD] }] });
        expect(t.state.groups).toHaveLength(1);
      });
      it('runCardGroupPass hands the live repair PRs (any decision) to reconcile and forms no group while one is published', () => {
        const seen = [];
        const grouping = { reconcile: a => { seen.push(['reconcile', a]); return { checked: 0 }; }, form: () => { seen.push(['form']); return { reason: 'x' }; } };
        // #98 needs a rebase (decision skip) and has an incomplete file list; the sibling repo's #98 lends it no files;
        // #97 has no verdict this pass; a stale `redMainFixPr` field on #5 never makes it a repair.
        const verdicts = [{ num: 99, decision: 'merge', listedFilesComplete: true, listedFiles: [CARD] },
          { num: 98, decision: 'skip', listedFilesComplete: false, listedFiles: [CARD] }, { num: 98, repo: 'sib/x', decision: 'merge', listedFilesComplete: true, listedFiles: [CARD] },
          { num: 5, decision: 'merge', redMainFixPr: true }];
        const r = runCardGroupPass({ grouping, enqueues: true, verdicts, mainFixNums: [99, '98', 97, 99], isLocalRepo: x => !x, log: { write: () => {} } });
        expect(seen).toEqual([['reconcile', { mainFixPrs: [{ num: 99, repo: null, files: [CARD] }, { num: 98, repo: null, files: null }, { num: 97, repo: null, files: null }] }]]);
        expect(r.grouping).toMatchObject({ reason: expect.stringMatching(/main is red/) });
        seen.length = 0;
        runCardGroupPass({ grouping, enqueues: true, verdicts, log: { write: () => {} } });
        expect(seen).toEqual([['reconcile', { mainFixPrs: [] }], ['form']]);
      });
    });

    it.each([
      ['merged', { combined: { state: 'MERGED' } }],
      ['closed', { combined: { state: 'CLOSED' } }],
      ['sent back', { combined: { state: 'OPEN', labels: [{ name: 'review:changes' }] } }],
      ['interrupted creation', { pr: null, list: [{ number: 88 }], at: T0 + 20 * 60_000 }],
      ['expired creation', { pr: null, at: T0 + 20 * 60_000 }],
    ])('ignores a foreign repository group (%s) without reads, writes, or releasing its holds', (_, c) => {
      const t = reconcileCase({ ...c, repo: 'o/foreign' });
      expect(t.r).toEqual({ checked: 0 });
      expect(t.calls).toEqual([]);
      expect(t.unchanged).toBe(true);
      expect(t.g.holdFor({ num: 1, repo: 'o/foreign' })).toMatchObject({ kind: 'card-grouped' });
    });

    it.each([null, '', '   '])('refuses reconciliation with missing local repository identity %j', localSlug => {
      const t = reconcileCase({ localSlug, repo: localSlug, combined: { state: 'CLOSED' } });
      expect(t.calls).toEqual([]);
      expect(t.unchanged).toBe(true);
      expect(t.r).toMatchObject({ checked: 0, reason: 'repository identity missing' });
    });

    it('dissolves only the local group when repository groups share IDs and PR numbers', () => {
      const foreign = { id: 'g', repo: 'o/foreign', pr: 77, branch: 'lane/card-group-g', sources: [{ num: 1, headSha: A }] };
      const t = reconcileCase({ repo: 'O/R', combined: { state: 'CLOSED' }, extraGroups: [foreign] });
      expect(t.r).toMatchObject({ checked: 1, dissolved: ['g'] });
      expect(t.state.groups).toEqual([foreign]);
      expect(t.calls.filter(c => c.startsWith('pr view 77 '))).toHaveLength(1);
      expect(t.calls.filter(c => c.startsWith('pr comment '))).toHaveLength(2);
    });

    it('adopts only the local interrupted group when repository groups share an ID', () => {
      const foreign = { id: 'g', repo: 'o/foreign', pr: null, branch: 'lane/card-group-g', sources: [{ num: 1, headSha: A }] };
      const t = reconcileCase({ pr: null, list: [{ number: 88 }], extraGroups: [foreign] });
      expect(t.r.checked).toBe(1);
      expect(t.state.groups[0].pr).toBe(88);
      expect(t.state.groups[1]).toEqual(foreign);
      expect(t.calls.filter(c => c.startsWith('pr list '))).toHaveLength(1);
    });

    it('reconcile ignores foreign groups with colliding PR numbers', () => {
      // This repo's #77 is closed; the foreign group's #77 is another PR. Nothing is read, closed, commented or dropped.
      const t = reconcileCase({ repo: 'o/foreign', combined: { state: 'CLOSED' }, sources: { 1: { state: 'CLOSED' } } });
      expect(t.r).toEqual({ checked: 0 });
      expect(t.calls).toEqual([]);
      expect(t.unchanged).toBe(true);
    });

    it('a foreign drain\'s reconcile never throttles this repository\'s reconcile', () => {
      const statePath = join(tmp(), 's.json');
      const group = (id, repo) => ({ id, repo, pr: 77, branch: `lane/card-group-${id}`, createdAt: T0, sources: [{ num: 1, headSha: A }] });
      writeFileSync(statePath, JSON.stringify({ groups: [group('g', 'o/r'), group('f', 'o/foreign')], failed: {} }));
      const source = { state: 'OPEN', isDraft: false, headRefOid: A, headRefName: 'lane/x', baseRefName: 'main', labels: accepted };
      const drain = (localSlug, at) => {
        const calls = [];
        const exec = (cmd, args) => {
          calls.push(args.join(' '));
          if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(args[2] === '77' ? { state: 'OPEN', labels: waiting } : source);
          throw new Error(`unexpected ${args.join(' ')}`);
        };
        const r = createCardGrouping({ localSlug, cwd: tmp(), run: () => { throw new Error('no git on this path'); }, exec, statePath, settings, log: { write: () => {} }, now: () => at }).reconcile();
        return { r, calls };
      };
      expect(drain('o/foreign', T0).r).toMatchObject({ checked: 1 });
      // Inside reconcileSec of the foreign pass, but this repo's groups were never re-read: they are re-read now.
      expect(drain('o/r', T0 + 60_000).r).toMatchObject({ checked: 1 });
      // Each repository's own stamp still throttles itself.
      expect(drain('o/foreign', T0 + 90_000)).toEqual({ r: { checked: 0, throttled: true }, calls: [] });
      expect(drain('O/R', T0 + 90_000)).toEqual({ r: { checked: 0, throttled: true }, calls: [] });
      expect(drain('o/r', T0 + 60_000 + 120_000).r).toMatchObject({ checked: 1 });
      // A stamp in the future (corrupt file, clock stepped back) never throttles for good.
      for (const bad of [T0 * 1000, 'soon']) {
        writeFileSync(statePath, JSON.stringify({ groups: [group('g', 'o/r')], failed: {}, lastReconcileAt: { 'o/r': bad } }));
        expect(drain('o/r', T0).r).toMatchObject({ checked: 1 });
      }
    });

    it.each([
      ['combined PR closed unmerged', { combined: { state: 'CLOSED', labels: [] } }, /combined PR closed without merging/, false],
      ['combined PR conflicts with main', { combined: { state: 'OPEN', labels: waiting, mergeable: 'CONFLICTING' } }, /combined PR conflicts/, true],
      ['sent back: review:changes', { combined: { state: 'OPEN', labels: [{ name: 'review:changes' }] } }, /combined PR sent back \(review:changes\)/, true],
      ['sent back: review:human', { combined: { state: 'OPEN', labels: [{ name: 'review:human' }] } }, /combined PR sent back \(review:human\)/, true],
      ['required check failed', { combined: { state: 'OPEN', labels: accepted, statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] } }, /combined PR failed the required check/, true],
      ['required check timed out (status context)', { combined: { state: 'OPEN', labels: accepted, statusCheckRollup: [{ context: 'test', state: 'TIMED_OUT' }] } }, /combined PR failed the required check/, true],
      ['required check needs action (ACTION_REQUIRED)', { combined: { state: 'OPEN', labels: accepted, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }] } }, /combined PR failed the required check/, true],
      ['required check failed to start (STARTUP_FAILURE)', { combined: { state: 'OPEN', labels: accepted, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }] } }, /combined PR failed the required check/, true],
      ['the latest required run failed after an older success', { combined: { state: 'OPEN', labels: accepted, statusCheckRollup: [
        { name: 'test', conclusion: 'FAILURE', startedAt: '2026-10-21T10:06:00Z', completedAt: '2026-10-21T10:20:00Z' },
        { name: 'test', conclusion: 'SUCCESS', startedAt: '2026-10-21T10:00:00Z', completedAt: '2026-10-21T10:05:00Z' }] } }, /combined PR failed the required check/, true],
      ['source head moved', { sources: { 2: { headRefOid: 'c'.repeat(40) } } }, /source #2 changed \(head moved\)/, true],
      ['source lost its approval', { sources: { 1: { labels: [{ name: 'ready-to-merge' }] } } }, /source #1 changed \(not review:accepted\)/, true],
      ['source sent back', { sources: { 2: { labels: [...accepted, { name: 'review:human' }] } } }, /source #2 changed \(holds review:human\)/, true],
      ['source closed', { sources: { 1: { state: 'CLOSED' } } }, /source #1 changed \(not open\)/, true],
      ['source made draft', { sources: { 2: { isDraft: true } } }, /source #2 changed \(draft\)/, true],
    ])('dissolves when %s: drain closes only its own combined PR, every source is released with its approval untouched', (_, c, why, closesCombined) => {
      const { r, calls, out, state, g } = reconcileCase(c);
      expect(r.dissolved).toEqual(['g']);
      expect(out).toMatch(why);
      expect(state.groups).toEqual([]);
      expect(g.holdFor({ num: 1 })).toBeNull();
      expect(g.holdFor({ num: 2 })).toBeNull();
      const closes = calls.filter(x => x.startsWith('pr close'));
      expect(closes).toEqual(closesCombined ? [expect.stringMatching(/^pr close 77 .*Card group dissolved/)] : []);
      for (const n of [1, 2]) expect(calls.some(x => x.startsWith(`pr comment ${n} `) && why.test(x))).toBe(true);
      expect(calls.some(x => /^pr (edit|close [12] )/.test(x))).toBe(false);
    });

    it.each([
      ['the combined PR is waiting for review (ready-to-merge + review:pending)', {}],
      ['a check that is not required failed', { combined: { state: 'OPEN', labels: waiting, statusCheckRollup: [{ name: 'lint', conclusion: 'FAILURE' }] } }],
      ['the required check is still running', { combined: { state: 'OPEN', labels: waiting, statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS', conclusion: '' }] } }],
      ['an older CANCELLED required run is superseded by a newer SUCCESS', { combined: { state: 'OPEN', labels: waiting, statusCheckRollup: [
        { name: 'test', conclusion: 'SUCCESS', startedAt: '2026-10-21T10:04:00Z', completedAt: '2026-10-21T10:20:00Z' },
        { name: 'test', conclusion: 'CANCELLED', startedAt: '2026-10-21T10:00:00Z', completedAt: '2026-10-21T10:05:00Z' }] } }],
      ['an older FAILURE status context is superseded by a newer SUCCESS', { combined: { state: 'OPEN', labels: waiting, statusCheckRollup: [
        { context: 'test', state: 'FAILURE', startedAt: '2026-10-21T10:00:00Z' },
        { context: 'test', state: 'SUCCESS', startedAt: '2026-10-21T10:30:00Z' }] } }],
      ['a cancelled required run has a queued rerun listed first (gh zero dates on both stamps)', { combined: { state: 'OPEN', labels: waiting, statusCheckRollup: [
        { name: 'test', status: 'QUEUED', conclusion: '', startedAt: '0001-01-01T00:00:00Z', completedAt: '0001-01-01T00:00:00Z' },
        { name: 'test', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: '2026-10-21T10:00:00Z', completedAt: '2026-10-21T10:05:00Z' }] } }],
      ['a running rerun was queued before the old run was cancelled', { combined: { state: 'OPEN', labels: waiting, statusCheckRollup: [
        { name: 'test', status: 'IN_PROGRESS', conclusion: '', startedAt: '2026-10-21T10:03:00Z', completedAt: '0001-01-01T00:00:00Z' },
        { name: 'test', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: '2026-10-21T10:00:00Z', completedAt: '2026-10-21T10:05:00Z' }] } }],
      ['a failed required run is re-running (gh zero completedAt on the rerun)', { combined: { state: 'OPEN', labels: waiting, statusCheckRollup: [
        { name: 'test', conclusion: 'FAILURE', startedAt: '2026-10-21T10:00:00Z', completedAt: '2026-10-21T10:05:00Z' },
        { name: 'test', status: 'IN_PROGRESS', conclusion: '', startedAt: '2026-10-21T10:10:00Z', completedAt: '0001-01-01T00:00:00Z' }] } }],
      ['a source read fails (fail closed: held)', { readFails: [2] }],
      ['closing the combined PR fails (held, retried)', { combined: { state: 'OPEN', labels: [{ name: 'review:changes' }] }, closeFails: true }],
      ['the combined PR read fails', { combined: 'throw' }],
    ])('keeps the group (sources stay held) when %s', (_, c) => {
      const { r, calls, state, g } = reconcileCase(c);
      expect(r.dissolved ?? []).toEqual([]);
      expect(state.groups.map(x => x.id)).toEqual(['g']);
      expect(g.holdFor({ num: 1 })).toMatchObject({ kind: 'card-grouped' });
      expect(calls.some(x => x.startsWith('pr comment'))).toBe(false);
    });

    // Parity with the drain: the group dissolves on exactly the required-check results the drain reads as failed,
    // so a terminal failure the drain will never land can never keep the sources held across reconciles.
    it.each([
      ['FAILURE'], ['ERROR'], ['CANCELLED'], ['TIMED_OUT'], ['ACTION_REQUIRED'], ['STARTUP_FAILURE'],
      ['SUCCESS'], ['SKIPPED'], ['NEUTRAL'], ['STALE'], [''],
    ])('dissolves on a %s required run exactly when the drain reads it as failed', concl => {
      const row = { name: 'test', status: concl ? 'COMPLETED' : 'IN_PROGRESS', conclusion: concl };
      const failed = isRequiredCheckFailed({ statusCheckRollup: [row] });
      expect(failed).toBe(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(concl));
      const { r, state, g } = reconcileCase({ combined: { state: 'OPEN', labels: waiting, statusCheckRollup: [row] } });
      expect(r.dissolved ?? []).toEqual(failed ? ['g'] : []);
      expect(state.groups.length).toBe(failed ? 0 : 1);
      expect(g.holdFor({ num: 1 })).toEqual(failed ? null : expect.objectContaining({ kind: 'card-grouped' }));
    });

    it('reads the drain\'s configured required check name, not a hard-coded "test"', () => {
      const rollup = [{ name: 'ci', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }, { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
      expect(reconcileCase({ requiredCheck: 'ci', combined: { state: 'OPEN', labels: waiting, statusCheckRollup: rollup } }).r.dissolved).toEqual(['g']);
      expect(reconcileCase({ combined: { state: 'OPEN', labels: waiting, statusCheckRollup: rollup } }).r.dissolved ?? []).toEqual([]);
    });

    describe('a capped or check-less rollup is re-read from REST, as the drain does', () => {
      const H = 'c'.repeat(40);
      const capped = [...Array.from({ length: 100 }, (_, i) => ({ name: `lint-${i}`, status: 'COMPLETED', conclusion: 'SUCCESS' })),
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-21T10:05:00Z' }];
      const restRun = (conclusion, extra = {}) => [{ check_runs: [{ id: 9, name: 'test', head_sha: H, status: 'completed', conclusion, ...extra }] }];
      const combined = rollup => ({ number: 77, state: 'OPEN', labels: waiting, headRefOid: H, statusCheckRollup: rollup });

      it.each([
        ['the newest run is past the 100-context cap', capped, restRun('action_required')],
        ['the required check is missing from the rollup', [{ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }], restRun('startup_failure')],
      ])('dissolves when %s and REST shows a terminal failure', (_, rollup, runs) => {
        const t = reconcileCase({ combined: combined(rollup), checkRuns: runs });
        expect(t.r.dissolved).toEqual(['g']);
        expect(t.calls).toContainEqual(expect.stringMatching(new RegExp(`^api repos/o/r/commits/${H}/check-runs\\?check_name=test&filter=latest`)));
      });

      it.each([
        ['REST shows the newest run green', restRun('success')],
        ['the REST read fails (unknown, never a failure)', 'throw'],
        ['REST returns a run for another head', restRun('failure', { head_sha: 'd'.repeat(40) })],
      ])('keeps the group when %s', (_, runs) => {
        const t = reconcileCase({ combined: combined([...capped.slice(0, 100), { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }]), checkRuns: runs });
        expect(t.r.dissolved ?? []).toEqual([]);
        expect(t.state.groups.map(x => x.id)).toEqual(['g']);
      });
    });

    it('interrupted creation: a PR recorded by the forming pass after the snapshot is never dropped', () => {
      const statePath = join(tmp(), 's.json');
      const rec = { id: 'g', repo: 'o/r', pr: null, branch: 'lane/card-group-g', createdAt: T0, files: [CARD], sources: [{ num: 1, headSha: A }, { num: 2, headSha: B }] };
      writeFileSync(statePath, JSON.stringify({ groups: [rec], failed: {} }));
      // The list read sees no PR yet; the forming pass records #77 before this reconcile's drop takes the lock.
      const exec = (cmd, args) => {
        if (args[0] === 'pr' && args[1] === 'list') { writeFileSync(statePath, JSON.stringify({ groups: [{ ...rec, pr: 77 }], failed: {} })); return '[]'; }
        throw new Error(`unexpected ${args.join(' ')}`);
      };
      const g = createCardGrouping({ localSlug: 'o/r', cwd: tmp(), run: () => { throw new Error('no git on this path'); }, exec, statePath, settings, log: { write() {} }, now: () => T0 + 16 * 60_000 });
      expect(g.reconcile({ force: true }).dissolved).toEqual([]);
      const st = readGroupState(statePath);
      expect(st.groups.map(x => [x.id, x.pr])).toEqual([['g', 77]]);
      expect(st.failed).toEqual({});
    });

    it('interrupted creation: adopts the PR opened for the branch', () => {
      const { r, calls, state } = reconcileCase({ pr: null, list: [{ number: 88, state: 'OPEN' }], at: T0 + 20 * 60_000 });
      expect(r.dissolved).toEqual([]);
      expect(state.groups[0].pr).toBe(88);
      expect(calls).toContainEqual(expect.stringMatching(/^pr list --repo o\/r --head lane\/card-group-g --state all/));
    });

    it('interrupted creation: no PR after 15 minutes drops the record and releases the sources', () => {
      const { r, state, g, out } = reconcileCase({ pr: null, list: [], at: T0 + 16 * 60_000 });
      expect(r.dissolved).toEqual(['g']);
      expect(state.groups).toEqual([]);
      expect(g.holdFor({ num: 1 })).toBeNull();
      expect(out).toMatch(/no PR was opened — record dropped/);
    });

    it.each([
      ['no PR yet but inside the 15-minute window', { list: [], at: T0 + 5 * 60_000 }],
      ['the PR list read fails', { listThrows: true, at: T0 + 60 * 60_000 }],
    ])('interrupted creation: keeps holding when %s', (_, c) => {
      const { r, state, g } = reconcileCase({ pr: null, ...c });
      expect(r.dissolved ?? []).toEqual([]);
      expect(state.groups).toHaveLength(1);
      expect(state.groups[0].pr).toBeNull();
      expect(g.holdFor({ num: 2 })).toMatchObject({ kind: 'card-grouped' });
    });
  });
});

describe('verifyUnion refusals (real git)', () => {
  it('refuses a file the combined commit changes that no source changes', () => {
    const { cwd, base, branch } = repo();
    const a = branch('a', () => writeFileSync(join(cwd, CARD), card([1, 2, 10])));
    const combined = branch('c', () => { writeFileSync(join(cwd, CARD), card([1, 2, 10])); writeFileSync(join(cwd, 'backlog/5473-other.md'), card([7, 99])); });
    const proof = verifyUnion({ base, combined, sources: [{ num: 1, headSha: a }], cwd });
    expect(proof.ok).toBe(false);
    expect(proof.outside).toEqual(['backlog/5473-other.md']);
    expect(proof).toMatchObject({ missing: [], extra: [], deleted: [], resurrected: [], disagree: [] });
  });

  it('refuses a line one source raises and another lowers (disagree)', () => {
    const { cwd, base, branch } = repo();
    const up = branch('up', () => writeFileSync(join(cwd, CARD), card([1, 2, 2])));
    const down = branch('down', () => writeFileSync(join(cwd, CARD), card([1])));
    const proof = verifyUnion({ base, combined: up, sources: [{ num: 1, headSha: up }, { num: 2, headSha: down }], cwd });
    expect(proof.ok).toBe(false);
    expect(proof.disagree).toEqual([{ path: CARD, line: entry(2) }]);
  });

  it('refuses a source that deletes a file (unsupported), even when the combined commit matches it', () => {
    const { cwd, base, branch } = repo();
    const del = branch('del', () => rmSync(join(cwd, 'backlog/5473-other.md')));
    const b = branch('b', () => writeFileSync(join(cwd, CARD), card([1, 2, 11])));
    const combined = branch('c', () => { rmSync(join(cwd, 'backlog/5473-other.md')); writeFileSync(join(cwd, CARD), card([1, 2, 11])); });
    const proof = verifyUnion({ base, combined, sources: [{ num: 1, headSha: del }, { num: 2, headSha: b }], cwd });
    expect(proof.ok).toBe(false);
    expect(proof.unsupported).toEqual(['backlog/5473-other.md deleted by a source']);
    expect(proof.outside).toEqual([]);
  });

  it('refuses a combined commit that lost a whole source file', () => {
    const { cwd, base, branch } = repo();
    const a = branch('a', () => writeFileSync(join(cwd, 'backlog/5474-new.md'), card([3])));
    const proof = verifyUnion({ base, combined: base, sources: [{ num: 1, headSha: a }], cwd });
    expect(proof.ok).toBe(false);
    expect(proof.missing).toEqual([{ path: 'backlog/5474-new.md', line: '(whole file)' }]);
  });
});
