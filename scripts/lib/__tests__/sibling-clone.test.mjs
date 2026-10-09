/**
 * The drain's on-demand sibling clone (we:scripts/lib/sibling-clone.mjs). Live case 2026-10-09: plateau-app PR #217
 * was accepted, MERGEABLE/CLEAN, and skipped every pass with `merge-queue: refresh (…) → skipped-remote failed: no
 * plateauapp/plateau-app clone provisioned` — the drain runs from `.lanes/we-drain-daemon/lane-1`, whose `../plateau-app`
 * was never created, so the freshness refresh could never run and the PR could never merge.
 */
import { describe, it, expect } from 'vitest';
import { siblingCloneUrl, referenceRootFromAlternates, planSiblingClone, ensureSiblingClone } from '../sibling-clone.mjs';

const LANE = '/Users/me/workspace/.lanes/we-drain-daemon/lane-1';
const ALTERNATES = '/Users/me/workspace/webeverything/.git/objects\n';

describe('siblingCloneUrl — same host and transport as the drain clone, the target repo slug', () => {
  it('ssh scp form', () => {
    expect(siblingCloneUrl('git@github.com:chalbert/web-everything.git', 'plateauapp/plateau-app')).toBe('git@github.com:plateauapp/plateau-app.git');
  });
  it('https form, with or without .git', () => {
    expect(siblingCloneUrl('https://github.com/web-everything/web-everything.git', 'frontier-ui/frontierui')).toBe('https://github.com/frontier-ui/frontierui.git');
    expect(siblingCloneUrl('https://github.com/web-everything/web-everything', 'plateauapp/plateau-app')).toBe('https://github.com/plateauapp/plateau-app.git');
  });
  it('unknown shapes and bad slugs → null (never guess)', () => {
    expect(siblingCloneUrl('/local/path/repo', 'plateauapp/plateau-app')).toBeNull();
    expect(siblingCloneUrl('git@github.com:a/b.git', 'no-slash')).toBeNull();
    expect(siblingCloneUrl('', 'a/b')).toBeNull();
  });
});

describe('referenceRootFromAlternates', () => {
  it('the drain lane borrows objects from the primary checkout → that checkout', () => {
    expect(referenceRootFromAlternates(ALTERNATES)).toBe('/Users/me/workspace/webeverything');
  });
  it('none / not a .git/objects path → null', () => {
    expect(referenceRootFromAlternates('')).toBeNull();
    expect(referenceRootFromAlternates('/some/bare.git/objects-odd\n')).toBeNull();
  });
});

describe('planSiblingClone — the #217 case', () => {
  it('plans ../plateau-app next to the drain lane, from plateau-app origin, borrowing the primary sibling', () => {
    const plan = planSiblingClone({
      repo: 'plateauapp/plateau-app', name: 'plateau-app', cwd: LANE,
      originUrl: 'git@github.com:chalbert/web-everything.git', alternates: ALTERNATES,
    });
    expect(plan).toEqual({
      ok: true, dest: '/Users/me/workspace/.lanes/we-drain-daemon/plateau-app',
      url: 'git@github.com:plateauapp/plateau-app.git', reference: '/Users/me/workspace/plateau-app',
    });
  });
  it('no name (outside the constellation) or no derivable URL → refused with a reason', () => {
    expect(planSiblingClone({ repo: 'x/y', name: null, cwd: LANE, originUrl: 'git@github.com:a/b.git' })).toMatchObject({ ok: false });
    expect(planSiblingClone({ repo: 'a/b', name: 'b', cwd: LANE, originUrl: '/local' })).toMatchObject({ ok: false, error: expect.stringMatching(/origin URL/) });
  });
});

describe('ensureSiblingClone — IO through injected git', () => {
  const base = { repo: 'plateauapp/plateau-app', name: 'plateau-app', cwd: LANE };
  it('an existing clone is reused, nothing is cloned', () => {
    const calls = [];
    const r = ensureSiblingClone({ ...base, exists: () => true, git: (a) => { calls.push(a); return ''; } });
    expect(r).toEqual({ ok: true, dir: '/Users/me/workspace/.lanes/we-drain-daemon/plateau-app', created: false });
    expect(calls).toEqual([]);
  });
  it('a missing clone is created with --reference-if-able + --dissociate (no shared-object dependency)', () => {
    const calls = [];
    const git = (args) => { calls.push(args); return args[0] === 'remote' ? 'git@github.com:chalbert/web-everything.git\n' : ''; };
    const exists = (p) => p.endsWith('/plateau-app') ? calls.some((a) => a[0] === 'clone') : false;
    const r = ensureSiblingClone({ ...base, git, exists, readAlternates: () => ALTERNATES, rm: () => {} });
    expect(r).toMatchObject({ ok: true, created: true, dir: '/Users/me/workspace/.lanes/we-drain-daemon/plateau-app' });
    expect(calls.find((a) => a[0] === 'clone')).toEqual(['clone', '--quiet', '--reference-if-able', '/Users/me/workspace/plateau-app', '--dissociate',
      'git@github.com:plateauapp/plateau-app.git', '/Users/me/workspace/.lanes/we-drain-daemon/plateau-app']);
  });
  it('a failed clone removes the partial directory and reports, never throws', () => {
    const removed = [];
    const git = (args) => { if (args[0] === 'clone') throw new Error('Permission denied (publickey)'); return 'git@github.com:a/b.git'; };
    const r = ensureSiblingClone({ ...base, git, exists: () => false, readAlternates: () => '', rm: (p) => removed.push(p) });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/clone failed: Permission denied/) });
    expect(removed).toEqual(['/Users/me/workspace/.lanes/we-drain-daemon/plateau-app']);
  });
});
