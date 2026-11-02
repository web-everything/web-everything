import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as adoption from '../daemon-rebuild/adopt.mjs';
import { readOverlayEventLog } from '../daemon-rebuild/prepare.mjs';
import { overlayFilePath } from '../daemon-overlays.mjs';

const liveApplied = [
  { ref: 'lane/stack-base-refs-m1', sha: 'a'.repeat(40) },
  { ref: 'lane/stack-base-resolve-m1', sha: 'b'.repeat(40) },
];
const merged = '9a55830597';
const mergeSha = `${merged}${'0'.repeat(30)}`;
const buildTree = 'c'.repeat(40);

function fixture() {
  const ready = {
    kind: 'candidate', prevHead: 'H', tree: 'T1',
    at: new Date(1_000_000).toISOString(),
    passedAt: new Date(1_000_000).toISOString(),
    adopt: { finalSha: 'S1', inputsKey: 'K1', mainSha: 'M1', applied: [] },
  };
  return {
    ready,
    plan: { finalSha: 'S2', inputsKey: 'K2', mainSha: 'M2', applied: [] },
    prevHead: 'H', treeOf: () => 'T2', stillWanted: () => true,
    verifyBuilt: () => true, liveApplied, carries: () => false,
    nowMs: 1_060_000, maxAgeMs: 3_600_000,
  };
}

function graduation(overrides = {}) {
  const build = fixture().ready.adopt.finalSha;
  const responses = new Map([
    [JSON.stringify(['rev-parse', '--verify', `${merged}^{commit}`]), { status: 0, stdout: `${mergeSha}\n` }],
    [JSON.stringify(['merge-base', '--is-ancestor', mergeSha, build]), { status: 0, stdout: '' }],
    [JSON.stringify(['rev-parse', `${build}^{tree}`]), { status: 0, stdout: `${buildTree}\n` }],
    ...liveApplied.map(({ sha }) => [
      JSON.stringify(['merge-tree', '--write-tree', '--no-messages', build, sha]),
      { status: 0, stdout: `${buildTree}\nadditional output\n` },
    ]),
  ]);
  return {
    ...liveApplied[0], build, registered: () => false,
    events: liveApplied.flatMap(({ ref }) => [
      { kind: 'added', ref },
      { kind: 'removed', ref, reason: 'graduated #6011 (merged 9a55830597)' },
    ]),
    git: vi.fn((args) => responses.get(JSON.stringify(args)) ?? { status: 1, stdout: '' }),
    ...overrides,
  };
}

function autoDropped(overrides = {}) {
  const ref = 'lane/daemon-heap-log-m2';
  const { event = {}, ...rest } = overrides;
  return graduation({
    ref, readyAt: fixture().ready.at,
    events: [
      { kind: 'added', ref },
      { kind: 'auto-dropped', ref, reason: 'in-main', at: new Date(999_999).toISOString(), ...event },
    ],
    ...rest,
  });
}

function matchWith(evidence, overrides = {}) {
  const args = { ...fixture(), ...overrides };
  const leftForMain = vi.fn((applied, build) => adoption.overlayGraduated({
    ...evidence, ...applied, build, readyAt: args.ready.at,
  }));
  return { args, leftForMain, match: adoption.matchReadyCandidate({ ...args, leftForMain }) };
}

describe('readOverlayEventLog', () => {
  it('reads auto-dropped in-main events from the overlay directory and skips blank lines', () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-rebuild-graduated-'));
    const env = { WE_DAEMON_OVERLAY_DIR: root };
    try {
      const events = autoDropped().events;
      const file = overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl');
      writeFileSync(file, `\n${events.map((event) => JSON.stringify(event)).join('\n \t\n')}\n\n`, 'utf8');
      expect(readOverlayEventLog(root, env)).toEqual(events);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns no evidence when the overlay event log is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-rebuild-graduated-'));
    const env = { WE_DAEMON_OVERLAY_DIR: root };
    try {
      expect(readOverlayEventLog(root, env)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns no partial evidence when an overlay event cannot be parsed', () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-rebuild-graduated-'));
    const env = { WE_DAEMON_OVERLAY_DIR: root };
    try {
      const file = overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl');
      writeFileSync(file, `${JSON.stringify(autoDropped().events[1])}\ninvalid json\n`, 'utf8');
      expect(readOverlayEventLog(root, env)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('squash-graduated overlays in superseded ready candidates', () => {
  it('adopts a candidate that omits a squash-graduated, unregistered overlay', () => {
    const { args, leftForMain, match } = matchWith(graduation());
    expect(match).toEqual({ adopt: args.ready.adopt, dropRefs: [], match: 'superseded' });
    expect(leftForMain).toHaveBeenCalledTimes(2);
    for (const applied of liveApplied) {
      expect(leftForMain).toHaveBeenCalledWith(applied, args.ready.adopt.finalSha);
    }
  });

  it('still refuses when the omitted overlay is still registered', () => {
    const evidence = graduation({ registered: () => true });
    expect(adoption.overlayGraduated(evidence)).toBe(false);
    const { match } = matchWith(evidence);
    expect(match.adopt).toBeNull();
    expect(match.omitted).toEqual(liveApplied.map(({ ref }) => ref));
    expect(match.reason).toBe(`superseded-omits-live-overlay: ${match.omitted.join(', ')}`);
    expect(evidence.git).not.toHaveBeenCalled();
  });

  it('still refuses when unregistered overlay content is not on main', () => {
    const evidence = graduation();
    const success = evidence.git;
    evidence.git = vi.fn((args) => args[0] === 'merge-tree'
      ? { status: 0, stdout: `${'d'.repeat(40)}\n` } : success(args));
    expect(adoption.overlayGraduated(evidence)).toBe(false);
    const { match } = matchWith(evidence);
    expect(match.adopt).toBeNull();
    expect(match.omitted).toEqual(liveApplied.map(({ ref }) => ref));
    expect(match.reason).toBe(`superseded-omits-live-overlay: ${match.omitted.join(', ')}`);
  });
});

describe('auto-dropped in-main overlays in superseded ready candidates', () => {
  it('adopts a candidate omitting lane/daemon-heap-log-m2 auto-dropped before ready.at', () => {
    const evidence = autoDropped({ readyAt: undefined });
    const applied = { ref: evidence.ref, sha: evidence.sha };
    const { args, leftForMain, match } = matchWith(evidence, { liveApplied: [applied] });
    expect(Date.parse(args.ready.at)).toBeLessThan(args.nowMs);
    expect(args.ready.adopt.applied).toEqual([]);
    expect(match).toEqual({ adopt: args.ready.adopt, dropRefs: [], match: 'superseded' });
    expect(leftForMain.mock.calls).toEqual([[applied, args.ready.adopt.finalSha]]);
  });

  it('discards a candidate when lane/daemon-heap-log-m2 was auto-dropped after ready.at', () => {
    const evidence = autoDropped({ events: [
      { kind: 'auto-dropped', ref: 'lane/daemon-heap-log-m2', reason: 'in-main', at: new Date(1_000_001).toISOString() },
    ] });
    const applied = { ref: evidence.ref, sha: evidence.sha };
    const { args, leftForMain, match } = matchWith(evidence, { liveApplied: [applied] });
    expect(match.adopt).toBeNull();
    expect(match.omitted).toEqual([applied.ref]);
    expect(match.reason).toMatch(/^superseded-omits-live-overlay/);
    expect(leftForMain.mock.calls).toEqual([[applied, args.ready.adopt.finalSha]]);
  });
});

describe('overlayGraduated auto-dropped in-main evidence', () => {
  it.each([
    ['ISO', new Date(1_000_000).toISOString()],
    ['milliseconds', 1_000_000],
  ])('accepts an unregistered overlay auto-dropped before %s readyAt with content proof and no merge sha', (_name, readyAt) => {
    const evidence = autoDropped({ readyAt });
    expect(adoption.overlayGraduated(evidence)).toBe(true);
    expect(evidence.git.mock.calls.map(([args]) => args)).toEqual(expect.arrayContaining([
      ['merge-tree', '--write-tree', '--no-messages', evidence.build, evidence.sha],
      ['rev-parse', `${evidence.build}^{tree}`],
    ]));
  });

  it.each([
    ['events missing', () => ({ events: undefined })],
    ['events not an array', () => ({ events: {} })],
    ['events empty', () => ({ events: [] })],
    ['still registered', () => ({ registered: () => true })],
    ['readyAt missing', () => ({ readyAt: undefined })],
    ['readyAt null', () => ({ readyAt: null })],
    ['readyAt unparsable', () => ({ readyAt: 'not-a-date' })],
    ['readyAt nonfinite', () => ({ readyAt: NaN })],
    ['event at missing', () => ({ event: { at: undefined } })],
    ['event at null', () => ({ event: { at: null } })],
    ['event at unparsable', () => ({ event: { at: 'not-a-date' } })],
    ['event at equals readyAt', () => ({ event: { at: fixture().ready.at } })],
    ['event at after readyAt', () => ({ event: { at: new Date(1_000_001).toISOString() } })],
    ...['pr-closed', 'ref-gone', 'pr-merged'].map((reason) => [
      `reason is ${reason} without a merge sha`, () => ({ event: { reason } }),
    ]),
    ['a later added event exists for the ref', () => ({ events: [
      ...autoDropped().events, { kind: 'added', ref: 'lane/daemon-heap-log-m2' },
    ] })],
    ['auto-drop belongs to another ref', () => ({ events: [
      { kind: 'auto-dropped', ref: 'lane/other', reason: 'in-main', at: new Date(999_999).toISOString() },
    ] })],
  ])('fails closed when %s', (_name, overrides) => {
    expect(adoption.overlayGraduated(autoDropped(overrides()))).toBe(false);
  });

  it.each([
    ['merge-tree changes the build tree', 'merge-tree', { status: 0, stdout: `${'d'.repeat(40)}\n` }],
    ['only a later output line matches the build tree', 'merge-tree', { status: 0, stdout: `${'d'.repeat(40)}\n${buildTree}\n` }],
    ['merge-tree conflicts', 'merge-tree', { status: 1, stdout: `${buildTree}\n` }],
    ['merge-tree status is unknown', 'merge-tree', { status: null, stdout: `${buildTree}\n` }],
    ['merge-tree output is empty', 'merge-tree', { status: 0, stdout: '' }],
    ['build tree cannot be read', 'rev-parse', { status: 1, stdout: `${buildTree}\n` }],
    ['build tree is empty', 'rev-parse', { status: 0, stdout: '' }],
    ['git returns unknown evidence', 'merge-tree', undefined],
  ])('fails closed when %s', (_name, command, response) => {
    const evidence = autoDropped();
    const success = evidence.git;
    evidence.git = vi.fn((args) => args[0] === command ? response : success(args));
    expect(adoption.overlayGraduated(evidence)).toBe(false);
  });

  it('fails closed when git throws during the content proof', () => {
    const evidence = autoDropped({ git: () => { throw new Error('unreadable git evidence'); } });
    expect(adoption.overlayGraduated(evidence)).toBe(false);
  });
});

describe('overlayGraduated evidence', () => {
  it('uses the resolved merge commit and the candidate build for ancestry and content proof', () => {
    const evidence = graduation();
    expect(adoption.overlayGraduated(evidence)).toBe(true);
    expect(evidence.git.mock.calls.map(([args]) => args)).toEqual(expect.arrayContaining([
      ['rev-parse', '--verify', `${merged}^{commit}`],
      ['merge-base', '--is-ancestor', mergeSha, evidence.build],
      ['merge-tree', '--write-tree', '--no-messages', evidence.build, evidence.sha],
      ['rev-parse', `${evidence.build}^{tree}`],
    ]));
  });

  it.each([
    ['git throws', () => ({ git: () => { throw new Error('unreadable git evidence'); } })],
    ['events missing', () => ({ events: undefined })],
    ['events empty', () => ({ events: [] })],
    ['last event is added', () => ({ events: [
      ...graduation().events, { kind: 'added', ref: liveApplied[0].ref },
    ] })],
    ['last removal is not graduation', () => ({ events: [
      ...graduation().events, { kind: 'removed', ref: liveApplied[0].ref, reason: 'operator removed' },
    ] })],
    ['graduation event belongs to another ref', () => ({ events: graduation().events.filter(
      ({ ref }) => ref !== liveApplied[0].ref,
    ) })],
    ['graduation reason has an invalid merge hash', () => ({ events: [
      { kind: 'removed', ref: liveApplied[0].ref, reason: 'graduated #6011 (merged xyz)' },
    ] })],
  ])('fails closed when %s', (_name, overrides) => {
    expect(adoption.overlayGraduated(graduation(overrides()))).toBe(false);
  });

  it.each([
    ['merge commit cannot be resolved', 'rev-parse', '--verify', { status: 1, stdout: '' }],
    ['resolved merge commit is empty', 'rev-parse', '--verify', { status: 0, stdout: '' }],
    ['merge is not in the candidate build', 'merge-base', '--is-ancestor', { status: 1, stdout: '' }],
    ['ancestry status is unknown', 'merge-base', '--is-ancestor', { status: null, stdout: '' }],
    ['merge-tree conflicts', 'merge-tree', '--write-tree', { status: 1, stdout: `${buildTree}\n` }],
    ['merge-tree output is empty', 'merge-tree', '--write-tree', { status: 0, stdout: '' }],
    ['build tree cannot be read', 'rev-parse', 'S1^{tree}', { status: 1, stdout: `${buildTree}\n` }],
    ['build tree is empty', 'rev-parse', 'S1^{tree}', { status: 0, stdout: '' }],
    ['git returns unknown evidence', 'merge-tree', '--write-tree', undefined],
  ])('fails closed when %s', (_name, command, argument, response) => {
    const evidence = graduation();
    const success = evidence.git;
    evidence.git = (args) => args[0] === command && args[1] === argument ? response : success(args);
    expect(adoption.overlayGraduated(evidence)).toBe(false);
  });
});

describe('reportDiscardedCandidate', () => {
  it('discarding a ready candidate emits the alert and a ready-candidate-discarded needs-you with reason, refs and target', () => {
    const { ready } = fixture();
    const refs = liveApplied.map(({ ref }) => ref);
    const match = { adopt: null, reason: `superseded-omits-live-overlay: ${refs.join(', ')}`, omitted: refs };
    const alert = vi.fn();
    const needsYou = vi.fn();
    adoption.reportDiscardedCandidate({ ready, match, alert, needsYou });
    const detail = { target: ready.adopt.finalSha, reason: match.reason, refs };
    expect(alert.mock.calls).toEqual([['ready-candidate-discarded', detail]]);
    expect(needsYou.mock.calls).toEqual([[{ kind: 'ready-candidate-discarded', ...detail }]]);
  });

  it.each(['expired', 'other-base', 'already-head'])('alerts without needs-you for %s', (reason) => {
    const { ready } = fixture();
    ready.adopt.applied = liveApplied;
    const alert = vi.fn();
    const needsYou = vi.fn();
    adoption.reportDiscardedCandidate({ ready, match: { reason }, alert, needsYou });
    expect(alert.mock.calls).toEqual([['ready-candidate-discarded', {
      target: ready.adopt.finalSha, reason, refs: liveApplied.map(({ ref }) => ref),
    }]]);
    expect(needsYou).not.toHaveBeenCalled();
  });

  it.each([undefined, []])('uses nullish refs fallback and escalates unknown reasons (omitted: %s)', (omitted) => {
    const { ready } = fixture();
    ready.adopt.applied = liveApplied;
    const alert = vi.fn();
    const needsYou = vi.fn();
    const reason = 'unknown-refusal';
    adoption.reportDiscardedCandidate({ ready, match: { reason, omitted }, alert, needsYou });
    const detail = { target: ready.adopt.finalSha, reason, refs: omitted ?? liveApplied.map(({ ref }) => ref) };
    expect(alert.mock.calls).toEqual([['ready-candidate-discarded', detail]]);
    expect(needsYou.mock.calls).toEqual([[{ kind: 'ready-candidate-discarded', ...detail }]]);
  });
});
