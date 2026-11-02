import { describe, it, expect, vi } from 'vitest';
import * as adoption from '../daemon-rebuild/adopt.mjs';

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

function matchWith(evidence) {
  const args = fixture();
  const leftForMain = vi.fn((applied, build) => adoption.overlayGraduated({ ...evidence, ...applied, build }));
  return { args, leftForMain, match: adoption.matchReadyCandidate({ ...args, leftForMain }) };
}

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

  it('only exempts the overlay with complete graduation evidence', () => {
    const evidence = graduation();
    evidence.events = evidence.events.filter(({ ref }) => ref === liveApplied[0].ref);
    const { match } = matchWith(evidence);
    expect(match.adopt).toBeNull();
    expect(match.omitted).toEqual([liveApplied[1].ref]);
  });

  it.each([undefined, null, 'unknown', {}])('refuses unknown graduation proof (%j)', (proof) => {
    const match = adoption.matchReadyCandidate({ ...fixture(), leftForMain: () => proof });
    expect(match.adopt).toBeNull();
    expect(match.omitted).toEqual(liveApplied.map(({ ref }) => ref));
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
