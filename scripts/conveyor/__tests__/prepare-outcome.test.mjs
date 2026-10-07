import { describe, expect, it } from 'vitest';
import {
  classifyPrepareReport, deriveScopeFromCard, needsYouReason, replaceCardScope, scopeIsDefective, bareScopePath,
} from '../prepare-outcome.mjs';
import { classifyHoldReason } from '../build-dispatch-hold-router.mjs';

describe('classifyPrepareReport - the prepare worker line, in worker-result outcome words', () => {
  it('reads the live #4560 report (dashed, no colon) as no-change with the delivering commit', () => {
    const r = classifyPrepareReport("already-done - delivered by commit 10fedba67afc, which references this card's birth ID xak56ki; ran its 12 tests");
    expect(r).toMatchObject({ outcome: 'no-change', blocker: null, commit: '10fedba67afc' });
  });
  it.each([
    'already-done: commit 10fedba67afc',
    'Already done — commit `10fedba67afc`',
    'spec is fine.\nalready-done delivered by 10fedba67afc',
  ])('reads %j as no-change', (msg) => expect(classifyPrepareReport(msg)).toMatchObject({ outcome: 'no-change', commit: '10fedba67afc' }));
  it('an already-done with no sha is no-change with commit null (the caller must not resolve it)', () => {
    expect(classifyPrepareReport('already-done - it was shipped last week')).toMatchObject({ outcome: 'no-change', commit: null });
  });
  it('reads the live #4328 report as blocked / spec-defect', () => {
    const r = classifyPrepareReport('could-not-prepare — scope is wrong: `scope:` points at the 4309 backlog card itself, so a build would have nothing to build');
    expect(r).toMatchObject({ outcome: 'blocked', blocker: { kind: 'spec-defect' } });
  });
  it('a genuine judgment call stays blocked / needs-ruling', () => {
    expect(classifyPrepareReport('could-not-prepare: the card must choose between A and B; that is a policy call'))
      .toMatchObject({ outcome: 'blocked', blocker: { kind: 'needs-ruling' } });
  });
  it.each([
    'could-not-prepare: must choose between A and B; scope mentions A; policy missing',
    'could-not-prepare: the card needs a ruling on scope vs. size; the rollout plan is empty',
    'could-not-prepare: out of scope for this card, the owner policy is missing',
    'could-not-prepare: two designs fit the scope; picking one is a bad call without the operator',
  ])('a needs-ruling decline that merely mentions scope near a defect word stays needs-ruling: %s', (msg) => {
    expect(classifyPrepareReport(msg)).toMatchObject({ outcome: 'blocked', blocker: { kind: 'needs-ruling' } });
  });
  it.each([
    'could-not-prepare: the scope is wrong',
    'could-not-prepare - wrong scope: names the 4309 card',
    'could-not-prepare: scope is stale, the file was renamed',
    'could-not-prepare: `scope:` is empty',
    'could-not-prepare: scope is missing',
  ])('still reads a plain bad-scope decline as spec-defect: %s', (msg) => {
    expect(classifyPrepareReport(msg)).toMatchObject({ outcome: 'blocked', blocker: { kind: 'spec-defect' } });
  });
  it('a decline that merely mentions "already done" in its reason stays a decline', () => {
    expect(classifyPrepareReport('could-not-prepare: premise stale; part of it is already done on main')).toMatchObject({ outcome: 'blocked' });
  });
  it('anything else is done (the caller still checks the diff)', () => {
    expect(classifyPrepareReport('Prepared the card.')).toMatchObject({ outcome: 'done', blocker: null });
    expect(classifyPrepareReport(undefined)).toMatchObject({ outcome: 'done' });
  });
});

describe('re-scope probe', () => {
  const files = new Set(['scripts/a.mjs', 'scripts/b.mjs', 'scripts/__tests__/a.test.mjs']);
  const exists = (p) => files.has(p);
  const cards = { 'backlog/4309-queue.md': ['we:scripts/a.mjs', 'we:scripts/b.mjs', 'we:backlog/other.md', 'fui:src/x.ts'] };
  const readScope = (p) => cards[p] ?? [];
  const card = '---\nstatus: open\nscope: ["we:backlog/4309-queue.md"]\n---\n\n1. `we:backlog/4309-queue.md:67` - a unit test.\n2. we:scripts/__tests__/a.test.mjs and we:scripts/missing.mjs\n';

  it('a scope that only names a backlog card is defective; a real file is not', () => {
    expect(scopeIsDefective(['we:backlog/4309-queue.md'], { exists })).toBe(true);
    expect(scopeIsDefective([], { exists })).toBe(true);
    expect(scopeIsDefective(['we:scripts/missing.mjs'], { exists })).toBe(true);
    expect(scopeIsDefective(['we:scripts/a.mjs'], { exists })).toBe(false);
  });
  it('follows a cited backlog card one hop and keeps only existing source files', () => {
    expect(deriveScopeFromCard(card, { exists, readScope })).toEqual(['we:scripts/a.mjs', 'we:scripts/b.mjs', 'we:scripts/__tests__/a.test.mjs']);
  });
  it.each([
    'see backlog/../../../.ssh/x.md and we:../../other-repo/src/a.mjs',
    'cites ../../other-repo/src/a.mjs',
    'cites scripts/../../other-repo/src/a.mjs',
    'cites scripts/./a.mjs',
    'cites scripts\\..\\a.mjs',
  ])('never probes or keeps a path that escapes the lane (%s)', (line) => {
    const probed = [];
    const probe = (p) => { probed.push(p); return true; };
    const out = deriveScopeFromCard(`---\nstatus: open\n---\n${line}\n`, { exists: probe, readScope: (p) => { probed.push(p); return ['we:../../x.mjs', 'we:/etc/x.mjs', 'we:scripts/a.mjs']; } });
    expect(out.every((e) => !/(^|[/:\\])\.{1,2}([/\\]|$)/.test(e) && !e.startsWith('we:/'))).toBe(true);
    expect(probed.filter((p) => /(^|\/)\.{1,2}(\/|$)/.test(p) || p.startsWith('/'))).toEqual([]);
  });
  it('drops an escaping entry a cited backlog card carries in its own scope', () => {
    const out = deriveScopeFromCard('---\nstatus: open\n---\nsee backlog/4309-queue.md\n', {
      exists: () => true, readScope: () => ['we:../../x.mjs', 'we:/etc/x.mjs', 'we:scripts/a.mjs'],
    });
    expect(out).toEqual(['we:scripts/a.mjs']);
  });
  it('keeps a directory scope entry safe, and refuses .git and padded segments', () => {
    expect(scopeIsDefective(['we:scripts/conveyor/'], { exists: () => true })).toBe(false);
    expect(bareScopePath('we:reports/')).toBe('reports/');
    expect(bareScopePath('we:.github/workflows/')).toBe('.github/workflows/');
    for (const bad of ['we:.git/hooks/x.mjs', 'we:a//b.mjs', 'we:a/b /c.mjs', 'we:../', 'we:/']) expect(bareScopePath(bad)).toBeNull();
  });
  it('bareScopePath refuses an escaping or absolute entry', () => {
    expect(bareScopePath('we:../x.mjs')).toBeNull();
    expect(bareScopePath('we:scripts/../../x.mjs')).toBeNull();
    expect(bareScopePath('we:/etc/x.mjs')).toBeNull();
    expect(bareScopePath('we:scripts/a.mjs')).toBe('scripts/a.mjs');
  });
  it('returns nothing when the card cites no real code', () => {
    expect(deriveScopeFromCard('---\nstatus: open\n---\nno paths here', { exists, readScope })).toEqual([]);
  });
  it('replaces an inline or a block scope, or adds one', () => {
    expect(replaceCardScope('---\nstatus: open\nscope: ["we:x.md"]\n---\nbody', ['we:scripts/a.mjs'])).toBe('---\nstatus: open\nscope: ["we:scripts/a.mjs"]\n---\nbody');
    expect(replaceCardScope('---\nstatus: open\nscope:\n  - we:x.md\n  - we:y.md\ntags: []\n---\nb', ['we:s.mjs'])).toBe('---\nstatus: open\nscope: ["we:s.mjs"]\ntags: []\n---\nb');
    expect(replaceCardScope('---\nstatus: open\n---\nb', ['we:s.mjs'])).toContain('scope: ["we:s.mjs"]');
  });
});

describe('needsYouReason', () => {
  it('is plain, names the way out, and can never steer the hold router into lane work', () => {
    const r = needsYouReason('spec-defect', 'worker-declined: spec already done on main: commit abcdef1 `x` <b>');
    expect(r).toMatch(/^needs-you: prepare blocked \(spec-defect\)/);
    expect(classifyHoldReason(r)).toEqual({ route: 'other', commit: null });
    expect(r).not.toMatch(/[`<>]/);
  });
});

describe('classifyPrepareReport - adverb before the defect word (PR #4323 review)', () => {
  it('reads "the scope is entirely wrong" as spec-defect', () => {
    expect(classifyPrepareReport('could-not-prepare: the scope is entirely wrong')).toMatchObject({ blocker: { kind: 'spec-defect' } });
  });
});
