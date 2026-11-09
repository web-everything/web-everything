import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as adoption from '../daemon-rebuild/adopt.mjs';
import { readOverlayEventLog, prMergedDropEvidence } from '../daemon-rebuild/prepare.mjs';
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
    [JSON.stringify(['config', '--get-regexp', '^merge\\..*\\.driver$']), { status: 1, stdout: '' }],
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

const ruledDrop = {
  ref: 'lane/redteam-pending-on-accept-m1', pr: 6554,
  at: '2026-11-09T11:58:41.018Z', ruling: 'R790',
};

function prMergedDrop({ legacy = false, event = {}, ...overrides } = {}) {
  return autoDropped({
    ref: ruledDrop.ref, readyAt: '2026-11-09T12:00:00.000Z',
    events: [{
      kind: 'auto-dropped', reason: 'pr-merged',
      ref: ruledDrop.ref, pr: ruledDrop.pr, at: ruledDrop.at,
      ...(!legacy ? { tip: liveApplied[0].sha, evidence: { contentInMain: true, cleanMerges: true } } : {}),
      ...event,
    }],
    ...overrides,
  });
}

describe('prMergedDropEvidence writer', () => {
  const tip = liveApplied[0].sha;
  const mainSha = 'e'.repeat(40);
  const merge = 'f'.repeat(40);
  const parent = 'd'.repeat(40);
  function writerGit({ unresolved = false, stacked = false, clean = true } = {}) {
    const responses = new Map([
      [JSON.stringify(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ruledDrop.ref}^{commit}`]),
        { status: unresolved ? 1 : 0, stdout: unresolved ? '' : tip }],
      [JSON.stringify(['rev-parse', '--verify', `${mainSha}^{tree}`]), { status: 0, stdout: buildTree }],
      [JSON.stringify(['rev-list', '--no-merges', `${mainSha}..${tip}`]), { status: 0, stdout: stacked ? parent : '' }],
      [JSON.stringify(['rev-list', '--merges', `${mainSha}..${tip}`]), { status: 0, stdout: stacked ? merge : '' }],
      [JSON.stringify(['rev-list', '--parents', '-n', '1', merge]), { status: 0, stdout: `${merge} ${mainSha} ${parent}` }],
      [JSON.stringify(['merge-tree', '--write-tree', '--no-messages', mainSha, parent]), { status: 0, stdout: tip }],
      [JSON.stringify(['rev-parse', '--verify', `${merge}^{tree}`]), { status: 0, stdout: clean ? tip : buildTree }],
      [JSON.stringify(['merge-tree', '--write-tree', '--no-messages', mainSha, tip]),
        { status: 0, stdout: stacked ? tip : buildTree }],
    ]);
    return vi.fn((args) => responses.get(JSON.stringify(args)) ?? { status: 1, stdout: '' });
  }

  it('records content in the plan main and adapts git status to code', () => {
    const git = writerGit();
    expect(prMergedDropEvidence({ git, ref: ruledDrop.ref, mainSha })).toEqual({
      tip, evidence: { contentInMain: true, cleanMerges: true },
    });
    expect(git).toHaveBeenCalledWith(['merge-tree', '--write-tree', '--no-messages', mainSha, tip]);
  });

  it('fails closed with null tip and false evidence for an unresolvable tip', () => {
    expect(prMergedDropEvidence({ git: writerGit({ unresolved: true }), ref: ruledDrop.ref, mainSha })).toEqual({
      tip: null, evidence: { contentInMain: false, cleanMerges: false },
    });
  });

  it('does not claim stacked-branch merge content is in main', () => {
    expect(prMergedDropEvidence({ git: writerGit({ stacked: true }), ref: ruledDrop.ref, mainSha })).toEqual({
      tip, evidence: { contentInMain: false, cleanMerges: true },
    });
  });

  it('records unclean stacked merges as false', () => {
    expect(prMergedDropEvidence({ git: writerGit({ stacked: true, clean: false }), ref: ruledDrop.ref, mainSha })).toEqual({
      tip, evidence: { contentInMain: false, cleanMerges: false },
    });
  });

  it('fails closed when git throws', () => {
    expect(prMergedDropEvidence({ git: () => { throw new Error('unreadable'); }, ref: ruledDrop.ref, mainSha })).toEqual({
      tip: null, evidence: { contentInMain: false, cleanMerges: false },
    });
  });
});

describe('overlayGraduated pr-merged auto-drops', () => {
  it('accepts evidence bound to the applied tip with independent content proof', () => {
    expect(adoption.overlayGraduated(prMergedDrop())).toBe(true);
  });

  it.each([
    ['missing tip', { tip: undefined }],
    ['wrong tip', { tip: liveApplied[1].sha }],
    ['contentInMain false', { evidence: { contentInMain: false, cleanMerges: true } }],
    ['cleanMerges false', { evidence: { contentInMain: true, cleanMerges: false } }],
    ['incomplete evidence', { evidence: {} }],
    ['at readyAt', { at: '2026-11-09T12:00:00.000Z' }],
    ['after readyAt', { at: '2026-11-09T12:00:00.001Z' }],
    ['pr-closed', { reason: 'pr-closed' }],
    ['ref-gone', { reason: 'ref-gone' }],
  ])('refuses %s even for the ruled identity', (_name, event) => {
    expect(adoption.overlayGraduated(prMergedDrop({ event }))).toBe(false);
  });

  it('exports the frozen exact R790 allowlist', () => {
    expect(adoption.RULED_LEGACY_PR_MERGED_DROPS).toEqual([ruledDrop]);
    expect(Object.isFrozen(adoption.RULED_LEGACY_PR_MERGED_DROPS)).toBe(true);
    expect(Object.isFrozen(adoption.RULED_LEGACY_PR_MERGED_DROPS[0])).toBe(true);
  });

  it('accepts the exact legacy R790 entry with independent content proof', () => {
    expect(adoption.overlayGraduated(prMergedDrop({ legacy: true }))).toBe(true);
  });

  it.each([
    ['ref', { ref: 'lane/other' }],
    ['pr', { pr: 6555 }],
    ['pr type', { pr: '6554' }],
    ['at', { at: '2026-11-09T11:58:41.019Z' }],
    ['equivalent at spelling', { at: '2026-11-09T11:58:41.018+00:00' }],
    ['kind', { kind: 'removed' }],
    ['reason', { reason: 'pr-closed' }],
  ])('refuses a legacy event with a different %s', (_name, event) => {
    expect(adoption.overlayGraduated(prMergedDrop({ legacy: true, event, ...(event.ref ? { ref: event.ref } : {}) }))).toBe(false);
  });

  it.each([false, true])('refuses content missing from the candidate (legacy=%s)', (legacy) => {
    const evidence = prMergedDrop({ legacy });
    const success = evidence.git;
    evidence.git = (args) => args[0] === 'merge-tree' ? { status: 0, stdout: 'd'.repeat(40) } : success(args);
    expect(adoption.overlayGraduated(evidence)).toBe(false);
  });

  it.each(['2026-11-09T11:58:41.018Z', '2026-11-09T11:58:41.017Z'])('refuses the legacy drop at or after readyAt %s', (readyAt) => {
    expect(adoption.overlayGraduated(prMergedDrop({ legacy: true, readyAt }))).toBe(false);
  });

  it('adopts a superseded ready candidate omitting both live occurrences of the ruled ref', () => {
    const evidence = prMergedDrop({ legacy: true });
    const base = fixture();
    const ready = { ...base.ready, at: evidence.readyAt };
    const applied = { ref: evidence.ref, sha: evidence.sha };
    const { args, leftForMain, match } = matchWith(evidence, { ready, liveApplied: [applied, { ...applied }] });
    expect(args.plan.finalSha).not.toBe(ready.adopt.finalSha);
    expect(args.treeOf(args.plan.finalSha)).not.toBe(ready.tree);
    expect(match).toEqual({ adopt: ready.adopt, dropRefs: [], match: 'superseded' });
    expect(leftForMain.mock.results.map(({ value }) => value)).toEqual([true, true]);
  });
});

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

describe.each([
  ['graduated-merged', graduation],
  ['auto-dropped in-main', autoDropped],
  ['auto-dropped pr-merged', prMergedDrop],
  ['R790 legacy pr-merged', () => prMergedDrop({ legacy: true })],
])('overlayGraduated %s merge driver evidence', (_name, makeEvidence) => {
  const configArgs = ['config', '--get-regexp', '^merge\\..*\\.driver$'];

  it.each([
    ['a custom merge driver is configured', { status: 0, stdout: 'merge.ours.driver true\n' }],
    ['config fails with status 128', { status: 128, stdout: '' }],
    ['config status is undefined', { stdout: '' }],
    ['config response is undefined', undefined],
  ])('fails closed before merge-tree when %s', (_reason, response) => {
    const evidence = makeEvidence();
    const success = evidence.git;
    evidence.git = vi.fn((args) => JSON.stringify(args) === JSON.stringify(configArgs) ? response : success(args));
    expect(adoption.overlayGraduated(evidence)).toBe(false);
    expect(evidence.git).toHaveBeenCalledWith(configArgs);
    expect(evidence.git.mock.calls.some(([args]) => args[0] === 'merge-tree')).toBe(false);
  });

  it('accepts content proof when config status is exactly 1', () => {
    const evidence = makeEvidence();
    expect(adoption.overlayGraduated(evidence)).toBe(true);
    const calls = evidence.git.mock.calls.map(([args]) => args);
    const configIndex = calls.findIndex((args) => JSON.stringify(args) === JSON.stringify(configArgs));
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(calls.findIndex((args) => args[0] === 'merge-tree')).toBeGreaterThan(configIndex);
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


describe('redecideWithCandidate (R787/R796)', () => {
  function setup(overrides = {}) {
    const evidence = graduation();
    const args = { ...fixture(), ...overrides };
    // Model the older running daemon: its graduation rule refuses this evidence.
    const oldGraduation = vi.fn(() => false);
    args.leftForMain = (applied, build, graduate = oldGraduation) => graduate({
      ...evidence, ...applied, build, readyAt: args.ready.at,
    });
    const candidate = {
      matchReadyCandidate: vi.fn(adoption.matchReadyCandidate),
      overlayGraduated: vi.fn(adoption.overlayGraduated),
    };
    return {
      m: adoption.matchReadyCandidate(args), ready: args.ready, args, git: evidence.git,
      alert: vi.fn(), loadCandidate: vi.fn(async () => candidate), candidate,
    };
  }

  it('re-decides the #6592 omission with candidate graduation, exactly once', async () => {
    const o = setup();
    expect(o.m.reason).toMatch(/^superseded-omits-live-overlay/);
    const result = await adoption.redecideWithCandidate(o);
    expect(result).toEqual({ adopt: o.ready.adopt, dropRefs: [], match: 'redecided-by-candidate' });
    expect(o.loadCandidate).toHaveBeenCalledTimes(1);
    expect(o.candidate.matchReadyCandidate).toHaveBeenCalledTimes(1);
    expect(o.candidate.matchReadyCandidate.mock.calls[0][0]).toEqual({
      ...o.args, leftForMain: expect.any(Function),
    });
    expect(o.candidate.overlayGraduated).toHaveBeenCalledTimes(liveApplied.length);
    expect(o.alert).toHaveBeenCalledWith('ready-candidate-redecided', {
      match: 'redecided-by-candidate', target: o.ready.adopt.finalSha,
    });
  });

  it('retains the original refusal and cleans scratch when the loader throws', async () => {
    const o = setup();
    let scratch;
    o.loadCandidate.mockImplementation(async ({ dir }) => { scratch = dir; throw new Error('cannot load candidate'); });
    expect(await adoption.redecideWithCandidate(o)).toBe(o.m);
    expect(o.alert).toHaveBeenCalledWith('redecide-candidate-error', { error: 'cannot load candidate' });
    expect(existsSync(scratch)).toBe(false);
  });

  it.each([
    ['other finalSha', { adopt: { finalSha: 'OTHER' }, dropRefs: [] }],
    ['rewritten adopt metadata', { adopt: { ...fixture().ready.adopt, inputsKey: 'TAMPERED' }, dropRefs: [] }],
    ['nonempty dropRefs', { adopt: fixture().ready.adopt, dropRefs: [{ ref: 'lane/drop' }] }],
    ['missing dropRefs', { adopt: fixture().ready.adopt }],
    ['candidate refusal', { adopt: null, reason: 'superseded-omits-live-overlay: still missing' }],
  ])('retains the original refusal for %s, without retry', async (_name, result) => {
    const o = setup();
    o.candidate.matchReadyCandidate.mockReturnValue(result);
    expect(await adoption.redecideWithCandidate(o)).toBe(o.m);
    expect(o.loadCandidate).toHaveBeenCalledTimes(1);
    expect(o.candidate.matchReadyCandidate).toHaveBeenCalledTimes(1);
    expect(o.alert).not.toHaveBeenCalled();
  });

  it.each([null, undefined, false, 'adopt'])('fails closed and alerts for non-object result %s', async (result) => {
    const o = setup();
    o.candidate.matchReadyCandidate.mockReturnValue(result);
    expect(await adoption.redecideWithCandidate(o)).toBe(o.m);
    expect(o.alert).toHaveBeenCalledWith('redecide-candidate-error', { error: expect.any(String) });
  });

  it('fails closed and alerts when candidate matching throws', async () => {
    const o = setup();
    o.candidate.matchReadyCandidate.mockImplementation(() => { throw new Error('candidate failed'); });
    expect(await adoption.redecideWithCandidate(o)).toBe(o.m);
    expect(o.alert).toHaveBeenCalledWith('redecide-candidate-error', { error: 'candidate failed' });
  });

  it.each([
    ['unverified-build', { verifyBuilt: () => false }],
    ['rejected-since', { rejected: { inputsKey: 'K1', at: new Date(1_001_000).toISOString() } }],
    ['expired', { nowMs: 9_000_000 }],
    ['other-base', { prevHead: 'OTHER' }],
    ['forced-sha-pinned', { ready: { ...fixture().ready, forced: true } }],
  ])('never loads a candidate after %s', async (reason, overrides) => {
    const o = setup(overrides);
    expect(o.m.reason).toBe(reason);
    expect(await adoption.redecideWithCandidate(o)).toBe(o.m);
    expect(o.loadCandidate).not.toHaveBeenCalled();
    expect(o.alert).not.toHaveBeenCalled();
  });

  it('never re-decides an existing adoption even if a reason is present', async () => {
    const o = setup();
    o.m = { ...o.m, adopt: o.ready.adopt };
    expect(await adoption.redecideWithCandidate(o)).toBe(o.m);
    expect(o.loadCandidate).not.toHaveBeenCalled();
  });

  // Happy DOM evaluates Function in a VM without Node's dynamic-import callback. Exercise the
  // production loader in native Node, with hermetic Git blobs and a private task-temp directory.
  function nativeDecision(source) {
    const root = mkdtempSync(join(tmpdir(), 'candidate-loader-test-'));
    const input = { args: fixture(), sources: [
      ['scripts/lib/daemon-rebuild/adopt.mjs', source],
      ['scripts/lib/candidate-rule.mjs', 'export const graduated = () => true;'],
    ] };
    const driver = `
      import { redecideWithCandidate } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/lib/daemon-rebuild/adopt.mjs')).href)};
      import { existsSync } from 'node:fs';
      const { args, sources } = JSON.parse(process.argv[1]);
      const blobs = new Map(sources);
      Object.assign(args, {
        treeOf: () => 'T2', stillWanted: () => true, verifyBuilt: () => true,
        carries: () => false, leftForMain: (applied, build, graduate = () => false) => graduate({ ...applied, build }),
      });
      const m = { adopt: null, reason: 'superseded-omits-live-overlay: lane/base' };
      const alerts = [], calls = [];
      const git = (argv) => {
        calls.push(argv);
        const name = argv[1]?.slice('S1:'.length);
        return argv[0] === 'show' && argv[1].startsWith('S1:') && blobs.has(name) && blobs.get(name) !== null
          ? { status: 0, stdout: blobs.get(name) } : { status: 1, stdout: '' };
      };
      const result = await redecideWithCandidate({ m, ready: args.ready, args, git,
        alert: (...args) => alerts.push(args) });
      process.stdout.write(JSON.stringify({ result, alerts, sameOriginal: result === m,
        scratchRemoved: result.sourceUrl ? !existsSync(new URL(result.sourceUrl)) : null,
        allFromReadySha: calls.length > 0 && calls.every(([cmd, spec]) => cmd === 'show' && spec.startsWith('S1:')) }));
    `;
    try {
      const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', driver, JSON.stringify(input)], {
        env: { ...process.env, TMPDIR: root }, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      }));
      expect(readdirSync(root)).toEqual([]);
      return result;
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('loads only the ready SHA module and its relative sibling, then removes scratch', () => {
    const { result, alerts, scratchRemoved, allFromReadySha } = nativeDecision(`
      import { graduated } from '../candidate-rule.mjs';
      export const overlayGraduated = graduated;
      export function matchReadyCandidate(args) {
        if (!args.leftForMain(args.liveApplied[0], args.ready.adopt.finalSha)) return { adopt: null };
        return { adopt: args.ready.adopt, dropRefs: [], sourceUrl: import.meta.url };
      }
    `);
    expect(result.match).toBe('redecided-by-candidate');
    expect(result.adopt.finalSha).toBe(fixture().ready.adopt.finalSha);
    expect(alerts).toEqual([['ready-candidate-redecided', {
      match: 'redecided-by-candidate', target: fixture().ready.adopt.finalSha,
    }]]);
    expect(scratchRemoved).toBe(true);
    expect(allFromReadySha).toBe(true);
  });

  it.each([
    ['unimportable', 'export const = syntax error'],
    ['missing exports', 'export const unrelated = true;'],
    ['unreadable git source', null],
    ['missing sibling', "import './missing.mjs'; export const overlayGraduated = () => true;"],
    ['top-level throw', "throw new Error('module failed');"],
  ])('retains the original refusal, cleans scratch and alerts for %s', (_name, source) => {
    const { sameOriginal, alerts } = nativeDecision(source);
    expect(sameOriginal).toBe(true);
    expect(alerts).toEqual([['redecide-candidate-error', { error: expect.any(String) }]]);
  });
});
