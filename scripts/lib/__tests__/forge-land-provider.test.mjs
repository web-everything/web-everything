/**
 * @file forge-land-provider.test.mjs — the land arc's forge port (#3585).
 *
 * Same two properties `review-label-provider.test.mjs` splits, for the same reason:
 *   1. THE ADAPTER IS FAITHFUL — the argv `gh` receives is byte-identical to what `pr-land.mjs`'s `ghC`
 *      executed inline before the port existed. Asserted here, against literals.
 *   2. THE CALLER'S ORDERING/GUARDS are `pr-land.mjs`'s own property, pinned in `pr-land.test.mjs` against the
 *      pure decision functions (`decideHoldReadyStrip`, `pollVerdict`, …) — not re-asserted here.
 */

import { describe, it, expect } from 'vitest';
import { GH_ARGV, createGhLandProvider, mergeMethodFlag, buildCreateArgs, buildMergeArgs, buildAddLabelArgs } from '../forge-land-provider.mjs';

describe('GH_ARGV is byte-identical to the pre-port inline calls', () => {
  it('finds an existing open PR by head', () => {
    expect(GH_ARGV.listOpenByHead('lane/2153-x'))
      .toEqual(['pr', 'list', '--head', 'lane/2153-x', '--state', 'open', '--json', 'number']);
  });

  it('reads a PR with whatever --json field list the caller asks for', () => {
    expect(GH_ARGV.viewPr(7, 'body')).toEqual(['pr', 'view', '7', '--json', 'body']);
    expect(GH_ARGV.viewPr(7, 'labels')).toEqual(['pr', 'view', '7', '--json', 'labels']);
    expect(GH_ARGV.viewPr(7, 'mergeable,mergeStateStatus')).toEqual(['pr', 'view', '7', '--json', 'mergeable,mergeStateStatus']);
  });

  it('edits the body with --body, never --body-file', () => {
    expect(GH_ARGV.editBody(7, 'new body')).toEqual(['pr', 'edit', '7', '--body', 'new body']);
  });

  it('removes one label', () => {
    expect(GH_ARGV.removeLabel(7, 'ready-to-merge')).toEqual(['pr', 'edit', '7', '--remove-label', 'ready-to-merge']);
  });

  it('creates a label WITHOUT --force — pr-land recreates best-effort, never force-updates', () => {
    expect(GH_ARGV.labelCreate('ready-to-merge', { color: '0E8A16', description: 'go' }))
      .toEqual(['label', 'create', 'ready-to-merge', '--color', '0E8A16', '--description', 'go']);
  });

  it('reads the required checks only', () => {
    expect(GH_ARGV.requiredChecks(7)).toEqual(['pr', 'checks', '7', '--required', '--json', 'state,bucket']);
  });

  it('clamps the ruling-needed description to GitHub’s limit', () => {
    const description = 'AI review parked with confirmed findings that need an operator ruling on the current head (auto-managed)';
    const argv = GH_ARGV.labelCreate('advisory:ruling-needed', { color: 'ededed', description });
    const value = argv[argv.indexOf('--description') + 1];
    expect(value.length).toBeLessThanOrEqual(100);
    expect(value.endsWith('…')).toBe(true);
    expect(value).toBe(description.slice(0, 99) + '…');
  });

  it('re-exports the pre-existing pure builders unchanged', () => {
    expect(mergeMethodFlag('squash')).toBe('--squash');
    expect(buildCreateArgs({ base: 'main', head: 'lane/2153-x' })).toEqual(['pr', 'create', '--base', 'main', '--head', 'lane/2153-x', '--fill']);
    expect(buildMergeArgs({ pr: 4, method: 'merge' })).toEqual(['pr', 'merge', '4', '--merge', '--delete-branch']);
    expect(buildAddLabelArgs({ pr: 60, label: 'ready-to-merge' })).toEqual(['pr', 'edit', '60', '--add-label', 'ready-to-merge']);
  });

  // draft-first PRs (operator-approved 2026-09-27)
  it('buildCreateArgs appends --draft only when draft is explicitly true', () => {
    expect(buildCreateArgs({ base: 'main', head: 'lane/2153-x', draft: true }))
      .toEqual(['pr', 'create', '--base', 'main', '--head', 'lane/2153-x', '--fill', '--draft']);
    expect(buildCreateArgs({ base: 'main', head: 'lane/2153-x', draft: false }))
      .toEqual(['pr', 'create', '--base', 'main', '--head', 'lane/2153-x', '--fill']);
    expect(buildCreateArgs({ base: 'main', head: 'lane/2153-x' }))
      .toEqual(['pr', 'create', '--base', 'main', '--head', 'lane/2153-x', '--fill']);
  });

  it('buildCreateArgs never emits a "--draft=..." valued flag — only the bare presence flag', () => {
    const args = buildCreateArgs({ base: 'main', head: 'lane/2153-x', title: 't', body: 'b', draft: true });
    expect(args).toEqual(['pr', 'create', '--base', 'main', '--head', 'lane/2153-x', '--title', 't', '--body', 'b', '--draft']);
    expect(args.some((a) => a.startsWith('--draft='))).toBe(false);
  });
});

describe('the gh adapter', () => {
  it('shells the exact argv GH_ARGV builds for each named op', () => {
    const seen = [];
    const p = createGhLandProvider({ cwd: '/repo', exec: (args) => { seen.push(args); return '[]'; } });
    p.listOpenByHead('lane/2153-x');
    p.viewPr(7, 'body');
    p.editBody(7, 'x');
    p.removeLabel(7, 'ready-to-merge');
    p.ensureLabel('ready-to-merge', { color: '0E8A16', description: 'go' });
    p.requiredChecks(7);
    expect(seen).toEqual([
      GH_ARGV.listOpenByHead('lane/2153-x'),
      GH_ARGV.viewPr(7, 'body'),
      GH_ARGV.editBody(7, 'x'),
      GH_ARGV.removeLabel(7, 'ready-to-merge'),
      GH_ARGV.labelCreate('ready-to-merge', { color: '0E8A16', description: 'go' }),
      GH_ARGV.requiredChecks(7),
    ]);
  });

  it('create builds argv via buildCreateArgs and returns whatever exec hands back', () => {
    // exec is the trim boundary (the default exec trims, matching ghC before this port existed) — create()
    // itself does no further processing, so a stub exec's raw return passes straight through.
    const seen = [];
    const p = createGhLandProvider({ cwd: '/repo', exec: (args) => { seen.push(args); return 'https://github.com/o/n/pull/42'; } });
    expect(p.create({ base: 'main', head: 'lane/2153-x' })).toBe('https://github.com/o/n/pull/42');
    expect(seen).toEqual([buildCreateArgs({ base: 'main', head: 'lane/2153-x' })]);
  });

  it('listOpenByHead / viewPr / requiredChecks parse the JSON they get back', () => {
    const p = createGhLandProvider({ cwd: '/repo', exec: () => JSON.stringify([{ number: 9 }]) });
    expect(p.listOpenByHead('lane/x')).toEqual([{ number: 9 }]);
    expect(p.requiredChecks(9)).toEqual([{ number: 9 }]);
  });

  it('viewPr returns the parsed object as-is, for the caller to pick its own field', () => {
    const p = createGhLandProvider({ cwd: '/repo', exec: () => JSON.stringify({ body: 'hello' }) });
    expect(p.viewPr(9, 'body')).toEqual({ body: 'hello' });
  });

  it('addLabel is a no-op given a null label or PR (the --no-label / no-PR guard, via buildAddLabelArgs)', () => {
    let called = false;
    const p = createGhLandProvider({ cwd: '/repo', exec: () => { called = true; return ''; } });
    expect(p.addLabel(60, null)).toBe(null);
    expect(p.addLabel(null, 'ready-to-merge')).toBe(null);
    expect(called).toBe(false);
  });

  it('addLabel builds argv via buildAddLabelArgs from (pr, label)', () => {
    const seen = [];
    const p = createGhLandProvider({ cwd: '/repo', exec: (args) => { seen.push(args); return ''; } });
    p.addLabel(60, 'ready-to-merge');
    expect(seen).toEqual([buildAddLabelArgs({ pr: 60, label: 'ready-to-merge' })]);
  });

  it('#3383: create() opts the exec call into header self-calibration; every other method does not', () => {
    const seenCallOpts = [];
    const p = createGhLandProvider({ cwd: '/repo', exec: (args, callOpts) => { seenCallOpts.push(callOpts); return '[]'; } });
    p.create({ base: 'main', head: 'lane/2153-x' });
    expect(seenCallOpts[0]).toEqual({ throttle: { op: 'pr-create', calibrateHeaders: true } });

    p.listOpenByHead('lane/x');
    p.viewPr(7, 'body');
    p.editBody(7, 'x');
    p.removeLabel(7, 'l');
    p.ensureLabel('l', { color: 'c', description: 'd' });
    p.requiredChecks(7);
    p.addLabel(60, 'ready-to-merge');
    // every OTHER method calls exec with just the one argument — no second (throttle) argument at all.
    expect(seenCallOpts.slice(1)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it('never adds a --repo flag — pr-land relies on gh inferring the repo from cwd, unlike review-label-provider', () => {
    expect(GH_ARGV.listOpenByHead('lane/x')).not.toContain('--repo');
    expect(GH_ARGV.viewPr(7, 'body')).not.toContain('--repo');
    expect(GH_ARGV.editBody(7, 'x')).not.toContain('--repo');
    expect(GH_ARGV.removeLabel(7, 'l')).not.toContain('--repo');
    expect(GH_ARGV.labelCreate('l', { color: 'c', description: 'd' })).not.toContain('--repo');
    expect(GH_ARGV.requiredChecks(7)).not.toContain('--repo');
  });
});
