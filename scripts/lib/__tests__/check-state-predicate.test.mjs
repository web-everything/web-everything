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
  it.each(['constructor', 'toString', '__proto__'])(
    'fails closed on prototype-key status %s with required omitted',
    (status) => {
      expect(classifyCheck({ status, conclusion: 'success' })).toBe('red');
    },
  );

  it.each(['constructor', 'toString', '__proto__'])(
    'fails closed on prototype-key conclusion %s with explicit or inferred completion',
    (conclusion) => {
      for (const statusFlag of [{ status: 'completed' }, {}, { status: null }, { status: undefined }]) {
        expect(classifyCheck({ ...statusFlag, conclusion })).toBe('red');
      }
    },
  );

  it('fails closed on prototype-key statuses and conclusions just like unknown values', () => {
    for (const value of ['unrecognised', 'constructor', 'toString', '__proto__']) {
      for (const evidence of [
        { status: value, conclusion: 'success' },
        { status: 'completed', conclusion: value },
        { conclusion: value },
      ]) {
        expect(classifyCheck({ name: 'ci', ...evidence, required: true })).toBe('red');
        expect(classifyCheck({ name: 'ci', ...evidence, required: false })).toBe('ignore');
      }
    }
  });

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

describe('latestAttempts', () => {
  it.each([undefined, null, '', 'invalid', 0, '0', '1970-01-01T00:00:00Z', '0001-01-01T00:00:00Z', '1999-12-31T23:59:59Z'])(
    'fails closed across dated/undated outcome pairs (timestamp=%j)', timestamp => {
      for (const datedConclusion of ['SUCCESS', 'FAILURE', 'STARTUP_FAILURE']) {
        for (const undatedConclusion of ['SUCCESS', 'FAILURE', 'STARTUP_FAILURE']) {
          const dated = settled('test', datedConclusion, { id: 999, completedAt: '2026-10-28T01:00:00Z' });
          const undated = settled('test', undatedConclusion, { id: 1, completedAt: timestamp });
          const expected = undatedConclusion === 'SUCCESS' ? dated : undated;
          for (const rows of [[dated, undated], [undated, dated]]) {
            expect(latestAttempts(rows)).toEqual([expected]);
            const result = summarize(rows, { requiredNames: ['test'] });
            expect(result.redSet).toEqual(new Set(expected.conclusion === 'SUCCESS' ? [] : ['test']));
            expect(result.allRequiredGreen).toBe(expected.conclusion === 'SUCCESS');
          }
        }
      }
    },
  );

  it.each(['completed_at', 'completedAt', 'started_at', 'startedAt', 'created_at', 'createdAt'])(
    'uses a valid %s to let a dated newer success clear an older failure', field => {
      const failure = settled('test', 'FAILURE', {
        completed_at: 'invalid', completedAt: '0001-01-01T00:00:00Z',
        started_at: 0, startedAt: '', created_at: null, createdAt: undefined,
        [field]: '2026-10-28T01:00:00Z',
      });
      const success = settled('test', 'SUCCESS', { completedAt: '2026-10-28T02:00:00Z' });
      for (const rows of [[failure, success], [success, failure]]) {
        expect(latestAttempts(rows)).toEqual([success]);
        expect(summarize(rows, { requiredNames: ['test'] }).allRequiredGreen).toBe(true);
      }
    },
  );

  it.each(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'unknown', null])(
    'undated %s stays red even with required=false when the roster requires it', conclusion => {
      const undated = settled('test', conclusion, { required: false });
      const success = settled('test', 'SUCCESS', { completedAt: '2026-10-28T01:00:00Z' });
      for (const rows of [[undated, success], [success, undated]]) {
        expect(summarize(rows, { requiredNames: ['test'] }).redSet).toEqual(new Set(['test']));
        expect(summarize(rows).allRequiredGreen).toBe(true);
      }
    },
  );

  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])(
    'undated %s remains pending ahead of dated success', status => {
      const pending = { name: 'test', status };
      const success = settled('test', 'SUCCESS', { completedAt: '2026-10-28T01:00:00Z' });
      for (const rows of [[pending, success], [success, pending]]) {
        expect(summarize(rows, { requiredNames: ['test'] }).pendingSet).toEqual(new Set(['test']));
      }
    },
  );

  it.each(['CANCELLED', 'STALE', 'SUCCESS'])(
    'undated completed %s cannot displace dated failure', conclusion => {
      const undated = settled('test', conclusion);
      const failure = settled('test', 'FAILURE', { completedAt: '2026-10-28T01:00:00Z' });
      for (const rows of [[undated, failure], [failure, undated]]) {
        expect(latestAttempts(rows)).toEqual([failure]);
      }
    },
  );

  it('does not mutate deeply frozen input and returns original rows in first-seen name order', () => {
    const older = Object.freeze(settled('test', 'failure', {
      run_attempt: 1, id: 1, completedAt: '2026-10-28T01:00:00Z',
      output: Object.freeze({ annotations: Object.freeze([Object.freeze({ message: 'failed' })]) }),
    }));
    const build = Object.freeze(settled('build', 'success', { run_attempt: 1, id: 2 }));
    const newer = Object.freeze(settled('test', 'success', { run_attempt: 2, id: 3, completedAt: '2026-10-28T02:00:00Z' }));
    const smoke = Object.freeze(settled('smoke', 'success', { run_attempt: 1, id: 4 }));
    const input = Object.freeze([older, build, newer, smoke]);
    const snapshot = structuredClone(input);

    const result = latestAttempts(input);

    expect(input).toEqual(snapshot);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(newer);
    expect(result[1]).toBe(build);
    expect(result[2]).toBe(smoke);
  });

  it('returns the original winning row objects without cloning or normalizing them', () => {
    const older = settled('Test', 'failure', { run_attempt: 1, id: 1 });
    const winner = settled('TEST', 'success', { run_attempt: 2, id: 2 });
    const build = settled('Build', 'success', { id: 3 });

    const result = latestAttempts([older, winner, build]);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(older);
    expect(result[1]).toBe(winner);
    expect(result[2]).toBe(build);
    expect(winner.name).toBe('TEST');
    expect(build.name).toBe('Build');
  });

  it('preserves first-seen name order when later attempts replace multiple winners', () => {
    const zed = settled('zed', 'success', { completedAt: '2026-10-28T02:00:00Z' });
    const alpha = settled('alpha', 'success', { completedAt: '2026-10-28T02:00:00Z' });
    const middle = settled('middle', 'success', { run_attempt: 1 });

    expect(latestAttempts([
      settled('zed', 'failure', { completedAt: '2026-10-28T01:00:00Z' }),
      settled('alpha', 'failure', { completedAt: '2026-10-28T01:00:00Z' }),
      middle, alpha, zed,
    ])).toEqual([zed, alpha, middle]);
  });

  it('keeps Test and test distinct in either order, including exact ranking ties', () => {
    const older = settled('Test', 'success', { run_attempt: 1, id: 1 });
    const newer = settled('test', 'failure', { run_attempt: 2, id: 2 });
    for (const rows of [[older, newer], [newer, older]]) {
      const result = latestAttempts(rows);
      expect(result).toHaveLength(2);
      expect(result).toEqual(rows);
    }
    const tied = { ...newer, name: 'Test' };
    for (const rows of [[newer, tied], [tied, newer]]) {
      const result = latestAttempts(rows);
      expect(result).toHaveLength(2);
      expect(result).toEqual(rows);
    }
  });

  it('ignores large run_attempt counters when completion times identify the latest check', () => {
    const older = settled('ci', 'success', { run_attempt: '9007199254740993', id: 999, completedAt: '2026-10-28T01:00:00Z' });
    const newer = settled('ci', 'failure', { run_attempt: '9007199254740992', id: 1, completedAt: '2026-10-28T02:00:00Z' });
    for (const runs of [[older, newer], [newer, older]]) {
      expect(latestAttempts(runs)).toEqual([newer]);
    }
  });

  it('compares canonical string and number ranks equally and retains the first exact tie', () => {
    const first = settled('ci', 'failure', { completedAt: '2026-10-28T01:00:00Z', id: 9007199254740992 });
    const second = settled('ci', 'success', { completedAt: '2026-10-28T01:00:00Z', id: '9007199254740992' });
    expect(latestAttempts([first, second])).toEqual([first]);
    expect(latestAttempts([second, first])).toEqual([second]);
  });

  it.each([
    undefined, null, '', 'garbage', '01', ' 2', '2 ', '2\n', '+2', '-2',
    '2.5', '2.0', '2e3', '0x10', 'Infinity', 'NaN', -2, 2.5, Infinity, NaN,
    true, {}, [],
  ])('treats noncanonical or missing id %j as zero and ignores run_attempt', (value) => {
    for (const field of ['run_attempt', 'id']) {
      const invalid = settled('ci', 'success', { completedAt: '2026-10-28T01:00:00Z', [field]: value });
      const zero = settled('ci', 'failure', { completedAt: '2026-10-28T01:00:00Z', [field]: '0' });
      expect(latestAttempts([zero, invalid])).toEqual([zero]);
      expect(latestAttempts([invalid, zero])).toEqual([invalid]);
    }
  });

  it('selects the greatest numeric id on equal timestamps, ignoring run_attempt, in either order', () => {
    const time = { completedAt: '2026-10-28T01:00:00Z' };
    const winner = settled('ci', 'failure', { ...time, run_attempt: '2', id: '1000' });
    const smoke = settled('smoke', 'success', { run_attempt: 1, id: 1 });
    const runs = [
      settled('ci', 'success', { ...time, run_attempt: '10', id: '999' }),
      settled('ci', 'success', { ...time, run_attempt: '10', id: '2' }),
      winner, smoke,
    ];
    for (const input of [runs, [...runs].reverse()]) {
      const result = latestAttempts(input);
      expect(result).toHaveLength(2);
      expect(result).toEqual(expect.arrayContaining([winner, smoke]));
    }
  });

  it('counts missing id as zero and never ranks run_attempt', () => {
    const missing = settled('ci', 'success');
    const byId = settled('ci', 'neutral', { id: 1 });
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

  it('ranks completedAt before check id and ignores attempt counters', () => {
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
  it('keeps check names, required rosters and hold gates case-sensitive', () => {
    const older = settled('Test', 'success', { run_attempt: 1, id: 1 });
    const newer = settled('test', 'failure', { run_attempt: 2, id: 2, required: false });
    for (const runs of [[older, newer], [newer, older]]) {
      expect(latestAttempts(runs)).toEqual(runs);
      expect(summarize([
        ...runs,
        { name: 'Build', status: 'queued' },
        settled('Smoke', 'failure'),
      ], {
        requiredNames: ['test', 'Build', 'ABSENT'],
        holdGateNames: ['test'],
      })).toEqual({
        redSet: new Set(['test']), pendingSet: new Set(['Build', 'ABSENT']),
        gateOnlyRed: true, allRequiredGreen: false,
      });
    }
  });

  it('large adjacent ids cannot hide a newer failure in either row order', () => {
    const older = settled('ci', 'success', { completedAt: '2026-10-28T01:00:00Z', id: '9007199254740992' });
    const newer = settled('ci', 'failure', { completedAt: '2026-10-28T01:00:00Z', id: '9007199254740993' });
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
      startedAt: '2026-10-27T12:00:00Z', completedAt: '2026-10-27T13:00:00Z',
    });
    const newer = settled('ci', 'FAILURE', {
      run_attempt: 2, id: 1,
      startedAt: '2026-10-28T12:00:00Z', completedAt: '2026-10-28T13:00:00Z',
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
  it('explicit roster overrides row.required in both directions', () => {
    expect(summarize([
      settled('test', 'FAILURE', { required: false }),
      settled('optional', 'FAILURE', { required: true }),
    ], { requiredNames: ['test'] })).toEqual({
      redSet: new Set(['test']), pendingSet: new Set(),
      gateOnlyRed: false, allRequiredGreen: false,
    });
    expect(summarize([settled('optional', 'FAILURE', { required: true })], { requiredNames: [] })
      .allRequiredGreen).toBe(true);
  });

  it('omitted roster honors row.required=false', () => {
    for (const conclusion of ['FAILURE', 'CANCELLED', 'STALE']) {
      expect(summarize([settled('optional', conclusion, { required: false })])).toEqual({
        redSet: new Set(), pendingSet: new Set(), gateOnlyRed: false, allRequiredGreen: true,
      });
    }
    expect(summarize([settled('test', 'FAILURE', { required: true })]).redSet).toEqual(new Set(['test']));
  });

  it('matches requiredNames exactly and keeps differently cased names missing', () => {
    expect(summarize([
      settled('TeSt', 'success', { required: false }),
      settled('SMOKE', 'failure'),
    ], { requiredNames: ['TEST', 'test'] })).toEqual({
      redSet: new Set(), pendingSet: new Set(['TEST', 'test']),
      gateOnlyRed: false, allRequiredGreen: false,
    });
  });

  it('matches holdGateNames exactly and preserves blocker case', () => {
    expect(summarize([
      settled('ReViEw-GaTe', 'failure'),
      settled('MERGE-GATE', 'failure'),
      { name: 'BuIlD', status: 'queued' },
    ], {
      requiredNames: ['ReViEw-GaTe', 'MERGE-GATE', 'BuIlD', 'Absent', 'ABSENT'],
      holdGateNames: ['ReViEw-GaTe', 'MERGE-GATE'],
    })).toEqual({
      redSet: new Set(['ReViEw-GaTe', 'MERGE-GATE']),
      pendingSet: new Set(['BuIlD', 'Absent', 'ABSENT']),
      gateOnlyRed: true, allRequiredGreen: false,
    });
    expect(summarize([settled('ReViEw-GaTe', 'failure')], {
      holdGateNames: ['review-gate'],
    }).gateOnlyRed).toBe(false);
  });

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
      settled('ci', 'failure', { completedAt: '2026-10-28T01:00:00Z' }),
      settled('ci', 'success', { completedAt: '2026-10-28T02:00:00Z' }),
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
