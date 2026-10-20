// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planCardGroups, overlapReasonIsCardOnly, buildCombined, verifyUnion, sourceLanded, cardGroupHold, readCardGroupSettings,
  readGroupState, groupId, cardOnlyFiles, readReferenceMap, createCardGrouping, combinedPrBody, CARD_GROUP_MARKER,
  resolveCardGroupStatePath, cardGroupStatePath, isSubsequence, inCardGroup, queueBlocksGroup,
} from '../card-group.mjs';

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
      if (args[0] === 'ls-tree' && args[1] === base) return { status: 128, stdout: '', stderr: 'fatal: read error' };
      try { return { status: 0, stdout: execFileSync(cmd, args, { cwd, encoding: 'utf8', input: o.input }), stderr: '' }; }
      catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
    };
    expect(sourceLanded({ ref: base, source: { num: 1, headSha: del }, cwd, run })).toMatchObject({ ok: false });
    expect(sourceLanded({ ref: base, source: { num: 1, headSha: del }, cwd })).toMatchObject({ ok: false, reason: expect.stringMatching(/still on main/) });
    expect(sourceLanded({ ref: del, source: { num: 1, headSha: del }, cwd }).ok).toBe(true);
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
  const state = { groups: [{ id: 'g1', repo: 'o/r', pr: 9, sources: [{ num: 5, headSha: 'a'.repeat(40) }] }], failed: {} };
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
    const opts = { localSlug: 'o/r', cwd, run: runIn(cwd, () => base), exec, settings, log: { write: l => out.push(l) }, prestage: () => ({ allowed: true }), cardConflictSettings: cc };
    return { cwd, base, heads, labels, fails, calls, exec, verdicts, outcomes, out, opts };
  }

  describe('form: admission and eligibility', () => {
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
      const r = createCardGrouping({ ...t.opts, run, statePath, withLock, readQueue: () => ({ inQueue: new Set() }) }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.reason).toMatch(refused);
      expect(r.formed).toBeUndefined();
      expect(readGroupState(statePath).groups ?? []).toEqual([]);
      expect(pushes).toEqual([]);
      expect(t.calls.some(c => c.startsWith('pr create') || c.startsWith('pr comment'))).toBe(false);
    });

    it('an unreadable merge queue at claim time refuses (fail closed)', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]) });
      const statePath = join(tmp(), 's.json');
      const withLock = fn => ({ ran: true, result: fn() });
      const r = createCardGrouping({ ...t.opts, statePath, withLock, readQueue: () => ({ error: 'gh down' }) }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.reason).toMatch(/claim refused: merge queue unreadable \(gh down\)/);
      expect(readGroupState(statePath).groups ?? []).toEqual([]);
    });

    it('a source that joined another group between the build and the claim refuses the claim', () => {
      const t = formRepo({ 1: card([1, 2, 10]), 2: card([1, 2, 11]) });
      const statePath = join(tmp(), 's.json');
      const other = { id: 'other', repo: 'o/r', pr: 5, branch: 'lane/card-group-other', sources: [{ num: 2, headSha: t.heads[2] }, { num: 9, headSha: 'e'.repeat(40) }] };
      const withLock = fn => { writeFileSync(statePath, JSON.stringify({ groups: [other], failed: {} })); return { ran: true, result: fn() }; };
      const r = createCardGrouping({ ...t.opts, statePath, withLock, readQueue: () => ({ inQueue: new Set() }) }).form({ outcomes: t.outcomes, verdicts: t.verdicts });
      expect(r.reason).toMatch(/claim refused: a source joined another group meanwhile/);
      expect(readGroupState(statePath).groups.map(g => g.id)).toEqual(['other']);
      expect(t.calls.some(c => c.startsWith('pr create'))).toBe(false);
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

    it('leaving out the only offender of two forms nothing, memos the original set, and backs off', () => {
      const t = formRepo({ 1: card([1, 2, 10], 'active'), 2: card([1, 2, 11], 'resolved') });
      const statePath = join(tmp(), 's.json');
      const g = createCardGrouping({ ...t.opts, statePath, withLock: fn => ({ ran: true, result: fn() }), readQueue: () => ({ inQueue: new Set() }) });
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
      const run = (cmd, args, o) => (args[0] === 'ls-tree' && args[1] === t.base ? { status: 128, stdout: '', stderr: 'fatal: read error' } : t.opts.run(cmd, args, o));
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
    function reconcileCase({ combined = { state: 'OPEN', labels: waiting }, sources = {}, readFails = [], closeFails = false, pr = 77, list = [], listThrows = false, at = T0 } = {}) {
      const statePath = join(tmp(), 's.json');
      writeFileSync(statePath, JSON.stringify({ groups: [{ id: 'g', repo: 'o/r', pr, branch: 'lane/card-group-g', createdAt: T0, sources: [{ num: 1, headSha: A }, { num: 2, headSha: B }] }], failed: {} }));
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
        if (args[0] === 'pr' && args[1] === 'close' && closeFails) throw new Error('gh: 502');
        if (args[0] === 'pr' && ['comment', 'close'].includes(args[1])) return '';
        throw new Error(`unexpected ${args.join(' ')}`);
      };
      const out = [];
      const g = createCardGrouping({ localSlug: 'o/r', cwd: tmp(), run: () => { throw new Error('no git on this path'); }, exec, statePath, settings, log: { write: l => out.push(l) }, now: () => at });
      const r = g.reconcile({ force: true });
      return { r, calls, out: out.join(''), state: readGroupState(statePath), g };
    }

    it.each([
      ['combined PR closed unmerged', { combined: { state: 'CLOSED', labels: [] } }, /combined PR closed without merging/, false],
      ['sent back: review:changes', { combined: { state: 'OPEN', labels: [{ name: 'review:changes' }] } }, /combined PR sent back \(review:changes\)/, true],
      ['sent back: review:human', { combined: { state: 'OPEN', labels: [{ name: 'review:human' }] } }, /combined PR sent back \(review:human\)/, true],
      ['required check failed', { combined: { state: 'OPEN', labels: accepted, statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] } }, /combined PR failed the required check/, true],
      ['required check timed out (status context)', { combined: { state: 'OPEN', labels: accepted, statusCheckRollup: [{ context: 'test', state: 'TIMED_OUT' }] } }, /combined PR failed the required check/, true],
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
