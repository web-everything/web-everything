import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  select, tableFindings, decisionFindings, orderFindings, candidateOrder,
  tableChangeFindings, replayFindings, canon, digestOf, DECISION_FIELDS,
} from '../delivery-strategy.mjs';
import table from '../../settings/delivery-strategy-table.json';
import settings from '../../settings/delivery-strategy.json';
import replay from './fixtures/strategy-replay.ours.json';

const clone = (x) => structuredClone(x);
const at = replay.points[0].at;
const observation = (value) => ({ ...clone(replay.points[0].candidates[0].inputs['security-open']), value });
function inputs(over = {}) {
  const result = clone(replay.points[0].candidates[0].inputs);
  // A fully recorded ordinary product candidate. Individual tests change only
  // the evidence relevant to their clause, preserving all other observations.
  for (const [n, value] of Object.entries({
    'step-kind': 'product', blocker: 'none', 'hold-causer': false,
    'loaded-stage-stress': 'clear', 'loads-stalled-stage': false,
    'red-interval-open': false, 'red-recovery-candidate': false,
    'stack-declared': false, 'stack-depth': 0,
    'prepped-independent': true, 'admission-clear': true, 'free-slots': 1,
    'review-rounds': 0, 'non-convergence-evidence': false,
  })) result[n] = observation(value);
  for (const [n, value] of Object.entries(over)) result[n] = observation(value);
  return result;
}
const run = (over = {}, opts = {}) => select({ table, settings, inputs: inputs(over), at, ...opts });
const outcome = (got, strategy, reason) => expect(got).toMatchObject({ strategy, reason, build: !['hold', 'unhandled'].includes(strategy) });
const row = (t, id) => t.rules.find((r) => r.id === id);
function refused(clause, mutate) {
  const changed = clone(table);
  mutate(changed);
  expect(tableFindings({ table: changed }).some((f) => f.includes(`SHIP-WM-${clause}`))).toBe(true);
  outcome(run({}, { table: changed }), 'unhandled', 'EVIDENCE_UNKNOWN');
  expect(run({}, { table: changed }).rule).toBe('unconfigured');
}
function decision() {
  const recorded = inputs();
  return {
    decisionId: 'decision-fixture', at, candidate: '#example', position: 1,
    positionReason: 'plan order', inputs: recorded,
    table: { uri: table.id, version: table.version, digest: digestOf(table) },
    settings: { revision: settings.revision, digest: digestOf(settings.values) },
    ...select({ table, settings, inputs: recorded, at }), actions: [],
  };
}

describe('SHIP-WM-160: replay 11-24..25: each fix gets the winning strategy', () => {
  for (const point of replay.points) {
    it(`SHIP-WM-160/163: golden point ${point.at} matches every strategy, reason, rule and candidate position`, () => {
      expect(candidateOrder(point.candidates)).toEqual(point.expected.order);
      expect(orderFindings({ candidates: point.candidates, order: point.expected.order })).toEqual([]);
      for (const candidate of point.candidates) {
        const expected = point.expected.outputs[candidate.id];
        const got = select({ table, settings, inputs: candidate.inputs, at: point.at });
        outcome(got, expected.strategy, expected.reason);
        expect(got.rule).toBe(expected.rule);
      }
    });
  }
  it('SHIP-WM-161/173: golden table and settings digests match the copied fixtures and replay helper', () => {
    expect(digestOf(table)).toEqual(replay.table.digest);
    expect(digestOf(settings.values)).toEqual(replay.settings.digest);
    expect(replayFindings({ table, settings, points: replay.points })).toEqual([]);
  });
  it('SHIP-WM-160/163: #7485 is prototype-first and first as hold-causer at its now-green head', () => {
    const point = replay.points.find((p) => p.candidates.some((c) => c.id === '#7485'));
    const candidate = point.candidates.find((c) => c.id === '#7485');
    expect(candidate.clearsHold).toBe(true);
    expect(candidate.inputs['audit-state'].value).toBe('pass');
    expect(candidate.inputs['ci-state'].value).toBe('pass');
    expect(candidateOrder(point.candidates)[0]).toBe('#7485');
    outcome(select({ table, settings, inputs: candidate.inputs, at: point.at }), 'prototype-first', 'BLOCKER_OVERLAY_ELIGIBLE');
  });
});

describe('SHIP-WM-160/161: timestamps denote valid, timezone-independent instants', () => {
  const datedInputs = (observedAt) => Object.fromEntries(Object.entries(clone(replay.points[0].candidates[0].inputs))
    .map(([name, x]) => [name, { ...x, fresh: true, observedAt }]));
  const invalid = [
    '2026-11-25T11:00:00', '2026-11-25', 'November 25, 2026 11:00:00 GMT',
    '2026-02-30T11:00:00Z', '2026-02-29T11:00:00Z', '1900-02-29T11:00:00Z',
    '2026-04-31T11:00:00+05:30', '2026-00-25T11:00:00Z', '2026-13-25T11:00:00Z',
    '2026-11-00T11:00:00Z', '2026-11-32T11:00:00Z', '2026-11-25T24:00:00Z',
    '2026-11-25T11:60:00Z', '2026-11-25T11:00:60Z',
    '2026-11-25T11:00:00+24:00', '2026-11-25T11:00:00+01:60',
    ' 2026-11-25T11:00:00Z', '2026-11-25T11:00:00Z\n',
  ];
  it.each(invalid)('SHIP-WM-160: invalid observation time %j fails closed', (observedAt) => {
    outcome(select({ table, settings, inputs: datedInputs(observedAt), at: '2026-11-25T12:00:00Z' }), 'unhandled', 'EVIDENCE_UNKNOWN');
  });
  it.each(invalid)('SHIP-WM-160/162: invalid decision time %j fails selection and record validation', (badAt) => {
    outcome(select({ table, settings, inputs: datedInputs('1800-01-01T00:00:00Z'), at: badAt }), 'unhandled', 'EVIDENCE_UNKNOWN');
    expect(decisionFindings({ record: { ...decision(), at: badAt }, table, settings })).toContain('decision decision-fixture: decision time is invalid: refused (SHIP-WM-162)');
  });
  it.each([
    ['2026-11-25T11:00:00Z', '2026-11-25T12:00:00Z'],
    ['2026-11-25T06:00:00-05:00', '2026-11-25T17:30:00+05:30'],
    ['2026-11-26T01:00:00+14:00', '2026-11-25T12:00:00Z'],
    ['2026-11-25T11:00:00.123Z', '2026-11-25T11:00:00.124Z'],
    ['2024-02-29T11:00:00Z', '2024-02-29T12:00:00Z'],
    ['2000-02-29T11:00:00Z', '2000-02-29T12:00:00Z'],
    [0, 1], [1795604400, 1795608000],
  ])('SHIP-WM-161: valid instants %j / %j retain prototype selection', (observedAt, decisionAt) => {
    expect(select({ table, settings, inputs: datedInputs(observedAt), at: decisionAt })).toMatchObject({ rule: 'R3', strategy: 'prototype-first', build: true });
  });
  it('SHIP-WM-160: explicit offsets still reject future observations', () => {
    outcome(select({ table, settings, inputs: datedInputs('2026-11-25T08:00:00-05:00'), at: '2026-11-25T12:00:00Z' }), 'unhandled', 'EVIDENCE_UNKNOWN');
  });
  it('SHIP-WM-161: identical arguments fail closed or select identically in UTC and Toronto', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const program = `
      import { readFileSync } from 'node:fs';
      import { select } from './scripts/conveyor/delivery-strategy.mjs';
      const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
      const table = read('scripts/settings/delivery-strategy-table.json');
      const settings = read('scripts/settings/delivery-strategy.json');
      const replay = read('scripts/conveyor/__tests__/fixtures/strategy-replay.ours.json');
      const results = ['2026-11-25T11:00:00', '2026-02-30T11:00:00Z', '2026-11-25T06:00:00-05:00'].map((observedAt) => {
        const inputs = structuredClone(replay.points[0].candidates[0].inputs);
        Object.values(inputs).forEach((x) => Object.assign(x, { fresh: true, observedAt }));
        return select({ table, settings, inputs, at: observedAt.includes('02-30') ? '2026-03-03T12:00:00Z' : '2026-11-25T12:00:00Z' });
      });
      console.log(JSON.stringify(results));
    `;
    const results = ['UTC', 'America/Toronto'].map((TZ) => {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
        cwd: root, env: { ...process.env, TZ }, encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024,
      });
      expect(child.error).toBeUndefined();
      expect(child.stderr).toBe('');
      expect(child.status).toBe(0);
      return JSON.parse(child.stdout);
    });
    expect(results[0]).toEqual(results[1]);
    for (const result of results) {
      outcome(result[0], 'unhandled', 'EVIDENCE_UNKNOWN');
      outcome(result[1], 'unhandled', 'EVIDENCE_UNKNOWN');
      expect(result[2]).toMatchObject({ rule: 'R3', strategy: 'prototype-first', build: true });
    }
  });
});

describe('SHIP-WM-160: unknown or stale input never yields prototype-first or incident', () => {
  it.each([
    ['absent', undefined], ['unknown', observation('unknown')],
    ['stale', { ...observation('pass'), fresh: false }],
    ['freshness absent', { ...observation('pass'), fresh: undefined }],
    ['future-dated', { ...observation('pass'), observedAt: '2099-01-01T00:00:00Z' }],
    ['invalid date', { ...observation('pass'), observedAt: 'invalid' }],
    ['date absent', { ...observation('pass'), observedAt: undefined }],
    ['outside declared values', observation('green')],
  ])('SHIP-WM-160: %s required audit is unhandled/EVIDENCE_UNKNOWN on both high-priority paths', (_, audit) => {
    for (const adopts of [true, false]) {
      const recorded = inputs({ 'step-kind': 'daemon-fix', blocker: 'hold', 'hold-causer': true, 'targets-can-adopt': adopts });
      recorded['audit-state'] = audit;
      const got = select({ table, settings, inputs: recorded, at });
      outcome(got, 'unhandled', 'EVIDENCE_UNKNOWN');
      expect(got.unknown).toEqual(['audit-state']);
      expect(got.evaluated).toEqual([]);
    }
  });
  it('SHIP-WM-160: a missing optional input needed by an earlier rule blocks later matches', () => {
    const recorded = inputs();
    delete recorded['red-interval-open'];
    recorded['red-recovery-candidate'] = observation(true);
    const got = run({}, { inputs: recorded });
    outcome(got, 'unhandled', 'EVIDENCE_UNKNOWN');
    expect(got.evaluated.at(-1)).toEqual({ rule: 'R4', result: 'unknown' });
    expect(got.unknown).toEqual(['red-interval-open']);
  });
  it('SHIP-WM-160: stale optional recovery evidence blocks a potentially matching incident row', () => {
    const recorded = inputs({ 'red-interval-open': true, 'red-recovery-candidate': true });
    recorded['red-recovery-candidate'].fresh = false;
    outcome(run({}, { inputs: recorded }), 'unhandled', 'EVIDENCE_UNKNOWN');
  });
  it('SHIP-WM-160: no decision time or an invalid decision time refuses observations', () => {
    for (const bad of [undefined, null, '', 'bad', NaN, Infinity]) outcome(run({}, { at: bad }), 'unhandled', 'EVIDENCE_UNKNOWN');
  });
  it.each([-1, 0.5, Infinity, NaN, '1'])('SHIP-WM-160: invalid count %s is unknown', (value) => {
    outcome(run({ 'live-overlays': value }), 'unhandled', 'EVIDENCE_UNKNOWN');
  });
  it('SHIP-WM-160: unknown is never false for a rule that otherwise matches', () => {
    const recorded = inputs({ 'red-interval-open': true });
    delete recorded['red-recovery-candidate'];
    outcome(run({}, { inputs: recorded }), 'unhandled', 'EVIDENCE_UNKNOWN');
  });
  it('SHIP-WM-160: no matching rule gives the declared closed outcome', () => {
    const got = run({ 'admission-clear': false });
    outcome(got, 'unhandled', 'NO_ELIGIBLE_STRATEGY');
    expect(got.rule).toBe('R11');
  });
});

describe('SHIP-WM-160/178: configured settings', () => {
  it('SHIP-WM-160: a missing settings key yields hold/settings-missing, now unhandled/EVIDENCE_UNKNOWN per spec', () => {
    for (const key of table.settings) {
      const changed = clone(settings);
      delete changed.values[key];
      outcome(run({}, { settings: changed }), 'unhandled', 'EVIDENCE_UNKNOWN');
    }
    outcome(run({}, { settings: undefined }), 'unhandled', 'EVIDENCE_UNKNOWN');
  });
  it.each([-1, NaN, Infinity, -Infinity, '3', null, {}, true])('SHIP-WM-160/178: malformed setting %s never passes', (value) => {
    for (const key of Object.keys(settings.values)) {
      const changed = clone(settings);
      changed.values[key] = value;
      outcome(run({}, { settings: changed }), 'unhandled', 'EVIDENCE_UNKNOWN');
    }
  });
  it('SHIP-WM-178: zero is a valid configured bound, with no code default', () => {
    const changed = clone(settings);
    changed.values['overlay-cap'] = 0;
    outcome(run({ 'step-kind': 'daemon-fix', blocker: 'stage' }, { settings: changed }), 'normal-pr', 'NORMAL_CAPACITY');
  });
});

describe('SHIP-WM-157/158/159: table load checks', () => {
  it.each([
    ['shadowed toString', { toString: null }],
    ['nested shadowed toString', [{ toString: null }]],
    ['object', {}], ['array', []], ['null', null], ['number', 42], ['boolean', true],
  ])('SHIP-WM-178: malformed JSON setting declaration (%s) fails closed', (_, value) => {
    const changed = JSON.parse(JSON.stringify(table));
    changed.settings.push(JSON.parse(JSON.stringify(value)));
    expect(tableFindings({ table: changed }).length).toBeGreaterThan(0);
    expect(run({}, { table: changed })).toMatchObject({
      rule: 'unconfigured', strategy: 'unhandled', reason: 'EVIDENCE_UNKNOWN', build: false,
    });
  });
  it('SHIP-WM-158: the copied versioned First table loads', () => {
    expect(tableFindings({ table })).toEqual([]);
  });
  it.each([
    ['table name in a refusal', (t, v) => { t.name = v; t.settings.push(null); }],
    ['table version', (t, v) => { t.version = v; }],
    ['hit policy', (t, v) => { t.hitPolicy = v; }],
    ['input name', (t, v) => { t.inputs[0].name = v; }],
    ['input type', (t, v) => { t.inputs[0].type = v; }],
    ['reason code', (t, v) => { t.reasonCodes[0].code = v; }],
    ['reason class', (t, v) => { t.reasonCodes[0].class = v; }],
    ['unknown reason', (t, v) => { t.onUnknown.reason = v; }],
    ['no-match reason', (t, v) => { t.onNoMatch.reason = v; }],
    ['strategy name', (t, v) => { t.strategies.names.push(v); }],
    ['prototype kind', (t, v) => { t.prototypeStepKinds.push(v); }],
    ['rule id', (t, v) => { t.rules[0].id = v; }],
    ['rule rank', (t, v) => { t.rules[0].rank = v; }],
    ['output strategy', (t, v) => { t.rules[0].output.strategy = v; }],
    ['output reason', (t, v) => { t.rules[0].output.reason = v; }],
    ['boolean condition', (t, v) => { t.rules[0].when['security-open'].eq = v; }],
    ['enum condition', (t, v) => { row(t, 'R2').when.blocker.eq = v; }],
    ...['belowSetting', 'atLeastSetting', 'atMostSetting'].map((k) => [
      k, (t, v) => { row(t, 'R3').when['live-overlays'] = { [k]: v }; },
    ]),
  ])('SHIP-WM-158/160: malformed JSON at %s is refused through validation and selection', (_, mutate) => {
    for (const value of [{ toString: null }, [{ toString: null }]]) {
      const changed = clone(table);
      mutate(changed, value);
      const jsonTable = JSON.parse(JSON.stringify(changed));
      expect(tableFindings({ table: jsonTable }).length).toBeGreaterThan(0);
      expect(run({}, { table: jsonTable })).toMatchObject({
        rule: 'unconfigured', strategy: 'unhandled', reason: 'EVIDENCE_UNKNOWN', build: false,
      });
      expect(decisionFindings({ record: decision(), table: jsonTable, settings }).length).toBeGreaterThan(0);
      expect(replayFindings({ table: jsonTable, settings, points: replay.points }).length).toBeGreaterThan(0);
    }
  });
  it('SHIP-WM-158: malformed contract names fail closed before property-key coercion', () => {
    const strategies = [{ name: { toString: null }, feedsGates: true }];
    expect(tableFindings({ table, strategies }).length).toBeGreaterThan(0);
    expect(run({}, { strategies })).toMatchObject({ rule: 'unconfigured', strategy: 'unhandled', build: false });
  });
  it('SHIP-WM-161/173: sibling diagnostics do not coerce malformed JSON metadata', () => {
    const bad = JSON.parse('{"toString":null}');
    const record = decision();
    record.decisionId = bad;
    record.table.version = bad;
    expect(decisionFindings({ record, table, settings }).length).toBeGreaterThan(0);
    expect(tableChangeFindings({ from: table, to: { ...table, version: bad } }).length).toBeGreaterThan(0);
    const point = clone(replay.points[0]);
    point.at = bad;
    point.candidates[0].id = bad;
    expect(replayFindings({ table, settings, points: [point] }).length).toBeGreaterThan(0);
  });
  it('SHIP-WM-159: tied rank is refused', () => refused(159, (t) => { row(t, 'R2').rank = row(t, 'R1').rank; }));
  it('SHIP-WM-159: undeclared input is refused', () => refused(159, (t) => { row(t, 'R3').when.secret = { eq: true }; }));
  it('SHIP-WM-159: undeclared setting is refused', () => refused(159, (t) => { row(t, 'R3').when['live-overlays'] = { belowSetting: 'undeclared-cap' }; }));
  it('SHIP-WM-159: setting comparison on a non-count is refused', () => refused(159, (t) => { row(t, 'R3').when['targets-can-adopt'] = { belowSetting: 'overlay-cap' }; }));
  it('SHIP-WM-159: undeclared enum value is refused', () => refused(159, (t) => { row(t, 'R2').when.blocker.eq = 'invented'; }));
  it('SHIP-WM-159: undeclared strategy is refused', () => refused(159, (t) => { row(t, 'R10').output.strategy = 'invented'; }));
  it('SHIP-WM-159: undeclared reason is refused', () => refused(159, (t) => { row(t, 'R10').output.reason = 'INVENTED'; }));
  it('SHIP-WM-159: reason class must fit its outcome', () => refused(159, (t) => { row(t, 'R10').output.reason = 'STALLED_GATE'; }));
  it('SHIP-WM-157: security row missing is refused', () => refused(157, (t) => { t.rules = t.rules.filter((r) => r.id !== 'R1'); }));
  it('SHIP-WM-157: security floor after a strategy row is refused', () => refused(157, (t) => { row(t, 'R1').rank = 100; }));
  it('SHIP-WM-157: a conditional security floor cannot waive security for other candidates', () => refused(157, (t) => { row(t, 'R1').when['hold-causer'] = { eq: true }; }));
  it('SHIP-WM-157: open security finding gives unhandled/SECURITY_FLOOR', () => outcome(run({ 'security-open': true }), 'unhandled', 'SECURITY_FLOOR'));
  it.each([undefined, {}, { ...table, rules: null }, { ...table, inputs: [null] }])('SHIP-WM-158: malformed table is unconfigured', (bad) => {
    expect(tableFindings({ table: bad }).length).toBeGreaterThan(0);
    outcome(run({}, { table: bad }), 'unhandled', 'EVIDENCE_UNKNOWN');
  });
  it.each(['boolean', 'count', 'enum', 'invalid'])('SHIP-WM-158: malformed values on a %s declaration are refused without throwing', (type) => {
    for (const values of [{}, 'none,stage,hold', true, 1, null]) {
      for (const name of ['blocker', 'step-kind']) {
        const changed = clone(table);
        Object.assign(changed.inputs.find((i) => i.name === name), { type, values });
        expect(tableFindings({ table: changed }).length).toBeGreaterThan(0);
        expect(run({}, { table: changed })).toMatchObject({ rule: 'unconfigured', strategy: 'unhandled', build: false });
      }
    }
  });
});

describe('SHIP-WM-164/165/166/168/170/178: mandatory row entries', () => {
  it('SHIP-WM-164: stalled-stage hold row missing is refused', () => refused(164, (t) => { t.rules = t.rules.filter((r) => r.id !== 'R6'); }));
  it('SHIP-WM-164: stalled-stage hold row must precede a gate-feeding row', () => refused(164, (t) => { row(t, 'R6').rank = 100; }));
  it.each([{ eq: 'hold' }, { eq: 'stage' }, { in: ['stage', 'hold'] }])('SHIP-WM-164: blocker %j alone does not prove an early gate-feeding candidate clears the hold', (blocker) => {
    const changed = clone(table);
    row(changed, 'R10').rank = 5;
    row(changed, 'R5').rank = 20;
    row(changed, 'R10').when.blocker = blocker;
    row(changed, 'R10').when['loaded-stage-stress'] = { eq: 'clear' };
    expect(tableFindings({ table: changed }).some((f) => f.includes('SHIP-WM-164'))).toBe(true);
    const got = run({ blocker: 'hold', 'hold-causer': false, 'loads-stalled-stage': true }, { table: changed });
    expect(got.build).toBe(false);
    expect(['hold', 'unhandled']).toContain(got.strategy);
    row(changed, 'R10').when['hold-causer'] = { eq: false };
    expect(tableFindings({ table: changed }).some((f) => f.includes('SHIP-WM-164'))).toBe(true);
    row(changed, 'R10').when['hold-causer'] = { eq: true };
    expect(tableFindings({ table: changed })).toEqual([]);
    const candidate = { blocker: blocker.eq ?? 'hold', 'hold-causer': true, 'loads-stalled-stage': true };
    outcome(run(candidate, { table: changed }), 'normal-pr', 'NORMAL_CAPACITY');
    outcome(run({ ...candidate, 'hold-causer': false }, { table: changed }), 'hold', 'STALLED_GATE');
  });
  it('SHIP-WM-164: stalled stage holds before normal-pr and build-ahead', () => {
    outcome(run({ 'loads-stalled-stage': true }), 'hold', 'STALLED_GATE');
    outcome(run({ 'loads-stalled-stage': true, 'loaded-stage-stress': 'stressed', 'stress-incident': 'fix-landed' }), 'hold', 'STALLED_GATE');
  });
  it.each(['step-kind', 'targets-can-adopt', 'audit-state', 'overlay-loadable', 'live-overlays'])('SHIP-WM-165: prototype row requires %s', (key) => refused(165, (t) => { delete row(t, 'R3').when[key]; }));
  it('SHIP-WM-165: prototype kind must be a declared step kind', () => refused(165, (t) => { t.prototypeStepKinds.push('invented'); }));
  it.each([
    ['fail', true, 'normal-pr', 'NORMAL_CAPACITY'],
    ['delta-owed', true, 'normal-pr', 'NORMAL_CAPACITY'],
    ['pass', false, 'normal-pr', 'NORMAL_CAPACITY'],
  ])('SHIP-WM-165: audit %s, overlay %s yields the exact fallback', (audit, overlay, strategy, reason) => {
    outcome(run({ 'step-kind': 'daemon-fix', blocker: 'stage', 'audit-state': audit, 'overlay-loadable': overlay }), strategy, reason);
  });
  it('SHIP-WM-165: overlay cap boundary prevents prototype selection', () => {
    outcome(run({ 'step-kind': 'daemon-fix', blocker: 'stage', 'live-overlays': settings.values['overlay-cap'] }), 'normal-pr', 'NORMAL_CAPACITY');
  });
  it.each(['blocker', 'hold-causer', 'targets-can-adopt'])('SHIP-WM-166: hold incident row requires %s', (key) => refused(166, (t) => { delete row(t, 'R2').when[key]; }));
  it.each(['red-interval-open', 'red-recovery-candidate'])('SHIP-WM-166: red incident row requires %s', (key) => refused(166, (t) => { delete row(t, 'R4').when[key]; }));
  it('SHIP-WM-166: hold-causer uses incident only while targets cannot adopt', () => {
    const over = { 'step-kind': 'daemon-fix', blocker: 'hold', 'hold-causer': true };
    outcome(run({ ...over, 'targets-can-adopt': false }), 'incident', 'HOLD_CLEAR_NO_ADOPT');
    outcome(run({ ...over, 'targets-can-adopt': true }), 'prototype-first', 'BLOCKER_OVERLAY_ELIGIBLE');
  });
  it('SHIP-WM-166: open red interval needs its recovery candidate', () => {
    outcome(run({ 'red-interval-open': true, 'red-recovery-candidate': true }), 'incident', 'RED_MAIN_RECOVERY');
    outcome(run({ 'red-interval-open': true }), 'normal-pr', 'NORMAL_CAPACITY');
  });
  it.each(['review-rounds', 'non-convergence-evidence'])('SHIP-WM-168: design-pass row requires %s', (key) => refused(168, (t) => { delete row(t, 'R5').when[key]; }));
  it('SHIP-WM-168: high rounds need non-convergence evidence', () => {
    const over = { 'review-rounds': settings.values['design-pass-after-rounds'] };
    outcome(run(over), 'normal-pr', 'NORMAL_CAPACITY');
    outcome(run({ ...over, 'non-convergence-evidence': true }), 'design-pass-first', 'REVIEW_NON_CONVERGING');
    outcome(run({ 'non-convergence-evidence': true }), 'normal-pr', 'NORMAL_CAPACITY');
  });
  it.each(['loaded-stage-stress', 'stress-incident'])('SHIP-WM-170: build-ahead row requires %s', (key) => refused(170, (t) => { delete row(t, 'R7').when[key]; }));
  it('SHIP-WM-170/181: stressed stages without a landed incident fix hold; landed fix permits build-ahead', () => {
    outcome(run({ 'loaded-stage-stress': 'stressed' }), 'hold', 'STAGE_STRESSED');
    outcome(run({ 'loaded-stage-stress': 'stressed', 'stress-incident': 'fix-not-landed' }), 'hold', 'STAGE_STRESSED');
    outcome(run({ 'loaded-stage-stress': 'stressed', 'stress-incident': 'fix-landed' }), 'build-ahead', 'KNOWN_INCIDENT_FIX_LANDED');
  });
  it('SHIP-WM-170: normal gate-feeding row ahead of stress hold is refused', () => refused(170, (t) => { row(t, 'R10').rank = 0; }));
  it('SHIP-WM-178: literal number in a condition is refused', () => refused(178, (t) => { row(t, 'R3').when['live-overlays'] = { eq: 2 }; }));
  it('SHIP-WM-178: literal number in the settings list is refused', () => refused(178, (t) => { t.settings.push(3); }));
});

describe('SHIP-WM-161/162/163/173: deterministic records, order and table lineage', () => {
  it('SHIP-WM-161: repeated selection is byte-equal without reading a clock or mutating inputs', () => {
    const args = { table: clone(table), settings: clone(settings), inputs: inputs(), at };
    const before = JSON.stringify(args);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock read'); });
    try {
      expect(JSON.stringify(select(args))).toBe(JSON.stringify(select(clone(args))));
      expect(JSON.stringify(args)).toBe(before);
    } finally {
      clock.mockRestore();
    }
  });
  it('SHIP-WM-161: undeclared observations do not influence selection', () => {
    const recorded = inputs();
    recorded['not-declared'] = observation('whatever');
    expect(JSON.stringify(run({}, { inputs: recorded }))).toBe(JSON.stringify(run()));
  });
  it('SHIP-WM-162: complete decision record replays', () => {
    expect(decisionFindings({ record: decision(), table, settings })).toEqual([]);
  });
  it.each([false, true])('SHIP-WM-161: custom strategy contracts (feedsGates=%s) survive decision and golden replay', (feedsGates) => {
    const changed = clone(table);
    changed.strategies.closed = false;
    changed.strategies.names.push('x-custom');
    row(changed, 'R10').output.strategy = 'x-custom';
    const strategies = table.strategies.names.map((name) => ({ name, feedsGates: ['normal-pr', 'build-ahead', 'stacked'].includes(name) }));
    strategies.push({ name: 'x-custom', feedsGates });
    expect(tableFindings({ table: changed, strategies })).toEqual([]);
    const recorded = inputs();
    const got = select({ table: changed, settings, inputs: recorded, at, strategies });
    expect(got).toMatchObject({ rule: 'R10', strategy: 'x-custom', build: true });
    const record = { ...decision(), ...got, inputs: recorded, table: { uri: changed.id, version: changed.version, digest: digestOf(changed) } };
    expect(decisionFindings({ record, table: changed, settings, strategies })).toEqual([]);
    const points = [{ at, candidates: [{ id: '#example', planOrder: 1, inputs: recorded }], expected: { order: ['#example'], outputs: { '#example': got } } }];
    expect(replayFindings({ table: changed, settings, points, strategies })).toEqual([]);
    // Missing contracts are refused at table load, before decision replay.
    expect(decisionFindings({ record, table: changed, settings })).toEqual([
      `table ${changed.name}@${changed.version}: strategy x-custom has no contract: refused (SHIP-WM-154)`,
    ]);
    expect(select({ table: changed, settings, inputs: recorded, at })).toMatchObject({
      rule: 'unconfigured', strategy: 'unhandled', build: false, reason: 'EVIDENCE_UNKNOWN',
    });
    expect(replayFindings({ table: changed, settings, points }).length).toBeGreaterThan(0);
  });
  it.each(DECISION_FIELDS)('SHIP-WM-162: decision missing %s is refused', (field) => {
    const record = decision();
    delete record[field];
    expect(decisionFindings({ record, table, settings }).some((f) => f.includes(`field ${field} is absent`))).toBe(true);
  });
  it.each(['value', 'observedAt', 'source', 'fresh'])('SHIP-WM-162: recorded observation needs %s', (field) => {
    const record = decision();
    delete record.inputs['security-open'][field];
    expect(decisionFindings({ record, table, settings }).some((f) => f.includes('SHIP-WM-162'))).toBe(true);
  });
  it('SHIP-WM-161: tampered output is refused by replay', () => {
    const record = decision();
    record.strategy = 'incident';
    expect(decisionFindings({ record, table, settings }).some((f) => f.includes('SHIP-WM-161'))).toBe(true);
  });
  it('SHIP-WM-163: hold-causer first order, then plan order, without mutating candidates', () => {
    const candidates = [{ id: 'product', planOrder: 1 }, { id: 'late', planOrder: 3 }, { id: 'hold', planOrder: 9, clearsHold: true }, { id: 'early', planOrder: 2 }];
    const before = clone(candidates);
    expect(candidateOrder(candidates)).toEqual(['hold', 'product', 'early', 'late']);
    expect(candidates).toEqual(before);
    expect(orderFindings({ candidates, order: ['product', 'hold', 'early', 'late'] })[0]).toContain('SHIP-WM-163');
  });
  it('SHIP-WM-173: table change needs a new version and digest with supersedes pin', () => {
    expect(tableChangeFindings({ from: table, to: clone(table) })).toEqual([]);
    const to = clone(table);
    to.description += ' changed';
    expect(tableChangeFindings({ from: table, to })[0]).toContain('silent edit');
    to.version += '-next';
    expect(tableChangeFindings({ from: table, to })[0]).toContain('supersedes');
    to.supersedes = { version: table.version, digest: digestOf(table) };
    expect(digestOf(to)).not.toEqual(digestOf(table));
    expect(tableChangeFindings({ from: table, to })).toEqual([]);
    to.supersedes.digest = { sha256: 'wrong' };
    expect(tableChangeFindings({ from: table, to })[0]).toContain('SHIP-WM-173');
  });
  it.each(['uri', 'version', 'digest'])('SHIP-WM-173: replay refuses a mismatching table %s pin', (field) => {
    const record = decision();
    record.table[field] = 'wrong';
    expect(decisionFindings({ record, table, settings }).some((f) => f.includes('SHIP-WM-173'))).toBe(true);
  });
  it('SHIP-WM-162: replay refuses mismatching settings revision and digest', () => {
    for (const field of ['revision', 'digest']) {
      const record = decision();
      record.settings[field] = 'wrong';
      expect(decisionFindings({ record, table, settings }).some((f) => f.includes('SHIP-WM-162'))).toBe(true);
    }
  });
  it('SHIP-WM-161: canonical digest ignores object insertion order', () => {
    expect(canon({ b: 2, a: [true, null] })).toBe(canon({ a: [true, null], b: 2 }));
    expect(digestOf({ b: 2, a: 1 })).toEqual(digestOf({ a: 1, b: 2 }));
  });
});
