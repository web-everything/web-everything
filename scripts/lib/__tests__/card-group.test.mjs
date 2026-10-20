// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planCardGroups, overlapReasonIsCardOnly, buildCombined, verifyUnion, sourceLanded, cardGroupHold, readCardGroupSettings,
  readGroupState, groupId, cardOnlyFiles, createCardGrouping, combinedPrBody, CARD_GROUP_MARKER,
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
    const built = buildCombined({ base, sources, cwd });
    expect(built.ok).toBe(true);
    expect(built.steps.map(s => s.resolved.length)).toEqual([0, 1, 1]);
    const text = git(cwd, 'show', `${built.commit}:${CARD}`);
    for (const n of [1, 2, 10, 11, 12]) expect(text).toContain(entry(n));
    expect(text).not.toMatch(/<<<<<<<|>>>>>>>/);
    const proof = verifyUnion({ base, combined: built.commit, sources, cwd });
    expect(proof).toMatchObject({ ok: true, missing: [], extra: [], resurrected: [], outside: [] });
    for (const s of sources) expect(sourceLanded({ ref: built.commit, source: s, cwd }).ok).toBe(true);
  });

  it('refuses a conflict outside the list (both PRs change the status line)', () => {
    const { cwd, base, branch } = repo();
    const a = branch('a', () => writeFileSync(join(cwd, CARD), card([1, 2], 'active')));
    const b = branch('b', () => writeFileSync(join(cwd, CARD), card([1, 2], 'resolved')));
    const built = buildCombined({ base, sources: [{ num: 1, headSha: a }, { num: 2, headSha: b }], cwd });
    expect(built.ok).toBe(false);
    expect(built.reason).toMatch(/#2: backlog\/5360-prevention-card\.md: conflict outside Also raised by list/);
  });

  it('refuses a non-card conflict', () => {
    const { cwd, base, branch } = repo();
    const a = branch('a', () => writeFileSync(join(cwd, 'README.md'), 'one\n'));
    const b = branch('b', () => writeFileSync(join(cwd, 'README.md'), 'two\n'));
    const built = buildCombined({ base, sources: [{ num: 1, headSha: a }, { num: 2, headSha: b }], cwd });
    expect(built).toMatchObject({ ok: false });
    expect(built.reason).toMatch(/non-card conflict \(README\.md\)/);
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
    const dry = createCardGrouping({ localSlug: 'o/r', cwd, run, exec, statePath: join(d, 's2.json'), settings, log: { write() {} }, dryRun: true, prestage: () => ({ allowed: true }) });
    const r = dry.form({ outcomes, verdicts });
    expect(r.dryRun).toBe(true);
    expect(r.proof.ok).toBe(true);
    expect(existsSync(join(d, 's2.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(d, 's.json'), 'utf8')).groups).toEqual([]);
  });
});
