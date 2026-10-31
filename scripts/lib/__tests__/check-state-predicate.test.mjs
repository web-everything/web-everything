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

describe('review regressions: fail-closed summary inputs', () => {
  it.each([
    ['null', null], ['string', 'ci'], ['Set', new Set(['ci'])],
    ['number', 1], ['object', {}], ['non-string entry', [null]],
    ['mixed entries', ['ci', 1]], ['sparse array', new Array(1)],
  ])('rejects malformed requiredNames: %s', (_label, requiredNames) => {
    expect(() => summarize([settled('ci', 'failure')], { requiredNames }))
      .toThrow(TypeError);
  });

  it('rejects nameless rows instead of dropping a failure behind a success', () => {
    const failed = { status: 'completed', conclusion: 'failure', id: 1 };
    const passed = { status: 'completed', conclusion: 'success', id: 2 };
    for (const rows of [[failed, passed], [passed, failed]]) {
      expect(() => latestAttempts(rows)).toThrow(TypeError);
      expect(() => summarize(rows)).toThrow(TypeError);
      expect(() => summarize(rows, { requiredNames: ['ci'] })).toThrow(TypeError);
    }
  });

  it.each([undefined, null, '', 1, {}, []].map((value) => [value]))('rejects invalid check identity %j', (name) => {
    expect(() => latestAttempts([settled(name, 'success')])).toThrow(TypeError);
  });

  it.each([null, 'ci', new Set(['ci']), [null], new Array(1)].map((value) => [value]))(
    'rejects malformed holdGateNames: %j', (holdGateNames) => {
      expect(() => summarize([settled('ci', 'failure')], { holdGateNames }))
        .toThrow(TypeError);
    },
  );

  it('rejects conflicting required flags across all rows in either order', () => {
    const optional = settled('ci', 'failure', { required: false });
    const required = { name: 'ci', status: 'queued' };
    for (const rows of [[optional, required], [required, optional]]) {
      expect(() => summarize(rows)).toThrow(TypeError);
      expect(() => summarize(rows, { requiredNames: ['ci'] })).toThrow(TypeError);
    }
  });

  it.each([
    ['missing', {}], ['noncanonical', { run_attempt: 'bad', id: 'node-id' }],
    ['canonical', { run_attempt: 1, id: 2 }],
  ])('retains all evidence with %s metadata in either order', (_label, rank) => {
    const green = settled('ci', 'success', rank);
    const pending = { name: 'ci', status: 'queued', ...rank };
    const red = settled('ci', 'failure', rank);
    for (const [better, worse] of [[green, pending], [green, red], [pending, red]]) {
      for (const rows of [[better, worse], [worse, better]]) {
        expect(latestAttempts(rows)).toEqual(rows);
        const summary = summarize(rows);
        expect(summary.allRequiredGreen).toBe(false);
        expect(summary[worse === red ? 'redSet' : 'pendingSet']).toEqual(new Set(['ci']));
      }
    }
  });

  it('retains both original rows with identical metadata', () => {
    const first = Object.freeze(settled('ci', 'failure', { id: 1 }));
    const second = Object.freeze(settled('ci', 'timed_out', { id: '1' }));
    expect(latestAttempts(Object.freeze([first, second]))).toEqual([first, second]);
    expect(latestAttempts(Object.freeze([second, first]))).toEqual([second, first]);
  });

  it('keeps the worse optional outcome for an explicit roster override', () => {
    const green = settled('ci', 'success', { required: false });
    const red = settled('ci', 'failure', { required: false });
    for (const rows of [[green, red], [red, green]]) {
      expect(summarize(rows).allRequiredGreen).toBe(true);
      expect(summarize(rows, { requiredNames: ['ci'] }).redSet).toEqual(new Set(['ci']));
    }
  });

  it('does not case-fold default hold gates or the required roster', () => {
    expect(summarize([settled('REVIEW-GATE', 'failure')]).gateOnlyRed).toBe(false);
    const result = summarize([settled('test', 'success')], { requiredNames: ['Test'] });
    expect(result.pendingSet).toEqual(new Set(['Test']));
    expect(result.allRequiredGreen).toBe(false);
  });

  it('honors optional row flags when requiredNames is omitted', () => {
    const result = summarize([
      settled('ci', 'success'),
      settled('optional-failed', 'failure', { required: false }),
      { name: 'optional-pending', status: 'queued', required: false },
    ]);
    expect(result.redSet).toEqual(new Set());
    expect(result.pendingSet).toEqual(new Set());
    expect(result.allRequiredGreen).toBe(true);
    expect(result.gateOnlyRed).toBe(false);
  });
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

  it.each([null, 0, '', 'false', '0', 1, NaN, {}, [], new Boolean(false)])(
    'only literal false makes a check optional; required=%j stays required', (required) => {
      for (const [evidence, expected] of [
        [{ status: 'completed', conclusion: 'failure' }, 'red'],
        [{ status: 'queued' }, 'pending'],
        [{ status: 'completed', conclusion: 'unknown' }, 'red'],
        [{}, 'red'],
        [{ status: 'completed', conclusion: 'success' }, 'green'],
      ]) {
        expect(classifyCheck({ ...evidence, required })).toBe(expected);
        expect(classifyCheck({ ...evidence, required: false }))
          .toBe(expected === 'green' ? 'green' : 'ignore');
        expect(summarize([{ name: 'ci', ...evidence, required }])).toEqual({
          redSet: new Set(expected === 'red' ? ['ci'] : []),
          pendingSet: new Set(expected === 'pending' ? ['ci'] : []),
          gateOnlyRed: false, allRequiredGreen: expected === 'green',
        });
      }
    },
  );

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
  it('does not mutate deeply frozen input and returns every original row in input order', () => {
    const older = Object.freeze(settled('test', 'failure', {
      run_attempt: 1, id: 1,
      output: Object.freeze({ annotations: Object.freeze([Object.freeze({ message: 'failed' })]) }),
    }));
    const build = Object.freeze(settled('build', 'success', { run_attempt: 1, id: 2 }));
    const newer = Object.freeze(settled('test', 'success', { run_attempt: 2, id: 3 }));
    const smoke = Object.freeze(settled('smoke', 'success', { run_attempt: 1, id: 4 }));
    const input = Object.freeze([older, build, newer, smoke]);
    const snapshot = structuredClone(input);

    const result = latestAttempts(input);

    expect(input).toEqual(snapshot);
    expect(result).toHaveLength(4);
    expect(result[0]).toBe(older);
    expect(result[1]).toBe(build);
    expect(result[2]).toBe(newer);
    expect(result[3]).toBe(smoke);
  });

  it('returns all original row objects without cloning or normalizing them', () => {
    const older = settled('TEST', 'failure', { run_attempt: 1, id: 1 });
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

  it('preserves every row when multiple names have repeated attempts', () => {
    const zed = settled('zed', 'success', { run_attempt: 2 });
    const alpha = settled('alpha', 'success', { run_attempt: 2 });
    const middle = settled('middle', 'success', { run_attempt: 1 });

    const rows = [
      settled('zed', 'failure', { run_attempt: 1 }),
      settled('alpha', 'failure', { run_attempt: 1 }),
      middle, alpha, zed,
    ];
    expect(latestAttempts(rows)).toEqual(rows);
    expect(summarize(rows).redSet).toEqual(new Set(['zed', 'alpha']));
  });

  it('keeps Test and test as distinct checks in either order, including identical metadata (#7501 B8)', () => {
    const older = settled('Test', 'success', { run_attempt: 1, id: 1 });
    const newer = settled('test', 'failure', { run_attempt: 2, id: 2 });
    for (const rows of [[older, newer], [newer, older]]) {
      const result = latestAttempts(rows);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(rows[0]);
      expect(result[1]).toBe(rows[1]);
    }
    const tied = { ...newer, name: 'Test' };
    for (const rows of [[newer, tied], [tied, newer]]) {
      const result = latestAttempts(rows);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(rows[0]);
      expect(result[1]).toBe(rows[1]);
    }
  });

  it('uses name || context without trimming or Unicode folding (#7501 I1)', () => {
    const names = ['test', 'TEST', 'test\u200b', ' test', 'test ', 'ｔｅｓｔ', 'é', 'e\u0301'];
    const rows = names.map((name, id) => settled(name, id === 0 ? 'success' : 'failure', { id }));
    for (const input of [rows, [...rows].reverse()]) {
      expect(latestAttempts(input)).toEqual(input);
      expect(summarize(input, { requiredNames: ['test'] })).toEqual({
        redSet: new Set(), pendingSet: new Set(),
        gateOnlyRed: false, allRequiredGreen: true,
      });
    }
    const fallback = { name: '', context: 'test', status: 'completed', conclusion: 'failure', id: 20 };
    expect(latestAttempts([rows[0], fallback])).toEqual([rows[0], fallback]);
    expect(summarize([rows[0], fallback], { requiredNames: ['test'] }).redSet).toEqual(new Set(['test']));
    const contextOnly = { context: 'test', status: 'queued', id: 21 };
    expect(latestAttempts([fallback, contextOnly])).toEqual([fallback, contextOnly]);
    expect(summarize([contextOnly], { requiredNames: ['test'] }).pendingSet).toEqual(new Set(['test']));
    expect(latestAttempts([rows[0], { ...fallback, name: 'other' }])).toHaveLength(2);
  });

  it('retains failures alongside large run_attempt integers in either order', () => {
    const older = settled('ci', 'success', { run_attempt: '9007199254740992', id: 999 });
    const newer = settled('ci', 'failure', { run_attempt: '9007199254740993', id: 1 });
    for (const runs of [[older, newer], [newer, older]]) {
      expect(latestAttempts(runs)).toEqual(runs);
      expect(summarize(runs).allRequiredGreen).toBe(false);
    }
  });

  it('retains all evidence with canonical string and number metadata', () => {
    const first = settled('ci', 'failure', { run_attempt: 2, id: 9007199254740992 });
    const second = settled('ci', 'success', { run_attempt: '2', id: '9007199254740992' });
    expect(latestAttempts([first, second])).toEqual([first, second]);
    expect(latestAttempts([second, first])).toEqual([second, first]);
  });

  it.each([
    undefined, null, '', 'garbage', '01', ' 2', '2 ', '2\n', '2\r', '2\u2028', '2\u2029', '+2', '-2',
    '2.5', '2.0', '2e3', '0x10', 'Infinity', 'NaN', -2, 2.5, Infinity, NaN,
    true, {}, [],
  ].map((value) => [value]))('retains all evidence despite noncanonical or missing metadata %j', (value) => {
    for (const field of ['run_attempt', 'id']) {
      const invalid = settled('ci', 'success', { [field]: value });
      const zero = settled('ci', 'failure', { [field]: '0' });
      expect(latestAttempts([zero, invalid])).toEqual([zero, invalid]);
      expect(summarize([zero, invalid]).allRequiredGreen).toBe(false);
      expect(latestAttempts([invalid, zero])).toEqual([invalid, zero]);
      expect(summarize([invalid, zero]).allRequiredGreen).toBe(false);
    }
  });

  it('keeps every numeric run_attempt and id per name in either input order', () => {
    const winner = settled('ci', 'failure', { run_attempt: '10', id: '10' });
    const smoke = settled('smoke', 'success', { run_attempt: 1, id: 1 });
    const runs = [
      settled('ci', 'success', { run_attempt: '2', id: '999' }),
      settled('ci', 'success', { run_attempt: '10', id: '2' }),
      winner, smoke,
    ];
    for (const input of [runs, [...runs].reverse()]) {
      const result = latestAttempts(input);
      expect(result).toEqual(input);
      expect(summarize(input).redSet).toEqual(new Set(['ci']));
    }
  });

  it('keeps missing run_attempt and id evidence alongside populated metadata', () => {
    const missing = settled('ci', 'success');
    const byId = settled('ci', 'failure', { id: 1 });
    const byAttempt = settled('ci', 'neutral', { run_attempt: 1 });
    for (const pair of [[missing, byId], [byId, missing]]) {
      expect(latestAttempts(pair)).toEqual(pair);
      expect(summarize(pair).allRequiredGreen).toBe(false);
    }
    for (const pair of [[byId, byAttempt], [byAttempt, byId]]) {
      expect(latestAttempts(pair)).toEqual(pair);
      expect(summarize(pair).allRequiredGreen).toBe(false);
    }
    expect(latestAttempts([missing])).toEqual([missing]);
    expect(latestAttempts([])).toEqual([]);
  });

  it('never uses startedAt or completedAt to discard rows', () => {
    const older = settled('ci', 'success', {
      run_attempt: 1, id: 2,
      startedAt: '2026-10-28T12:00:00Z', completedAt: '2026-10-28T13:00:00Z',
    });
    const newer = settled('ci', 'failure', {
      run_attempt: 1, id: 10,
      startedAt: '2026-10-27T12:00:00Z', completedAt: '2026-10-27T13:00:00Z',
    });
    expect(latestAttempts([older, newer])).toEqual([older, newer]);
    expect(latestAttempts([newer, older])).toEqual([newer, older]);
  });
});

describe('named check-state regressions', () => {
  it('keeps exact check identities through required and hold-gate matching (#7501 B8)', () => {
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

  it('mixed timestamps cannot hide a FAILURE', () => {
    const older = settled('ci', 'SUCCESS', {
      run_attempt: 1, id: 999,
      startedAt: '2026-10-28T12:00:00Z', completedAt: '2026-10-28T13:00:00Z',
    });
    const newer = settled('ci', 'FAILURE', {
      run_attempt: 2, id: 1,
      startedAt: '2026-10-27T12:00:00Z', completedAt: '2026-10-27T13:00:00Z',
    });
    for (const runs of [[older, newer], [newer, older]]) {
      expect(latestAttempts(runs)).toEqual(runs);
      expect(summarize(runs).allRequiredGreen).toBe(false);
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
  it('matches requiredNames exactly without inventing missing required checks', () => {
    expect(summarize([
      settled('TeSt', 'success', { required: false }),
      settled('SMOKE', 'failure'),
    ], { requiredNames: ['TeSt', 'TeSt'] })).toEqual({
      redSet: new Set(), pendingSet: new Set(),
      gateOnlyRed: false, allRequiredGreen: true,
    });
    expect(summarize([settled('TEST', 'success')], { requiredNames: ['test'] })).toEqual({
      redSet: new Set(), pendingSet: new Set(['test']),
      gateOnlyRed: false, allRequiredGreen: false,
    });
  });

  it('matches holdGateNames exactly and preserves blocker names', () => {
    expect(summarize([
      settled('ReViEw-GaTe', 'failure'),
      settled('MERGE-GATE', 'failure'),
      { name: 'BuIlD', status: 'queued' },
    ], {
      requiredNames: ['ReViEw-GaTe', 'MERGE-GATE', 'BuIlD', 'Absent', 'Absent'],
      holdGateNames: ['ReViEw-GaTe', 'MERGE-GATE'],
    })).toEqual({
      redSet: new Set(['ReViEw-GaTe', 'MERGE-GATE']),
      pendingSet: new Set(['BuIlD', 'Absent']),
      gateOnlyRed: true, allRequiredGreen: false,
    });
    expect(summarize([settled('MERGE-GATE', 'failure')]).gateOnlyRed).toBe(false);
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

  it('mixed success and failure for the same name never becomes green', () => {
    expect(summarize([
      settled('ci', 'failure', { run_attempt: 1 }),
      settled('ci', 'success', { run_attempt: 2 }),
    ], { requiredNames: ['ci'] })).toEqual({
      redSet: new Set(['ci']), pendingSet: new Set(),
      gateOnlyRed: false, allRequiredGreen: false,
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


describe('R272 every-row green rule', () => {
  it('all successes for the same exact name are green', () => {
    expect(summarize([
      settled('ci', 'success', { run_attempt: 1 }),
      settled('ci', 'SUCCESS', { run_attempt: 2 }),
    ], { requiredNames: ['ci'] }).allRequiredGreen).toBe(true);
  });

  it.each([
    { status: 'pending' }, { status: 'in_progress' }, { status: 'queued' },
    { status: 'completed', conclusion: 'cancelled' },
    { status: 'completed', conclusion: 'timed_out' }, {},
    { status: 'completed', conclusion: 'unknown' },
  ])('success alongside non-green evidence %j never admits', evidence => {
    const success = settled('ci', 'success', { run_attempt: 999, id: 999 });
    const blocker = { name: 'ci', ...evidence };
    for (const rows of [[success, blocker], [blocker, success]]) {
      expect(summarize(rows, { requiredNames: ['ci'] }).allRequiredGreen).toBe(false);
    }
  });
});
