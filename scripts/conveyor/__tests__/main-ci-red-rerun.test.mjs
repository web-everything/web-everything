import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../main-ci-red-core.mjs';
import * as io from '../main-ci-red-io.mjs';

const settings = core.mainCiRedSettings();
const green = { databaseId: 1, headSha: 'abcdef0123456789', createdAt: '2026-10-14T01:00:00Z', status: 'completed', conclusion: 'success' };
const red = { databaseId: 2, headSha: '62da75ed3123456789', createdAt: '2026-10-14T02:00:00Z', status: 'completed', conclusion: 'failure', attempt: 1 };
const tip = { databaseId: 3, headSha: '28a7885f1123456789', createdAt: '2026-10-14T03:00:00Z', status: 'completed', conclusion: 'cancelled', attempt: 1 };
const failure = { file: 'scripts/conveyor/__tests__/sim-scenario-self-sync-sibling.test.mjs', title: '#3383 daemon scenario simulator > A3: a main move t', error: 'Error: Test timed out in 180000ms.' };
const log = '2026-10-14T05:47:26.5319152Z \u001b[31m\u001b[1m\u001b[7m FAIL \u001b[27m\u001b[22m\u001b[39m scripts/conveyor/__tests__/sim-scenario-self-sync-sibling.test.mjs\u001b[2m > \u001b[22m#3383 daemon scenario simulator\u001b[2m > \u001b[22mA3: a main move t\n2026-10-14T05:47:26.5320853Z \u001b[31m\u001b[1mError\u001b[22m: Test timed out in 180000ms.';
const flake = { runId: 2, eligible: true, reason: 'flaky-signature' };
const classify = (overrides = {}) => core.classifyFlakeRun({ run: red, failedJobs: ['integration', 'test'], failures: [failure], settings, ...overrides });
const plan = (overrides = {}) => core.planMainCiRerun({ runs: [green, red, tip], tipSha: tip.headSha, flake, settings, ...overrides });

describe('repeat-proof reruns use the existing conveyor path', () => {
  const deterministic = { file: 'scripts/lib/__tests__/hermetic-guard.test.mjs', title: 'rejects host IO', error: 'AssertionError: unexpected host IO' };
  // Pin the switch for behavioral tests; test default declaration separately.
  const proofSettings = { ...settings, mainCiRedRerunForProof: true };
  const classifyProof = (overrides = {}) => classify({ failures: [deterministic], settings: proofSettings, ...overrides });

  it('declares a true default, validates boolean overrides and reports setting provenance', () => {
    const key = 'mainCiRedRerunForProof';
    expect(core.MAIN_CI_RED_DEFAULTS[key]).toBe(true);
    expect(core.mainCiRedSettings()[key]).toBe(true);
    expect(core.mainCiRedSettingSource({}, key)).toBe('standard');
    expect(core.mainCiRedSettings({ [key]: false })[key]).toBe(false);
    expect(core.mainCiRedSettingSource({ [key]: false }, key)).toBe('health');
    expect(core.mainCiRedSettings({ [key]: 'false' })[key]).toBe(true);
    expect(core.mainCiRedSettingSource({ [key]: 'false' }, key)).toBe('standard');
  });

  it('classifies a deterministic file failure as eligible for repeat proof', () => {
    expect(classifyProof()).toEqual({ eligible: true, reason: 'repeat-proof' });
  });

  it('preserves signature priority over repeat proof', () => {
    expect(classifyProof({ failures: [failure] })).toEqual({ eligible: true, reason: 'flaky-signature' });
  });

  it('default-enabled repeat proof accepts a deterministic file failure without other flake evidence', () => {
    expect(core.classifyFlakeRun({
      run: red, failures: [deterministic], prevRunGreen: false, changedFiles: [], groupEvidence: null,
    })).toEqual({ eligible: true, reason: 'repeat-proof' });
  });

  it('explicit-false repeat proof rejects a deterministic file failure without other flake evidence', () => {
    expect(core.classifyFlakeRun({
      run: red, failures: [deterministic], prevRunGreen: false, changedFiles: [], groupEvidence: null,
      settings: core.mainCiRedSettings({ mainCiRedRerunForProof: false }),
    })).toEqual({ eligible: false, reason: 'not-flaky' });
  });

  it('attempt >1 still refuses a repeat-proof rerun', () => {
    expect(classifyProof({ run: { ...red, attempt: 2 } })).toEqual({ eligible: false, reason: 'already-rerun' });
  });

  it('the global rerun-off switch wins even on attempt 2', () => {
    expect(classifyProof({ run: { ...red, attempt: 2 }, settings: { ...proofSettings, mainCiRedFlakeRerun: false } }))
      .toEqual({ eligible: false, reason: 'rerun-off' });
  });

  it.each([
    [], null, undefined, {}, [null],
    [{ title: 'missing file', error: 'AssertionError' }],
    [{ ...deterministic, file: '' }],
    [{ ...deterministic, file: 42 }], [deterministic, { title: 'missing file' }],
  ])('fails closed for empty, incomplete or malformed test failure evidence: %j', (failures) => {
    expect(classifyProof({ failures })).toEqual({ eligible: false, reason: 'not-flaky' });
  });

  it('plans exactly one repeat-proof rerun and none once its run id is ledgered', () => {
    const flake = { runId: red.databaseId, ...classifyProof() };
    expect(flake).toEqual({ runId: red.databaseId, eligible: true, reason: 'repeat-proof' });
    const input = { runs: [green, red], tipSha: red.headSha, flake, settings: proofSettings };
    const planned = core.planMainCiRerun(input);
    expect(planned).toEqual({ runId: red.databaseId, sha: red.headSha, kind: 'flake', reason: 'repeat-proof' });
    expect(core.planMainCiRerun({ ...input, reruns: { [red.databaseId]: { kind: 'flake', status: 'issued' } } })).toBeNull();
  });
});

describe('flake rules and cancelled tip priority', () => {
  it('parses timestamped ANSI logs, deduplicates and tolerates junk', () => {
    expect(core.parseVitestFailures(`${log}\n${log}`)).toEqual([failure]);
    for (const junk of [null, undefined, {}, 12, 'junk']) expect(core.parseVitestFailures(junk)).toEqual([]);
    expect(core.parseVitestFailures('FAIL a.test.mjs > title\n\ncontext\nTypeError: broken')).toEqual([{ file: 'a.test.mjs', title: 'title', error: 'TypeError: broken' }]);
    expect(core.parseVitestFailures('FAIL a > b\n1\n2\n3\n4\n5\n6\nError: late')[0].error).toBe('');
  });
  it('with repeat proof off, requires all failures to match a signature or known flaky test', () => {
    const settings = { ...core.mainCiRedSettings(), mainCiRedRerunForProof: false };
    const classify = (overrides = {}) => core.classifyFlakeRun({ run: red, failures: [failure], settings, ...overrides });
    expect(classify()).toEqual({ eligible: true, reason: 'flaky-signature' });
    const assertion = { file: 'other.test.mjs', title: 'assertion', error: 'AssertionError: mismatch' };
    expect(classify({ failures: [failure, assertion] }).eligible).toBe(false);
    expect(classify({ failures: [assertion], settings: { ...settings, mainCiRedKnownFlakyTests: ['other.test.mjs > assertion'] } }).eligible).toBe(true);
    expect(classify({ settings: { ...settings, mainCiRedFlakeSignaturePattern: '' } }).eligible).toBe(false);
    expect(classify({ settings: { ...settings, mainCiRedFlakeSignaturePattern: '[' } }).eligible).toBe(false);
  });
  it('uses only a nonempty prose diff after a green run for unrelated changes', () => {
    expect(classify({ failures: null, prevRunGreen: true, changedFiles: ['backlog/123.md', 'docs/foo.md'] })).toEqual({ eligible: true, reason: 'unrelated-change' });
    for (const changedFiles of [[], null, ['src/code.ts'], ['docs/code.mjs']]) expect(classify({ failures: [], prevRunGreen: true, changedFiles }).eligible).toBe(false);
    expect(classify({ failures: [], prevRunGreen: false, changedFiles: ['backlog/a.md'] }).eligible).toBe(false);
    expect(classify({ run: { ...red, attempt: 2 } }).reason).toBe('already-rerun');
    expect(classify({ settings: { ...settings, mainCiRedFlakeRerun: false } }).reason).toBe('rerun-off');
  });
  it('prefers the cancelled tip, never stacks and never repeats a run', () => {
    expect(plan()).toEqual({ runId: 3, sha: tip.headSha, kind: 'cancelled-tip', reason: 'latest main run was cancelled' });
    expect(plan({ runs: [red, { ...tip, status: 'in_progress' }] })).toBeNull();
    expect(plan({ reruns: { 3: {} } })).toEqual({ runId: 2, sha: red.headSha, kind: 'flake', reason: 'flaky-signature' });
    expect(plan({ reruns: { 2: {}, 3: {} } })).toBeNull();
    expect(plan({ settings: { ...settings, mainCiRedFlakeRerun: false } })).toBeNull();
    expect(plan({ settings: { ...settings, mainCiRedRerunCancelledTip: false }, flake: null })).toBeNull();
    expect(plan({ runs: [{ ...tip, attempt: 2 }], flake: null })).toBeNull();
  });
  it('keeps a flake rerun red and suppresses repair ownership', () => {
    const pending = { ...red, status: 'in_progress', rerunPending: true };
    expect(core.classifyRun(pending)).toBe('red');
    const state = core.mainRedState([green, pending]);
    expect(state.status).toBe('red');
    expect(core.decideOwner({ state, now: Date.parse(red.createdAt), rerunPending: true })).toEqual({ owed: false, reason: 'flake-rerun-pending' });
  });
});

const exhaustRerunRounds = (dir) => {
  const path = io.ledgerPathIn(dir), ledger = JSON.parse(readFileSync(path));
  for (const entry of Object.values(ledger._reruns)) entry.rounds = core.FLAKE_RERUN_ROUNDS;
  writeFileSync(path, JSON.stringify(ledger));
};

describe('rerun IO and ledger', () => {
  async function fixture(runTest) {
    const dir = mkdtempSync(join(process.env.TMPDIR, 'main-red-rerun-'));
    const rerun = vi.fn(), dispatch = vi.fn(), publishState = vi.fn();
    const opts = { dir, now: Date.parse('2026-10-14T06:00:00Z'), readRuns: () => ({ runs: [green, red], failing: { flake } }), readPrs: () => [], rerun, dispatch, publishState,
      publishPriority: vi.fn(), gates: async () => ({ killed: false }), listAgents: async () => [] };
    try { await runTest(opts); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it('reserves once, issues once, keeps hold, and suppresses dispatch during rerun', async () => fixture(async (opts) => {
    const first = await io.probeAndOwnMainCi(opts);
    expect(first.rerun).toMatchObject({ runId: 2, status: 'issued' });
    expect(opts.rerun).toHaveBeenCalledTimes(1);
    expect(opts.rerun).toHaveBeenCalledWith(2);
    expect(JSON.parse(readFileSync(io.ledgerPathIn(opts.dir)))._reruns['2']).toMatchObject({ status: 'issued', kind: 'flake' });
    expect(opts.publishState).toHaveBeenCalledWith(expect.objectContaining({ red: true }));
    expect(first.decision.reason).toBe('flake-rerun-pending');
    await io.probeAndOwnMainCi({ ...opts, readRuns: () => ({ runs: [green, { ...red, status: 'in_progress' }] }) });
    expect(opts.dispatch).not.toHaveBeenCalled();
    await io.probeAndOwnMainCi(opts);
    expect(opts.rerun).toHaveBeenCalledTimes(1);
  }));
  it('dry-run writes and issues nothing', async () => fixture(async (opts) => {
    expect((await io.probeAndOwnMainCi({ ...opts, dryRun: true })).rerun.status).toBe('dry-run');
    expect(opts.rerun).not.toHaveBeenCalled();
    expect(() => readFileSync(io.ledgerPathIn(opts.dir))).toThrow();
  }));
  it.each(['failure', 'timed_out', 'startup_failure'])('repeat-proof rerun that fails again is not re-run: %s', async (conclusion) => fixture(async (opts) => {
    const first = await io.probeAndOwnMainCi({ ...opts,
      readRuns: () => ({ runs: [{ ...green }, { ...red }], failing: { flake: { ...flake, reason: 'repeat-proof' } } }),
    });
    expect(first.rerun).toMatchObject({ reason: 'repeat-proof', status: 'issued' });
    const second = await io.probeAndOwnMainCi({ ...opts,
      readRuns: () => ({ runs: [{ ...green }, { ...red, attempt: 2, conclusion }] }),
    });
    expect(opts.rerun).toHaveBeenCalledTimes(1);
    expect(second.rerun).toBeUndefined();
    expect(second.mainRed).toMatchObject({ red: true, firstRedSha: red.headSha });
    expect(second.decision.reason).not.toBe('flake-rerun-pending');
    expect(JSON.parse(readFileSync(io.ledgerPathIn(opts.dir)))._reruns['2'].rounds).toBe(1);
  }));
  it.each([
    { conclusion: 'skipped' }, { conclusion: 'failure', infraOnly: true },
    { conclusion: 'timed_out', infraOnly: true },
  ])('retries only an inconclusive verdict once: %j', async (finished) => fixture(async (opts) => {
    await io.probeAndOwnMainCi(opts);
    const out = await io.probeAndOwnMainCi({ ...opts,
      readRuns: () => ({ runs: [{ ...green }, { ...red, attempt: 2, ...finished }] }),
    });
    expect(out.rerun).toMatchObject({ reason: 'inconclusive-rerun', status: 'issued' });
    expect(opts.rerun).toHaveBeenCalledTimes(2);
  }));
  it('records a failed issue once without retrying', async () => fixture(async (opts) => {
    opts.rerun.mockRejectedValue(new Error('offline\nmore'));
    expect((await io.probeAndOwnMainCi(opts)).rerun.status).toBe('failed');
    expect(JSON.parse(readFileSync(io.ledgerPathIn(opts.dir)))._reruns['2'].error).toBe('offline');
    await io.probeAndOwnMainCi(opts);
    expect(opts.rerun).toHaveBeenCalledTimes(1);
  }));
  it('reruns the cancelled tip without marking it as a red rerun', async () => fixture(async (opts) => {
    const first = await io.probeAndOwnMainCi({ ...opts, readRuns: () => ({ runs: [green, red, tip], failing: { flake } }) });
    expect(first.rerun).toMatchObject({ runId: 3, kind: 'cancelled-tip', status: 'issued' });
    const second = await io.probeAndOwnMainCi({ ...opts, readRuns: () => ({ runs: [green, red, { ...tip, status: 'in_progress' }], failing: { flake } }) });
    expect(second.runs.find((r) => r.databaseId === 3).rerunPending).not.toBe(true);
    expect(second.mainRed).toMatchObject({ red: true, firstRedSha: red.headSha });
    expect(second.decision.reason).toBe('flake-rerun-pending');
    expect(opts.dispatch).not.toHaveBeenCalled();
    expect(opts.rerun).toHaveBeenCalledTimes(1);
  }));
  it('keeps the hold when a flake rerun finishes inconclusive, and never lifts it on an older green', async () => fixture(async (opts) => {
    await io.probeAndOwnMainCi(opts); // reserves + issues the flake rerun of run 2
    exhaustRerunRounds(opts.dir); // no retry left, so the inconclusive outcome stands
    const publish = opts.publishState;
    for (const finished of [
      { conclusion: 'cancelled' }, { conclusion: 'skipped' }, { conclusion: 'failure', infraOnly: true },
    ]) {
      publish.mockClear();
      const out = await io.probeAndOwnMainCi({ ...opts, readRuns: () => ({ runs: [green, { ...red, status: 'completed', attempt: 2, ...finished }] }) });
      expect(out.mainRed, JSON.stringify(finished)).toMatchObject({ red: true, firstRedSha: red.headSha });
      expect(out.decision.reason, JSON.stringify(finished)).not.toBe('main-green');
      expect(publish).not.toHaveBeenCalledWith(null);
      // the rerun finished, so repair ownership is no longer suppressed
      expect(out.decision.reason, JSON.stringify(finished)).not.toBe('flake-rerun-pending');
    }
    // a later success on a newer commit still lifts the hold
    const next = { ...green, databaseId: 9, headSha: 'beef01234567890', createdAt: '2026-10-14T05:00:00Z' };
    const lifted = await io.probeAndOwnMainCi({ ...opts, readRuns: () => ({ runs: [green, { ...red, status: 'completed', attempt: 2, conclusion: 'cancelled' }, next] }) });
    expect(lifted.decision.reason).toBe('main-green');
    // only runs the IO layer flagged (flake reruns) are held red; a plain cancelled run still proves nothing
    expect(core.classifyRun({ ...tip, rerunInconclusive: true })).toBe('red');
    expect(core.classifyRun(tip)).toBe('ignore');
  }));
  it('retries an inconclusive flake rerun once, then leaves the hold to the owner', async () => fixture(async (opts) => {
    await io.probeAndOwnMainCi(opts);
    const cancelled = { ...red, status: 'completed', attempt: 2, conclusion: 'cancelled' };
    const again = await io.probeAndOwnMainCi({ ...opts, readRuns: () => ({ runs: [green, cancelled] }) });
    expect(again.rerun).toMatchObject({ runId: 2, kind: 'flake', reason: 'inconclusive-rerun', status: 'issued' });
    expect(opts.rerun).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(io.ledgerPathIn(opts.dir)))._reruns['2']).toMatchObject({ status: 'issued', rounds: 2 });
    expect(again.mainRed).toMatchObject({ red: true, firstRedSha: red.headSha });
    expect(again.decision.reason).toBe('flake-rerun-pending');
    const spent = await io.probeAndOwnMainCi({ ...opts, readRuns: () => ({ runs: [green, { ...cancelled, attempt: 3 }] }) });
    expect(spent.rerun).toBeUndefined();
    expect(opts.rerun).toHaveBeenCalledTimes(2);
    expect(spent.mainRed).toMatchObject({ red: true, firstRedSha: red.headSha });
  }));
  it('keeps the hold for a manual re-run that no ledger entry knows (missing, unreadable or pruned ledger)', async () => fixture(async (opts) => {
    // built from plain fields: earlier tests' probes flag the shared `red` fixture in place, which would hide a missing derivation
    const first = { databaseId: red.databaseId, headSha: red.headSha, createdAt: red.createdAt, status: 'completed', conclusion: 'failure', attempt: 1 };
    const manual = { ...first, attempt: 2 };
    const settled = (conclusion, extra = {}) => ({ runs: [green, { ...manual, status: 'completed', conclusion, ...extra }] });
    for (const readRuns of [() => settled('cancelled'), () => settled('skipped'), () => settled('failure', { infraOnly: true }), () => ({ runs: [green, { ...manual, status: 'in_progress' }] })]) {
      opts.publishState.mockClear();
      const out = await io.probeAndOwnMainCi({ ...opts, dryRun: true, readRuns });
      expect(out.mainRed).toMatchObject({ red: true, firstRedSha: red.headSha });
      expect(out.decision.reason).not.toBe('main-green');
    }
    writeFileSync(io.ledgerPathIn(opts.dir), '{ not json');
    const corrupt = await io.probeAndOwnMainCi({ ...opts, readRuns: () => settled('cancelled') });
    expect(corrupt.mainRed).toMatchObject({ red: true, firstRedSha: red.headSha });
    expect(opts.publishState).not.toHaveBeenCalledWith(null);
    // an ordinary first-attempt cancelled run, and a manual re-run that passed, still prove what they always did
    expect((await io.probeAndOwnMainCi({ ...opts, dryRun: true, readRuns: () => ({ runs: [green, { ...first, conclusion: 'cancelled' }] }) })).decision.reason).toBe('main-green');
    expect((await io.probeAndOwnMainCi({ ...opts, dryRun: true, readRuns: () => ({ runs: [green, { ...manual, conclusion: 'success' }] }) })).decision.reason).toBe('main-green');
  }));
  it('prunes only old reruns on green', async () => fixture(async (opts) => {
    writeFileSync(io.ledgerPathIn(opts.dir), JSON.stringify({ _reruns: { old: { at: 0 }, recent: { at: opts.now } } }));
    await io.probeAndOwnMainCi({ ...opts, readRuns: () => ({ runs: [green] }) });
    expect(JSON.parse(readFileSync(io.ledgerPathIn(opts.dir)))._reruns).toEqual({ recent: { at: opts.now } });
  }));
  it('uses raw logs, guarded compare JSON and failed-job rerun argv', () => {
    const exec = vi.fn(() => log);
    expect(io.readJobLog(42, { exec, repoSlug: 'o/r' })).toBe(log);
    expect(exec.mock.calls[0][1]).toEqual(['api', 'repos/o/r/actions/jobs/42/logs']);
    exec.mockReturnValue('["backlog/a.md"]');
    expect(io.readChangedFiles(green.headSha, red.headSha, { exec, repoSlug: 'o/r' })).toEqual(['backlog/a.md']);
    expect(() => io.readChangedFiles('bad', red.headSha, { exec })).toThrow();
    io.rerunMainRun(2, { exec, repoSlug: 'o/r' });
    expect(exec.mock.lastCall[1]).toEqual(['run', 'rerun', '2', '--failed', '--repo', 'o/r']);
  });
  it('refuses deferred reads and requests', () => {
    const exec = () => JSON.stringify({ outcome: 'deferred-low-budget' });
    expect(() => io.readJobLog(42, { exec })).toThrow(/deferred/);
    expect(() => io.readChangedFiles(green.headSha, red.headSha, { exec })).toThrow(/deferred/);
    expect(() => io.rerunMainRun(2, { exec })).toThrow(/deferred/);
    expect(io.readOpenPrsForOwner({ exec: (bin, argv) => {
      expect(argv.at(-1).split(',')).toContain('labels');
      return '[]';
    } })).toEqual([]);
  });
  it('keeps the runs probe when logs and compare cannot be read', () => {
    const exec = (bin, argv) => {
      if (argv[0] === 'run') return JSON.stringify([red, green]);
      if (argv[1].includes('/jobs?')) return JSON.stringify({ total_count: 1, jobs: [{ id: 42, name: 'integration', conclusion: 'failure' }] });
      throw new Error('unreadable evidence');
    };
    expect(io.probeMainCiRuns({ exec, settings }).failing).toMatchObject({ failures: null, changedFiles: null,
      prevRunGreen: true, flake: { eligible: false, reason: 'not-flaky' } });
  });
  it('probes non-summary logs, previous green, and compares only when needed', () => {
    const calls = [];
    let raw = log;
    const exec = (bin, argv) => {
      calls.push(argv);
      if (argv[0] === 'run') { expect(argv.at(-1)).toContain('attempt'); return JSON.stringify([red, green]); }
      if (argv[1].includes('/jobs?')) return JSON.stringify({ total_count: 2, jobs: [{ id: 42, name: 'integration', conclusion: 'failure' }, { id: 43, name: 'test', conclusion: 'failure' }] });
      if (argv[1].endsWith('/logs')) { expect(argv[1]).toContain('/42/'); return raw; }
      if (argv[1].includes('/annotations')) return '[]';
      if (argv[1].includes('/compare/')) return '["backlog/a.md"]';
      throw new Error('no tip');
    };
    const probe = () => io.probeMainCiRuns({ exec, repoSlug: 'o/r', settings });
    expect(probe().failing).toMatchObject({ failures: [failure], prevRunGreen: true, flake: { eligible: true, reason: 'flaky-signature' } });
    expect(calls.some((argv) => argv[1]?.includes('/compare/'))).toBe(false);
    raw = 'no failures';
    expect(probe().failing).toMatchObject({ changedFiles: ['backlog/a.md'], flake: { reason: 'unrelated-change' } });
  });
});

describe('declared red-main repair owners', () => {
  const firstRed = { sha: red.headSha, createdAt: red.createdAt };
  const pr = (number, extra = {}) => ({ number, title: 'repair A3', state: 'OPEN', createdAt: tip.createdAt, author: { login: 'app/web-everything' }, headRefName: 'lane/fix-a3-sim-flake', ...extra });
  const owners = (prs, overrides = {}) => core.findOwnerPrs({ firstRed, prs, settings: { ...settings, ...overrides } }).map((p) => p.number);
  it('recognises labels with trust and date guards and an off setting', () => {
    const labelled = pr(5270, { labels: [{ name: 'RED-MAIN-REPAIR' }] });
    expect(owners([labelled])).toEqual([5270]);
    expect(owners([labelled], { mainCiRedOwnerLabels: [] })).toEqual([]);
    expect(owners([{ ...labelled, author: { login: 'stranger' } }])).toEqual([]);
    expect(owners([{ ...labelled, createdAt: green.createdAt }])).toEqual([]);
  });
  it('requires the current sha or an existing-rule owner PR and preserves old ordering', () => {
    const marked = pr(5270, { body: '<!-- red-main-repair: supersedes lane/main-fix-62da75ed3 -->' });
    expect(owners([marked])).toEqual([5270]);
    expect(owners([{ ...marked, body: 'red-main-repair: supersedes abcdef012' }])).toEqual([]);
    expect(owners([{ ...marked, body: 'RED-MAIN-REPAIR: supersedes 62DA75ED3' }])).toEqual([5270]);
    expect(owners([marked], { mainCiRedOwnerSupersedeMarker: false })).toEqual([]);
    const old = pr(5269, { headRefName: 'lane/main-fix-62da75ed3' });
    expect(owners([pr(5270, { body: 'red-main-repair: supersedes #5269' }), old])).toEqual([5269, 5270]);
    expect(owners([pr(5270, { body: 'red-main-repair: supersedes #9999' })])).toEqual([]);
    expect(owners([old, { ...old, labels: [{ name: 'red-main-repair' }] }])).toEqual([5269]);
  });
  it('recognises complete declaration lines and paired comment wrappers', () => {
    const marker = 'red-main-repair: supersedes lane/main-fix-62da75ed3';
    for (const body of [marker, `  ${marker}  `, `<!-- ${marker} -->`, `<!-- ${marker} --!>`,
      `prose\r\n\t<!-- ${marker} -->\r\nmore prose`, `<!--\n${marker}\n-->`]) {
      expect(owners([pr(5270, { body })]), body).toEqual([5270]);
    }
    const old = pr(5269, { headRefName: 'lane/main-fix-62da75ed3' });
    expect(owners([old, pr(5270, { body: '<!-- red-main-repair: supersedes #5269 --!>' })])).toEqual([5269, 5270]);
  });
  it('does not assemble declarations by deleting embedded or unpaired comment delimiters', () => {
    const marker = 'red-main-repair: supersedes 62da75ed3';
    for (const body of [`red-main-<!--repair: supersedes 62da75ed3`,
      `red-main-repair: super-->sedes 62da75ed3`, `red-main-repair: supersedes 62da<!--75ed3`,
      `<!-- ${marker}`, `${marker} -->`, `${marker} --!>`, `<!-- <!-- ${marker} --> -->`,
      `prefix <!-- ${marker} -->`, `<!-- ${marker} --> suffix`,
      `<!-- ${marker} --!> suffix`, `<script>${marker}</script>`]) {
      expect(owners([pr(5270, { body })]), body).toEqual([]);
    }
  });
});
