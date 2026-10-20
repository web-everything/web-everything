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
const admit = vs => new Map(vs.map(v => [Number(v.num), v.listedHeadSha]));
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
    const dry = createCardGrouping({ localSlug: 'o/r', cwd, run, exec, statePath: join(d, 's2.json'), settings, log: { write() {} }, dryRun: true, prestage: () => ({ allowed: true }), readQueueFiles: () => ({ entries: [] }), liveGate: () => null });
    const r = dry.form({ outcomes, verdicts, admitted: admit(verdicts) });
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
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: Number(args[2]), state: 'OPEN', isDraft: false, headRefOid: heads[args[2]], headRefName: 'lane/x', baseRefName: 'main', labels: accepted });
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
    const opts = { localSlug: 'o/r', cwd: t.cwd, run: runIn(t.cwd, base), exec: t.exec, settings, log: { write() {} }, prestage: () => ({ allowed: true }), cardConflictSettings: cc, liveGate: () => null };
    expect(createCardGrouping({ ...opts, statePath: join(d, 'a.json') }).form({ outcomes: t.outcomes, verdicts: t.verdicts, admitted: admit(t.verdicts) }).reason).toMatch(/no queue file read wired/);
    expect(createCardGrouping({ ...opts, statePath: join(d, 'a2.json'), readQueueFiles: () => ({ entries: [] }) }).form({ outcomes: t.outcomes, verdicts: t.verdicts, admitted: admit(t.verdicts) }).reason).toMatch(/no land mutex/);
    // A queued PR still sharing the card: wait, build nothing, memo nothing.
    const waiting = createCardGrouping({ ...opts, statePath: join(d, 'w.json'), withLock: fn => ({ ran: true, result: fn() }), readQueueFiles: () => ({ entries: [{ num: 99, files: [CARD] }] }) });
    expect(waiting.form({ outcomes: t.outcomes, verdicts: t.verdicts, admitted: admit(t.verdicts) })).toMatchObject({ waiting: true, reason: expect.stringMatching(/queued #99 still shares/) });
    expect(existsSync(join(d, 'w.json'))).toBe(false);
    let locked = false;
    const withLock = fn => { locked = true; try { return { ran: true, result: fn() }; } finally { locked = false; } };
    const queued = createCardGrouping({ ...opts, statePath: join(d, 'b.json'), withLock, readQueueFiles: () => (locked ? { entries: [{ num: 2, files: [CARD] }] } : { entries: [] }) });
    expect(queued.form({ outcomes: t.outcomes, verdicts: t.verdicts, admitted: admit(t.verdicts) }).reason).toMatch(/#2 is already in the merge queue/);
    expect(readGroupState(join(d, 'b.json')).groups ?? []).toEqual([]);
    const busy = createCardGrouping({ ...opts, statePath: join(d, 'c.json'), withLock: () => ({ ran: false }), readQueueFiles: () => ({ entries: [] }) });
    expect(busy.form({ outcomes: t.outcomes, verdicts: t.verdicts, admitted: admit(t.verdicts) }).reason).toMatch(/land mutex held/);
    // A clean claim records the group inside the lock and opens the PR.
    const ok = createCardGrouping({ ...opts, statePath: join(d, 'e.json'), withLock, readQueueFiles: () => ({ entries: [] }) });
    const r = ok.form({ outcomes: t.outcomes, verdicts: t.verdicts, admitted: admit(t.verdicts) });
    expect(r.formed).toMatchObject({ pr: 77 });
    // overlap-yield holds are a waiting kind too (the git card-only check still decides).
    const t2 = setup();
    const y = createCardGrouping({ ...opts, cwd: t2.cwd, run: runIn(t2.cwd, () => t2.base), exec: t2.exec, statePath: join(d, 'y.json'), withLock, readQueueFiles: () => ({ entries: [] }) });
    expect(y.form({ outcomes: [1, 2].map(n => ({ num: n, kind: 'overlap-yield', reason: 'overlap-yield:#9' })), verdicts: t2.verdicts, admitted: admit(t2.verdicts) }).formed).toMatchObject({ pr: 77 });
    expect(ok.holdFor({ num: 1 })).toMatchObject({ kind: 'card-grouped' });
    expect(t.calls.some(c => c.startsWith('pr create') && c.includes('review:pending'))).toBe(true);
  });

  it('group first: planner overlap-yield deferrals and early (pre-enqueue) candidates reach form; safety checks still decide', () => {
    const d = tmp();
    const withLock = fn => ({ ran: true, result: fn() });
    const mk = (t, statePath, extra = {}) => createCardGrouping({ localSlug: 'o/r', cwd: t.cwd, run: runIn(t.cwd, () => t.base), exec: t.exec, settings, log: { write() {} },
      prestage: () => ({ allowed: true }), cardConflictSettings: cc, withLock, readQueueFiles: () => ({ entries: [] }), liveGate: () => null, statePath, ...extra });
    // A PLANNER deferral (waitOn overlap-yield, never an enqueue outcome) is offered.
    const t1 = setup();
    expect(mk(t1, join(d, 'p.json')).form({ verdicts: t1.verdicts, admitted: admit(t1.verdicts), deferred: [1, 2].map(n => ({ num: n, waitOn: ['overlap-yield:#9'], overlapYield: { pr: 9, repo: null } })) }).formed).toMatchObject({ pr: 77 });
    // A planner deferral on anything else (blockedBy), or mixed with another wait, or of another repo, is not.
    const t2 = setup();
    const g2 = mk(t2, join(d, 'q.json'));
    expect(g2.form({ verdicts: t2.verdicts, admitted: admit(t2.verdicts), deferred: [1, 2].map(n => ({ num: n, waitOn: ['#123'] })) }).reason).toMatch(/0 card-only overlap deferral/);
    expect(g2.form({ verdicts: t2.verdicts, admitted: admit(t2.verdicts), deferred: [1, 2].map(n => ({ num: n, waitOn: ['overlap-yield:#9', '#123'], overlapYield: { pr: 9, repo: null } })) }).reason).toMatch(/0 card-only overlap deferral/);
    expect(g2.form({ verdicts: t2.verdicts, admitted: admit(t2.verdicts), deferred: [1, 2].map(n => ({ num: n, waitOn: ['overlap-yield:#9'], overlapYield: { pr: 9, repo: 'o/other' } })) }).reason).toMatch(/0 card-only overlap deferral/);
    // Early candidates (the drain's pre-cascade offer) form a group before any single enqueue.
    const t3 = setup();
    expect(mk(t3, join(d, 'e.json')).form({ verdicts: t3.verdicts, admitted: admit(t3.verdicts), early: t3.verdicts }).formed).toMatchObject({ pr: 77 });
    // Early offer does not bypass the label gate: a not-accepted sibling is left out, leaving < 2.
    const t4 = setup();
    const v4 = t4.verdicts.map(v => (v.num === 2 ? { ...v, prLabels: [{ name: 'ready-to-merge' }, { name: 'review:pending' }] } : v));
    expect(mk(t4, join(d, 'f.json')).form({ verdicts: v4, early: v4, admitted: admit(v4) }).reason).toMatch(/fewer than 2 accepted card candidates/);
    // Nor the red-team admission, nor the queue wait.
    const t5 = setup();
    expect(mk(t5, join(d, 'g.json'), { prestage: (c) => ({ allowed: c.num !== 2, reason: 'red team pending' }) }).form({ verdicts: t5.verdicts, admitted: admit(t5.verdicts), early: t5.verdicts }).reason).toMatch(/live re-check left fewer than 2/);
    const t6 = setup();
    expect(mk(t6, join(d, 'h.json'), { readQueueFiles: () => ({ entries: [{ num: 99, files: [CARD] }] }) }).form({ verdicts: t6.verdicts, admitted: admit(t6.verdicts), early: t6.verdicts })).toMatchObject({ waiting: true });
    // The live gate (production: the live fix claim) leaves a member out; unwired or throwing fails closed.
    const t8 = setup();
    expect(mk(t8, join(d, 'i.json'), { liveGate: pr => (Number(pr.number) === 2 ? 'fix claim held by x' : null) }).form({ verdicts: t8.verdicts, admitted: admit(t8.verdicts), early: t8.verdicts }).reason).toMatch(/live re-check left fewer than 2/);
    const t9 = setup();
    expect(mk(t9, join(d, 'j.json'), { liveGate: null }).form({ verdicts: t9.verdicts, admitted: admit(t9.verdicts), early: t9.verdicts }).reason).toMatch(/live re-check left fewer than 2/);
    const t10 = setup();
    expect(mk(t10, join(d, 'k.json'), { liveGate: () => { throw new Error('store down'); } }).form({ verdicts: t10.verdicts, admitted: admit(t10.verdicts), early: t10.verdicts }).reason).toMatch(/live re-check left fewer than 2/);
    // The drain's fresh single-path admission is required: no map, or a member admitted at another head, is left out.
    const t11 = setup();
    expect(mk(t11, join(d, 'l.json')).form({ verdicts: t11.verdicts, early: t11.verdicts }).reason).toMatch(/live re-check left fewer than 2/);
    const t12 = setup();
    expect(mk(t12, join(d, 'm.json')).form({ verdicts: t12.verdicts, early: t12.verdicts, admitted: new Map([[1, t12.a], [2, t12.a]]) }).reason).toMatch(/live re-check left fewer than 2/);
    const t13 = setup();
    expect(mk(t13, join(d, 'n.json')).form({ verdicts: t13.verdicts, early: t13.verdicts, admitted: new Map([[1, t13.a]]) }).reason).toMatch(/live re-check left fewer than 2/);
    // An open group A reserving the card: new accepted PRs on it never form group B — before planning, and
    // under the lock when A appeared meanwhile.
    const groupA = { id: 'aaaa', repo: 'o/r', branch: 'lane/card-group-aaaa', pr: 60, sources: [{ num: 50, headSha: 'f'.repeat(40) }], files: [CARD] };
    const t14 = setup();
    const pa = join(d, 'r.json');
    writeFileSync(pa, JSON.stringify({ groups: [groupA], failed: {} }));
    expect(mk(t14, pa).form({ verdicts: t14.verdicts, early: t14.verdicts, admitted: admit(t14.verdicts) }).reason).toMatch(/no group of 2\+ sharing a card/);
    expect(readGroupState(pa).groups.map(g => g.id)).toEqual(['aaaa']);
    const t15 = setup();
    const pb = join(d, 's2b.json');
    const racing = fn => { writeFileSync(pb, JSON.stringify({ groups: [groupA], failed: {} })); return { ran: true, result: fn() }; };
    expect(mk(t15, pb, { withLock: racing }).form({ verdicts: t15.verdicts, early: t15.verdicts, admitted: admit(t15.verdicts) }).reason).toMatch(/reserved by another open card group/);
    expect(readGroupState(pb).groups.map(g => g.id)).toEqual(['aaaa']);
    expect(t15.calls.some(c => c.startsWith('pr create'))).toBe(false);
    // Dependency/manifest/couple-bearing candidates stay serial, and an unparseable item (0/NaN) fails closed.
    for (const [name, extra] of [['blockedBy', { blockedBy: ['x123456'] }], ['stackParents', { stackParents: [7] }], ['item 0', { item: 0 }],
      ['item NaN', { item: NaN }], ['manifest', { hasManifest: true }], ['couple carrier', { coupleCarrier: { num: 3 } }]]) {
      const t = setup();
      const vs = t.verdicts.map(v => (v.num === 2 ? { ...v, ...extra } : v));
      expect(mk(t, join(d, `dep-${name}.json`)).form({ verdicts: vs, early: vs, admitted: admit(vs) }).reason, name).toMatch(/fewer than 2 accepted card candidates/);
    }
    // A PR already in a recorded group is never offered again.
    const t7 = setup();
    const sp = join(d, 'e.json');
    expect(mk(t7, sp).form({ verdicts: t7.verdicts, admitted: admit(t7.verdicts), early: t7.verdicts }).reason).toMatch(/0 card-only overlap deferral/);
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
});

describe('drain wiring: group first', () => {
  it('the drain offers its candidates to form BEFORE the heal/rebase rebuilds and the cascade, and passes planner deferrals after', () => {
    const src = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
    const early = src.indexOf('cardGrouping.form({ verdicts, early, admitted: await cardGroupAdmission(early) })');
    expect(early).toBeGreaterThan(0);
    // After the review gate (decision === 'merge' already judged), before the source hold and any single enqueue.
    expect(early).toBeGreaterThan(src.indexOf('let remaining = verdicts.map('));
    expect(early).toBeLessThan(src.indexOf('const grouped = cardGrouping.holdFor(c);'));
    expect(early).toBeLessThan(src.indexOf('const memoHold = createHoldMemo('));
    expect(src).toMatch(/liveGate: \(pr\) => \{ const who = attachLiveFixClaim\(/);
    // The early pool is only what the planner marked ready, or deferred on overlap-yield alone.
    expect(src).toContain('&& !v.prestagePendingCi && plannerReady(v));');
    expect(src).toMatch(/d\.waitOn\.every\(w => String\(w\)\.startsWith\('overlap-yield:'\)\)/);
    expect(src).toContain('cardGrouping.form({ outcomes: enqueueOutcomes, verdicts, deferred, admitted: await cardGroupAdmission(');
    // Admission reuses the single path's own gates: the shared pre-enqueue hold (numbering etc.) and revalidateFresh.
    const adm = src.slice(src.indexOf('const cardGroupAdmission = async'), src.indexOf('const cardGroupAdmission = async') + 2000);
    expect(adm).toContain('await preEnqueueHold(c, { forGroup: true })');
    expect(adm).toContain('await revalidateFresh(c.repo, c.num,');
    expect(src).toContain('const earlyHold = c => memoHold(c, () => preEnqueueHold(c));');
    const hold = src.slice(src.indexOf('const preEnqueueHold = async'), src.indexOf('const cardGroupAdmission = async'));
    expect(hold).toMatch(/if \(numberingWithdrawalOwed\(c\.repo \|\| localSlug, c\.num\)\)\s*return \{ kind: 'numbering'/);
    expect(hold).toContain('return mergeStrategy.recordedHold(');
  });
});
