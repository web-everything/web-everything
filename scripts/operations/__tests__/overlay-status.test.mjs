// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { assessOverlayStatus, overlayStatusLines, overlayStatusOperation, OVERLAY_STATUS_FOOTER } from '../overlay-status.mjs';
import { collectOverlayStatus } from '../overlay-status-io.mjs';
import { runOverlayStatusCli } from '../overlay-status-cli.mjs';
const sha = 'a'.repeat(40);
const row = (ref, extra = {}) => ({ ref, tipSha: ref, fresh: true,
  adopted: true, onMain: false, containers: [], ...extra });
const snapshot = (registrations, extra = {}) => ({ clones: [{ clone: 'daemon', headSha: sha,
  held: false, onLastGood: false, building: false, registrations, ...extra }] });
const assess = (rows, extra) => assessOverlayStatus(snapshot(rows, extra)).clones[0].registrations;
const git = (_clone, args) => ({ status: 0, text: args[0] === 'rev-parse' ? sha
  : args[0] === 'ls-remote' ? args.slice(2).map((ref) => `${sha}\t${ref}`).join('\n') : '' });
const read = (overrides = {}) => collectOverlayStatus({ clone: 'daemon' }, {
  list: () => [{ ref: 'a' }], rebuild: () => ({}), git, ...overrides });
describe('overlay-status', () => {
  it.each([35, 101])('batches %i registrations per clone and finishes after remote failures', async (count) => {
    const refs = Array.from({ length: count }, (_, i) => `lane/${i}`);
    const probe = vi.fn((clone, args) => args[0] !== 'ls-remote' ? git(clone, args)
      : clone === 'offline' ? { status: null, text: `${sha}\trefs/heads/main` }
      : { status: 0, text: args.slice(2).filter((ref) => ref !== 'refs/heads/lane/0')
        .reverse().map((ref) => `${sha}\t${ref}`).join('\n') });
    const reader = () => collectOverlayStatus({}, {
      discover: () => ({ daemons: ['offline', 'two', 'three', 'four', 'two'].map((clone) => ({ clone })) }),
      list: () => refs.map((ref) => ({ ref })), rebuild: () => ({}), git: probe,
    });
    const outcome = await runOverlayStatusCli([], { collect: reader });
    expect(outcome.code).toBe(0);
    const clones = outcome.run.verdict.clones;
    expect(clones.map((c) => c.clone)).toEqual(['offline', 'two', 'three', 'four']);
    expect(clones[0].registrations.every((r) => !r.fresh && !r.onMain)).toBe(true);
    expect(clones[1].registrations.map((r) => r.fresh)).toEqual(refs.map((_, i) => i !== 0));
    const remoteCalls = probe.mock.calls.filter(([, args]) => args[0] === 'ls-remote');
    expect(remoteCalls).toHaveLength(4 * Math.ceil((count + 1) / 100));
    expect(remoteCalls[0][1]).toEqual(['ls-remote', 'origin', 'refs/heads/main',
      ...refs.slice(0, 99).map((ref) => `refs/heads/${ref}`)]);
    expect(remoteCalls.every(([, args]) => args.length <= 102)).toBe(true);
    expect(remoteCalls.filter(([clone]) => clone === 'two').flatMap(([, args]) => args.slice(2))).toEqual(['refs/heads/main', ...refs.map((ref) => `refs/heads/${ref}`)]);
    expect(clones[1].registrations.every((r) => r.onMain)).toBe(true);
  });
  it('reports coverage by main or another fresh adopted registration, independently of holds', () => {
    const rows = assess([row('a', { containers: ['top'], pinned: true }), row('top'), row('main', { onMain: true }),
      row('unknown', { tipSha: null, onMain: true }), row('pending', { adopted: false, onMain: true })],
    { held: true, onLastGood: true, building: true });
    expect(rows.map((r) => [r.covered, r.containedBy])).toEqual([
      [true, 'top'], [false, null], [true, null], [false, null], [false, null],
    ]);
    expect(rows[0].pinned).toBe(true);
    expect(rows[3].adopted).toBe(false);
    for (const extra of [{ adopted: false }, { fresh: false }, { tipSha: null }]) {
      expect(assess([row('a', { containers: ['top'] }), row('top', extra)])[0].containedBy).toBeNull();
    }
  });
  it('reports equal-tip registrations as mutually covered without implying removal', () => {
    expect(assess([row('a', { tipSha: sha, containers: ['b'] }), row('b', { tipSha: sha, containers: ['a'] })])
      .map((r) => [r.covered, r.containedBy])).toEqual([[true, 'b'], [true, 'a']]);
  });
  it.each(['advanced', 'failed', 'missing'])('refuses stale tracking: %s', (mode) => {
    const result = read({ git: (c, args) => args[0] !== 'ls-remote' ? git(c, args)
      : { status: mode === 'failed' ? 1 : 0, text: mode === 'advanced' ? `${'b'.repeat(40)}\t${args[2]}` : '' } });
    expect(assessOverlayStatus(result).clones[0].registrations[0]).toMatchObject({ fresh: false, covered: false });
  });
  it.each([
    [null, false, null, false],
    [{ building: { startedAt: new Date().toISOString() }, adopted: { head: sha } }, false, true, true],
    [{ adopted: { head: sha, at: new Date().toISOString() } }, false, true, false],
    [{ adopted: { head: sha }, held: { since: 'today', why: 'smoke rejected' } }, true, true, false],
    [{ adopted: { head: 'old' }, held: { since: 'today', why: 'smoke rejected' } }, true, false, false],
    [{ building: { startedAt: new Date().toISOString() }, adopted: { head: 'old' } }, false, false, true],
  ])('reports held, last-good and building separately: %j', (state, held, onLastGood, building) => {
    const result = read({ rebuild: () => state }), c = result.clones[0];
    expect(c).toMatchObject({ held, onLastGood, building });
    expect(overlayStatusLines(result)[0]).toContain(`held=${held ? 'yes' : 'no'}${held ? ' since today why=smoke rejected' : ''} onLastGood=${onLastGood == null ? '?' : onLastGood ? 'yes' : 'no'} building=${building ? 'yes' : 'no'}`);
  });
  it('bounds held reasons to 120 characters on one line', () => {
    const result = read({ rebuild: () => ({ held: { since: 'today', why: `smoke\n${'x'.repeat(200)}` } }) });
    expect(overlayStatusLines(result)[0]).toContain(`held=yes since today why=smoke ${'x'.repeat(114)} onLastGood=no building=no`);
  });
  it('has only clone input and read/assess compute steps, with no effects', async () => {
    const collect = vi.fn(() => snapshot([row('a', { onMain: true, pinned: true })]));
    const declaration = overlayStatusOperation({ collect });
    expect(Object.keys(declaration.input)).toEqual(['clone']);
    const outcome = await runOverlayStatusCli(['--clone=daemon'], { collect });
    expect(outcome.code).toBe(0);
    expect(collect).toHaveBeenCalledWith({ clone: 'daemon' });
    expect(Object.keys(outcome.run.findings)).toEqual(['read', 'assess']);
    expect(outcome.run.effects).toEqual([]);
    expect(outcome.lines.join('\n')).toContain('pinned covered');
    expect(outcome.lines.at(-1)).toBe(OVERLAY_STATUS_FOOTER);
    expect(outcome.lines.join('\n')).not.toContain('RETIRE');
    const json = await runOverlayStatusCli(['--json'], { collect });
    expect(JSON.parse(json.lines.join('\n')).verdict.clones[0].registrations[0].covered).toBe(true);
  });
  it.each(['--retire-contained', '--retireContained', '--actor=operator', '--reason=yes', '--preview'])(
    'rejects removed input %s before collection', async (flag) => {
      const collect = vi.fn();
      expect((await runOverlayStatusCli([flag], { collect })).code).not.toBe(0);
      expect(collect).not.toHaveBeenCalled();
    });
  it('preserves recorded SHAs and exposes explicit pins without inferring unpinned status', () => {
    const registrations = read({ list: () => [{ ref: 'a', sha: 'recorded', pinned: true }, { ref: 'b' }],
      rebuild: () => ({ adopted: { applied: [{ ref: 'b', sha: 'adopted' }] } }) }).clones[0].registrations;
    expect(registrations[0]).toMatchObject({ recordedSha: 'recorded', pinned: true });
    expect(registrations[1].recordedSha).toBe('adopted');
    expect(registrations[1]).not.toHaveProperty('pinned');
  });
  it('reuses discovery and only read-only git commands', () => {
    const probe = vi.fn(git);
    expect(collectOverlayStatus({}, { discover: () => ({ daemons: [{ clone: 'daemon' }] }),
      list: () => [{ ref: 'a' }], rebuild: () => ({}), git: probe }).clones).toHaveLength(1);
    expect(probe.mock.calls.every(([, args]) => ['rev-parse', 'merge-base', 'ls-remote'].includes(args[0]))).toBe(true);
  });
});
