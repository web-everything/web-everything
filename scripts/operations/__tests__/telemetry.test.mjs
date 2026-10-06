/**
 * @file scripts/operations/__tests__/telemetry.test.mjs
 * @description Tests for the delivery-telemetry schema, store, recorder and read shell (#3383).
 *
 * The load-bearing thing these tests protect is NOT that a span has the right fields — it is that a telemetry
 * bug can never break a delivery. So the suite is weighted towards the failure paths: a store that throws, a
 * clock that throws, an attribute bag full of hostile values, an oversized record, a torn last line. Every one
 * of those must degrade to "less telemetry", never to a thrown exception reaching a wrapper.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DISPATCH_KINDS, DURABLE_SPAN_NAMES, ERROR_OUTCOMES, MAX_ATTRIBUTE_KEYS, MAX_LINE_BYTES, MAX_VALUE_LENGTH,
  METRIC_NAMES, METRIC_UNITS, OK_OUTCOMES, SPAN_NAMES, SPAN_STATUS, TELEMETRY_SCHEMA_VERSION,
  DEFAULT_SUBSTANTIAL_CPU_PCT, DEFAULT_SUBSTANTIAL_MEM_BYTES,
  classifyOutcomeStatus, deriveTraceId, durationMs, goldenSignals, groupByTrace, newMetric, newSpanEnd,
  newSpanStart, normItemKey, normalizeAttributes, parseTelemetryLine, parseTelemetryLines, percentile,
  serializeTelemetryEvent, summarizeHostProcesses, truncateValue, validateTelemetryEvent,
} from '../telemetry.mjs';
import {
  activeRecorder, createFileTelemetryStore, createMemoryTelemetryStore, createNullRecorder,
  createTelemetryRecorder, dayKey, readGitResource, resetResourceCache, resourceAttributes,
  setActiveRecorder, spanAround, spanAroundAsync, telemetryDir, telemetryEnabled,
} from '../telemetry-store.mjs';
import { buildProcessSnapshot, processSnapshotMetrics } from '../host-process-sample.mjs';
import {
  daysInWindow, eventTime, fmtBytes, fmtMs, renderReport, renderTrace, renderTraces, runTelemetryCli, withinWindow,
} from '../telemetry-cli.mjs';

/** A deterministic clock: each read advances by `stepMs`, so a span's duration is exactly predictable. */
function fakeClock(startIso = '2026-09-12T10:00:00.000Z', stepMs = 1000) {
  let t = Date.parse(startIso);
  return () => { const d = new Date(t); t += stepMs; return d; };
}

/** A recorder wired to a memory store with a deterministic clock and span ids — the harness every
 *  behaviour test below uses, so no test depends on a real clock, disk, or randomness. */
function harness(opts = {}) {
  const store = createMemoryTelemetryStore();
  let n = 0;
  const rec = createTelemetryRecorder({
    store, enabled: true, now: fakeClock(opts.start, opts.stepMs ?? 1000),
    newSpanId: () => `span${String(n += 1).padStart(4, '0')}`,
    resource: { repo: 'web-everything', branch: 'lane/mechanical-dispatcher', commit: 'abcdef123456' },
    ...opts,
  });
  return { store, rec };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('vocabularies — the closed sets that make aggregation possible', () => {
  it('uses OTel span status codes exactly: unset/ok/error, no more and no fewer', () => {
    expect(SPAN_STATUS).toEqual(['unset', 'ok', 'error']);
  });

  it('every durable span name is itself a real span name', () => {
    for (const n of DURABLE_SPAN_NAMES) expect(SPAN_NAMES).toContain(n);
  });

  it('span names are low-cardinality — <subject>.<operation> or a bare root, never an identifier', () => {
    for (const n of SPAN_NAMES) {
      expect(n).toMatch(/^[a-z]+(\.[a-z]+)?$/);
      // A name carrying a number would be a high-cardinality name — the one semconv rule that, broken,
      // silently destroys every rollup by splitting one phase into N buckets.
      expect(n).not.toMatch(/\d/);
    }
  });

  it('the error and ok outcome vocabularies are disjoint — a word cannot mean both', () => {
    for (const o of ERROR_OUTCOMES) expect(OK_OUTCOMES).not.toContain(o);
  });

  // PR #3990 review (correctness): `blocked-on-permission` consumed a lane and an agent turn and produced no
  // landable diff, exactly like `blocked-on-infra` — it must stay an error outcome.
  it('counts the fix brief\'s `blocked-on-permission` as an error outcome, like `blocked-on-infra`', () => {
    expect(ERROR_OUTCOMES).toContain('blocked-on-permission');
    expect(classifyOutcomeStatus('blocked-on-permission')).toBe('error');
    expect(classifyOutcomeStatus('blocked-on-permission')).toBe(classifyOutcomeStatus('blocked-on-infra'));
  });

  it('classifyOutcomeStatus never guesses: an unknown word is `unset`, not `ok`', () => {
    expect(classifyOutcomeStatus('gate-red')).toBe('error');
    expect(classifyOutcomeStatus('pr-opened')).toBe('ok');
    // The two deliberately-neutral words — declining work correctly is neither a success nor a failure.
    expect(classifyOutcomeStatus('not-applicable')).toBe('unset');
    expect(classifyOutcomeStatus('not-ready')).toBe('unset');
    expect(classifyOutcomeStatus('something-new-a-future-wrapper-invents')).toBe('unset');
    expect(classifyOutcomeStatus(null)).toBe('unset');
    expect(classifyOutcomeStatus(undefined)).toBe('unset');
  });

  it('a review that asked for changes is NOT an error — that would measure strictness, not reliability', () => {
    expect(classifyOutcomeStatus('bounced')).toBe('ok');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('deriveTraceId — the join key', () => {
  it('keys on the item, so every stage of one lifecycle lands in one trace', () => {
    expect(deriveTraceId({ item: 3441 })).toBe('i3441');
    expect(deriveTraceId({ item: '3441' })).toBe('i3441');
    expect(deriveTraceId({ item: '03441' })).toBe('i3441');
    expect(deriveTraceId({ item: ' 3441 ' })).toBe('i3441');
  });

  it('lower-cases a JIT slug so a mixed-case ref still finds its trace', () => {
    expect(deriveTraceId({ item: 'Xe6NenK' })).toBe('ixe6nenk');
  });

  it('prefers the item over the PR — the item IS the lifecycle', () => {
    expect(deriveTraceId({ item: 3441, pr: 2131 })).toBe('i3441');
  });

  it('falls back to the PR for a wrapper that genuinely knows no item', () => {
    expect(deriveTraceId({ pr: 2131 })).toBe('p2131');
    expect(deriveTraceId({ pr: '#2131' })).toBe('p2131');
  });

  it('returns null rather than inventing a key, so identity-less work stays visible as such', () => {
    expect(deriveTraceId({})).toBeNull();
    expect(deriveTraceId()).toBeNull();
    expect(deriveTraceId({ item: '', pr: '  ' })).toBeNull();
  });

  it('does NOT fold the attempt in — attempt 2 belongs in the same trace as attempt 1', () => {
    // The whole reason "how many attempts did this item take" is answerable at all.
    expect(deriveTraceId({ item: 3441 })).toBe(deriveTraceId({ item: 3441 }));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('durationMs — never negative, never NaN', () => {
  it('measures a forward span', () => {
    expect(durationMs('2026-09-12T10:00:00Z', '2026-09-12T10:00:05Z')).toBe(5000);
  });
  it('refuses a BACKWARD span rather than returning a negative that would corrupt every sum', () => {
    expect(durationMs('2026-09-12T10:00:05Z', '2026-09-12T10:00:00Z')).toBeNull();
  });
  it('returns null (never 0, never NaN) on a missing or unparseable boundary', () => {
    expect(durationMs(null, '2026-09-12T10:00:00Z')).toBeNull();
    expect(durationMs('2026-09-12T10:00:00Z', undefined)).toBeNull();
    expect(durationMs('not a date', '2026-09-12T10:00:00Z')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('normalizeAttributes — bounded, deterministic, and total on hostile input', () => {
  it('keeps primitives and truncates long strings', () => {
    const out = normalizeAttributes({ a: 1, b: true, c: null, d: 'x'.repeat(MAX_VALUE_LENGTH + 50) });
    expect(out.a).toBe(1);
    expect(out.b).toBe(true);
    expect(out.c).toBeNull();
    expect(out.d).toHaveLength(MAX_VALUE_LENGTH);
    expect(out.d.endsWith('…')).toBe(true);
  });

  it('stringifies a non-finite number instead of emitting NaN/Infinity, which JSON cannot round-trip', () => {
    const out = normalizeAttributes({ n: NaN, i: Infinity });
    expect(out.n).toBe('NaN');
    expect(out.i).toBe('Infinity');
  });

  it('caps the key count DETERMINISTICALLY, by sort order — two identical inputs drop the same keys', () => {
    const big = Object.fromEntries(Array.from({ length: MAX_ATTRIBUTE_KEYS + 20 }, (_, i) => [`k${String(i).padStart(3, '0')}`, i]));
    const a = normalizeAttributes(big);
    const b = normalizeAttributes(big);
    expect(Object.keys(a)).toHaveLength(MAX_ATTRIBUTE_KEYS);
    expect(Object.keys(a)).toEqual(Object.keys(b));
  });

  it('survives a circular structure', () => {
    const circ = {}; circ.self = circ;
    expect(() => normalizeAttributes({ circ })).not.toThrow();
  });

  it('survives a THROWING getter — one bad attribute never takes the span down', () => {
    const hostile = { good: 1 };
    Object.defineProperty(hostile, 'bad', { enumerable: true, get() { throw new Error('boom'); } });
    const out = normalizeAttributes(hostile);
    expect(out.good).toBe(1);
    expect(String(out.bad)).toContain('unreadable');
  });

  it('is total on non-objects', () => {
    expect(normalizeAttributes(null)).toEqual({});
    expect(normalizeAttributes('a string')).toEqual({});
    expect(normalizeAttributes([1, 2])).toEqual({});
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('validation — the write path refuses a malformed event rather than persisting it', () => {
  const good = () => newSpanEnd({
    traceId: 'i1', spanId: 's1', name: 'dispatch', kind: 'build',
    startedAt: '2026-09-12T10:00:00.000Z', endedAt: '2026-09-12T10:00:01.000Z', status: 'ok',
  });

  it('accepts a well-formed span', () => {
    expect(validateTelemetryEvent(good()).ok).toBe(true);
  });

  it('refuses an unknown span name — the closed set is what stops a seventh wrapper falling out of rollups', () => {
    const r = validateTelemetryEvent({ ...good(), name: 'acquireLaneForReviewLoop' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('unknown span name');
  });

  it('refuses an unknown dispatch kind', () => {
    expect(validateTelemetryEvent({ ...good(), kind: 'mystery' }).ok).toBe(false);
  });

  it('refuses an unknown schema version', () => {
    expect(validateTelemetryEvent({ ...good(), v: 99 }).ok).toBe(false);
  });

  it('refuses a non-ISO timestamp', () => {
    expect(validateTelemetryEvent({ ...good(), endedAt: 'yesterday' }).ok).toBe(false);
  });

  it('refuses a metric with an unknown name', () => {
    const m = newMetric({ name: 'made.up.metric', value: 1, timestamp: '2026-09-12T10:00:00.000Z' });
    expect(validateTelemetryEvent(m).ok).toBe(false);
  });

  it('NEVER THROWS, whatever it is handed', () => {
    for (const junk of [null, undefined, 42, 'str', [], () => {}]) {
      expect(() => validateTelemetryEvent(junk)).not.toThrow();
      expect(validateTelemetryEvent(junk).ok).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('serialization — the atomic-append size bound, and what is shed to honour it', () => {
  it('emits exactly one newline-terminated line', () => {
    const line = serializeTelemetryEvent(newSpanEnd({
      traceId: 'i1', spanId: 's1', name: 'dispatch', kind: 'build',
      startedAt: '2026-09-12T10:00:00.000Z', endedAt: '2026-09-12T10:00:01.000Z',
    }));
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
  });

  it('stays under the PIPE_BUF-derived bound so a concurrent append cannot interleave mid-line', () => {
    const huge = newSpanEnd({
      traceId: 'i1', spanId: 's1', name: 'dispatch', kind: 'build',
      startedAt: '2026-09-12T10:00:00.000Z', endedAt: '2026-09-12T10:00:01.000Z',
      attributes: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'v'.repeat(400)])),
    });
    const line = serializeTelemetryEvent(huge);
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_LINE_BYTES);
  });

  it('SHEDS attributes rather than dropping the line — losing a phase entirely is worse than losing detail', () => {
    const huge = newSpanEnd({
      traceId: 'i1', spanId: 's1', name: 'agent.turn', kind: 'build',
      startedAt: '2026-09-12T10:00:00.000Z', endedAt: '2026-09-12T10:40:00.000Z', status: 'error',
      attributes: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'v'.repeat(400)])),
    });
    const parsed = JSON.parse(serializeTelemetryEvent(huge));
    expect(parsed._truncated).toContain('attributes');
    // The timing skeleton — the part every rollup depends on — always survives.
    expect(parsed.durationMs).toBe(2400000);
    expect(parsed.status).toBe('error');
    expect(parsed.name).toBe('agent.turn');
    expect(parsed.traceId).toBe('i1');
  });

  it('returns null rather than throwing on something unserializable', () => {
    const circ = { v: TELEMETRY_SCHEMA_VERSION, event: 'span.end' }; circ.self = circ;
    expect(() => serializeTelemetryEvent(circ)).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('parsing — TOLERANT, because nothing is ever resumed from this log', () => {
  it('round-trips a written line', () => {
    const rec = newSpanEnd({
      traceId: 'i1', spanId: 's1', name: 'dispatch', kind: 'build',
      startedAt: '2026-09-12T10:00:00.000Z', endedAt: '2026-09-12T10:00:01.000Z', status: 'ok',
    });
    expect(parseTelemetryLine(serializeTelemetryEvent(rec))).toEqual(rec);
  });

  it('skips a TORN last line (a process killed mid-append) and keeps every good one', () => {
    const good = serializeTelemetryEvent(newSpanEnd({
      traceId: 'i1', spanId: 's1', name: 'dispatch', kind: 'build',
      startedAt: '2026-09-12T10:00:00.000Z', endedAt: '2026-09-12T10:00:01.000Z',
    }));
    const { events, corrupt } = parseTelemetryLines(`${good}{"v":1,"event":"span.e`);
    expect(events).toHaveLength(1);
    expect(corrupt).toBe(1);
  });

  it('skips a line from an unknown schema version rather than guessing at its shape', () => {
    expect(parseTelemetryLine('{"v":99,"event":"span.end"}')).toBeNull();
  });

  it('ignores blank lines without counting them as corruption', () => {
    expect(parseTelemetryLines('\n\n  \n').corrupt).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('the recorder — the never-throw contract, which is the whole point', () => {
  it('a disabled recorder is a total no-op with the IDENTICAL shape, so call sites need no guard', () => {
    const rec = createTelemetryRecorder({ enabled: false });
    const span = rec.startSpan('dispatch');
    expect(() => { span.setAttributes({ a: 1 }).child('agent.turn').ok(); span.fail(new Error('x')); }).not.toThrow();
    expect(rec.recordMetric('queue.depth', 3).skipped).toBe(true);
    expect(rec.closeRoot({ outcome: 'gate-red' }).skipped).toBe(true);
  });

  it('WE_TELEMETRY=0 disables it', () => {
    expect(telemetryEnabled({ WE_TELEMETRY: '0' })).toBe(false);
    expect(telemetryEnabled({ WE_TELEMETRY: 'off' })).toBe(false);
    expect(telemetryEnabled({ WE_TELEMETRY: 'false' })).toBe(false);
    expect(telemetryEnabled({})).toBe(true);
    expect(telemetryEnabled({ WE_TELEMETRY: '1' })).toBe(true);
  });

  it('a store that THROWS on every write never reaches the caller — it is counted, not raised', () => {
    const exploding = { append() { throw new Error('disk on fire'); }, days: () => [], readDay: () => ({ events: [], corrupt: 0 }), readAll: () => ({ events: [], corrupt: 0 }) };
    const rec = createTelemetryRecorder({ store: exploding, enabled: true, now: fakeClock() });
    expect(() => rec.startSpan('dispatch').ok()).not.toThrow();
    expect(rec.errors).toBeGreaterThan(0);
  });

  it('a CLOCK that throws degrades to a null span instead of taking the delivery down', () => {
    const rec = createTelemetryRecorder({
      store: createMemoryTelemetryStore(), enabled: true,
      now: () => { throw new Error('no clock'); },
    });
    expect(() => rec.startSpan('dispatch').ok()).not.toThrow();
  });

  it('writes a span.end line with a real duration', () => {
    const { store, rec } = harness();
    rec.startSpan('dispatch', { attributes: { item: '3441' } }).ok({ pr: 2131 });
    const { events } = store.readAll();
    const end = events.find((e) => e.event === 'span.end');
    expect(end.name).toBe('dispatch');
    expect(end.durationMs).toBe(1000);
    expect(end.status).toBe('ok');
    expect(end.attributes).toMatchObject({ item: '3441', pr: 2131 });
  });

  it('stamps the RESOURCE bag — which code produced this span', () => {
    const { store, rec } = harness();
    rec.startSpan('dispatch').ok();
    const end = store.readAll().events.find((e) => e.event === 'span.end');
    expect(end.resource).toMatchObject({ repo: 'web-everything', branch: 'lane/mechanical-dispatcher', commit: 'abcdef123456' });
  });

  it('parents a child span, so a lifecycle reconstructs as a tree', () => {
    const { store, rec } = harness();
    const root = rec.startSpan('dispatch');
    root.child('lane.acquire').ok();
    root.ok();
    const ends = store.readAll().events.filter((e) => e.event === 'span.end');
    const lane = ends.find((e) => e.name === 'lane.acquire');
    const disp = ends.find((e) => e.name === 'dispatch');
    expect(lane.parentSpanId).toBe(disp.spanId);
    expect(lane.traceId).toBe(disp.traceId);
  });

  it('a span with an open ROOT nests under it automatically — OTel active-span semantics', () => {
    // This is what makes the ambient design work at all: `acquireLane` cannot be passed a parent, so without
    // this a trace would read as a flat list of siblings rather than as the phase tree it really is.
    const { store, rec } = harness();
    const root = rec.startRoot({ item: '3441' });
    rec.startSpan('lane.acquire').ok();   // no explicit parent — the shared-helper case
    rec.closeRoot({ outcome: 'pr-opened' });
    const ends = store.readAll().events.filter((e) => e.event === 'span.end');
    expect(ends.find((e) => e.name === 'lane.acquire').parentSpanId).toBe(root.spanId);
  });

  it('the ROOT itself has no parent, and an explicit null parent is honoured over the root', () => {
    const { store, rec } = harness();
    rec.startRoot();
    rec.startSpan('runner.tick', { parent: null }).ok();
    const ends = store.readAll().events.filter((e) => e.event === 'span.end');
    expect(ends.find((e) => e.name === 'runner.tick').parentSpanId).toBeNull();
  });

  it('end() is IDEMPOTENT — a finally-close after an explicit fail cannot double-count', () => {
    const { store, rec } = harness();
    const s = rec.startSpan('verify.gate');
    s.fail(new Error('red'));
    s.ok();
    expect(store.readAll().events.filter((e) => e.event === 'span.end')).toHaveLength(1);
  });

  it('writes a span.start for a DURABLE span only, so a crash mid-phase stays visible', () => {
    const { store, rec } = harness();
    rec.startSpan('agent.turn');      // durable, never ended → abandoned
    rec.startSpan('item.claim').ok(); // not durable
    const starts = store.readAll().events.filter((e) => e.event === 'span.start');
    expect(starts.map((s) => s.name)).toEqual(['agent.turn']);
  });

  it('a span that is never ended writes no span.end — an abandoned span, not a leak', () => {
    const { store, rec } = harness();
    rec.startSpan('agent.turn');
    expect(store.readAll().events.filter((e) => e.event === 'span.end')).toHaveLength(0);
  });

  it('carries the attempt as an ATTRIBUTE of the span, giving a uniform retry axis', () => {
    const { store, rec } = harness();
    rec.startSpan('verify.gate', { attempt: 2 }).ok();
    expect(store.readAll().events.find((e) => e.event === 'span.end').attempt).toBe(2);
  });

  it('files each event into its own UTC day file', () => {
    const store = createMemoryTelemetryStore();
    const rec = createTelemetryRecorder({ store, enabled: true, now: fakeClock('2026-09-12T23:59:59.500Z', 1000) });
    rec.startSpan('dispatch').ok();
    // EACH EVENT is filed by ITS OWN timestamp, not by the span's start: the durable `span.start` at
    // 23:59:59.5 lands in 09-12 and the `span.end` at 00:00:00.5 in 09-13. That is deliberate — a day file
    // must be a faithful log of what was WRITTEN during that day, so a rolling-window read never has to
    // second-guess which file an event could be hiding in.
    expect(store.days()).toEqual(['2026-09-12', '2026-09-13']);
    expect(store.readDay('2026-09-12').events.map((e) => e.event)).toEqual(['span.start']);
    expect(store.readDay('2026-09-13').events.map((e) => e.event)).toEqual(['span.end']);
  });

  it('closeRoot maps the wrapper vocabulary onto an OTel status and self-uninstalls the ambient recorder', () => {
    const { store, rec } = harness();
    setActiveRecorder(rec);
    rec.startRoot({ item: '3441' });
    expect(activeRecorder()).toBe(rec);
    rec.closeRoot({ outcome: 'gate-red', label: '2 failing' });
    const end = store.readAll().events.find((e) => e.event === 'span.end');
    expect(end.status).toBe('error');
    expect(end.attributes.outcome).toBe('gate-red');
    // Self-uninstall: without it, the next dispatch in the same process would land in this trace.
    expect(activeRecorder().enabled).toBe(false);
  });

  it('closeRoot on a neutral outcome closes `unset`, never a guessed `ok`', () => {
    const { store, rec } = harness();
    rec.startRoot();
    rec.closeRoot({ outcome: 'not-applicable' });
    expect(store.readAll().events.find((e) => e.event === 'span.end').status).toBe('unset');
  });

  it('closeRoot with no root open is a harmless no-op', () => {
    const { rec } = harness();
    expect(rec.closeRoot({ outcome: 'gate-red' }).skipped).toBe(true);
  });

  it('withTrace shares the store and resource bag but keys a different trace', () => {
    const { store, rec } = harness();
    const other = rec.withTrace({ pr: 2131, kind: 'review' });
    rec.startSpan('dispatch').ok();
    other.startSpan('dispatch').ok();
    const traces = new Set(store.readAll().events.map((e) => e.traceId));
    expect(traces.size).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('ambient context — how a 6/6 shared helper emits without being passed a recorder', () => {
  beforeEach(() => setActiveRecorder(null));

  it('defaults to the NULL recorder, so an uninstrumented caller behaves exactly as before', () => {
    expect(activeRecorder().enabled).toBe(false);
    expect(() => activeRecorder().startSpan('lane.acquire').ok()).not.toThrow();
  });

  it('setActiveRecorder returns a restore that puts back the PRIOR recorder, so nesting is safe', () => {
    const a = harness().rec;
    const b = harness().rec;
    const restoreA = setActiveRecorder(a);
    const restoreB = setActiveRecorder(b);
    expect(activeRecorder()).toBe(b);
    restoreB();
    expect(activeRecorder()).toBe(a);
    restoreA();
    expect(activeRecorder().enabled).toBe(false);
  });

  it('spanAround times a call, closes ok, and passes the return value through UNTOUCHED', () => {
    const { store, rec } = harness();
    setActiveRecorder(rec);
    const out = spanAround('lane.acquire', { attributes: { purpose: 'review-loop' } }, () => 'lane-19');
    expect(out).toBe('lane-19');
    const end = store.readAll().events.find((e) => e.event === 'span.end');
    expect(end.status).toBe('ok');
    expect(end.attributes.purpose).toBe('review-loop');
  });

  it('spanAround records the error AND RETHROWS the original, unchanged — telemetry is a bystander', () => {
    const { store, rec } = harness();
    setActiveRecorder(rec);
    const boom = new Error('the real failure');
    expect(() => spanAround('pr.open', {}, () => { throw boom; })).toThrow(boom);
    const end = store.readAll().events.find((e) => e.event === 'span.end');
    expect(end.status).toBe('error');
    expect(end.statusMessage).toBe('the real failure');
  });

  it('spanAroundAsync does the same for an awaited phase', async () => {
    const { store, rec } = harness();
    setActiveRecorder(rec);
    await expect(spanAroundAsync('agent.turn', {}, async () => 'report')).resolves.toBe('report');
    await expect(spanAroundAsync('agent.turn', {}, async () => { throw new Error('spawn failed'); })).rejects.toThrow('spawn failed');
    const ends = store.readAll().events.filter((e) => e.event === 'span.end');
    expect(ends.map((e) => e.status)).toEqual(['ok', 'error']);
  });

  it('spanAround with NO active recorder still returns the value and swallows nothing', () => {
    expect(spanAround('lane.acquire', {}, () => 42)).toBe(42);
    expect(() => spanAround('lane.acquire', {}, () => { throw new Error('x'); })).toThrow('x');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('the file store', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-telemetry-')); });

  it('appends to a day file and reads it back', () => {
    const store = createFileTelemetryStore({ dir });
    const rec = createTelemetryRecorder({ store, enabled: true, now: fakeClock() });
    rec.startSpan('dispatch').ok();
    expect(store.days()).toEqual(['2026-09-12']);
    // TWO lines: `dispatch` is a DURABLE span name, so it writes its `span.start` as well as its `span.end`.
    expect(store.readDay('2026-09-12').events).toHaveLength(2);
    expect(store.readDay('2026-09-12').events.map((e) => e.event)).toEqual(['span.start', 'span.end']);
    // Genuinely on disk, as NDJSON.
    expect(readFileSync(join(dir, '2026-09-12.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('APPENDS rather than overwrites — two writers, one file, both lines survive', () => {
    const a = createFileTelemetryStore({ dir });
    const b = createFileTelemetryStore({ dir });
    createTelemetryRecorder({ store: a, enabled: true, now: fakeClock() }).startSpan('dispatch').ok();
    createTelemetryRecorder({ store: b, enabled: true, now: fakeClock() }).startSpan('verify.gate').ok();
    // Both are durable names → 2 lines each; the point is that writer b's lines did not replace writer a's.
    expect(a.readDay('2026-09-12').events).toHaveLength(4);
    expect(a.readDay('2026-09-12').events.filter((e) => e.name === 'dispatch')).toHaveLength(2);
    expect(a.readDay('2026-09-12').events.filter((e) => e.name === 'verify.gate')).toHaveLength(2);
  });

  it('a missing day reads as empty, never as an error', () => {
    expect(createFileTelemetryStore({ dir }).readDay('1999-01-01')).toEqual({ events: [], corrupt: 0 });
  });

  it('a corrupt file is REPORTED, not thrown — an observability file must never be an outage', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-09-12.jsonl'), 'not json at all\n{"v":1,"event":"metric"}\n');
    const r = createFileTelemetryStore({ dir }).readDay('2026-09-12');
    expect(r.corrupt).toBe(1);
    expect(r.events).toHaveLength(1);
  });

  it('ignores files that are not day logs', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'hi');
    expect(createFileTelemetryStore({ dir }).days()).toEqual([]);
  });

  it('an unwritable directory never throws', () => {
    // Unwritable because its parent is a regular FILE (ENOTDIR on every platform). NOT a `/proc/...` path: on
    // Linux, `mkdirSync(<under /proc>, { recursive: true })` spins forever (procfs answers ENOENT, the parent
    // exists, Node's mkdirp retries) — which hung CI `test-shard (1)` for hours on PR #2636, three runs in a row.
    const parentFile = join(mkdtempSync(join(tmpdir(), 'tel-unwritable-')), 'a-file');
    writeFileSync(parentFile, '');
    const store = createFileTelemetryStore({ dir: join(parentFile, 'not', 'writable') });
    expect(store.append('{"v":1}\n', '2026-09-12').ok).toBe(false);
    expect(store.days()).toEqual([]);
  });

  it('the memory twin round-trips through serialize+parse, so it catches the same shape bugs', () => {
    const store = createMemoryTelemetryStore();
    createTelemetryRecorder({ store, enabled: true, now: fakeClock() }).startSpan('dispatch').ok();
    expect(store.raw('2026-09-12').endsWith('\n')).toBe(true);
    expect(store.readDay('2026-09-12').events[0].v).toBe(TELEMETRY_SCHEMA_VERSION);
  });

  it('OPERATION_TELEMETRY_DIR overrides the location, mirroring every other operations store', () => {
    const prior = process.env.OPERATION_TELEMETRY_DIR;
    process.env.OPERATION_TELEMETRY_DIR = dir;
    try { expect(telemetryDir()).toBe(dir); } finally {
      if (prior === undefined) delete process.env.OPERATION_TELEMETRY_DIR; else process.env.OPERATION_TELEMETRY_DIR = prior;
    }
  });

  it('dayKey is UTC, so a day file means the same window on every machine', () => {
    expect(dayKey('2026-09-12T23:30:00.000Z')).toBe('2026-09-12');
    expect(dayKey('2026-09-13T00:30:00.000Z')).toBe('2026-09-13');
    expect(dayKey('nonsense')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('resource detection — reads git WITHOUT spawning a subprocess', () => {
  beforeEach(() => resetResourceCache());

  it('reads branch and commit from a real .git directory', () => {
    const r = readGitResource(new URL('../../..', import.meta.url).pathname);
    expect(r).toHaveProperty('branch');
    expect(r).toHaveProperty('commit');
    if (r.commit) expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns nulls rather than throwing when there is no .git at all', () => {
    expect(readGitResource(mkdtempSync(join(tmpdir(), 'no-git-')))).toEqual({ branch: null, commit: null });
  });

  it('shortens the sha and caches the bag, so it costs nothing per span', () => {
    const a = resourceAttributes({ root: new URL('../../..', import.meta.url).pathname });
    const b = resourceAttributes({ root: '/somewhere/else/entirely' });
    expect(b).toBe(a); // cached — the second call never re-reads
    if (a.commit) expect(a.commit).toHaveLength(12);
    expect(a.pid).toBe(process.pid);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('goldenSignals — the rollup a future scoring pass consumes', () => {
  /** A realistic window: two build dispatches (one clean, one gate-red after a retried gate), one review,
   *  a saturated tick, and an abandoned agent turn. */
  function scenario() {
    const store = createMemoryTelemetryStore();

    const good = createTelemetryRecorder({ store, enabled: true, kind: 'build', item: '3441', now: fakeClock('2026-09-12T10:00:00.000Z', 60000) });
    const r1 = good.startRoot({ item: '3441' });
    r1.child('lane.acquire').ok({ outcome: 'acquired' });
    r1.child('agent.turn').ok({ outcome: 'done' });
    r1.child('verify.gate').ok({ outcome: 'pass' });
    r1.child('pr.open').ok();
    good.closeRoot({ outcome: 'pr-opened' });

    const bad = createTelemetryRecorder({ store, enabled: true, kind: 'build', item: '3442', now: fakeClock('2026-09-12T11:00:00.000Z', 120000) });
    const r2 = bad.startRoot({ item: '3442' });
    r2.child('lane.acquire').ok({ outcome: 'acquired' });
    r2.child('agent.turn').ok({ outcome: 'done' });
    r2.child('verify.gate', { attempt: 1 }).fail('gate red (3 failing)', { outcome: 'gate-red' });
    r2.child('verify.gate', { attempt: 2 }).fail('gate red (3 failing)', { outcome: 'gate-red' });
    bad.closeRoot({ outcome: 'gate-red' });

    const rev = createTelemetryRecorder({ store, enabled: true, kind: 'review', pr: 2131, now: fakeClock('2026-09-12T12:00:00.000Z', 30000) });
    const r3 = rev.startRoot({ pr: 2131 });
    r3.child('lane.acquire').fail('no free lane after bounded wait', { outcome: 'no-free-lane' });
    rev.closeRoot({ outcome: 'blocked-on-infra' });

    const runner = createTelemetryRecorder({ store, enabled: true, kind: 'runner', traceId: 'runner-1', now: fakeClock('2026-09-12T13:00:00.000Z', 10) });
    runner.recordMetric('dispatch.admitted', 2);
    runner.recordMetric('dispatch.denied', 3, { attributes: { reason: 'capacity-cap' } });
    runner.recordMetric('dispatch.denied', 1, { attributes: { reason: 'build-guard' } });
    runner.recordMetric('lane.pool.free', 0);
    runner.recordMetric('lane.pool.free', 4);
    runner.recordMetric('heavy.admission.waiting', 2);
    runner.startSpan('agent.turn', { kind: 'build' }); // durable, never ended → abandoned

    return store.readAll().events;
  }

  const sig = () => goldenSignals(scenario());

  it('LATENCY: per-phase distributions, not just a mean', () => {
    const s = sig();
    expect(s.latency.bySpan['verify.gate'].count).toBe(3);
    expect(s.latency.bySpan['agent.turn'].count).toBe(2);
    for (const k of ['count', 'totalMs', 'meanMs', 'p50Ms', 'p90Ms', 'p99Ms', 'maxMs']) {
      expect(s.latency.bySpan['verify.gate']).toHaveProperty(k);
    }
  });

  it('LATENCY: end-to-end is taken from the root span, split by kind', () => {
    const s = sig();
    expect(s.latency.endToEndByKind.build.count).toBe(2);
    expect(s.latency.endToEndByKind.review.count).toBe(1);
  });

  it('TRAFFIC: dispatch volume per kind', () => {
    const s = sig();
    expect(s.traffic.dispatches).toBe(3);
    expect(s.traffic.dispatchesByKind).toEqual({ build: 2, review: 1 });
    expect(s.traffic.traces).toBe(3); // i3441, i3442, p2131 — the runner emitted no ENDED span
  });

  it('ERRORS: a rate per phase AND per kind, WITH the classified reason', () => {
    const s = sig();
    expect(s.errors.bySpan['verify.gate']).toMatchObject({ total: 3, errors: 2 });
    expect(s.errors.bySpan['verify.gate'].reasons).toEqual({ 'gate-red': 2 });
    expect(s.errors.bySpan['lane.acquire']).toMatchObject({ total: 3, errors: 1 });
    expect(s.errors.bySpan['lane.acquire'].reasons).toEqual({ 'no-free-lane': 1 });
    expect(s.errors.byKind.build.errors).toBe(3);   // 2 gates + the gate-red root
    expect(s.errors.byKind.review.errors).toBe(2);  // the acquire + the blocked-on-infra root
  });

  it('ERRORS: a clean phase has a zero rate rather than being absent — the denominator matters', () => {
    const s = sig();
    expect(s.errors.bySpan['pr.open']).toEqual({ total: 1, errors: 0, rate: 0, reasons: {} });
  });

  it('SATURATION: the admission ledger, with WHY work was refused', () => {
    const s = sig();
    expect(s.saturation.admission).toMatchObject({ admitted: 2, denied: 4, total: 6 });
    expect(s.saturation.admission.reasons).toEqual({ 'capacity-cap': 3, 'build-guard': 1 });
    expect(s.saturation.admission.denyRate).toBeCloseTo(4 / 6);
  });

  it('SATURATION: gauges keep min/max/mean/last, so a momentary 0 free lanes is not averaged away', () => {
    const s = sig();
    expect(s.saturation.gauges['lane.pool.free']).toMatchObject({ samples: 2, min: 0, max: 4, mean: 2, last: 4 });
    expect(s.saturation.gauges['heavy.admission.waiting'].max).toBe(2);
  });

  it('RETRIES: a uniform attempt axis across every kind', () => {
    const s = sig();
    expect(s.retries['verify.gate']).toEqual({ spans: 3, retried: 1, maxAttempt: 2 });
  });

  it('ABANDONED: a durable span opened and never closed is surfaced, not silently lost', () => {
    const s = sig();
    expect(s.abandoned).toHaveLength(1);
    expect(s.abandoned[0]).toMatchObject({ name: 'agent.turn', kind: 'build' });
  });

  it('is TOTAL on an empty window — every section present, no division by zero', () => {
    const s = goldenSignals([]);
    expect(s.traffic).toMatchObject({ traces: 0, spans: 0, dispatches: 0 });
    expect(s.errors.overall).toEqual({ total: 0, errors: 0, rate: 0 });
    expect(s.saturation.admission.denyRate).toBe(0);
    expect(s.abandoned).toEqual([]);
  });

  it('never throws on junk input', () => {
    for (const junk of [null, undefined, 'str', 42, [null, {}, { event: 'span.end' }]]) {
      expect(() => goldenSignals(junk)).not.toThrow();
    }
  });

  it('ignores a span whose duration could not be computed rather than counting it as 0', () => {
    const s = goldenSignals([
      { v: 1, event: 'span.end', name: 'dispatch', kind: 'build', traceId: 'i1', spanId: 's1', durationMs: null, status: 'ok', attempt: 1 },
    ]);
    expect(s.latency.bySpan.dispatch).toBeUndefined();
    expect(s.traffic.dispatches).toBe(1); // still counted as TRAFFIC — it happened
  });
});

describe('percentile — nearest-rank, so it always returns an observed value', () => {
  it('returns a real sample, never an interpolation of two that never happened', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
  });
  it('is null on empty', () => { expect(percentile([], 0.5)).toBeNull(); });
});

describe('groupByTrace', () => {
  it('collects a lifecycle and its item attribute under one key', () => {
    const { store, rec } = harness({ item: '3441', kind: 'build' });
    const r = rec.startSpan('dispatch', { attributes: { item: '3441' } });
    r.child('agent.turn', { attributes: { item: '3441' } }).ok();
    r.ok();
    const g = groupByTrace(store.readAll().events);
    expect(Object.keys(g)).toEqual(['i3441']);
    expect(g.i3441.spans).toHaveLength(2);
    expect(g.i3441.items).toEqual(['3441']);
    expect(g.i3441.kinds).toEqual(['build']);
  });
  it('skips an event with no trace id instead of minting a bucket for it', () => {
    expect(groupByTrace([{ event: 'metric', traceId: null }])).toEqual({});
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('the read CLI', () => {
  function loaded(now = '2026-09-12T14:00:00.000Z') {
    const store = createMemoryTelemetryStore();
    const rec = createTelemetryRecorder({ store, enabled: true, kind: 'build', item: '3441', now: fakeClock('2026-09-12T10:00:00.000Z', 60000) });
    const r = rec.startRoot({ item: '3441' });
    r.child('lane.acquire').ok({ outcome: 'acquired' });
    r.child('agent.turn').ok({ outcome: 'done' });
    rec.closeRoot({ outcome: 'pr-opened' });
    return { store, now: () => new Date(now) };
  }

  it('report renders the four golden signals by name', () => {
    const { store, now } = loaded();
    let text = '';
    expect(runTelemetryCli(['report'], { store, now, out: (s) => { text += s; } })).toBe(0);
    for (const h of ['TRAFFIC', 'LATENCY', 'ERRORS', 'SATURATION']) expect(text).toContain(h);
    expect(text).toContain('rolling 24h');
  });

  it('report --json emits the raw rollup, so a scoring pass never parses prose', () => {
    const { store, now } = loaded();
    let text = '';
    runTelemetryCli(['report', '--json'], { store, now, out: (s) => { text += s; } });
    const parsed = JSON.parse(text);
    expect(parsed).toHaveProperty('latency');
    expect(parsed).toHaveProperty('traffic');
    expect(parsed).toHaveProperty('errors');
    expect(parsed).toHaveProperty('saturation');
    expect(parsed.hours).toBe(24);
  });

  it('trace shows one lifecycle in time order, children indented under the root', () => {
    const { store, now } = loaded();
    let text = '';
    runTelemetryCli(['trace', '--trace=i3441'], { store, now, out: (s) => { text += s; } });
    expect(text).toContain('trace i3441');
    expect(text).toContain('lane.acquire');
    expect(text).toContain('agent.turn');
  });

  it('trace refuses without --trace rather than guessing', () => {
    expect(runTelemetryCli(['trace'], { store: createMemoryTelemetryStore() })).toBe(1);
  });

  it('trace reads EVERY day, so a lifecycle that finished yesterday is still findable', () => {
    const { store } = loaded();
    let text = '';
    // A "now" five days later — a windowed read would return nothing.
    runTelemetryCli(['trace', '--trace=i3441'], { store, now: () => new Date('2026-09-17T00:00:00Z'), out: (s) => { text += s; } });
    expect(text).toContain('lane.acquire');
  });

  it('traces lists the index, newest first', () => {
    const { store, now } = loaded();
    let text = '';
    runTelemetryCli(['traces', '--json'], { store, now, out: (s) => { text += s; } });
    const parsed = JSON.parse(text);
    expect(parsed.traces[0]).toMatchObject({ traceId: 'i3441', outcome: 'pr-opened', errors: 0 });
  });

  it('days lists what is on disk', () => {
    const { store, now } = loaded();
    let text = '';
    runTelemetryCli(['days', '--json'], { store, now, out: (s) => { text += s; } });
    expect(JSON.parse(text).days).toEqual(['2026-09-12']);
  });

  it('an unknown verb is refused', () => {
    expect(runTelemetryCli(['frobnicate'], { store: createMemoryTelemetryStore() })).toBe(1);
  });

  it('renders an empty window without crashing or implying data exists', () => {
    let text = '';
    runTelemetryCli(['report'], { store: createMemoryTelemetryStore(), out: (s) => { text += s; } });
    expect(text).toContain('no dispatches recorded');
  });

  it('--since narrows the window and genuinely excludes older events', () => {
    const { store } = loaded();
    let text = '';
    // The events are at 10:00; "now" is 14:00 with a 1h window → nothing in range.
    runTelemetryCli(['report', '--since=1', '--json'], { store, now: () => new Date('2026-09-12T14:00:00Z'), out: (s) => { text += s; } });
    expect(JSON.parse(text).traffic.dispatches).toBe(0);
  });

  it('daysInWindow covers the boundary, so a 24h window spanning midnight reads both files', () => {
    const days = daysInWindow(24, new Date('2026-09-13T01:00:00Z'));
    expect(days).toContain('2026-09-12');
    expect(days).toContain('2026-09-13');
  });

  it('windowing files a span by when it ENDED — that is when it became a fact', () => {
    const e = { event: 'span.end', startedAt: '2026-09-12T09:00:00Z', endedAt: '2026-09-12T10:00:00Z' };
    expect(eventTime(e)).toBe(Date.parse('2026-09-12T10:00:00Z'));
    expect(eventTime({ event: 'metric', timestamp: '2026-09-12T10:00:00Z' })).toBe(Date.parse('2026-09-12T10:00:00Z'));
    expect(eventTime({ event: 'span.end', endedAt: 'garbage' })).toBeNull();
  });

  it('withinWindow drops an unparseable timestamp rather than including it by accident', () => {
    const now = new Date('2026-09-12T12:00:00Z');
    expect(withinWindow([{ event: 'metric', timestamp: 'nope' }], 24, now)).toEqual([]);
  });

  it('fmtMs scales from ms to hours', () => {
    expect(fmtMs(500)).toBe('500ms');
    expect(fmtMs(1500)).toBe('1.5s');
    expect(fmtMs(125000)).toBe('2m 05s');
    expect(fmtMs(3900000)).toBe('1h 05m');
    expect(fmtMs(null)).toBe('—');
  });

  // #3383 follow-on — `host.mem.*` renders human-sized rather than as a raw byte count that would dwarf every
  // other line in the report; the JSON path still carries the raw integer untouched.
  it('fmtBytes scales from bytes to terabytes', () => {
    expect(fmtBytes(512)).toBe('512B');
    expect(fmtBytes(4 * 1024 * 1024)).toBe('4.0MB');
    expect(fmtBytes(1.2 * 1024 * 1024 * 1024)).toBe('1.2GB');
    expect(fmtBytes(null)).toBe('—');
  });

  it('report breaks host samples into their OWN section, formatted human-sized, not raw byte counts', () => {
    const { store, now } = loaded();
    store.append(`${JSON.stringify({
      v: 1, event: 'metric', name: 'host.cpu.load1', kind: 'runner', value: 2.5, unit: 'count',
      timestamp: '2026-09-12T10:00:00.000Z', traceId: null, attributes: {}, resource: {},
    })}\n`, '2026-09-12');
    store.append(`${JSON.stringify({
      v: 1, event: 'metric', name: 'host.cpu.count', kind: 'runner', value: 8, unit: 'count',
      timestamp: '2026-09-12T10:00:00.000Z', traceId: null, attributes: {}, resource: {},
    })}\n`, '2026-09-12');
    store.append(`${JSON.stringify({
      v: 1, event: 'metric', name: 'host.mem.free_bytes', kind: 'runner', value: 2 * 1024 * 1024 * 1024,
      unit: 'bytes', timestamp: '2026-09-12T10:00:00.000Z', traceId: null, attributes: {}, resource: {},
    })}\n`, '2026-09-12');
    let text = '';
    runTelemetryCli(['report'], { store, now, out: (s) => { text += s; } });
    expect(text).toContain('HOST — is the machine itself the constraint?');
    expect(text).toContain('host.cpu.load1');
    expect(text).toContain('of 8 cores');
    expect(text).toContain('host.mem.free_bytes');
    expect(text).toContain('2.0GB');
    // The generic SATURATION section must NOT also print the host gauges (no double-reporting).
    const saturationBlock = text.slice(text.indexOf('SATURATION'), text.indexOf('HOST —'));
    expect(saturationBlock).not.toContain('host.cpu.load1');
  });

  it('report says so plainly when no host samples landed in the window', () => {
    let text = '';
    runTelemetryCli(['report'], { store: createMemoryTelemetryStore(), out: (s) => { text += s; } });
    expect(text).toContain('no host samples recorded in this window');
  });

  // #3383 telemetry-granularity follow-on — the three FIXED categories keep their own rows exactly as before;
  // everything else now gets an INDIVIDUAL named row (real pid + command) once it clears the substantial bar,
  // rather than being flattened into `vscode`/`chrome`/`other`.
  it('report breaks per-process samples into fixed categories + individually-named substantial processes + a labeled remainder', () => {
    const { store, now } = loaded();
    const fixed = {
      conveyor: { cpu: 12.5, mem: 100 * 1024 * 1024 },
      drain: { cpu: 3, mem: 40 * 1024 * 1024 },
      dispatched_agents: { cpu: 220, mem: 900 * 1024 * 1024 },
    };
    for (const [cat, { cpu, mem }] of Object.entries(fixed)) {
      store.append(`${JSON.stringify({
        v: 1, event: 'metric', name: `host.process.${cat}.cpu_pct`, kind: 'runner', value: cpu, unit: 'percent',
        timestamp: '2026-09-12T10:00:00.000Z', traceId: null, attributes: {}, resource: {},
      })}\n`, '2026-09-12');
      store.append(`${JSON.stringify({
        v: 1, event: 'metric', name: `host.process.${cat}.mem_bytes`, kind: 'runner', value: mem, unit: 'bytes',
        timestamp: '2026-09-12T10:00:00.000Z', traceId: null, attributes: {}, resource: {},
      })}\n`, '2026-09-12');
    }
    // A NAMED APP beyond vscode/chrome, above the default substantial bar — its own row, real identity.
    const entryAttrs = { pid: 1713, command: '/Applications/Spotify.app/.../Spotify Helper --type=gpu-process', tick: 5 };
    store.append(`${JSON.stringify({
      v: 1, event: 'metric', name: 'host.process.entry.cpu_pct', kind: 'runner', value: 40, unit: 'percent',
      timestamp: '2026-09-12T10:00:00.000Z', traceId: null, attributes: entryAttrs, resource: {},
    })}\n`, '2026-09-12');
    store.append(`${JSON.stringify({
      v: 1, event: 'metric', name: 'host.process.entry.mem_bytes', kind: 'runner', value: 1200 * 1024 * 1024, unit: 'bytes',
      timestamp: '2026-09-12T10:00:00.000Z', traceId: null, attributes: entryAttrs, resource: {},
    })}\n`, '2026-09-12');
    // The collection-time remainder — everything below the storage floor, clearly labeled.
    store.append(`${JSON.stringify({
      v: 1, event: 'metric', name: 'host.process.below_floor_remainder.cpu_pct', kind: 'runner', value: 30, unit: 'percent',
      timestamp: '2026-09-12T10:00:00.000Z', traceId: null, attributes: { processCount: 900 }, resource: {},
    })}\n`, '2026-09-12');
    store.append(`${JSON.stringify({
      v: 1, event: 'metric', name: 'host.process.below_floor_remainder.mem_bytes', kind: 'runner', value: 500 * 1024 * 1024, unit: 'bytes',
      timestamp: '2026-09-12T10:00:00.000Z', traceId: null, attributes: { processCount: 900 }, resource: {},
    })}\n`, '2026-09-12');
    let text = '';
    runTelemetryCli(['report'], { store, now, out: (s) => { text += s; } });
    expect(text).toContain('HOST PROCESSES — who is actually consuming it');
    for (const cat of Object.keys(fixed)) expect(text).toContain(cat);
    // The specific named process shows up by name, not lost inside `other`/`chrome`.
    expect(text).toContain('Spotify Helper');
    // The remainder is CLEARLY labeled as a remainder, never read as a bucket of its own the way `other` was.
    expect(text).toContain('below-threshold remainder');
    expect(text).toContain('— total —');
    // The generic SATURATION and whole-machine HOST sections must not ALSO print these per-process names.
    const beforeProcessTable = text.slice(0, text.indexOf('HOST PROCESSES'));
    expect(beforeProcessTable).not.toContain('host.process.');
  });

  // PR #2220 review (security): a crafted process title must not be able to drive the operator's terminal.
  it('renderReport strips control/escape characters from a process label and masks credential-shaped argv', () => {
    const { store, now } = loaded();
    const evil = 'node x.mjs \u001b[2J\u001b]0;pwned\u0007 --api-key=hunter2Trombone';
    for (const [name, value, unit] of [['host.process.entry.cpu_pct', 30, 'percent'], ['host.process.entry.mem_bytes', 5e6, 'bytes']]) {
      store.append(`${JSON.stringify({
        v: 1, event: 'metric', name, kind: 'runner', value, unit, timestamp: '2026-09-12T10:00:00.000Z',
        traceId: null, attributes: { pid: 9, command: evil, tick: 1 }, resource: {},
      })}\n`, '2026-09-12');
    }
    let text = '';
    runTelemetryCli(['report'], { store, now, out: (s) => { text += s; } });
    expect(text).toContain('node x.mjs');
    expect(text).not.toMatch(/[\u001b\u0007]/);
    expect(text).not.toContain('hunter2Trombone');
    // Direct renderReport with a HAND-BUILT hostProcesses (the seam a caller could bypass summarize with).
    const direct = renderReport({
      ...goldenSignals([]), corrupt: 0,
      hostProcesses: {
        substantial: [{ label: evil, pids: [9], meanCpuPct: 30, meanMemBytes: 5e6, maxCpuPct: 30, maxMemBytes: 5e6, samples: 1 }],
        belowThresholdRemainder: { meanCpuPct: 0, meanMemBytes: 0, samples: 0 }, windowTicks: 1, cpuThresholdPct: 2, memThresholdBytes: 200 * 1024 * 1024,
      },
    }, { hours: 24 });
    expect(direct).not.toMatch(/[\u001b\u0007]/);
    expect(direct).not.toContain('hunter2Trombone');
  });

  it('report says so plainly when no per-process samples landed in the window', () => {
    const { store, now } = loaded();
    let text = '';
    runTelemetryCli(['report'], { store, now, out: (s) => { text += s; } });
    expect(text).toContain('no per-process samples recorded in this window');
  });

  it('renderTrace says so plainly when a trace has no spans', () => {
    expect(renderTrace('i9999', [])).toContain('no spans recorded');
  });

  it('renderTraces says so plainly when the window is empty', () => {
    expect(renderTraces([]).text).toContain('no traces');
  });

  it('renderReport surfaces an abandoned span prominently', () => {
    const s = goldenSignals([
      { v: 1, event: 'span.start', name: 'agent.turn', kind: 'build', traceId: 'i1', spanId: 'x', startedAt: '2026-09-12T10:00:00.000Z', attempt: 1 },
    ]);
    expect(renderReport(s, { hours: 24 })).toContain('ABANDONED');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('METRIC_NAMES / DISPATCH_KINDS cover what the system actually has', () => {
  it('names every dispatch kind the provider registry can launch, plus the runner itself', () => {
    for (const k of ['build', 'fix', 'prepare', 'prepare-decision', 'ci-heal', 'review', 'runner']) {
      expect(DISPATCH_KINDS).toContain(k);
    }
  });

  it('covers the three real saturation sources: lane pool, heavy-command semaphore, admission cap', () => {
    expect(METRIC_NAMES.some((n) => n.startsWith('lane.pool.'))).toBe(true);
    expect(METRIC_NAMES.some((n) => n.startsWith('heavy.admission.'))).toBe(true);
    expect(METRIC_NAMES).toContain('dispatch.denied');
    expect(METRIC_NAMES).toContain('dispatch.admitted');
  });

  // #3383 follow-on — the HOST-RESOURCE half of the capacity-planning question: is the machine itself, not the
  // queue/lane logic, the actual delivery constraint.
  it('covers host CPU load, core count, and memory — the capacity-planning terms', () => {
    for (const n of [
      'host.cpu.load1', 'host.cpu.load5', 'host.cpu.load15', 'host.cpu.count',
      'host.mem.free_bytes', 'host.mem.total_bytes',
    ]) {
      expect(METRIC_NAMES).toContain(n);
    }
  });

  it('the `bytes` unit exists so a byte-valued gauge never has to lie and call itself a `count`', () => {
    expect(METRIC_UNITS).toContain('bytes');
  });

  // #3383 telemetry-granularity follow-on — three FIXED categories (this system's own processes) plus the
  // generic per-process `entry`/`below_floor_remainder` pair that carries every OTHER process's real identity
  // in `attributes` instead of in the metric name (a closed vocabulary can never grow per-process).
  it('covers the three fixed host.process.* categories, plus the generic entry/remainder pair, CPU and memory each', () => {
    for (const cat of ['conveyor', 'drain', 'dispatched_agents']) {
      expect(METRIC_NAMES).toContain(`host.process.${cat}.cpu_pct`);
      expect(METRIC_NAMES).toContain(`host.process.${cat}.mem_bytes`);
    }
    expect(METRIC_NAMES).toContain('host.process.entry.cpu_pct');
    expect(METRIC_NAMES).toContain('host.process.entry.mem_bytes');
    expect(METRIC_NAMES).toContain('host.process.below_floor_remainder.cpu_pct');
    expect(METRIC_NAMES).toContain('host.process.below_floor_remainder.mem_bytes');
    // The old fixed vscode/chrome/other buckets are GONE — a real process now keeps its own identity instead.
    for (const cat of ['vscode', 'chrome', 'other']) {
      expect(METRIC_NAMES).not.toContain(`host.process.${cat}.cpu_pct`);
      expect(METRIC_NAMES).not.toContain(`host.process.${cat}.mem_bytes`);
    }
  });

  it('the `percent` unit exists, distinct from `ratio`, so a 0..100+ CPU-percent sum is never mistaken for a 0..1 fraction', () => {
    expect(METRIC_UNITS).toContain('percent');
    expect(METRIC_UNITS).toContain('ratio');
  });

  it('a `host.process.*.cpu_pct` metric validates with unit `percent`', () => {
    const rec = newMetric({
      name: 'host.process.entry.cpu_pct', kind: 'runner', value: 42, unit: 'percent',
      timestamp: '2026-09-12T10:00:00.000Z',
    });
    expect(validateTelemetryEvent(rec)).toEqual({ ok: true, errors: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('summarizeHostProcesses — the reporting/query layer that decides which processes get their own named entry', () => {
  /** One tick's paired cpu_pct/mem_bytes `host.process.entry.*` lines for one pid+command. */
  function entry({ pid, command, cpuPct, memBytes, tick = 1 }) {
    const attrs = { pid, command, tick };
    return [
      { v: 1, event: 'metric', name: 'host.process.entry.cpu_pct', kind: 'runner', value: cpuPct, unit: 'percent', timestamp: '2026-09-12T10:00:00.000Z', traceId: null, attributes: attrs, resource: {} },
      { v: 1, event: 'metric', name: 'host.process.entry.mem_bytes', kind: 'runner', value: memBytes, unit: 'bytes', timestamp: '2026-09-12T10:00:00.000Z', traceId: null, attributes: attrs, resource: {} },
    ];
  }

  it('defaults to the operator\'s own suggested bar: >2% CPU or >200MB', () => {
    expect(DEFAULT_SUBSTANTIAL_CPU_PCT).toBe(2);
    expect(DEFAULT_SUBSTANTIAL_MEM_BYTES).toBe(200 * 1024 * 1024);
  });

  it('a process above the CPU bar (even under the mem bar) gets its own named entry', () => {
    const events = entry({ pid: 100, command: 'git log -1', cpuPct: 80, memBytes: 50 * 1024 * 1024 });
    const s = summarizeHostProcesses(events);
    expect(s.substantial).toHaveLength(1);
    expect(s.substantial[0]).toMatchObject({ label: 'git log -1', pids: [100], meanCpuPct: 80 });
  });

  it('a process above the MEM bar (even under the cpu bar) gets its own named entry', () => {
    const events = entry({ pid: 200, command: 'Google Chrome Helper (Renderer)', cpuPct: 0.1, memBytes: 620 * 1024 * 1024 });
    const s = summarizeHostProcesses(events);
    expect(s.substantial).toHaveLength(1);
    expect(s.substantial[0].label).toBe('Google Chrome Helper (Renderer)');
  });

  it('a process under BOTH bars folds into the below-threshold remainder, not its own entry', () => {
    const events = entry({ pid: 300, command: 'some small helper', cpuPct: 0.5, memBytes: 10 * 1024 * 1024 });
    const s = summarizeHostProcesses(events);
    expect(s.substantial).toHaveLength(0);
    expect(s.belowThresholdRemainder.samples).toBe(1);
    expect(s.belowThresholdRemainder.meanCpuPct).toBeCloseTo(0.5);
  });

  it('groups by COMMAND across ticks (not by pid, which is meaningless across a restart) and reports every distinct pid seen', () => {
    const events = [
      ...entry({ pid: 400, command: 'Code Helper (Plugin)', cpuPct: 3, memBytes: 250 * 1024 * 1024, tick: 1 }),
      ...entry({ pid: 400, command: 'Code Helper (Plugin)', cpuPct: 5, memBytes: 260 * 1024 * 1024, tick: 2 }),
      ...entry({ pid: 401, command: 'Code Helper (Plugin)', cpuPct: 4, memBytes: 255 * 1024 * 1024, tick: 3 }),
    ];
    const s = summarizeHostProcesses(events);
    expect(s.substantial).toHaveLength(1);
    expect(s.substantial[0].samples).toBe(3);
    expect(s.substantial[0].pids).toEqual([400, 401]);
    expect(s.substantial[0].meanCpuPct).toBeCloseTo((3 + 5 + 4) / 3);
    expect(s.substantial[0].maxMemBytes).toBe(260 * 1024 * 1024);
  });

  it('a STRICTER threshold moves an already-stored entry into the remainder, with no re-collection needed', () => {
    const events = entry({ pid: 500, command: 'Windows App.app', cpuPct: 2.5, memBytes: 210 * 1024 * 1024 });
    expect(summarizeHostProcesses(events).substantial).toHaveLength(1);
    const stricter = summarizeHostProcesses(events, { cpuThresholdPct: 5, memThresholdBytes: 500 * 1024 * 1024 });
    expect(stricter.substantial).toHaveLength(0);
    expect(stricter.belowThresholdRemainder.samples).toBe(1);
  });

  it('folds the collection-time below_floor_remainder metrics into its OWN remainder — honest even below its own floor', () => {
    const events = [
      { v: 1, event: 'metric', name: 'host.process.below_floor_remainder.cpu_pct', kind: 'runner', value: 12, unit: 'percent', timestamp: '2026-09-12T10:00:00.000Z', traceId: null, attributes: { processCount: 300 }, resource: {} },
      { v: 1, event: 'metric', name: 'host.process.below_floor_remainder.mem_bytes', kind: 'runner', value: 3 * 1024 * 1024 * 1024, unit: 'bytes', timestamp: '2026-09-12T10:00:00.000Z', traceId: null, attributes: { processCount: 300 }, resource: {} },
    ];
    const s = summarizeHostProcesses(events);
    expect(s.substantial).toHaveLength(0);
    expect(s.belowThresholdRemainder.samples).toBe(1);
    expect(s.belowThresholdRemainder.meanCpuPct).toBeCloseTo(12);
  });

  it('is total on empty/hostile input — never throws', () => {
    for (const junk of [undefined, null, [], [null, undefined, 42, {}]]) {
      expect(() => summarizeHostProcesses(junk)).not.toThrow();
    }
    const s = summarizeHostProcesses([]);
    expect(s).toMatchObject({ substantial: [], belowThresholdRemainder: { samples: 0 } });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// PR #2220 review findings (correctness): the report's per-process means must be WINDOW means that reconcile
// with the machine — normalised per TICK, not per stored row — and the remainder must never mix a single
// process row into a mean with a whole tick's aggregate.
describe('summarizeHostProcesses — window-normalised arithmetic (the report reconciles with the machine)', () => {
  const MB = 1024 * 1024;
  const at = (t) => new Date(Date.UTC(2026, 8, 12, 10, t)).toISOString();
  const metric = (name, value, unit, attributes, t) => ({
    v: 1, event: 'metric', name, kind: 'runner', value, unit, timestamp: at(t), traceId: null, attributes, resource: {},
  });
  /** Run REAL `ps`-shaped rows through the real collection functions, one snapshot per tick, exactly as the
   *  runner would have — so the stored shape under test is the shape production writes. */
  function collect(ticks, rowsFor) {
    const events = [];
    const whole = []; // per tick: the true whole-machine sums, computed straight from the input rows
    for (let t = 0; t < ticks; t += 1) {
      const rows = rowsFor(t);
      whole.push({ cpu: rows.reduce((n, r) => n + r.pcpu, 0), mem: rows.reduce((n, r) => n + r.rssKb * 1024, 0) });
      for (const m of processSnapshotMetrics(buildProcessSnapshot(rows))) {
        events.push(metric(m.name, m.value, m.unit, { ...m.attributes, tick: t }, t));
      }
    }
    return { events, whole };
  }
  const small = (n) => Array.from({ length: n }, (_, i) => ({ pid: 5000 + i, pcpu: 0.5, rssKb: 10 * 1024, command: `/usr/libexec/daemon${i}` }));

  it('a process substantial on ONE tick of ten is averaged over ten ticks, not reported as a steady load', () => {
    const { events } = collect(10, (t) => [
      ...small(20),
      ...(t === 3 ? [{ pid: 900, pcpu: 40, rssKb: 50 * 1024, command: 'git gc --aggressive' }] : []),
    ]);
    const s = summarizeHostProcesses(events);
    expect(s.windowTicks).toBe(10);
    const git = s.substantial.find((g) => g.label === 'git gc --aggressive');
    expect(git.meanCpuPct).toBeCloseTo(4); // 40 over ONE tick of ten — not 40
    expect(git.samples).toBe(1);
    expect(git.maxCpuPct).toBe(40);
  });

  it('N concurrent same-command pids SUM within a tick (4 x 3% is 12% while present), then average over the window', () => {
    const helpers = [1, 2, 3, 4].map((i) => ({ pid: 700 + i, pcpu: 3, rssKb: 50 * 1024, command: 'Electron Helper --type=renderer' }));
    const { events } = collect(10, (t) => [...small(5), ...(t === 0 ? helpers : [])]);
    const g = summarizeHostProcesses(events).substantial.find((x) => x.label.startsWith('Electron Helper'));
    expect(g.pids).toEqual([701, 702, 703, 704]);
    expect(g.maxCpuPct).toBeCloseTo(12);      // the per-tick peak is the SUM of the four
    expect(g.meanCpuPct).toBeCloseTo(1.2);    // 12 on one tick of ten
    // …and the four helpers on EVERY tick: 12% steady, not the 3% a per-row mean would report.
    const steady = collect(10, () => helpers);
    expect(summarizeHostProcesses(steady.events).substantial[0].meanCpuPct).toBeCloseTo(12);
  });

  it('RECONCILES: fixed categories + substantial entries + remainder equals the mean whole-machine sum, per tick', () => {
    const { events, whole } = collect(12, (t) => [
      { pid: 11, pcpu: 11, rssKb: 200 * 1024, command: 'node /w/skills-src/conveyor/runner.mjs' },
      ...small(30),
      ...(t % 4 === 0 ? [1, 2, 3].map((i) => ({ pid: 800 + i, pcpu: 6, rssKb: 400 * 1024, command: 'Code Helper (Plugin)' })) : []),
      ...(t === 5 ? [{ pid: 950, pcpu: 55, rssKb: 90 * 1024, command: 'git repack' }] : []),
      ...(t >= 8 ? [{ pid: 960, pcpu: 1, rssKb: 900 * 1024, command: 'Big Idle App' }] : []),
    ]);
    const s = summarizeHostProcesses(events);
    const g = goldenSignals(events).saturation.gauges;
    const fixedCpu = ['conveyor', 'drain', 'dispatched_agents'].reduce((n, c) => n + (g[`host.process.${c}.cpu_pct`]?.mean || 0), 0);
    const fixedMem = ['conveyor', 'drain', 'dispatched_agents'].reduce((n, c) => n + (g[`host.process.${c}.mem_bytes`]?.mean || 0), 0);
    const reportedCpu = fixedCpu + s.substantial.reduce((n, x) => n + x.meanCpuPct, 0) + s.belowThresholdRemainder.meanCpuPct;
    const reportedMem = fixedMem + s.substantial.reduce((n, x) => n + x.meanMemBytes, 0) + s.belowThresholdRemainder.meanMemBytes;
    expect(reportedCpu).toBeCloseTo(whole.reduce((n, w) => n + w.cpu, 0) / whole.length, 6);
    expect(reportedMem).toBeCloseTo(whole.reduce((n, w) => n + w.mem, 0) / whole.length, 0);
    // A stricter threshold only MOVES load between the parts; the total must not change.
    const stricter = summarizeHostProcesses(events, { cpuThresholdPct: 20, memThresholdBytes: 800 * MB });
    const strictCpu = fixedCpu + stricter.substantial.reduce((n, x) => n + x.meanCpuPct, 0) + stricter.belowThresholdRemainder.meanCpuPct;
    expect(strictCpu).toBeCloseTo(reportedCpu, 6);
    expect(stricter.substantial.map((x) => x.label)).toEqual(['git repack', 'Big Idle App']);
  });

  it('the rendered report\'s `— total —` row is the true window mean (mutation guard: a per-row mean or a missing-tick omission reddens it)', () => {
    const { events, whole } = collect(10, (t) => [
      { pid: 11, pcpu: 10, rssKb: 100 * 1024, command: 'node /w/skills-src/conveyor/runner.mjs' },
      ...small(20),
      ...(t === 0 ? [1, 2, 3, 4].map((i) => ({ pid: 700 + i, pcpu: 3, rssKb: 30 * 1024, command: 'Electron Helper' })) : []),
      ...(t === 6 ? [{ pid: 900, pcpu: 40, rssKb: 30 * 1024, command: 'git gc' }] : []),
    ]);
    const text = renderReport({ ...goldenSignals(events), hostProcesses: summarizeHostProcesses(events), corrupt: 0 }, { hours: 24 });
    const m = /— total —\s+([\d.]+)%/.exec(text);
    expect(m).not.toBeNull();
    const expected = whole.reduce((n, w) => n + w.cpu, 0) / whole.length;
    expect(Number(m[1])).toBeCloseTo(expected, 1);
    // n= is shown as ticks-present out of ticks-in-window, so a one-tick spike is visibly a one-tick spike.
    expect(text).toMatch(/git gc\s+4\.0%.*1\/10 ticks/);
  });

  it('a STRICTER threshold does not mix single process rows into a mean with whole-tick aggregates (remainder is per tick)', () => {
    // 10 ticks: each stores a 100% below-floor AGGREGATE plus one 3% entry row. Stricter threshold 5 pushes the
    // 3% row into the remainder — true per-tick remainder is 103, not (10*100 + 10*3) / 20 = 51.5.
    const events = [];
    for (let t = 0; t < 10; t += 1) {
      events.push(metric('host.process.below_floor_remainder.cpu_pct', 100, 'percent', { processCount: 300, tick: t }, t));
      events.push(metric('host.process.below_floor_remainder.mem_bytes', 1000 * MB, 'bytes', { processCount: 300, tick: t }, t));
      events.push(metric('host.process.entry.cpu_pct', 3, 'percent', { pid: 42, command: 'helper', tick: t }, t));
      events.push(metric('host.process.entry.mem_bytes', 250 * MB, 'bytes', { pid: 42, command: 'helper', tick: t }, t));
    }
    const s = summarizeHostProcesses(events, { cpuThresholdPct: 5, memThresholdBytes: 500 * MB });
    expect(s.substantial).toHaveLength(0);
    expect(s.belowThresholdRemainder.meanCpuPct).toBeCloseTo(103);
    expect(s.belowThresholdRemainder.meanMemBytes).toBeCloseTo(1250 * MB, 0);
    expect(s.belowThresholdRemainder.samples).toBe(10); // ticks, not rows
  });

  it('a runner restart (tick numbering falls back to 0) counts as NEW ticks, not merged with the earlier run', () => {
    const events = [];
    const runs = [[0, 1, 2], [0, 1]];
    let clock = 0;
    for (const run of runs) {
      for (const t of run) {
        events.push(metric('host.process.below_floor_remainder.cpu_pct', 10, 'percent', { processCount: 1, tick: t }, clock));
        events.push(metric('host.process.entry.cpu_pct', 30, 'percent', { pid: 1, command: 'svc', tick: t }, clock));
        events.push(metric('host.process.entry.mem_bytes', 1 * MB, 'bytes', { pid: 1, command: 'svc', tick: t }, clock));
        clock += 1;
      }
    }
    const s = summarizeHostProcesses(events);
    expect(s.windowTicks).toBe(5);
    expect(s.substantial[0]).toMatchObject({ label: 'svc', samples: 5 });
    expect(s.substantial[0].meanCpuPct).toBeCloseTo(30);
  });

  it('masks credential-shaped argv in the group label even for lines stored BEFORE redaction existed', () => {
    const events = [
      metric('host.process.entry.cpu_pct', 30, 'percent', { pid: 7, command: 'node tool.mjs --token=abc123SECRET', tick: 1 }, 1),
      metric('host.process.entry.mem_bytes', 1 * MB, 'bytes', { pid: 7, command: 'node tool.mjs --token=abc123SECRET', tick: 1 }, 1),
    ];
    const [g] = summarizeHostProcesses(events).substantial;
    expect(g.label).toBe('node tool.mjs --token=[REDACTED]');
    expect(JSON.stringify(summarizeHostProcesses(events))).not.toContain('abc123SECRET');
  });
});

describe('normItemKey matches conveyor-instrument.mjs, so the two dispatch keys agree', () => {
  it('normalizes the same way', () => {
    expect(normItemKey('0341')).toBe('341');
    expect(normItemKey('Xe6NenK')).toBe('xe6nenk');
    expect(normItemKey(null)).toBe('');
  });
});

describe('truncateValue marks the cut so a short value is distinguishable from a shortened one', () => {
  it('appends an ellipsis only when it actually truncated', () => {
    expect(truncateValue('short')).toBe('short');
    expect(truncateValue('x'.repeat(600)).endsWith('…')).toBe(true);
    expect(truncateValue(null)).toBe('');
  });
});

describe('newSpanStart / newSpanEnd / newMetric — constructor defaults', () => {
  it('a span end DERIVES its duration rather than trusting the caller', () => {
    const rec = newSpanEnd({
      traceId: 'i1', spanId: 's1', name: 'dispatch',
      startedAt: '2026-09-12T10:00:00.000Z', endedAt: '2026-09-12T10:00:07.000Z',
      durationMs: 999999, // a caller cannot lie about it
    });
    expect(rec.durationMs).toBe(7000);
  });

  it('an unknown status falls back to `unset` rather than being persisted as-is', () => {
    expect(newSpanEnd({ traceId: 'i1', spanId: 's1', name: 'dispatch', startedAt: 'x', endedAt: 'y', status: 'kinda-ok' }).status).toBe('unset');
  });

  it('an out-of-range attempt falls back to 1', () => {
    expect(newSpanStart({ traceId: 'i1', spanId: 's1', name: 'dispatch', startedAt: 'x', attempt: 0 }).attempt).toBe(1);
    expect(newSpanStart({ traceId: 'i1', spanId: 's1', name: 'dispatch', startedAt: 'x', attempt: -3 }).attempt).toBe(1);
  });

  it('a metric with a non-numeric value stores null rather than NaN', () => {
    expect(newMetric({ name: 'queue.depth', value: 'lots', timestamp: 'x' }).value).toBeNull();
  });

  it('a metric defaults to no trace — a host gauge belongs to no item', () => {
    expect(newMetric({ name: 'lane.pool.free', value: 3, timestamp: 'x' }).traceId).toBeNull();
  });
});


describe('summarizeHostProcesses — finding 2 strict reporting boundary', () => {
  it.each([
    ['CPU exactly at bar', 2, 1024, false],
    ['memory exactly at bar', 0, 200 * 1024 * 1024, false],
    ['CPU just above bar', 2.01, 1024, true],
    ['memory just above bar', 0, 200 * 1024 * 1024 + 1024, true],
  ])('uses strict > for %s', (_name, cpuPct, memBytes, substantial) => {
    // Feed stored events directly: routing through buildProcessSnapshot would hide a reporting bug.
    const attributes = { pid: 703, command: 'boundary-helper', tick: 1 };
    const events = [
      { event: 'metric', name: 'host.process.entry.cpu_pct', value: cpuPct, attributes },
      { event: 'metric', name: 'host.process.entry.mem_bytes', value: memBytes, attributes },
    ];
    const summary = summarizeHostProcesses(events);
    expect(summary.substantial).toHaveLength(substantial ? 1 : 0);
    if (substantial) {
      expect(summary.substantial[0]).toMatchObject({ label: 'boundary-helper', pids: [703], meanCpuPct: cpuPct, meanMemBytes: memBytes });
    }
    expect(summary.belowThresholdRemainder.meanCpuPct).toBe(substantial ? 0 : cpuPct);
    expect(summary.belowThresholdRemainder.meanMemBytes).toBe(substantial ? 0 : memBytes);
  });
});
