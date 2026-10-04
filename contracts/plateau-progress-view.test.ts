// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import schema from './plateau-progress-view.schema.json';
import examples from './plateau-progress-view.examples.json';

const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const snapshot = () => structuredClone(examples['partial-history'].snapshot);

describe('Plateau progress-view declarative contract', () => {
  it.each(Object.entries(examples))('accepts %s', (_name, example) => {
    expect(validate(example.snapshot), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(Object.keys(snapshot().summary))('rejects negative summary count: %s', key => {
    const value = snapshot();
    value.summary[key as keyof typeof value.summary].value = -1;
    expect(validate(value)).toBe(false);
  });

  it.each(['today', 'current', 'previous'])('rejects negative delivery count: %s', window => {
    const value = snapshot();
    if (window === 'today') value.deliveries.today.count = -1;
    else value.deliveries.trend[window as 'current' | 'previous'].count = -1;
    expect(validate(value)).toBe(false);
  });

  it.each([0, 3, '2', null])('rejects unsupported version %s', major => {
    expect(validate({ ...snapshot(), schema: major })).toBe(false);
  });

  it('requires source freshness on the envelope', () => {
    const { sources: _sources, ...value } = snapshot();
    expect(validate(value)).toBe(false);
    expect(validate({ ...value, sources: {} })).toBe(false);
  });

  for (const source of Object.keys(snapshot().sources)) {
    it.each(['observedAt', 'lastSuccessAt', 'expectedEveryMs', 'staleAfterMs', 'status', 'complete', 'reason'])(
      `requires ${source}.%s even when unknown`, field => {
        const value = snapshot();
        Reflect.deleteProperty(value.sources[source as keyof typeof value.sources], field);
        expect(validate(value)).toBe(false);
      });
  }

  it('rejects a comparable trend without a measured baseline', () => {
    const value = structuredClone(examples['missing-trend-baseline'].snapshot);
    value.deliveries.trend.status = 'comparable';
    expect(validate(value)).toBe(false);
  });

  it('keeps schema 1 free of required progress sections', () => {
    const value = examples['schema-1-compatibility'].snapshot;
    expect(validate(value)).toBe(true);
    expect(value).not.toHaveProperty('summary');
    expect(validate({ ...value, schema: 2 })).toBe(false);
  });

  it.each(['pending-review-without-human-action', 'red-ci-without-human-action'] as const)(
    '%s records flow without operator work', name => {
      const value = examples[name].snapshot;
      expect(value.items).toHaveLength(1);
      expect(value.actions).toEqual([]);
      expect(value.summary.humanPending.value).toBe(0);
      expect(value.summary.humanActionable.value).toBe(0);
    });

  it('accepts an explicitly pending human review with system prerequisites', () => {
    const value = snapshot();
    const action = {
      id: 'review:web-everything/web-everything#123', kind: 'human-review',
      ref: 'web-everything/web-everything#123', description: 'Review the contract change.',
      operatorReason: 'Explicit human review requested.', ready: false,
      blockingSystemPrerequisites: ['clean CI'],
      url: 'https://github.com/web-everything/web-everything/pull/123', forkRef: null,
    };
    const example = { ...value, actions: [action] };
    example.summary.humanPending.value = 1;
    example.coverage.collections.actions = { total: 1, included: 1, complete: true, source: 'actions' };
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...example, actions: [{ ...action, kind: 'red-ci' }] })).toBe(false);
  });
});

// Walk the supplied health evidence to exercise every nested closed object.
const healthSnapshot = () => structuredClone(examples['health-stop-pending'].snapshot);
type Path = (string | number)[];
function entries(value: unknown, path: Path = []): { path: Path; value: unknown }[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = [...path, Array.isArray(value) ? Number(key) : key];
    return [{ path: childPath, value: child }, ...entries(child, childPath)];
  });
}
function replace(value: object, path: Path, replacement: unknown) {
  const parent = path.slice(0, -1).reduce((node, key) => Reflect.get(node, key), value);
  Reflect.set(parent, path[path.length - 1], replacement);
}
const healthEntries = [{ path: ['health'], value: healthSnapshot().health },
  ...entries(healthSnapshot().health, ['health'])];
const timestampPaths = healthEntries.filter(({ path }) => /At$|^since$/.test(String(path.at(-1))));
const countPaths = healthEntries.filter(({ path }) =>
  ['limit', 'remaining', 'used', 'measured', 'estimated', 'unattributed', 'expectedEveryMs', 'staleAfterMs'].includes(String(path.at(-1))));
const objectPaths = healthEntries.filter(({ value }) => value !== null && typeof value === 'object' && !Array.isArray(value));

describe('optional, strictly validated health evidence', () => {
  it('retains all existing schema-2 examples without health', () => {
    for (const [name, example] of Object.entries(examples)) {
      if (name.startsWith('health-') || example.snapshot.schema !== 2) continue;
      expect(example.snapshot).not.toHaveProperty('health');
      expect(validate(example.snapshot)).toBe(true);
    }
  });

  for (const { path } of timestampPaths) {
    it.each(['yesterday', '', 0, '2026-13-01T00:00:00Z', '2026-02-29T00:00:00Z',
      '2100-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-09-30T24:00:00Z',
      '2026-09-30T16:60:00Z', '2026-09-30T16:00:60Z', '2026-09-30T16:00:00+00:00'])(
      `rejects invalid ${path.join('.')}: %s`, invalid => {
        const value = healthSnapshot();
        replace(value, path, invalid);
        expect(validate(value)).toBe(false);
      });
  }
  it.each(['2024-02-29T00:00:00Z', '2000-02-29T23:59:59.123Z'])(
    'accepts calendar-valid leap timestamp %s', instant => {
      const value = healthSnapshot();
      for (const { path } of timestampPaths) replace(value, path, instant);
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    });

  for (const { path } of countPaths) {
    it.each([-1, 1.5, '1', true])(`rejects invalid ${path.join('.')}: %s`, invalid => {
      const value = healthSnapshot();
      replace(value, path, invalid);
      expect(validate(value)).toBe(false);
    });
  }
  for (const { path, value: object } of objectPaths) {
    it(`rejects unknown keys at ${path.join('.')}`, () => {
      const value = healthSnapshot();
      replace(value, path, { ...object as object, surprise: true });
      expect(validate(value)).toBe(false);
    });
    it.each(Object.keys(object as object))(`requires ${path.join('.')}.%s`, key => {
      const value = healthSnapshot();
      const replacement = { ...object as object };
      Reflect.deleteProperty(replacement, key);
      replace(value, path, replacement);
      expect(validate(value)).toBe(false);
    });
  }
  it.each([null, [], 'healthy', {}])('rejects malformed health %j', health => {
    expect(validate({ ...snapshot(), health })).toBe(false);
  });
  it('requires explanation for unavailable evidence', () => {
    const value = structuredClone(examples['health-unknown'].snapshot);
    value.health.episodes.freshness.reason = '';
    expect(validate(value)).toBe(false);
  });
  it('does not allow unavailable rows to certify healthy completeness', () => {
    const value = healthSnapshot();
    replace(value, ['health', 'episodes', 'rows'], null);
    expect(validate(value)).toBe(false);
  });
  it('requires an explanation for unknown control evidence', () => {
    const value = healthSnapshot();
    replace(value, ['health', 'overnight', 'reason'], null);
    expect(validate(value)).toBe(false);
  });
  it('preserves pending stop, unknown scope and independent source ages', () => {
    const pending = examples['health-stop-pending'].snapshot.health.overnight;
    expect(pending).toMatchObject({ desiredMode: 'stop', observedState: 'running', status: 'pending', nextCheckAt: null });
    expect(pending.affectedJobRefs).toEqual(['runner:job-7']);
    expect(examples['health-unknown'].snapshot.health.overnight).toMatchObject({ observedState: null, affectedJobRefs: null });
    const stale = examples['health-stale'].snapshot;
    expect(stale.health.daemons.rows[0].heartbeatAt).toBe(stale.observedAt);
    expect(stale.health.daemons.rows[0].completedPassAt).not.toBe(stale.observedAt);
    expect(stale.health.budgetWindows.rows[0].freshness.observedAt).not.toBe(stale.observedAt);
    expect(examples['health-conflict'].snapshot.health.overnight.observedState).toBe('controller-vNext:active');
  });
});

const provenanceSnapshot = () => {
  const value = structuredClone(examples['moving-and-held'].snapshot);
  const observation = { source: 'runs', observedAt: '2024-02-29T00:00:00Z' };
  Object.assign(value.runs[0], {
    owner: 'alice', author: 'bob', origin: 'standalone',
    supervisor: { identity: 'runner:supervisor', provider: null, ...observation },
    executor: { identity: 'codex:session-1', provider: 'openai', ...observation },
    requestedModel: { provider: 'openai', model: 'requested-model', ...observation, evidenceKind: 'requested' },
    reportedModel: { provider: 'provider-vNext', model: 'reported-model', ...observation, evidenceKind: 'reported' },
  });
  Object.assign(value.holds[0], {
    sourceEvidence: { source: 'holds', observedAt: null },
    overlap: { counterpart: { workRef: 'we:4620', runId: null }, files: [{ repo: 'we', path: 'contracts/example.json' }] },
    capacity: { used: 3, limit: 2, unit: 'jobs', source: 'holds', observedAt: null },
  });
  return value;
};
const extensionPaths: Path[] = [
  ...['owner', 'author', 'origin', 'supervisor', 'executor', 'requestedModel', 'reportedModel'].map(key => ['runs', 0, key]),
  ...['sourceEvidence', 'overlap', 'capacity'].map(key => ['holds', 0, key]),
];
const provenanceEntries = extensionPaths.flatMap(path => {
  const value = path.reduce((node, key) => Reflect.get(node, key), provenanceSnapshot() as object);
  return [{ path, value }, ...entries(value, path)];
});
function rejectsAt(path: Path, invalid: unknown, keyword: string) {
  const value = provenanceSnapshot();
  replace(value, path, invalid);
  expect(validate(value)).toBe(false);
  expect(validate.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ instancePath: '/' + path.join('/'), keyword }),
  ]));
}

describe('executor provenance and hold evidence', () => {
  it('accepts mismatched requested/reported evidence without inferring truth', () => {
    const value = provenanceSnapshot();
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    const run = value.runs[0] as unknown as Record<string, unknown>;
    expect(run.requestedModel).not.toEqual(run.reportedModel);
  });
  it('accepts absent extensions, null extensions and unknown nested facts', () => {
    expect(validate(examples['moving-and-held'].snapshot)).toBe(true);
    const value = provenanceSnapshot();
    for (const path of extensionPaths) replace(value, path, null);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    const unknown = provenanceSnapshot();
    for (const { path } of provenanceEntries) {
      if (['identity', 'provider', 'model', 'observedAt', 'counterpart', 'files', 'used', 'limit'].includes(String(path.at(-1)))) replace(unknown, path, null);
    }
    expect(validate(unknown), JSON.stringify(validate.errors)).toBe(true);
  });
  for (const { path, value } of provenanceEntries) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      it.each([42, [], true])(`rejects wrong object type ${path.join('.')}: %j`, invalid => rejectsAt(path, invalid, 'type'));
      it(`closes ${path.join('.')}`, () => rejectsAt(path, { ...value, typo: true }, 'additionalProperties'));
      it.each(Object.keys(value))(`requires ${path.join('.')}.%s`, key => {
        const replacement = { ...value };
        Reflect.deleteProperty(replacement, key);
        rejectsAt(path, replacement, 'required');
      });
    }
    if (typeof value === 'string' && !['observedAt', 'evidenceKind'].includes(String(path.at(-1)))) {
      it(`rejects empty ${path.join('.')}`, () => rejectsAt(path, '', 'minLength'));
      it(`rejects wrong string type ${path.join('.')}`, () => rejectsAt(path, [], 'type'));
    }
    if (path.at(-1) === 'observedAt') {
      it.each(['yesterday', '2026-02-29T00:00:00Z', '2100-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-10-01T24:00:00Z', '2026-10-01T00:00:00+00:00'])(
        `rejects invalid instant ${path.join('.')}: %s`, invalid => rejectsAt(path, invalid, 'pattern'));
      it(`accepts leap instant ${path.join('.')}`, () => {
        const value = provenanceSnapshot();
        replace(value, path, '2000-02-29T23:59:59.123Z');
        expect(validate(value)).toBe(true);
      });
    }
  }
  it.each(['used', 'limit'])('validates capacity %s', key => {
    for (const invalid of [-1, 1.5, '1', true]) rejectsAt(['holds', 0, 'capacity', key], invalid, invalid === -1 ? 'minimum' : 'type');
    for (const valid of [null, 0, 5]) {
      const value = provenanceSnapshot();
      replace(value, ['holds', 0, 'capacity', key], valid);
      expect(validate(value)).toBe(true);
    }
  });
  it('does not accept requested-only evidence as reported', () => {
    rejectsAt(['runs', 0, 'reportedModel', 'evidenceKind'], 'requested', 'const');
    rejectsAt(['runs', 0, 'requestedModel', 'evidenceKind'], 'reported', 'const');
  });
  it.each(['/tmp/log', '../secret', 'a/../secret', './file', 'a/./file', 'C:/logs', '\\server\\log', 'a\\..\\secret', 'a//b', 'a/'])(
    'rejects unsafe file path %s', path => rejectsAt(['holds', 0, 'overlap', 'files', 0, 'path'], path, 'pattern'));
  it('rejects bare file references and malformed file collections', () => {
    rejectsAt(['holds', 0, 'overlap', 'files', 0], 'contracts/example.json', 'type');
    rejectsAt(['holds', 0, 'overlap', 'files'], {}, 'type');
  });
  it('preserves unassigned preparation and unknown raw codes', () => {
    const value = provenanceSnapshot();
    value.holds[0].owner = null;
    value.holds[0].rawReason = 'scheduler-vNext:pending';
    value.holds[0].normalizedReason = 'preparation';
    value.runs[0].rawState = 'executor-vNext:active';
    expect(validate(value)).toBe(true);
  });
});

describe('PR collection capability regressions', () => {
  it.each([null, {}, 'unavailable', [null]])('rejects malformed supplied PR rows %j', pullRequests => {
    expect(validate({ ...snapshot(), pullRequests })).toBe(false);
  });
  it('requires matching coverage when PR rows are supplied', () => {
    expect(validate({ ...snapshot(), pullRequests: [] })).toBe(false);
  });
  it('rejects malformed supplied PR coverage', () => {
    const value = snapshot();
    Object.assign(value.coverage.collections, { pullRequests: {} });
    expect(validate(value)).toBe(false);
  });
  it.each(['prPageRequest', 'prPageResponse', 'prPageRestart'])('declares standalone %s', name => {
    expect(schema.definitions).toHaveProperty(name);
  });
});

// Fixture-only relationship assertions: no runtime validator or classification algorithm.
const pageAjv = new Ajv({ allErrors: true, strict: false });
const pageValidators = Object.fromEntries(['prPageRequest', 'prPageResponse', 'prPageRestart'].map(name => [name,
  pageAjv.compile({ definitions: schema.definitions, $ref: `#/definitions/${name}` }),
]));
const prSnapshot = () => structuredClone(examples['pr-complete-cross-repo'].snapshot);
type PrSnapshot = ReturnType<typeof prSnapshot>;
type Row = PrSnapshot['pullRequests'][number];
type Coverage = PrSnapshot['coverage']['collections']['pullRequests'];
type Exchange = typeof examples['pr-unknown-total-pages']['exchanges'][number] |
  typeof examples['pr-restart-old-snapshot']['exchanges'][number];
const identity = (row: Row) => `${row.repo}#${row.number}`;
function conformRows(rows: Row[], coverage: Coverage, value: PrSnapshot) {
  expect(coverage.included).toBe(rows.length);
  expect(coverage.included).toBeLessThanOrEqual(coverage.cached);
  if (coverage.total !== null) expect(coverage.cached).toBeLessThanOrEqual(coverage.total);
  expect(new Set(rows.map(identity)).size).toBe(rows.length);
  expect(value.sources).toHaveProperty(coverage.source);
  expect(coverage.freshness).toEqual(Reflect.get(value.sources, coverage.source));
  if (coverage.complete) {
    expect(coverage.total).not.toBeNull();
    expect(coverage.cached).toBe(coverage.total);
    expect(coverage.freshness.complete).toBe(true);
  }
  for (const row of rows) {
    expect(row.url).toBe(`https://github.com/${row.repo}/pull/${row.number}`);
    for (const source of [...row.sources, row.ci.source, row.review.source,
      ...row.waitingChain.blockers.map(blocker => blocker.source)]) {
      expect(Object.hasOwn(value.sources, source)).toBe(true);
      expect(row.sources).toContain(source);
    }
    expect(row.waitReasons).toContain(row.primaryWait);
    if (row.primaryWait === 'ready') {
      expect(row.draft).toBe(false);
      expect(row.ci.state.value).toBe('success');
      expect(row.review.state.value).toBe('approved');
      for (const evidence of [row.ci, row.review]) {
        expect(evidence.observedHeadSha.value).toBe(row.headSha);
        expect(evidence.observedAt.value).not.toBeNull();
      }
    }
    const chain = row.waitingChain;
    expect(chain.nextSteps.map(step => step.order)).toEqual(chain.nextSteps.map((_, i) => i + 1));
    for (const instant of [row.waitSince.value, chain.holder.claimedAt.value,
      row.ci.observedAt.value, row.review.observedAt.value,
      ...chain.blockers.map(blocker => blocker.observedAt.value)]) {
      if (instant !== null) expect(Date.parse(instant)).toBeLessThanOrEqual(Date.parse(value.observedAt));
    }
    if (chain.holder.liveness === 'active') {
      expect(chain.holder.identity.value).not.toBeNull();
      expect(chain.holder.claimedAt.value).not.toBeNull();
      expect(chain.holder.leaseExpiresAt.value).not.toBeNull();
      expect(Date.parse(chain.holder.leaseExpiresAt.value!)).toBeGreaterThan(Date.parse(value.observedAt));
    }
    if (chain.eta.milliseconds.value !== null) {
      expect(chain.eta.sampleCount).toBeGreaterThan(0);
      expect(chain.eta.sampleWindow.value).not.toBeNull();
      expect(chain.eta.method.value).not.toBeNull();
      expect(chain.eta.uncertainty.value).not.toBeNull();
    }
    const window = chain.eta.sampleWindow.value;
    if (window) {
      expect(Date.parse(window.start)).toBeLessThan(Date.parse(window.end));
      expect(Date.parse(window.end)).toBeLessThanOrEqual(Date.parse(value.observedAt));
    }
  }
}
function conformExchanges(value: PrSnapshot, exchanges: Exchange[]) {
  const expectedIdentity = { snapshotId: value.snapshotId, publisherId: value.publisherId, sequence: value.sequence };
  const seen: Row[] = [];
  const cursors = new Set<string>();
  let next: string | null = null;
  for (const { request, result } of exchanges) {
    expect(pageValidators.prPageRequest(request)).toBe(true);
    const restart = result.kind === 'pr-page-restart';
    expect(pageValidators[restart ? 'prPageRestart' : 'prPageResponse'](result)).toBe(true);
    expect(request.identity).toEqual(expectedIdentity);
    expect(result.identity).toEqual(request.identity);
    expect(result.cursor).toBe(request.cursor);
    expect(result.collection).toBe(request.collection);
    if ('replacement' in result) {
      if (result.replacement) {
        expect(result.replacement).not.toEqual(request.identity);
        if (result.reason === 'publisher-restart') expect(result.replacement.publisherId).not.toBe(request.identity.publisherId);
      }
      continue;
    }
    expect(request.cursor).toBe(next);
    const coverage = value.coverage.collections.pullRequests;
    expect({ ...result.coverage, included: coverage.included }).toEqual(coverage);
    conformRows(result.rows, result.coverage, value);
    for (const row of result.rows) {
      const initial = value.pullRequests.find(r => identity(r) === identity(row));
      if (initial) expect(row).toEqual(initial);
    }
    seen.push(...result.rows);
    expect(new Set(seen.map(identity)).size).toBe(seen.length);
    next = result.nextCursor;
    if (next !== null) {
      expect(cursors.has(next)).toBe(false);
      cursors.add(next);
      expect(seen.length).toBeLessThan(coverage.cached);
    } else expect(seen.length).toBe(coverage.cached);
  }
  if (seen.length) {
    expect(next).toBeNull();
    for (const row of value.pullRequests) expect(seen).toContainEqual(row);
  }
}
const prEntries = [
  ...entries(prSnapshot().pullRequests, ['pullRequests']),
  { path: ['coverage', 'collections', 'pullRequests'], value: prSnapshot().coverage.collections.pullRequests },
  ...entries(prSnapshot().coverage.collections.pullRequests, ['coverage', 'collections', 'pullRequests']),
];

describe('PR waiting and cached-page conformance', () => {
  for (const [name, example] of Object.entries(examples)) {
    if (!('pullRequests' in example.snapshot)) continue;
    it(`validates relationships in ${name}`, () => {
      const value = example.snapshot as PrSnapshot;
      conformRows(value.pullRequests, value.coverage.collections.pullRequests, value);
      if ('exchanges' in example) conformExchanges(value, example.exchanges);
    });
  }
  for (const { path, value: field } of prEntries) {
    if (field !== null && typeof field === 'object' && !Array.isArray(field)) {
      it(`closes structured evidence ${path.join('.')}`, () => {
        const value = prSnapshot();
        replace(value, path, { ...field, transcript: 'forbidden payload' });
        expect(validate(value)).toBe(false);
      });
      it.each(Object.keys(field))(`requires ${path.join('.')}.%s`, key => {
        const value = prSnapshot();
        const changed = { ...field };
        Reflect.deleteProperty(changed, key);
        replace(value, path, changed);
        expect(validate(value)).toBe(false);
      });
      if ('value' in field && field.value === null) {
        it(`requires reason for unknown ${path.join('.')}`, () => {
          const value = prSnapshot();
          replace(value, [...path, 'reason'], null);
          expect(validate(value)).toBe(false);
        });
      }
    }
    if (typeof field === 'number') {
      it.each([-1, 1.5])(`rejects invalid count/duration ${path.join('.')}: %s`, invalid => {
        const value = prSnapshot(); replace(value, path, invalid);
        expect(validate(value)).toBe(false);
      });
    }
    if (typeof field === 'string' && /^2026-/.test(field)) {
      it.each(['yesterday', '2026-02-29T00:00:00Z', '2026-09-30T24:00:00Z'])(
        `rejects invalid instant ${path.join('.')}: %s`, invalid => {
          const value = prSnapshot(); replace(value, path, invalid);
          expect(validate(value)).toBe(false);
        });
    }
  }
  it.each(['/tmp/secret', '~/secret', '../secret', 'a/../secret', './secret', 'C:/secret', 'a\\secret', 'a//secret'])(
    'rejects hostile shared file %s', invalid => {
      const value = prSnapshot(); value.pullRequests[0].waitingChain.blockers[0].file.path = invalid;
      expect(validate(value)).toBe(false);
    });
  it.each(['alpha', '/alpha', '../alpha', 'example/alpha/more'])('rejects malformed repository %s', repo => {
    const value = prSnapshot(); value.pullRequests[0].repo = repo;
    expect(validate(value)).toBe(false);
  });
  const mutations: [string, (value: PrSnapshot) => void][] = [
    ['included mismatch', v => { v.coverage.collections.pullRequests.included = 1; }],
    ['above cached', v => { v.coverage.collections.pullRequests.cached = 1; }],
    ['above total', v => { v.coverage.collections.pullRequests.total = 1; }],
    ['duplicate identity', v => { v.pullRequests[1] = structuredClone(v.pullRequests[0]); }],
    ['missing source join', v => { v.pullRequests[0].ci.source = 'missing'; }],
    ['false completeness', v => { Reflect.set(v.coverage.collections.pullRequests, 'total', null); }],
    ['incomplete source', v => { v.sources.pullRequests.complete = false; v.coverage.collections.pullRequests.freshness.complete = false; }],
    ['old-head readiness', v => { v.pullRequests[1].ci.observedHeadSha.value = 'b'.repeat(40); }],
    ['missing-CI readiness', v => { Reflect.set(v.pullRequests[1].ci.state, 'value', null); }],
    ['expired active holder', v => { v.pullRequests[0].waitingChain.holder.liveness = 'active'; }],
    ['unordered next steps', v => { v.pullRequests[0].waitingChain.nextSteps.reverse(); }],
    ['unmeasured ETA', v => { v.pullRequests[1].waitingChain.eta.sampleCount = 0; }],
    ['inverted sample window', v => { v.pullRequests[1].waitingChain.eta.sampleWindow.value!.start = v.observedAt; }],
    ['future wait start', v => { Reflect.set(v.pullRequests[0].waitSince, 'value', '2099-01-01T00:00:00Z'); }],
  ];
  it.each(mutations)('rejects cross-field %s', (_name, mutate) => {
    const value = prSnapshot(); mutate(value);
    expect(() => conformRows(value.pullRequests, value.coverage.collections.pullRequests, value)).toThrow();
  });
  it('retains unknown universe through final partial page and historical head evidence', () => {
    const value = examples['pr-unknown-total-pages'];
    expect(value.exchanges.at(-1)!.result).toMatchObject({ nextCursor: null, coverage: { total: null, cached: 3, complete: false } });
    expect(value.snapshot.pullRequests[0].ci.observedHeadSha.value).not.toBe(value.snapshot.pullRequests[0].headSha);
    expect(value.snapshot.pullRequests[0].waitSince.value).toBeNull();
    expect(value.snapshot.pullRequests[0].waitingChain.holder.claimedAt.value).not.toBe(value.snapshot.observedAt);
  });
  it.each(['identity', 'cursor', 'membership', 'counts', 'early-end', 'cycle', 'duplicate', 'changed-row'])(
    'rejects page inconsistency: %s', mutation => {
      const value = structuredClone(examples['pr-unknown-total-pages']);
      const result = value.exchanges[1].result;
      if (mutation === 'identity') result.identity.publisherId = 'different-boot';
      if (mutation === 'cursor') result.cursor = 'wrong';
      if (mutation === 'membership') result.coverage.cached++;
      if (mutation === 'counts') result.coverage.included++;
      if (mutation === 'early-end') result.nextCursor = null;
      if (mutation === 'cycle') result.nextCursor = 'opaque-1';
      if (mutation === 'duplicate') result.rows[0] = structuredClone(value.exchanges[0].result.rows[0]);
      if (mutation === 'changed-row') value.exchanges[0].result.rows[0].description = 'Changed within snapshot';
      expect(() => conformExchanges(value.snapshot as PrSnapshot, value.exchanges)).toThrow();
    });
  for (const example of [examples['pr-unknown-total-pages'], examples['pr-restart-old-snapshot']]) {
    for (const [index, exchange] of example.exchanges.entries()) {
      for (const [side, message] of Object.entries(exchange)) {
        const validator = pageValidators[side === 'request' ? 'prPageRequest' : 'replacement' in message ? 'prPageRestart' : 'prPageResponse'];
        it.each(Object.keys(message))(`requires page ${message.kind} ${index} %s`, key => {
          const value = structuredClone(message); Reflect.deleteProperty(value, key);
          expect(validator(value)).toBe(false);
        });
        it(`rejects transcript and root-envelope use of ${message.kind} ${index}`, () => {
          expect(validator({ ...message, transcript: 'not permitted' })).toBe(false);
          expect(validate(message)).toBe(false);
        });
      }
    }
  }
});

describe('strict PR page and identity wire boundaries', () => {
  it.each([
    [['pullRequests', 0, 'number'], 0],
    [['pullRequests', 0, 'headSha'], 'short-sha'],
    [['pullRequests', 0, 'url'], 'file:///private/secret'],
    [['pullRequests', 0, 'waitingChain'], {}],
    [['pullRequests', 0, 'waitingChain', 'queuePosition', 'value'], 0],
    [['coverage', 'collections', 'pullRequests', 'freshness'], {}],
  ] as [Path, unknown][])('rejects malformed supplied %j', (path, invalid) => {
    const value = prSnapshot(); replace(value, path, invalid);
    expect(validate(value)).toBe(false);
  });
  it.each([
    [['identity', 'sequence'], -1], [['identity', 'sequence'], 0.5],
    [['identity', 'snapshotId'], ''], [['identity', 'publisherId'], ''],
    [['collection'], 'runs'], [['cursor'], ''], [['nextCursor'], ''],
    [['rows'], null], [['rows', 0, 'waitingChain'], {}],
    [['coverage', 'cached'], -1], [['coverage', 'included'], 0.5],
    [['coverage', 'freshness', 'observedAt'], '2026-02-29T00:00:00Z'],
  ] as [Path, unknown][])('rejects malformed standalone response %j', (path, invalid) => {
    const value = structuredClone(examples['pr-unknown-total-pages'].exchanges[0].result);
    replace(value, path, invalid);
    expect(pageValidators.prPageResponse(value)).toBe(false);
  });
  it('rejects restart with a non-replacement identity or wrong publisher boot', () => {
    for (const name of ['pr-restart-old-snapshot', 'pr-restart-publisher-restart'] as const) {
      const value = structuredClone(examples[name]);
      value.exchanges[0].result.replacement = structuredClone(value.exchanges[0].request.identity);
      expect(() => conformExchanges(value.snapshot as PrSnapshot, value.exchanges)).toThrow();
    }
    const value = structuredClone(examples['pr-restart-invalid-cursor'].exchanges[0].result);
    value.reason = 'invented';
    expect(pageValidators.prPageRestart(value)).toBe(false);
  });
});
