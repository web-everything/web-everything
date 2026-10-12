import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestCheckVerdicts, tipRequiredVerdict, mainRedState, runsAsOf } from '../main-ci-red-core.mjs';
import { readMainTip, probeMainCiRuns, probeAndOwnMainCi, ledgerPathIn } from '../main-ci-red-io.mjs';
import smell from '../health-smells/main-ci-red.mjs';
import { runSafetyNet, resolveQuarantineSettings } from '../../lib/red-main-quarantine-io.mjs';

const RED_SHA = 'c12db238f029cfe03b3dd79f03f2286b78c4120a';
const TIP_SHA = 'b5e21364240ec2b10a3987115a9f2fa893e8e974';
const at = (time) => Date.parse(`2026-10-11T${time}Z`);
const requiredChecks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
const runs = [
  { headSha: RED_SHA, databaseId: 38166405992, status: 'completed', conclusion: 'failure', createdAt: '2026-10-11T19:03:32Z', updatedAt: '2026-10-11T19:15:15Z' },
  { headSha: TIP_SHA, databaseId: 38166433535, status: 'completed', conclusion: 'success', createdAt: '2026-10-11T19:03:53Z', updatedAt: '2026-10-11T19:27:10Z' },
];
const check = (name, conclusion = 'success', id = 1) => ({ name, status: 'completed', conclusion, id });
const redCheckRuns = ['smoke', 'integration', ...[1, 2, 3, 4, 5].map((n) => `test-shard (${n})`),
  ...[1, 2, 3, 4].map((n) => `soak-shard (${n})`), 'test', 'daemon-soak']
  .map((name, id) => check(name, ['test-shard (3)', 'test'].includes(name) ? 'failure' : 'success', id));
// Completion times observed in the incident; checks without a supplied time stay pending until the run ends.
const completions = [
  ['smoke', '19:18:14'], ['test-shard (5)', '19:18:59'], ['test-shard (1)', '19:22:37'],
  ['test-shard (4)', '19:22:46'], ['test-shard (2)', '19:23:56'], ['test-shard (3)', '19:24:11'],
  ['soak-shard (4)', '19:24:34'], ['test', '19:25:41'], ['daemon-soak', '19:27:10'],
  ['integration', '19:27:10'], ...[1, 2, 3].map((n) => [`soak-shard (${n})`, '19:27:10']),
];
function replay(time = '19:24:34') {
  const snapshot = runsAsOf(runs, at(time));
  return { runs: snapshot, tip: { sha: TIP_SHA, runStatus: snapshot.find((r) => r.headSha === TIP_SHA).status,
    requiredChecks, redCheckRuns, checkRuns: completions.map(([name, done], id) => at(done) <= at(time)
      ? check(name, 'success', id) : { name, id, status: 'in_progress', conclusion: null }) } };
}

describe('main CI truth follows the tip (2026-10-11 incident)', () => {
  it('replays the old false red without tip facts', () => {
    expect(mainRedState(replay().runs)).toMatchObject({ status: 'red', firstRed: { sha: RED_SHA } });
  });
  it('lifts the hold once the tip passes the older red cause, before summaries finish', () => {
    const { runs, tip } = replay();
    expect(mainRedState(runs, { tip })).toEqual({ status: 'pending', reason: 'red-causes-passed-on-tip',
      tipSha: TIP_SHA, clearedRedSha: RED_SHA, causes: ['test-shard (3)'] });
  });
  it('keeps red while the cause is owed or has failed again', () => {
    const early = replay('19:20:00');
    expect(mainRedState(early.runs, { tip: early.tip })).toEqual(mainRedState(early.runs));
    const { runs, tip } = replay();
    tip.checkRuns.push(check('test-shard (3)', 'failure', 100));
    expect(mainRedState(runs, { tip }).status).toBe('red');
  });
  it('keeps red when an unrelated, non-required check has already failed on the tip', () => {
    const { runs, tip } = replay();
    expect(tipRequiredVerdict(tip)).toBe('pending');
    tip.checkRuns = tip.checkRuns.map((c) => (c.name === 'test-shard (2)' ? check('test-shard (2)', 'failure', 200) : c));
    expect(tip.checkRuns.find((c) => c.name === 'test-shard (2)').conclusion).toBe('failure');
    expect(tipRequiredVerdict(tip)).toBe('pending'); // the summary job is still running, so the tip is not required-red
    expect(mainRedState(runs, { tip })).toEqual(mainRedState(runs));
    expect(mainRedState(runs, { tip }).status).toBe('red');
    // A later passing rerun of that same shard lifts the hold again.
    tip.checkRuns.push(check('test-shard (2)', 'success', 300));
    expect(mainRedState(runs, { tip }).status).toBe('pending');
  });
  it('clears after completion despite the absent PR-only required check', () => {
    const { runs, tip } = replay('19:27:10');
    expect(mainRedState(runs, { tip })).toEqual({ status: 'green', via: 'tip-required-checks',
      latestGreen: { sha: TIP_SHA, runId: null, createdAt: null, updatedAt: null } });
  });
  it('preserves red for a failed required check or no present required checks', () => {
    const { runs, tip } = replay();
    tip.runStatus = 'completed';
    tip.checkRuns.push(check('smoke', 'failure', 100));
    expect(tipRequiredVerdict(tip)).toBe('red');
    expect(mainRedState(runs, { tip })).toEqual(mainRedState(runs));
    expect(mainRedState(runs, { tip: { ...tip, runStatus: 'in_progress', checkRuns: [] } })).toEqual(mainRedState(runs));
  });
  it('uses the highest check id for a same-sha rerun, regardless of list order', () => {
    const tip = { sha: RED_SHA, runStatus: 'completed', requiredChecks, checkRuns: [
      check('test', 'success', 2), check('test', 'failure', 1),
      check('test-shard (3)', 'failure', 1), check('test-shard (3)', 'success', 2),
    ] };
    expect(mainRedState(replay().runs, { tip })).toMatchObject({ status: 'green', via: 'tip-required-checks' });
    // gh run list reports the latest attempt of the same run.
    expect(mainRedState([{ ...runs[0], conclusion: 'success' }])).toMatchObject({ status: 'green', latestGreen: { sha: RED_SHA } });
  });
  it('leaves malformed tip facts equivalent to no tip', () => {
    const { runs, tip } = replay();
    for (const bad of [null, {}, { ...tip, sha: '' }, { ...tip, checkRuns: undefined }, { ...tip, requiredChecks: [] }]) {
      expect(tipRequiredVerdict(bad)).toBe('unknown');
      expect(mainRedState(runs, { tip: bad })).toEqual(mainRedState(runs));
    }
  });
  it('classifies checks and requires all required checks while still running', () => {
    expect([...latestCheckVerdicts([check('a'), check('b', 'timed_out'), check('c', 'startup_failure'),
      check('d', 'skipped'), check('e', 'cancelled'), check('f', 'neutral'), { name: 'g', status: 'queued' }]).values()])
      .toEqual(['green', 'red', 'red', 'other', 'other', 'other', 'pending']);
    const tip = { sha: TIP_SHA, runStatus: 'in_progress', requiredChecks: ['test', 'smoke'], checkRuns: [check('test')] };
    expect(tipRequiredVerdict(tip)).toBe('pending');
    tip.checkRuns.push(check('smoke'));
    expect(tipRequiredVerdict(tip)).toBe('green');
  });
  it('falls back to summary causes only when no underlying red cause exists', () => {
    const { runs, tip } = replay();
    tip.redCheckRuns = [check('test', 'failure')];
    expect(mainRedState(runs, { tip }).status).toBe('red');
    tip.checkRuns.push(check('test', 'success', 100));
    expect(mainRedState(runs, { tip })).toMatchObject({ status: 'pending', causes: ['test'] });
    tip.redCheckRuns = [];
    expect(mainRedState(runs, { tip }).status).toBe('red');
  });
  it('clears publication without ending the red owner window or dispatching', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'main-ci-red-tip-'));
    try {
      const ledger = { [RED_SHA]: { at: at('19:20:00'), sessionSlug: 'existing-owner' } };
      writeFileSync(ledgerPathIn(dir), JSON.stringify(ledger));
      const states = [], priorities = [];
      const result = await probeAndOwnMainCi({ dir, now: at('19:24:34'), readRuns: () => replay(),
        readPrs: () => [], listAgents: async () => [], gates: async () => ({ killed: false, fixGate: null }),
        dispatch: () => { throw new Error('must not dispatch'); },
        publishState: (state) => states.push(state), publishPriority: (priority) => priorities.push(priority) });
      expect(result.decision).toEqual({ owed: false, reason: 'main-tip-red-causes-passed' });
      expect(states).toEqual([null]);
      expect(priorities).toEqual([null]);
      const saved = JSON.parse(readFileSync(ledgerPathIn(dir), 'utf8'));
      expect(saved).toEqual(ledger);
      expect(saved).not.toHaveProperty('_greenSeenAt');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('best-effort tip IO', () => {
  it('builds the tip from GitHub facts and reads the required set through injection', () => {
    const { runs, tip } = replay();
    const exec = (bin, argv) => {
      expect(bin).toBe('gh');
      if (argv[1] === 'repos/example/repo/commits/main') {
        expect(argv.slice(2)).toEqual(['--jq', '.sha']);
        return `${TIP_SHA}\n`;
      }
      if (argv[1] === `repos/example/repo/commits/${TIP_SHA}/check-runs?per_page=100`) return JSON.stringify({ check_runs: tip.checkRuns });
      if (argv[1] === `repos/example/repo/commits/${RED_SHA}/check-runs?per_page=100`) return JSON.stringify({ check_runs: redCheckRuns });
      throw new Error(`unexpected read: ${argv}`);
    };
    expect(readMainTip({ exec, repoSlug: 'example/repo', runs, readRequired: (o) => {
      expect(o).toEqual({ repo: 'example/repo' });
      return { checks: requiredChecks };
    } })).toEqual(tip);
  });
  it('returns null on any failed tip read and preserves the runs probe', () => {
    const fail = () => { throw new Error('offline'); };
    expect(readMainTip({ exec: fail })).toBeNull();
    expect(readMainTip({ exec: () => TIP_SHA, readRequired: fail })).toBeNull();
    expect(readMainTip({ exec: (bin, argv) => argv.includes('--jq') ? TIP_SHA : 'null', requiredChecks })).toBeNull();
    const snapshot = replay().runs;
    const probe = probeMainCiRuns({ exec: (bin, argv) => argv[0] === 'run' ? JSON.stringify(snapshot) : fail(), readRequired: fail });
    expect(probe.runs).toEqual([...snapshot].reverse());
    expect(probe).not.toHaveProperty('tip');
  });
});

describe('tip facts reach the smell and the quarantine safety net', () => {
  const failing = { jobs: ['test-shard (3)', 'test'], tests: [], runId: 38166405992 };
  const evaluate = (mainCiRuns) => smell.evaluate({ mainCiRuns }, { now: at('19:24:34'), config: {}, quarantineSafetyNet: () => null });
  it('the smell reports the red without tip facts and stays quiet once the causes passed on the tip', () => {
    const { runs, tip } = replay();
    expect(evaluate({ runs, failing })).toHaveLength(1);
    expect(evaluate({ runs, failing, tip })).toEqual([]);
  });
  it('the safety net plans a quarantine without tip facts and does nothing once the causes passed on the tip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'main-ci-red-tip-net-'));
    try {
      const { runs, tip } = replay();
      const net = (mainCiRuns, sub) => {
        const calls = { jobs: 0, logs: 0, writes: 0 };
        const r = runSafetyNet({ dir: join(dir, sub), settings: resolveQuarantineSettings({ env: {}, file: '/nonexistent', platform: null }),
          mode: { value: 'stop', source: 'settings' }, live: false, now: at('19:24:34'), mainCiRuns,
          readJobs: () => { calls.jobs += 1; return { failed: [] }; }, readLog: () => { calls.logs += 1; return { complete: false }; },
          readList: () => ({ ok: true, list: { version: 1, entries: [] } }), write: () => { calls.writes += 1; return { events: [] }; }, log: () => {} });
        return { r, calls };
      };
      const without = net({ runs, failing }, 'a');
      expect(without.calls.jobs).toBe(1); // a red window reads the failing job's log
      const withTip = net({ runs, failing, tip }, 'b');
      expect(withTip.calls).toEqual({ jobs: 0, logs: 0, writes: 0 });
      expect(withTip.r.plan?.action ?? 'none').toBe('none');
      expect(withTip.r.plan?.firstRedSha ?? null).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
