import { describe, expect, it } from 'vitest';
import {
  CHECK_STATE_TABLE,
  classifyCheck,
  latestAttempts,
  summarize,
} from '../check-state-predicate.mjs';

// Independent oracle: expectations never come from CHECK_STATE_TABLE.
const completedOutcomes = {
  success: 'green',
  failure: 'red',
  cancelled: 'pending', // A re-run is expected; cancellation cannot pass admission.
  timed_out: 'red',
  action_required: 'red',
  neutral: 'green',
  skipped: 'green',
  stale: 'pending', // A re-run is expected here too.
  startup_failure: 'red',
  null: 'red',
};
const statuses = ['queued', 'in_progress', 'waiting', 'requested', 'pending', 'completed'];
const conclusions = [
  'success', 'failure', 'cancelled', 'timed_out', 'action_required',
  'neutral', 'skipped', 'stale', 'startup_failure', null,
];
const expectedByStatus = {
  queued: 'pending',
  in_progress: 'pending',
  waiting: 'pending',
  requested: 'pending',
  pending: 'pending',
  completed: completedOutcomes,
};
const settled = (name, conclusion, extra = {}) => ({
  name, status: 'completed', conclusion, ...extra,
});

describe('CHECK_STATE_TABLE', () => {
  it('exports a frozen table', () => {
    expect(CHECK_STATE_TABLE).toBeTypeOf('object');
    expect(CHECK_STATE_TABLE).not.toBeNull();
    expect(Object.isFrozen(CHECK_STATE_TABLE)).toBe(true);
  });
});

describe('classifyCheck exhaustive independent outcome grid', () => {
  for (const required of [true, false]) {
    for (const status of statuses) {
      for (const conclusion of conclusions) {
        const requiredOutcome = status === 'completed'
          ? expectedByStatus.completed[String(conclusion)]
          : expectedByStatus[status];
        const expected = required || requiredOutcome === 'green' ? requiredOutcome : 'ignore';
        it(`status=${status}, conclusion=${conclusion}, required=${required} => ${expected} (REST and GraphQL)`, () => {
          for (const uppercase of [false, true]) {
            expect(classifyCheck({
              name: 'ci', required,
              status: uppercase ? status.toUpperCase() : status,
              conclusion: uppercase && conclusion !== null ? conclusion.toUpperCase() : conclusion,
            })).toBe(expected);
          }
        });
      }
    }
  }

  it.each([
    { status: 'unknown_status', conclusion: 'success' },
    { status: 'completed', conclusion: 'unknown_conclusion' },
    { status: 'unknown_status', conclusion: 'unknown_conclusion' },
    { status: 'completed', conclusion: '' },
    { status: 'completed', conclusion: undefined },
    {},
  ])('fails closed on unknown or unreadable evidence: %j', (evidence) => {
    expect(classifyCheck({ name: 'ci', ...evidence, required: true })).toBe('red');
    expect(classifyCheck({ name: 'ci', ...evidence, required: false })).toBe('ignore');
  });

  it('defaults an omitted or undefined required flag to required', () => {
    for (const requiredFlag of [{}, { required: undefined }]) {
      expect(classifyCheck({ ...settled('ci', 'failure'), ...requiredFlag })).toBe('red');
      expect(classifyCheck({ name: 'ci', status: 'queued', ...requiredFlag })).toBe('pending');
      expect(classifyCheck({ ...settled('ci', 'success'), ...requiredFlag })).toBe('green');
    }
  });

  it.each(conclusions.filter((conclusion) => conclusion !== null))(
    'treats missing status with conclusion=%s as completed',
    (conclusion) => {
      for (const statusFlag of [{}, { status: undefined }, { status: null }]) {
        expect(classifyCheck({ name: 'ci', conclusion, ...statusFlag }))
          .toBe(completedOutcomes[conclusion]);
      }
    },
  );
});

describe('inherited check-state keys', () => {
  it.each(['constructor', 'toString', '__proto__'])('classifies inherited status/conclusion %s as red', key => {
    expect(classifyCheck({ status: key })).toBe('red');
    expect(classifyCheck({ status: 'COMPLETED', conclusion: key })).toBe('red');
  });
});

describe('latestAttempts', () => {
  it.each([undefined, 'invalid', '2026-10-29T02:00:00Z'])(
    'uses global check ids across runs when completion times are missing, invalid or equal (%s)', timestamp => {
      const rerun = settled('ci', 'failure', { run_id: 100, run_attempt: 2, id: 300, completedAt: timestamp });
      const newerRun = settled('ci', 'success', { run_id: 200, run_attempt: 1, id: 200, completedAt: timestamp });
      for (const rows of [[rerun, newerRun], [newerRun, rerun]]) expect(latestAttempts(rows)).toEqual([rerun]);
    },
  );

  it('compares completion times across same-run attempts and other runs in every input order', () => {
    const oldAttempt = settled('ci', 'success', { run_id: 100, run_attempt: 1, id: 100, completedAt: '2026-10-29T04:00:00Z' });
    const rerun = settled('ci', 'failure', { run_id: 100, run_attempt: 2, id: 300, completedAt: '2026-10-29T03:00:00Z' });
    const newerRun = settled('ci', 'success', { run_id: 200, run_attempt: 1, id: 200, completedAt: '2026-10-29T02:00:00Z' });
    for (const rows of [
      [oldAttempt, rerun, newerRun], [oldAttempt, newerRun, rerun],
      [rerun, oldAttempt, newerRun], [rerun, newerRun, oldAttempt],
      [newerRun, oldAttempt, rerun], [newerRun, rerun, oldAttempt],
    ]) expect(latestAttempts(rows)).toEqual([oldAttempt]);
  });

  it.each(['completedAt', 'completed_at'])('uses %s across runs so a later rerun of an older run wins', timeField => {
    const rerun = settled('ci', 'failure', { run_id: 100, run_attempt: 2, id: 300,
      [timeField]: '2026-10-29T03:00:00Z' });
    const newerRun = settled('ci', 'success', { run_id: 200, run_attempt: 1, id: 200,
      [timeField]: '2026-10-29T02:00:00Z' });
    for (const rows of [[rerun, newerRun], [newerRun, rerun]]) {
      expect(latestAttempts(rows)).toEqual([rerun]);
      expect(summarize(rows).redSet).toEqual(new Set(['ci']));
    }
  });

  it('ignores large run_attempt integers and uses check-run id in either order', () => {
    const older = settled('ci', 'success', { run_attempt: '9007199254740992', id: 999 });
    const newer = settled('ci', 'failure', { run_attempt: '9007199254740993', id: 1 });
    for (const runs of [[older, newer], [newer, older]]) {
      expect(latestAttempts(runs)).toEqual([older]);
    }
  });

  it('never mutates its input rows or array', () => {
    const rows = Object.freeze([Object.freeze({ name: 'ci', id: 1 }), Object.freeze({ name: 'ci', id: 2 })]);
    expect(latestAttempts(rows)[0]).toBe(rows[1]);
  });

  it('compares equal-time check-run ids exactly above Number.MAX_SAFE_INTEGER in either order', () => {
    const older = settled('ci', 'success', { completed_at: '2026-10-28T13:00:00-04:00', id: '9007199254740992' });
    const newer = settled('ci', 'failure', { completedAt: '2026-10-28T13:00:00-04:00', id: '9007199254740993' });
    for (const runs of [[older, newer], [newer, older]]) {
      expect(latestAttempts(runs)).toEqual([newer]);
    }
  });

  it('compares canonical string and number ranks equally and retains the first exact tie', () => {
    const first = settled('ci', 'failure', { run_attempt: 2, id: 9007199254740992 });
    const second = settled('ci', 'success', { run_attempt: '2', id: '9007199254740992' });
    expect(latestAttempts([first, second])).toEqual([first]);
    expect(latestAttempts([second, first])).toEqual([second]);
  });

  it.each([
    undefined, null, '', 'garbage', '01', ' 2', '2 ', '2\n', '+2', '-2',
    '2.5', '2.0', '2e3', '0x10', 'Infinity', 'NaN', -2, 2.5, Infinity, NaN,
    true, {}, [],
  ])('treats noncanonical or missing ranking evidence %j as zero for both fields', (value) => {
    for (const field of ['run_attempt', 'id']) {
      const invalid = settled('ci', 'success', { [field]: value });
      const zero = settled('ci', 'failure', { [field]: '0' });
      expect(latestAttempts([zero, invalid])).toEqual([zero]);
      expect(latestAttempts([invalid, zero])).toEqual([invalid]);
    }
  });

  it('selects effective time, then numeric check-run id, per name in either input order', () => {
    const winner = settled('ci', 'failure', { run_attempt: '10', id: '10', completedAt: '2026-10-28T13:00:00-04:00' });
    const smoke = settled('smoke', 'success', { run_attempt: 1, id: 1 });
    const runs = [
      settled('ci', 'success', { run_attempt: '2', id: '999', completedAt: '2026-10-28T12:00:00-04:00' }),
      settled('ci', 'success', { run_attempt: '10', id: '2', completedAt: '2026-10-28T13:00:00-04:00' }),
      winner, smoke,
    ];
    for (const input of [runs, [...runs].reverse()]) {
      const result = latestAttempts(input);
      expect(result).toHaveLength(2);
      expect(result).toEqual(expect.arrayContaining([winner, smoke]));
    }
  });

  it('ignores run_attempt and counts missing check-run id as zero', () => {
    const missing = settled('ci', 'success');
    const byId = settled('ci', 'failure', { id: 1 });
    const byAttempt = settled('ci', 'neutral', { run_attempt: 1 });
    for (const pair of [[missing, byId], [byId, missing]]) {
      expect(latestAttempts(pair)).toEqual([byId]);
    }
    for (const pair of [[byId, byAttempt], [byAttempt, byId]]) {
      expect(latestAttempts(pair)).toEqual([byId]);
    }
    expect(latestAttempts([missing])).toEqual([missing]);
    expect(latestAttempts([])).toEqual([]);
  });

  it('timestamps outrank check-run ids', () => {
    const older = settled('ci', 'success', {
      run_attempt: 1, id: 2,
      startedAt: '2026-10-28T12:00:00Z', completedAt: '2026-10-28T13:00:00Z',
    });
    const newer = settled('ci', 'failure', {
      run_attempt: 1, id: 10,
      startedAt: '2026-10-27T12:00:00Z', completedAt: '2026-10-27T13:00:00Z',
    });
    expect(latestAttempts([older, newer])).toEqual([older]);
    expect(latestAttempts([newer, older])).toEqual([older]);
  });
});

describe('named check-state regressions', () => {
  it('large adjacent ids cannot hide a newer failure in either row order', () => {
    const older = settled('ci', 'success', { run_attempt: 1, id: '9007199254740992' });
    const newer = settled('ci', 'failure', { run_attempt: 1, id: '9007199254740993' });
    for (const runs of [[older, newer], [newer, older]]) {
      const result = summarize(runs, { requiredNames: ['ci'] });
      expect(result.redSet).toEqual(new Set(['ci']));
      expect(result.allRequiredGreen).toBe(false);
    }
  });

  it('STALE is not omitted from the failed set', () => {
    const check = settled('ci', 'STALE');
    expect(classifyCheck(check)).toBe('pending');
    const result = summarize([check], { requiredNames: ['ci'] });
    expect(result.pendingSet).toEqual(new Set(['ci']));
    expect(result.allRequiredGreen).toBe(false);
  });

  it('mixed timestamp ranking cannot hide a newer FAILURE', () => {
    const older = settled('ci', 'SUCCESS', {
      run_attempt: 1, id: 999,
      startedAt: '2026-10-26T12:00:00Z', completedAt: '2026-10-26T13:00:00Z',
    });
    const newer = settled('ci', 'FAILURE', {
      run_attempt: 2, id: 1,
      startedAt: '2026-10-27T12:00:00Z', completedAt: '2026-10-27T13:00:00Z',
    });
    for (const runs of [[older, newer], [newer, older]]) {
      expect(latestAttempts(runs)).toEqual([newer]);
      expect(summarize(runs, { requiredNames: ['ci'] })).toEqual({
        redSet: new Set(['ci']), pendingSet: new Set(),
        gateOnlyRed: false, allRequiredGreen: false,
      });
    }
  });

  it('optional CANCELLED smoke', () => {
    const smoke = settled('smoke', 'CANCELLED');
    expect(classifyCheck({ ...smoke, required: false })).toBe('ignore');
    expect(summarize([settled('ci', 'success'), smoke], { requiredNames: ['ci'] })).toEqual({
      redSet: new Set(), pendingSet: new Set(),
      gateOnlyRed: false, allRequiredGreen: true,
    });
  });

  it('settled CANCELLED required smoke', () => {
    const smoke = settled('smoke', 'CANCELLED');
    expect(classifyCheck(smoke)).toBe('pending');
    expect(summarize([smoke], { requiredNames: ['smoke'] })).toEqual({
      redSet: new Set(), pendingSet: new Set(['smoke']),
      gateOnlyRed: false, allRequiredGreen: false,
    });
  });
});

describe('summarize required checks', () => {
  it('marks an explicitly required name with no row as pending', () => {
    expect(summarize([settled('ci', 'success')], { requiredNames: ['ci', 'missing'] })).toEqual({
      redSet: new Set(), pendingSet: new Set(['missing']),
      gateOnlyRed: false, allRequiredGreen: false,
    });
    expect(summarize([], { requiredNames: ['ci'] }).pendingSet).toEqual(new Set(['ci']));
  });

  it('requires every observed check when requiredNames is omitted', () => {
    expect(summarize([settled('ci', 'success'), settled('smoke', 'failure')], {})).toEqual({
      redSet: new Set(['smoke']), pendingSet: new Set(),
      gateOnlyRed: false, allRequiredGreen: false,
    });
    expect(summarize([settled('ci', 'success')], {}).allRequiredGreen).toBe(true);
  });

  it('ignores optional failed and pending checks when deciding allRequiredGreen', () => {
    expect(summarize([
      settled('ci', 'neutral'), settled('smoke', 'failure'),
      { name: 'optional-build', status: 'queued', conclusion: null },
    ], { requiredNames: ['ci'] })).toEqual({
      redSet: new Set(), pendingSet: new Set(),
      gateOnlyRed: false, allRequiredGreen: true,
    });
  });

  it('handles an explicitly empty required roster and empty input', () => {
    const empty = {
      redSet: new Set(), pendingSet: new Set(),
      gateOnlyRed: false, allRequiredGreen: true,
    };
    expect(summarize([settled('optional', 'failure')], { requiredNames: [] })).toEqual(empty);
    expect(summarize([], {})).toEqual(empty);
  });

  it('uses the latest green attempt to clear an older failure', () => {
    expect(summarize([
      settled('ci', 'failure', { run_attempt: 1, completed_at: '2026-10-28T12:00:00-04:00' }),
      settled('ci', 'success', { run_attempt: 2, completed_at: '2026-10-28T13:00:00-04:00' }),
    ], { requiredNames: ['ci'] })).toEqual({
      redSet: new Set(), pendingSet: new Set(),
      gateOnlyRed: false, allRequiredGreen: true,
    });
  });
});

describe('gate-only-red detection', () => {
  it.each([
    [['review-gate'], true],
    [['review-gate', 'merge-gate'], true],
    [['review-gate', 'ci'], false],
    [[], false],
  ])('red names %j => gateOnlyRed=%s', (names, expected) => {
    const result = summarize([
      ...names.map((name) => settled(name, 'failure')),
      settled('passing-check', 'success'),
    ], {});
    expect(result.redSet).toEqual(new Set(names));
    expect(result.gateOnlyRed).toBe(expected);
    expect(result.allRequiredGreen).toBe(names.length === 0);
  });

  it('honors custom holdGateNames instead of the default gates', () => {
    const options = { holdGateNames: ['custom-gate'] };
    expect(summarize([settled('custom-gate', 'failure')], options).gateOnlyRed).toBe(true);
    expect(summarize([settled('review-gate', 'failure')], options).gateOnlyRed).toBe(false);
  });
});


describe('R216 effective-time attempt ranking', () => {
  const early = '2026-10-28T12:00:00-04:00';
  const late = '2026-10-28T13:00:00-04:00';

  it('invalid completion falls back to a newer pending start', () => {
    const success = settled('test', 'SUCCESS', { completedAt: early });
    const pending = { name: 'test', status: 'IN_PROGRESS', completedAt: 'invalid', startedAt: late };
    for (const rows of [[success, pending], [pending, success]]) {
      expect(latestAttempts(rows)).toEqual([pending]);
      expect(summarize(rows, { requiredNames: ['test'] })).toEqual({
        redSet: new Set(), pendingSet: new Set(['test']),
        gateOnlyRed: false, allRequiredGreen: false,
      });
    }
  });

  it.each([
    [{ completed_at: 'invalid' }, 'completedAt'],
    [{ completed_at: 'invalid' }, 'started_at'],
    [{ completedAt: 'invalid' }, 'startedAt'],
    [{ completed_at: 'invalid', completedAt: 'invalid', started_at: 'invalid' }, 'startedAt'],
    [{ completedAt: 'invalid', startedAt: 'invalid' }, 'created_at'],
    [{ completed_at: 'invalid', started_at: 'invalid' }, 'createdAt'],
    [{ completedAt: 'invalid', startedAt: 'invalid', created_at: 'invalid' }, 'createdAt'],
  ])('malformed higher-priority timestamps %j fall through to valid %s in both orders', (malformed, field) => {
    const success = settled('test', 'SUCCESS', { id: 999, completedAt: early });
    for (const fallback of ['2026-10-27T12:00:00Z', late]) {
      const pending = { name: 'test', status: 'IN_PROGRESS', id: 1, ...malformed, [field]: fallback };
      const winner = fallback === late ? pending : success;
      for (const rows of [[success, pending], [pending, success]]) {
        expect(latestAttempts(rows)).toEqual([winner]);
        expect(summarize(rows, { requiredNames: ['test'] })).toEqual({
          redSet: new Set(), pendingSet: new Set(winner === pending ? ['test'] : []),
          gateOnlyRed: false, allRequiredGreen: winner === success,
        });
      }
    }
  });

  it('an unfinished row with only malformed timestamps stays pending in both orders', () => {
    const success = settled('test', 'SUCCESS', { completedAt: early });
    const pending = { name: 'test', status: 'IN_PROGRESS',
      completedAt: 'invalid', startedAt: 'invalid', createdAt: 'invalid' };
    for (const rows of [[success, pending], [pending, success]]) {
      expect(latestAttempts(rows)).toEqual([pending]);
      expect(summarize(rows, { requiredNames: ['test'] })).toEqual({
        redSet: new Set(), pendingSet: new Set(['test']),
        gateOnlyRed: false, allRequiredGreen: false,
      });
    }
  });

  it.each(['0001-01-01T00:00:00Z', '1999-12-31T23:59:59Z', '1970-01-01T00:00:00Z', 0, '0'])(
    'zero/epoch-like completion %j falls back to start time or undated-newest in both orders', completed => {
      const success = settled('test', 'SUCCESS', { id: 999, completed_at: early });
      for (const field of ['completed_at', 'completedAt']) {
        for (const start of [{ started_at: late }, { startedAt: late }, {}]) {
          const pending = { name: 'test', status: 'IN_PROGRESS', id: 1, [field]: completed, ...start };
          for (const rows of [[success, pending], [pending, success]]) {
            expect(latestAttempts(rows)).toEqual([pending]);
            expect(summarize(rows, { requiredNames: ['test'] })).toEqual({
              redSet: new Set(), pendingSet: new Set(['test']),
              gateOnlyRed: false, allRequiredGreen: false,
            });
          }
        }
        const olderPending = { name: 'test', status: 'IN_PROGRESS', [field]: completed,
          startedAt: '2026-10-27T12:00:00Z' };
        for (const rows of [[success, olderPending], [olderPending, success]]) {
          expect(latestAttempts(rows)).toEqual([success]);
        }
      }
    },
  );

  it.each(['created_at', 'createdAt'])(
    '%s is the last timestamp fallback after completion and start time', field => {
      const older = settled('test', 'SUCCESS', { id: 999, [field]: early });
      const newer = settled('test', 'FAILURE', { id: 1, [field]: late });
      for (const rows of [[older, newer], [newer, older]]) {
        expect(latestAttempts(rows)).toEqual([newer]);
        expect(summarize(rows).redSet).toEqual(new Set(['test']));
      }
      for (const timestamp of ['completed_at', 'completedAt', 'started_at', 'startedAt']) {
        const earlier = settled('test', 'SUCCESS', { id: 999, [timestamp]: early, [field]: late });
        for (const rows of [[earlier, newer], [newer, earlier]]) {
          expect(latestAttempts(rows)).toEqual([newer]);
        }
      }
    },
  );

  it.each(['completed_at', 'completedAt', 'started_at', 'startedAt', 'created_at', 'createdAt'])(
    'zero dates in %s count as absent for unfinished and completed rows', field => {
      const dated = settled('test', 'FAILURE', { completedAt: early });
      for (const zero of ['0001-01-01T00:00:00Z', '1970-01-01T00:00:00Z', 0, '0']) {
        const pending = { name: 'test', status: 'IN_PROGRESS', [field]: zero };
        const completed = settled('test', 'SUCCESS', { id: 999, [field]: zero });
        for (const rows of [[dated, pending], [pending, dated]]) {
          expect(latestAttempts(rows)).toEqual([pending]);
          expect(summarize(rows).pendingSet).toEqual(new Set(['test']));
        }
        for (const rows of [[dated, completed], [completed, dated]]) {
          expect(latestAttempts(rows)).toEqual([dated]);
          expect(summarize(rows).redSet).toEqual(new Set(['test']));
        }
      }
    },
  );

  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending', 'QUEUED', 'IN_PROGRESS', 'PENDING'])(
    'an undated %s attempt ranks newest and keeps a required check pending', status => {
      const success = settled('test', 'SUCCESS', { id: 999, completed_at: late });
      const pending = { name: 'test', status, conclusion: null };
      for (const rows of [[success, pending], [pending, success]]) {
        expect(latestAttempts(rows)).toEqual([pending]);
        expect(summarize(rows, { requiredNames: ['test'] })).toEqual({
          redSet: new Set(), pendingSet: new Set(['test']),
          gateOnlyRed: false, allRequiredGreen: false,
        });
      }
    },
  );

  it.each([
    {},
    { started_at: null, completed_at: null },
    { completed_at: 'invalid' },
    { startedAt: 'invalid' },
  ])('completed rows with missing or invalid timestamps rank lowest: %j', timestamps => {
    const dated = settled('test', 'FAILURE', { id: 1, completed_at: early });
    for (const conclusion of ['SUCCESS', 'CANCELLED', 'STALE']) {
      const undated = settled('test', conclusion, { id: 999, ...timestamps });
      for (const rows of [[undated, dated], [dated, undated]]) {
        expect(latestAttempts(rows)).toEqual([dated]);
        expect(summarize(rows, { requiredNames: ['test'] }).redSet).toEqual(new Set(['test']));
      }
    }
  });

  it.each([
    ['R1b: different workflow runs never compare attempt counters',
      { run_id: 100, run_attempt: 2, id: 1001, completed_at: early },
      { run_id: 200, run_attempt: 1, id: 2001, completed_at: late }],
    ['R2: partial metadata cannot hide a timestamp-only failure',
      { run_attempt: 2, id: 1001, completedAt: early }, { completedAt: late }],
    ['R4: an older-run rerun failure beats a newer-run success completed earlier',
      { run_id: 200, run_attempt: 1, id: 2001, completed_at: early },
      { run_id: 100, run_attempt: 2, id: 1001, completed_at: late }],
    ['missing timestamps rank lowest even with greater workflow and check-run ids',
      { run_id: 999, run_attempt: 999, id: 9999 }, { completedAt: late }],
    ['invalid timestamps rank lowest', { id: 9999, completed_at: 'invalid' }, { completed_at: early }],
    ['completion time takes precedence over start time',
      { started_at: late, completed_at: early }, { started_at: early, completed_at: late }],
  ])('%s', (_name, olderMetadata, newerMetadata) => {
    const older = settled('TEST', 'SUCCESS', olderMetadata);
    const newer = settled('test', 'FAILURE', newerMetadata);
    for (const rows of [[older, newer], [newer, older]]) {
      expect(latestAttempts(rows)).toEqual([newer]);
      expect(summarize(rows, { requiredNames: ['test'] }).redSet).toEqual(new Set(['test']));
    }
  });

  it.each(['started_at', 'startedAt'])('a newer in-progress %s outranks an older completed check', field => {
    const older = settled('test', 'SUCCESS', { id: 999, completed_at: early });
    const pending = { name: 'test', status: 'IN_PROGRESS', id: 1, [field]: late };
    for (const rows of [[older, pending], [pending, older]]) {
      expect(latestAttempts(rows)).toEqual([pending]);
      expect(summarize(rows).pendingSet).toEqual(new Set(['test']));
    }
  });
});
