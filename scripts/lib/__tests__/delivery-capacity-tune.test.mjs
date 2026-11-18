import { describe, expect, it, vi } from 'vitest';
import { aimdStep, summarizeMerged, shadowTune, renderTuneLine } from '../delivery-capacity-tune.mjs';
import { DELIVERY_CAPACITY_DEFAULTS, assessCapacity } from '../delivery-capacity.mjs';
import { finishDeliveryCapacity } from '../../operations/delivery-capacity.mjs';
import { createDeliveryCapacityTune } from '../../operations/delivery-capacity-tune-shell.mjs';
import { renderOutcome } from '../../operations/cli-adapter.mjs';

const H = 3600000;
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const policy = structuredClone(DELIVERY_CAPACITY_DEFAULTS);
const resources = { heavyWaitMin: 0, lanesFree: 5, prs: [] };
const healthy = { merges: 20, medianTtmH: 4, meanRounds: 1.8, idlePct: 30, memGb: 8, capBinding: true };
const step = (over = {}, extra = {}) => aimdStep({ cap: 30, signals: { ...healthy, ...over }, policy, last: null, nowMs: NOW, ...extra });

describe('autoTune settings defaults', () => {
  it('match the S2 design exactly', () => {
    expect(DELIVERY_CAPACITY_DEFAULTS.autoTune).toEqual({
      mode: 'shadow', everyMin: 60, windowH: 6, minMerges: 10, ttmTargetH: 6, backoffFactor: 1.5,
      roundsTarget: 2.0, increase: 2, decrease: 0.8, minUnits: 12, maxUnits: 48, raiseOnlyIfBinding: true,
      heavyWaitMaxMin: 10, lanesFreeMin: 3, activeHighRatio: 0.6, activeLowRatio: 0.3,
      sessionUnits: 1, minutesPerUnit: 30, laneUnits: 0.5, rebaseUnits: 0.25,
    });
  });
});

describe('aimdStep table', () => {
  it('raises by +2 when healthy and the cap was binding', () => {
    expect(step()).toMatchObject({ action: 'raise', from: 30, to: 32, changed: true });
  });
  it('holds when healthy but the cap was never binding', () => {
    const r = step({ capBinding: false });
    expect(r).toMatchObject({ action: 'hold', to: 30, changed: false });
    expect(r.reason).toMatch(/binding/);
  });
  it.each([
    ['slow merges', { medianTtmH: 9.5 }],
    ['many rounds', { meanRounds: 3.2 }],
    ['low idle', { idlePct: 5 }],
    ['low memory', { memGb: 1 }],
  ])('lowers x0.8 on %s', (_n, over) => {
    expect(step(over)).toMatchObject({ action: 'lower', from: 30, to: 24, changed: true });
  });
  it('does not lower at exactly target x backoff', () => {
    expect(step({ medianTtmH: 9 }).action).not.toBe('lower');
  });
  it('clamps to bounds', () => {
    expect(aimdStep({ cap: 47, signals: healthy, policy, last: null, nowMs: NOW })).toMatchObject({ to: 48 });
    expect(aimdStep({ cap: 48, signals: healthy, policy, last: null, nowMs: NOW })).toMatchObject({ action: 'hold', to: 48, changed: false });
    expect(aimdStep({ cap: 13, signals: { ...healthy, idlePct: 1 }, policy, last: null, nowMs: NOW })).toMatchObject({ to: 12 });
    expect(aimdStep({ cap: 12, signals: { ...healthy, idlePct: 1 }, policy, last: null, nowMs: NOW })).toMatchObject({ action: 'hold', to: 12 });
  });
  it('holds inside the everyMin cooldown after a change, then allows the next', () => {
    const last = { tsMs: NOW - 30 * 60000, changed: true, to: 30 };
    expect(step({}, { last })).toMatchObject({ action: 'hold', changed: false });
    expect(step({}, { last }).reason).toMatch(/cooldown/);
    expect(step({}, { last: { ...last, tsMs: NOW - 61 * 60000 } }).changed).toBe(true);
  });
  it('holds with a reason when there are too few merges', () => {
    const r = step({ merges: 9, medianTtmH: 99 });
    expect(r).toMatchObject({ action: 'hold', changed: false });
    expect(r.reason).toMatch(/too few merges \(9 < 10\)/);
  });
  it('is deterministic on replay', () => {
    expect(step()).toEqual(step());
  });
  it('holds with a reason when host evidence is unreadable', () => {
    expect(step({ idlePct: null }).changed).toBe(false);
  });
});

describe('summarizeMerged', () => {
  const pr = (n, startH, endH, events = []) => ({ number: n, createdAt: new Date(NOW - startH * H).toISOString(),
    mergedAt: new Date(NOW - endH * H).toISOString(), events });
  it('excludes time under hold labels and counts review:changes rounds', () => {
    const prs = [
      pr(1, 5, 1, [{ at: new Date(NOW - 4 * H).toISOString(), label: 'review:human', type: 'labeled' },
        { at: new Date(NOW - 2 * H).toISOString(), label: 'review:human', type: 'unlabeled' },
        { at: new Date(NOW - 3 * H).toISOString(), label: 'review:changes', type: 'labeled' }]),
      pr(2, 3, 1),
    ];
    const s = summarizeMerged(prs, { holdLabels: policy.holdLabels, nowMs: NOW, windowH: 6 });
    expect(s.merges).toBe(2);
    expect(s.medianTtmH).toBeCloseTo(2, 5); // PR1: 4h minus 2h held = 2h; PR2: 2h
    expect(s.meanRounds).toBeCloseTo(1.5, 5);
  });
  it('treats a hold label never removed as held until merge, and ignores PRs merged outside the window', () => {
    const prs = [pr(1, 5, 1, [{ at: new Date(NOW - 3 * H).toISOString(), label: 'blocked', type: 'labeled' }]), pr(2, 20, 10)];
    const s = summarizeMerged(prs, { holdLabels: policy.holdLabels, nowMs: NOW, windowH: 6 });
    expect(s.merges).toBe(1);
    expect(s.medianTtmH).toBeCloseTo(2, 5);
  });
});

describe('shadowTune and render', () => {
  const readout = assessCapacity({ prs: [], host: { idlePct: 30, memGb: 8 }, policy: { ...policy, mode: 'units' } });
  const merged = Array.from({ length: 12 }, (_, i) => ({ number: i, createdAt: new Date(NOW - 5 * H).toISOString(),
    mergedAt: new Date(NOW - H).toISOString(), events: [] }));
  it('renders the would-set line and builds one jsonl row', () => {
    const out = shadowTune({ resources, readout: { ...readout, used: 31, cap: 30, verdict: 'deliver' }, policy, merged, rows: [], nowMs: NOW });
    expect(out.line).toMatch(/^auto-tune \(shadow\): would set unitCap 30→32 because /);
    expect(out.row).toMatchObject({ schema: 'deliveryCapacity.tune.v1', mode: 'shadow', from: 30, to: 32, action: 'raise', tsMs: NOW });
    expect(renderTuneLine(out.row)).toBe(out.line);
  });
  it('chains from the last row cap and treats a prior binding row inside the window as binding', () => {
    const rows = [{ tsMs: NOW - 2 * H, changed: true, to: 34, binding: true, bindingNow: true }];
    const out = shadowTune({ resources, readout, policy, merged, rows, nowMs: NOW });
    expect(out.row.from).toBe(34);
    expect(out.row.binding).toBe(true);
  });
  it('is off when mode is off', () => {
    const off = { ...policy, autoTune: { ...policy.autoTune, mode: 'off' } };
    expect(shadowTune({ resources, readout, policy: off, merged, rows: [], nowMs: NOW })).toBeNull();
  });
  it('repeated cooldown hold rows cannot shorten the last adjustment cooldown', () => {
    const bindingReadout = { ...readout, verdict: 'deliver' };
    const rows = [];
    const check = minutes => {
      const out = shadowTune({ resources, readout: bindingReadout, policy, merged, rows, nowMs: NOW + minutes * 60000 });
      rows.push(out.row);
      return out.row;
    };
    expect(check(0)).toMatchObject({ action: 'raise', from: 30, to: 32, changed: true });
    expect(check(1)).toMatchObject({ action: 'hold', from: 32, to: 32, changed: false, reason: 'cooldown' });
    expect(check(2)).toMatchObject({ action: 'hold', from: 32, to: 32, changed: false, reason: 'cooldown' });
    expect(check(59)).toMatchObject({ action: 'hold', from: 32, to: 32, changed: false, reason: 'cooldown' });
    expect(check(60)).toMatchObject({ action: 'raise', from: 32, to: 34, changed: true });
  });
  it('IO shell preserves adjustment cooldown after more than 200 journaled holds', () => {
    let journal = JSON.stringify({ schema: 'deliveryCapacity.tune.v1', action: 'raise',
      from: 30, to: 32, changed: true, tsMs: NOW - 30 * 60000 }) + '\n', nowMs = NOW;
    const io = {
      statSync: () => ({ size: journal.length }),
      readFileSync: () => journal,
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn((_file, line) => { journal += line; }),
    };
    const exec = vi.fn(() => JSON.stringify({ data: { search: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: merged.map(pr => ({ number: pr.number, createdAt: pr.createdAt, mergedAt: pr.mergedAt,
        timelineItems: { nodes: [], pageInfo: { hasNextPage: false } } })),
    } } }));
    const tune = createDeliveryCapacityTune({ resolvePolicy: () => ({ value: policy }),
      coordinationRoot: () => 'coordination-fixture', io, exec, now: () => nowMs });
    const check = () => {
      const out = tune({ ...readout, verdict: 'deliver' });
      expect(out).not.toBeNull();
      expect(JSON.parse(journal.trim().split('\n').at(-1))).toEqual(out.row);
      return out.row;
    };
    expect(check()).toMatchObject({ action: 'hold', from: 32, to: 32, changed: false, reason: 'cooldown' });
    for (let second = 1; second <= 205; second++) {
      nowMs = NOW + second * 1000;
      expect(check()).toMatchObject({ action: 'hold', from: 32, to: 32, changed: false, reason: 'cooldown' });
    }
    nowMs = NOW + 60 * 60000;
    expect(check()).toMatchObject({ action: 'hold', from: 32, to: 32, changed: false, reason: 'resource evidence unreadable' });
    nowMs += 1000;
    expect(check()).toMatchObject({ action: 'hold', from: 32, to: 32, changed: false, reason: 'resource evidence unreadable' });
    expect(io.appendFileSync).toHaveBeenCalledTimes(208);
  });
});

describe('audit regressions', () => {
  const merged = Array.from({ length: 12 }, (_, i) => ({ number: i, createdAt: new Date(NOW - 5 * H).toISOString(),
    mergedAt: new Date(NOW - H).toISOString(), events: [] }));
  it('a carried binding does not renew itself: no raise 10h after the last real binding', () => {
    const base = assessCapacity({ prs: [], host: { idlePct: 30, memGb: 8 }, policy: { ...policy, mode: 'units' } });
    const rows = [];
    let out = shadowTune({ resources, readout: { ...base, verdict: 'deliver' }, policy, merged, rows, nowMs: NOW });
    rows.push(out.row);
    for (let h = 1; h <= 10; h++) {
      out = shadowTune({ resources, readout: base, policy, merged, rows, nowMs: NOW + h * H });
      rows.push(out.row);
    }
    expect(rows[0]).toMatchObject({ action: 'raise', to: 32 });
    expect(out.row.binding).toBe(false);
    expect(out.row.changed).toBe(false);
    expect(out.row.reason).toBe('cap was not binding');
  });
  it('overload (gate closed on low idle) recommends lowering instead of holding on unreadable host', () => {
    const readout = assessCapacity({ prs: [], host: { idlePct: 3, memGb: 8 }, policy: { ...policy, mode: 'units' } });
    expect(readout.why[0]).toMatch(/^gate closed \(idle 3% mem 8GB\)$/);
    const out = shadowTune({ resources, readout, policy, merged, rows: [], nowMs: NOW });
    expect(out.row).toMatchObject({ action: 'lower', from: 30, to: 24 });
  });
});

describe('audit regressions 2', () => {
  it('partial label timelines block a raise but not a lower', () => {
    expect(step({ partial: 2 })).toMatchObject({ action: 'hold', changed: false });
    expect(step({ partial: 2 }).reason).toMatch(/partial/);
    expect(step({ partial: 2, medianTtmH: 20 }).action).toBe('lower');
  });
  it('summarizeMerged counts partial PRs', () => {
    const pr = { number: 1, createdAt: new Date(NOW - 3 * H).toISOString(), mergedAt: new Date(NOW - H).toISOString(), events: [], partial: true };
    expect(summarizeMerged([pr], { holdLabels: [], nowMs: NOW, windowH: 6 }).partial).toBe(1);
  });
  it('a malformed journal row fails closed: no row, no change', () => {
    const io = { statSync: () => ({ size: 10 }), readFileSync: () => '{"tsMs":1,"to":3\n', mkdirSync: vi.fn(), appendFileSync: vi.fn() };
    const exec = vi.fn(() => '{}');
    const tune = createDeliveryCapacityTune({ resolvePolicy: () => ({ value: policy }), coordinationRoot: () => 'x', io, exec, now: () => NOW });
    expect(tune({ verdict: 'deliver', used: 1, cap: 30, why: ['gate open (idle 30% mem 8GB)'] })).toBeNull();
    expect(io.appendFileSync).not.toHaveBeenCalled();
  });
});

describe('audit regressions 3', () => {
  it('a foreign journal row without schema/changed fails closed', () => {
    const io = { statSync: () => ({ size: 10 }), readFileSync: () => JSON.stringify({ to: 32, tsMs: NOW - 1000 }) + '\n', mkdirSync: vi.fn(), appendFileSync: vi.fn() };
    const tune = createDeliveryCapacityTune({ resolvePolicy: () => ({ value: policy }), coordinationRoot: () => 'x', io, exec: vi.fn(() => '{}'), now: () => NOW });
    expect(tune({ verdict: 'deliver', used: 1, cap: 30, why: ['gate open (idle 30% mem 8GB)'] })).toBeNull();
    expect(io.appendFileSync).not.toHaveBeenCalled();
  });
});

describe('audit regressions 4', () => {
  it('count-mode saturation is not unit-cap binding', () => {
    const base = assessCapacity({ prs: [], host: { idlePct: 30, memGb: 8 }, policy });
    const out = shadowTune({ resources, readout: { ...base, mode: 'count', used: 18, cap: 18, verdict: 'deliver' }, policy,
      merged: Array.from({ length: 12 }, (_, i) => ({ number: i, createdAt: new Date(NOW - 5 * H).toISOString(), mergedAt: new Date(NOW - H).toISOString(), events: [] })), rows: [], nowMs: NOW });
    expect(out.row).toMatchObject({ binding: false, changed: false, reason: 'cap was not binding' });
  });
  it('a contradictory journal row fails closed', () => {
    const row = { schema: 'deliveryCapacity.tune.v1', action: 'raise', from: 30, to: 32, changed: false, tsMs: NOW - 1000 };
    const io = { statSync: () => ({ size: 10 }), readFileSync: () => JSON.stringify(row) + '\n', mkdirSync: vi.fn(), appendFileSync: vi.fn() };
    const tune = createDeliveryCapacityTune({ resolvePolicy: () => ({ value: policy }), coordinationRoot: () => 'x', io, exec: vi.fn(() => '{}'), now: () => NOW });
    expect(tune({ mode: 'units', verdict: 'deliver', used: 1, cap: 30, why: ['gate open (idle 30% mem 8GB)'] })).toBeNull();
    expect(io.appendFileSync).not.toHaveBeenCalled();
  });
});

describe('shadow is inert', () => {
  const verdict = assessCapacity({ prs: [], host: { idlePct: 30, memGb: 8 }, policy: { ...policy, mode: 'units' } });
  const tuned = { line: 'auto-tune (shadow): would set unitCap 30→24 because x', row: { to: 24 } };
  it('never changes the enforced verdict, cap or slots in plain or json mode', () => {
    const before = structuredClone(verdict);
    const plain = finishDeliveryCapacity({ run: { verdict }, code: 0, lines: ['raw'] }, { tune: () => tuned });
    expect(plain.lines.at(-1)).toBe(tuned.line);
    const envelope = { runId: 'capacity-run', op: 'delivery-capacity', stopped: 'complete', verdict };
    const json = finishDeliveryCapacity({ run: { verdict }, code: 0, lines: [JSON.stringify(envelope)], json: true }, { tune: () => tuned });
    const parsed = JSON.parse(json.lines.join('\n'));
    expect(parsed).toEqual({ ...envelope, autoTune: tuned.row });
    expect(parsed.autoTune).toEqual(tuned.row);
    expect(verdict).toEqual(before);
  });
  it.each([
    ['shadow', 12, 'complete', 'hold'],
    ['shadow', 0, 'complete', 'hold'],
    ['on', 12, 'error', 'hold'],
  ])('preserves the adapter JSON envelope after a successful %s journal append (%i merges, %s)', (mode, merges, stopped, action) => {
    const run = { id: 'capacity-run', op: 'delivery-capacity', verdict: { ...verdict, used: verdict.cap, verdict: 'deliver' },
      effects: [], pending: null, findings: [{ key: 'capacity-evidence' }], telemetry: [], outcome: 'observed' };
    const before = structuredClone(run);
    const rendered = renderOutcome({ outcome: { run, stopped, applied: ['read'],
      error: stopped === 'error' ? new Error('adapter diagnostic') : null }, json: true });
    // Preserve fields supplied by the adapter even if the finish hook does not know them.
    const envelope = { ...JSON.parse(rendered.lines.join('\n')), futureField: { retained: true } };
    const lines = JSON.stringify(envelope, null, 2).split('\n');
    const io = { statSync: () => ({ size: 0 }), readFileSync: () => '', mkdirSync: vi.fn(), appendFileSync: vi.fn() };
    const exec = vi.fn(() => JSON.stringify({ data: { search: {
      pageInfo: { hasNextPage: false },
      nodes: Array.from({ length: merges }, (_, number) => ({ number,
        createdAt: new Date(NOW - 5 * H).toISOString(), mergedAt: new Date(NOW - H).toISOString(),
        timelineItems: { nodes: [], pageInfo: { hasNextPage: false } } })),
    } } }));
    const tune = createDeliveryCapacityTune({ resolvePolicy: () => ({ value: { ...policy,
      autoTune: { ...policy.autoTune, mode } } }), coordinationRoot: () => 'coordination-fixture', io, exec, now: () => NOW });
    const out = finishDeliveryCapacity({ run, ...rendered, lines, json: true }, { tune });
    expect(io.appendFileSync).toHaveBeenCalledTimes(1);
    const row = JSON.parse(io.appendFileSync.mock.calls[0][1]);
    expect(row.action).toBe(action);
    expect(out.code).toBe(rendered.code);
    expect(JSON.parse(out.lines.join('\n'))).toEqual({ ...envelope, autoTune: row });
    expect(run).toEqual(before);
  });
  it.each(['off', 'throw', 'invalid-json'])('preserves the original JSON output on %s fallback', kind => {
    const lines = kind === 'invalid-json' ? ['invalid json'] : [JSON.stringify({ runId: 'capacity-run', verdict })];
    const tune = kind === 'off' ? () => null : kind === 'throw' ? () => { throw new Error('boom'); } : () => tuned;
    expect(finishDeliveryCapacity({ run: { verdict }, code: 7, lines, json: true }, { tune })).toEqual({ code: 7, lines });
  });
  it('a throwing tune never fails the readout', () => {
    const out = finishDeliveryCapacity({ run: { verdict }, code: 0, lines: ['raw'] }, { tune: vi.fn(() => { throw new Error('boom'); }) });
    expect(out.code).toBe(0);
    expect(out.lines).toHaveLength(2);
  });
});
