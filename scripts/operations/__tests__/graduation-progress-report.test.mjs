/**
 * @file we:scripts/operations/__tests__/graduation-progress-report.test.mjs
 * @description Regression proofs for graduation progress (#3690, #xtw2rap): the report now calls the
 * router (`selectSupervisionLevel`) instead of re-deriving its own findings-based predicates — the prior
 * version disagreed with the router because it treated any non-null `findings` as a problem, even on the
 * 14 `landed` rows that carry praise there. These cases assert the router semantics directly, over both
 * synthetic fixtures and a frozen snapshot of the real scorecard history (`fixtures/run-scorecards-2026-09-25.json`).
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { withRealRepo } from './helpers/real-repo.mjs';
import { createRegistry } from '../registry.mjs';
import { startRun, advanceWhileRunning, runStatus } from '../engine.mjs';
import { isReadOnlyDeclaration } from '../http-adapter.mjs';
import { importGraph } from './import-graph.mjs';
import { OPERATIONS } from '../run.mjs';
import { selectSupervisionLevel, DEFAULT_BACKDOWN_THRESHOLDS } from '../../lib/provider-routing.mjs';
import {
  createScorecardReader, createPromotionsReader, createProbationReader,
} from '../graduation-progress-report-io.mjs';
import {
  GRADUATION_PROGRESS_REPORT_OP, buildGraduationProgressReport, graduationProgressReportOperation,
} from '../graduation-progress-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AS_OF = '2026-09-15T06:00:00.000Z';
// The real trial history as it stood when the store moved out of the git tree (#4155) — a frozen snapshot of the
// last tracked `scripts/conveyor/run-scorecards.json`, so these real-data assertions stay deterministic.
const REAL_SCORECARDS_PATH = resolve(HERE, 'fixtures', 'run-scorecards-2026-09-25.json');
const REAL_RECORDS = JSON.parse(readFileSync(REAL_SCORECARDS_PATH, 'utf8')).records;

const ABSENT_SOURCE = { source: 'absent', entries: [] };
// The router is INJECTED into `buildGraduationProgressReport`/`graduationProgressReportOperation`, never
// imported by the declaration itself (see graduation-progress-report.mjs's header) -- spread this into every
// call in this file so each test supplies the SAME real predicates run.mjs wires in production.
const ROUTER = { selectSupervisionLevel, backdownThresholds: DEFAULT_BACKDOWN_THRESHOLDS };

const REAL_TRIALS = [
  { scoredAt: '2026-09-15T01:00:00.000Z', provider: 'codex', model: 'gpt-6-astra', dispatchKind: 'session-delegation', taskType: 'bugfix', verifiedBy: 'claude-subagent', findings: null, outcome: 'landed' },
  { scoredAt: '2026-09-15T01:30:00.000Z', provider: 'codex', model: 'gpt-6-astra', dispatchKind: 'session-delegation', taskType: 'conflict-resolution', verifiedBy: 'claude-subagent', findings: null, outcome: 'landed' },
  { scoredAt: '2026-09-15T02:00:00.000Z', provider: 'codex', model: 'gpt-6-astra', dispatchKind: 'session-delegation', taskType: 'self-fix', verifiedBy: 'claude-subagent', findings: null, outcome: 'landed' },
  { scoredAt: '2026-09-15T02:30:00.000Z', provider: 'codex', model: 'gpt-6-astra', dispatchKind: 'session-delegation', taskType: 'bugfix', verifiedBy: 'claude-subagent', findings: null, outcome: 'landed' },
  { scoredAt: '2026-09-15T03:00:00.000Z', provider: 'codex', model: 'gpt-6-astra', dispatchKind: 'session-delegation', taskType: 'doc-fix', verifiedBy: 'claude-subagent', findings: null, outcome: 'landed' },
  { scoredAt: '2026-09-15T03:40:00.000Z', provider: 'codex', model: 'gpt-6-astra', dispatchKind: 'session-delegation', taskType: 'bugfix', verifiedBy: 'independent-claude', findings: 'round 1 finding', outcome: 'reworked' },
  { scoredAt: '2026-09-15T04:20:00.000Z', provider: 'codex', model: 'gpt-6-astra', dispatchKind: 'session-delegation', taskType: 'bugfix', verifiedBy: 'independent-claude', findings: 'round 2 finding', outcome: 'reworked' },
  { scoredAt: '2026-09-15T05:00:00.000Z', provider: 'codex', model: 'gpt-6-astra', dispatchKind: 'session-delegation', taskType: 'bugfix', verifiedBy: 'independent-claude', findings: null, outcome: 'landed' },
  { scoredAt: '2026-09-15T05:30:00.000Z', provider: 'antigravity', model: 'gemini-3.1-pro', dispatchKind: 'session-delegation', taskType: 'other', verifiedBy: 'other', findings: 'smoke test note', outcome: 'landed' },
];

function trial(minute, overrides = {}) {
  // subjectClass is stamped here (not on REAL_TRIALS itself, which the io/roundtrip tests above compare
  // structurally) because #3897 ports #3845's {provider, model, subjectClass, taskType} keying into the
  // router this file injects: a record with no subjectClass never matches (the safe direction), which would
  // silently zero every synthetic fixture's streak below. Real scorecard rows all carry it already.
  return { ...REAL_TRIALS[0], subjectClass: 'work-agent', scoredAt: `2026-09-16T00:${String(minute).padStart(2, '0')}:00.000Z`, ...overrides };
}
const cleanTrials = (n) => Array.from({ length: n }, (_, i) => trial(i + 1));
// #3897 ports rules 4 (#3888) and 5 (#3889): `informative` is now read only from its own explicit field, and
// once ANY unclean record is on record, restoration needs a `rootCause` note in its own field plus the
// post-miss bar (minCleanStreak + k = 5 + 3 = 8 for these tests' default thresholds), not just minCleanStreak.
const informative = () => trial(0, {
  findings: 'caught and subsequently fixed', verifiedBy: 'independent-claude', outcome: 'reworked',
  informative: true, rootCause: 'Diagnosed: caught by review; fixed and root-caused.',
});
const POST_MISS_BAR = DEFAULT_BACKDOWN_THRESHOLDS.minCleanStreak + DEFAULT_BACKDOWN_THRESHOLDS.k;

function runReport(store, { promotions = ABSENT_SOURCE, probation = ABSENT_SOURCE } = {}) {
  const readScorecards = createScorecardReader({ exists: () => true, read: () => JSON.stringify(store), now: () => AS_OF });
  const readPromotions = () => promotions;
  const readProbation = () => probation;
  const declaration = graduationProgressReportOperation({ readScorecards, readPromotions, readProbation, ...ROUTER });
  const registry = createRegistry();
  registry.register(declaration);
  const run = advanceWhileRunning(startRun({ op: GRADUATION_PROGRESS_REPORT_OP, id: 'graduation-test', input: {}, registry }), { registry });
  expect(runStatus(run, { registry })).toBe('complete');
  return run;
}

function findTriple(report, provider, model, taskType) {
  const agent = report.agents.find((a) => a.provider === provider && a.model === model);
  return agent?.triples.find((t) => t.taskType === taskType);
}

describe('graduation progress registration and engine', () => {
  it('reads a real scorecard file without modifying it and handles a missing store', async () => {
    await withRealRepo(({ root }) => {
      const path = resolve(root, 'scorecards.json');
      const reader = createScorecardReader({ path });
      expect(reader().records).toEqual([]);
      const contents = JSON.stringify({ version: 1, records: REAL_TRIALS });
      writeFileSync(path, contents);
      const before = new Date().toISOString();
      const snapshot = reader();
      const after = new Date().toISOString();
      expect(snapshot.records).toEqual(REAL_TRIALS);
      expect(snapshot.asOfIso >= before && snapshot.asOfIso <= after).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe(contents);
    });
  });

  it('is reachable through the CLI table with no sinks and only compute steps', () => {
    expect(Object.keys(OPERATIONS)).toContain(GRADUATION_PROGRESS_REPORT_OP);
    const { declaration, sinks } = OPERATIONS[GRADUATION_PROGRESS_REPORT_OP]();
    expect(declaration.name).toBe(GRADUATION_PROGRESS_REPORT_OP);
    expect(sinks).toEqual({});
    expect(isReadOnlyDeclaration(declaration)).toBe(true);
  });

  it('never imports the router: it is injected, so this declaration reaches nothing that can act (#3036)', () => {
    // The file's own header names `provider-routing.mjs` in prose (explaining WHY it is injected, not
    // imported), so this asserts the real import-graph property rather than grepping raw source text.
    const { files, external } = importGraph(resolve(HERE, '..', 'graduation-progress-report.mjs'));
    expect(files.some((f) => f.endsWith('/provider-routing.mjs'))).toBe(false);
    expect(files.filter((f) => f.endsWith('graduation-progress-report-io.mjs'))).toEqual([]);
    expect(external).toEqual([]);
  });

  it('runs the full declaration with all three readers, the injected router, and an injected clock', () => {
    const run = runReport({ version: 1, records: REAL_TRIALS });
    expect(run.verdict).toEqual(buildGraduationProgressReport({ records: REAL_TRIALS, asOfIso: AS_OF, promotions: ABSENT_SOURCE, probation: ABSENT_SOURCE, ...ROUTER }));
    expect(run.verdict).toMatchObject({ schema: 2, asOf: AS_OF, sources: { scorecards: 'ok', promotions: 'absent', probation: 'absent' } });
    expect(run.verdict.agents.length).toBeGreaterThan(0);
  });

  it('reports an empty store cleanly', () => {
    const report = runReport({ version: 1, records: [] }).verdict;
    expect(report).toMatchObject({ schema: 2, asOf: AS_OF, agents: [] });
    expect(report.criteria).toHaveLength(6);
  });

  it('refuses construction without all five dependencies', () => {
    expect(() => graduationProgressReportOperation({})).toThrow(/readScorecards/);
    expect(() => graduationProgressReportOperation({ readScorecards: () => {} })).toThrow(/readPromotions/);
    expect(() => graduationProgressReportOperation({ readScorecards: () => {}, readPromotions: () => {} })).toThrow(/readProbation/);
    expect(() => graduationProgressReportOperation({ readScorecards: () => {}, readPromotions: () => {}, readProbation: () => {} })).toThrow(/selectSupervisionLevel/);
    expect(() => graduationProgressReportOperation({ readScorecards: () => {}, readPromotions: () => {}, readProbation: () => {}, selectSupervisionLevel: () => {} })).toThrow(/backdownThresholds/);
  });

  it('refuses buildGraduationProgressReport without an injected selectSupervisionLevel', () => {
    expect(() => buildGraduationProgressReport({ records: [], asOfIso: AS_OF, promotions: ABSENT_SOURCE, probation: ABSENT_SOURCE, backdownThresholds: DEFAULT_BACKDOWN_THRESHOLDS }))
      .toThrow(/selectSupervisionLevel/);
  });
});

describe('graduation-progress-report-io: promotions and probation sources', () => {
  it('reports `absent` for a missing promotions/probation file, promoting and naming nothing', () => {
    expect(createPromotionsReader({ exists: () => false })()).toEqual({ source: 'absent', entries: [] });
    expect(createProbationReader({ exists: () => false })()).toEqual({ source: 'absent', entries: [] });
  });

  it('reports `invalid` for unparseable JSON', () => {
    const bad = { exists: () => true, read: () => '{ not json' };
    expect(createPromotionsReader(bad)()).toEqual({ source: 'invalid', entries: [] });
    expect(createProbationReader(bad)()).toEqual({ source: 'invalid', entries: [] });
  });

  it('reports `invalid` for a well-formed JSON document with the wrong shape', () => {
    const noEntries = { exists: () => true, read: () => JSON.stringify({ version: 1 }) };
    expect(createPromotionsReader(noEntries)()).toEqual({ source: 'invalid', entries: [] });
    const badEntry = {
      exists: () => true,
      read: () => JSON.stringify({ version: 1, entries: [{ provider: 'codex' }] }),
    };
    expect(createPromotionsReader(badEntry)()).toEqual({ source: 'invalid', entries: [] });
    expect(createProbationReader(badEntry)()).toEqual({ source: 'invalid', entries: [] });
  });

  it('reports `ok` with entries for a valid promotions file', () => {
    const entry = { provider: 'codex', model: 'gpt-6-astra', taskType: 'other', ratifiedBy: '#3690', ratifiedOn: '2026-09-22', anchor: 'we:docs/agent/platform-decisions.md#delegation-trial-record-graduation' };
    const io = { exists: () => true, read: () => JSON.stringify({ version: 1, entries: [entry] }) };
    expect(createPromotionsReader(io)()).toEqual({ source: 'ok', entries: [entry] });
  });

  it('reports `ok` with entries for a valid probation file', () => {
    const entry = { provider: 'codex', model: 'gpt-6-astra', roles: { delivery: 'probation' }, since: '2026-09-13' };
    const io = { exists: () => true, read: () => JSON.stringify({ version: 1, entries: [entry] }) };
    expect(createProbationReader(io)()).toEqual({ source: 'ok', entries: [entry] });
  });

  it('round-trips a real promotions file on disk', async () => {
    await withRealRepo(({ root }) => {
      const path = resolve(root, 'promotions.json');
      const entry = { provider: 'codex', model: 'gpt-6-astra', taskType: 'other', ratifiedBy: '#3690', ratifiedOn: '2026-09-22', anchor: 'we:docs/agent/platform-decisions.md#x' };
      writeFileSync(path, JSON.stringify({ version: 1, entries: [entry] }));
      expect(createPromotionsReader({ path })()).toEqual({ source: 'ok', entries: [entry] });
    });
  });

  // #3906 ported `we:scripts/lib/dispatch-supervision-promotions.json` onto main, empty and in this reader's own
  // `{version, entries}` shape (the dispatch router's `validatePromotions` accepts it too) — the live read now
  // grounds `ok` with no rows instead of `absent`.
  it('reports `ok` with no rows for the real, now-ported (empty) promotions registry on main', () => {
    expect(createPromotionsReader()()).toEqual({ source: 'ok', entries: [] });
  });

  // #3893 ported `we:scripts/lib/model-probation.json` onto main (it previously read `absent`, per this
  // file's own prior assertion) — the live read now grounds `ok` instead, over the two real seeded rows.
  it('reports `ok` for the real, now-ported probation registry on main', () => {
    const real = createProbationReader()();
    expect(real.source).toBe('ok');
    expect(real.entries.map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: 'codex', model: 'gpt-6-astra' },
      { provider: 'antigravity', model: 'gemini-4-argon-high' },
    ]);
  });
});

describe('graduation report: real scorecard data (frozen 2026-09-25 snapshot)', () => {
  const report = buildGraduationProgressReport({ records: REAL_RECORDS, asOfIso: AS_OF, promotions: ABSENT_SOURCE, probation: ABSENT_SOURCE, ...ROUTER });

  it('matches the exact real-data triples named in the card', () => {
    // #3897 ports rule 5 (#3889): the real trial record carries no explicit `informative`/`rootCause`
    // fields on any row (that data is intentionally not ported — see the #3443 tail-sweep card and
    // platform-decisions.md#delegation-trial-record-graduation rules 1 and 4), so `hasInformative` is
    // false here and this triple stays `full`/`accruing` rather than the pre-#3897 `spot-check`.
    expect(findTriple(report, 'codex', 'gpt-6-astra', 'other')).toMatchObject({
      evidenceLevel: 'full', effectiveLevel: 'full', state: 'accruing',
    });
    expect(findTriple(report, 'antigravity', 'claude-sonnet-4-6', 'other')).toMatchObject({ state: 'vetoed' });
    expect(findTriple(report, 'antigravity', 'gemini-3.8-flash-low', 'conflict-resolution')).toMatchObject({ state: 'needs-positive-control' });
    expect(findTriple(report, 'antigravity', 'gemini-3.1-pro', 'other')).toMatchObject({ state: 'unverified', countedTrials: 0 });
  });

  it('never disagrees with the router: evidenceLevel always equals selectSupervisionLevel(...).level', () => {
    expect(report.agents.length).toBeGreaterThan(0);
    for (const agent of report.agents) {
      for (const triple of agent.triples) {
        const routed = selectSupervisionLevel(agent.provider, agent.model, triple.taskType, REAL_RECORDS, DEFAULT_BACKDOWN_THRESHOLDS);
        expect(triple.evidenceLevel).toBe(routed.level);
        expect(triple.cleanStreak).toBe(routed.cleanStreak);
        expect(triple.hasInformative).toBe(routed.hasInformativeTrial);
        expect(triple.mostRecentVetoed).toBe(routed.mostRecentVetoed);
      }
    }
  });

  it('carries the same 10 real triples the mock worked example documents', () => {
    const total = report.agents.reduce((sum, a) => sum + a.triples.length, 0);
    expect(total).toBe(10);
  });

  it('never invents a threshold value and reports the config-default source', () => {
    // #3897 lands rule 5 (#3889) onto main: DEFAULT_BACKDOWN_THRESHOLDS now carries `k: 3`, so postMissK is
    // no longer null.
    expect(report.thresholds).toEqual({ minCleanStreak: 5, requireInformativeTrial: true, source: 'config-default', postMissK: 3 });
  });

  it('states criteria rule 4 as not-on-main (no real row carries the field yet), rule 5 as built (landed by #3897), rule 6 as not-built, rule 7 as not-on-main, and the open decision (#3734)', () => {
    // Rule 4 stays not-on-main against REAL_RECORDS: the trial-record data itself was intentionally not
    // ported by #3897 (see #3443 tail-sweep + platform-decisions.md#delegation-trial-record-graduation
    // rules 1 and 4), so no real row carries an explicit `informative` field yet, even though the router
    // code now supports reading one (proven against synthetic fixtures elsewhere in this file).
    expect(report.criteria).toEqual([
      { rule: 3, label: 'Clean streak length N', state: 'config-default', detail: 'N = 5. A config default, changed by an ordinary finding against real data — not a ratified number.', ref: null },
      { rule: 4, label: 'A trial is "informative" only by its own recorded field', state: 'not-on-main', detail: 'Built on the prototype branch. On main the router still infers it from the outcome.', ref: '3888' },
      { rule: 5, label: 'After a miss: root-cause note, then a higher bar (N + k)', state: 'built', detail: 'Built: the post-miss bar is N + k = 8.', ref: '3889' },
      { rule: 6, label: 'Promotion only by your ratified act', state: 'not-built', detail: 'No promotion record exists yet, so every task type stays at Full.', ref: '3784' },
      { rule: 7, label: 'Spot-check keeps a shallower independent look', state: 'not-on-main', detail: 'Built on the prototype branch.', ref: '3887' },
      { rule: null, label: 'May family or benchmark data count toward the bar?', state: 'open-decision', detail: 'Prepared; recommendation is no.', ref: '3734' },
    ]);
  });

  it('never transfers trust across any component of a triple (groups strictly by provider+model+taskType)', () => {
    const codex = report.agents.find((a) => a.provider === 'codex' && a.model === 'gpt-6-astra');
    expect(codex.triples.map((t) => t.taskType).sort()).toEqual(['bugfix', 'conflict-resolution', 'doc-fix', 'other', 'self-fix']);
  });

  it('sorts agents by total trial count descending, then provider/model; triples by trial count then taskType', () => {
    const totals = report.agents.map((a) => a.triples.reduce((sum, t) => sum + t.trials, 0));
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    const codex = report.agents.find((a) => a.provider === 'codex' && a.model === 'gpt-6-astra');
    const codexCounts = codex.triples.map((t) => t.trials);
    expect(codexCounts).toEqual([...codexCounts].sort((a, b) => b - a));
  });

  it('excludes unrelated dispatch kinds and non-delegation rows', () => {
    const unrelated = [{ ...REAL_RECORDS[0], dispatchKind: 'fix' }];
    const withNoise = buildGraduationProgressReport({ records: [...REAL_RECORDS, ...unrelated], asOfIso: AS_OF, promotions: ABSENT_SOURCE, probation: ABSENT_SOURCE, ...ROUTER });
    expect(withNoise).toEqual(report);
  });

  it('owes a plain sentence per state, never inventing counts beyond the real threshold', () => {
    const accruing = report.agents.flatMap((a) => a.triples).find((t) => t.state === 'accruing');
    expect(accruing.owed).toMatch(/^\d+ more clean checked trials? in a row\.$/);
    expect(findTriple(report, 'antigravity', 'claude-sonnet-4-6', 'other').owed)
      .toBe('The latest checked trial had a problem. Next: a root-cause note, then a fresh clean streak.');
    expect(findTriple(report, 'antigravity', 'gemini-3.1-pro', 'other').owed)
      .toBe('No trial here was independently checked, so none counts yet. Next: one checked trial.');
    expect(findTriple(report, 'antigravity', 'gemini-3.8-flash-low', 'conflict-resolution').owed)
      .toBe('One trial where review caught a real problem that was then fixed (proves the check works).');
    expect(findTriple(report, 'codex', 'gpt-6-astra', 'other').owed)
      .toBe('3 more clean checked trials in a row.');
  });

  it('builds an oldest-to-newest trialList with counted/informative flags matching the router\'s own predicates', () => {
    const other = findTriple(report, 'codex', 'gpt-6-astra', 'other');
    expect(other.trialList).toHaveLength(6);
    const scoredAts = other.trialList.map((t) => t.scoredAt);
    expect(scoredAts).toEqual([...scoredAts].sort());
    expect(other.trialList.filter((t) => t.informative)).toHaveLength(1);
    expect(other.lastTrialAt).toBe(scoredAts.at(-1));
  });
});

describe('graduation report: promotion record (rule 6)', () => {
  it('a promotions row naming a triple with enough post-miss evidence yields promoted + spot-check effective level', () => {
    // #3897 (rule 5, #3889): the real codex/gpt-6-astra/other triple's post-miss clean streak (5) no longer
    // reaches the post-miss bar (8) on its own — see the "real ... data" describe block above — so this rule
    // 6 case is demonstrated on a synthetic triple that DOES clear the bar, same fixtures as the
    // "graduation arithmetic" describe block.
    const rows = [informative(), ...cleanTrials(POST_MISS_BAR)];
    const promotions = {
      source: 'ok',
      entries: [{ provider: rows[0].provider, model: rows[0].model, taskType: rows[0].taskType, ratifiedBy: '#3690', ratifiedOn: '2026-09-22', anchor: 'we:docs/agent/platform-decisions.md#delegation-trial-record-graduation' }],
    };
    const report = buildGraduationProgressReport({ records: rows, asOfIso: AS_OF, promotions, probation: ABSENT_SOURCE, ...ROUTER });
    const triple = findTriple(report, rows[0].provider, rows[0].model, rows[0].taskType);
    expect(triple.state).toBe('promoted');
    expect(triple.effectiveLevel).toBe('spot-check');
    expect(triple.promotion).toEqual({ ratifiedBy: '#3690', ratifiedOn: '2026-09-22', anchor: 'we:docs/agent/platform-decisions.md#delegation-trial-record-graduation' });
    expect(report.sources.promotions).toBe('ok');
    expect(report.criteria.find((c) => c.rule === 6)).toMatchObject({ state: 'built' });
  });

  it('naming a triple whose computed evidence is `full` never promotes it', () => {
    const promotions = {
      source: 'ok',
      entries: [{ provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix', ratifiedBy: '#3690', ratifiedOn: '2026-09-22', anchor: 'we:docs/agent/platform-decisions.md#x' }],
    };
    const report = buildGraduationProgressReport({ records: REAL_RECORDS, asOfIso: AS_OF, promotions, probation: ABSENT_SOURCE, ...ROUTER });
    const triple = findTriple(report, 'codex', 'gpt-6-astra', 'bugfix');
    expect(triple.evidenceLevel).toBe('full');
    expect(triple.effectiveLevel).toBe('full');
    expect(triple.state).not.toBe('promoted');
  });

  it('an invalid promotions source promotes nothing: effectiveLevel is full for every triple', () => {
    const report = buildGraduationProgressReport({ records: REAL_RECORDS, asOfIso: AS_OF, promotions: { source: 'invalid', entries: [] }, probation: ABSENT_SOURCE, ...ROUTER });
    expect(report.sources.promotions).toBe('invalid');
    for (const agent of report.agents) {
      for (const triple of agent.triples) {
        expect(triple.effectiveLevel).toBe('full');
        expect(triple.state).not.toBe('promoted');
      }
    }
    expect(report.criteria.find((c) => c.rule === 6)).toMatchObject({ state: 'not-built' });
  });

  it('a demoted (vetoed) triple is never protected by a stale promotion naming it', () => {
    // #3897 (rule 5, #3889): reaching spot-check after a rootcaused miss needs the post-miss bar
    // (minCleanStreak + k), not just minCleanStreak — see POST_MISS_BAR above.
    const rows = [informative(), ...cleanTrials(POST_MISS_BAR)];
    const promoted = buildGraduationProgressReport({
      records: rows, asOfIso: AS_OF,
      promotions: { source: 'ok', entries: [{ provider: rows[0].provider, model: rows[0].model, taskType: rows[0].taskType, ratifiedBy: '#1', ratifiedOn: '2026-09-22', anchor: 'we:docs/agent/platform-decisions.md#x' }] },
      probation: ABSENT_SOURCE,
      ...ROUTER,
    });
    expect(findTriple(promoted, rows[0].provider, rows[0].model, rows[0].taskType)).toMatchObject({ state: 'promoted', effectiveLevel: 'spot-check' });

    const miss = trial(POST_MISS_BAR + 1, { findings: 'new miss', outcome: 'reworked' });
    const demoted = buildGraduationProgressReport({
      records: [...rows, miss], asOfIso: AS_OF,
      promotions: { source: 'ok', entries: [{ provider: miss.provider, model: miss.model, taskType: miss.taskType, ratifiedBy: '#1', ratifiedOn: '2026-09-22', anchor: 'we:docs/agent/platform-decisions.md#x' }] },
      probation: ABSENT_SOURCE,
      ...ROUTER,
    });
    expect(findTriple(demoted, miss.provider, miss.model, miss.taskType)).toMatchObject({ state: 'vetoed', evidenceLevel: 'full', effectiveLevel: 'full' });
  });
});

describe('graduation report: probation (#3893)', () => {
  it('surfaces a readable probation entry on its agent', () => {
    const probation = { source: 'ok', entries: [{ provider: 'codex', model: 'gpt-6-astra', roles: { delivery: 'probation', 'advisory-review': 'probation' }, since: '2026-09-13' }] };
    const report = buildGraduationProgressReport({ records: REAL_RECORDS, asOfIso: AS_OF, promotions: ABSENT_SOURCE, probation, ...ROUTER });
    const agent = report.agents.find((a) => a.provider === 'codex' && a.model === 'gpt-6-astra');
    expect(agent.probation).toEqual({ roles: { delivery: 'probation', 'advisory-review': 'probation' }, since: '2026-09-13' });
    expect(report.sources.probation).toBe('ok');
  });

  it('leaves probation null for every agent when the source is absent or invalid', () => {
    for (const probation of [ABSENT_SOURCE, { source: 'invalid', entries: [] }]) {
      const report = buildGraduationProgressReport({ records: REAL_RECORDS, asOfIso: AS_OF, promotions: ABSENT_SOURCE, probation, ...ROUTER });
      expect(report.agents.every((a) => a.probation === null)).toBe(true);
    }
  });
});

describe('graduation arithmetic: streak/informative/veto boundary cases', () => {
  function soleTriple(records, options = {}) {
    return buildGraduationProgressReport({ records, asOfIso: AS_OF, promotions: ABSENT_SOURCE, probation: ABSENT_SOURCE, ...ROUTER, ...options }).agents[0].triples[0];
  }

  it.each([POST_MISS_BAR, POST_MISS_BAR + 1])('reaches spot-check evidence after a rootcaused miss and %i counted clean trials', (n) => {
    const triple = soleTriple([informative(), ...cleanTrials(n)]);
    expect(triple).toMatchObject({ cleanStreak: n, hasInformative: true, evidenceLevel: 'spot-check', state: 'awaiting-promotion' });
  });

  it('keeps four clean trials below the uniform floor as accruing', () => {
    // #3897 (rule 5, #3889): `owed` now measures against the post-miss bar (8) once a rootcaused miss is on
    // record, not the cold-start `minCleanStreak` (5) — 8 - 4 = 4 more, not 5 - 4 = 1.
    const triple = soleTriple([informative(), ...cleanTrials(4)]);
    expect(triple).toMatchObject({ evidenceLevel: 'full', state: 'accruing', owed: '4 more clean checked trials in a row.' });
  });

  it('requires informative counted evidence even with six clean trials (needs-positive-control)', () => {
    const triple = soleTriple(cleanTrials(6));
    expect(triple).toMatchObject({ cleanStreak: 6, hasInformative: false, evidenceLevel: 'full', state: 'needs-positive-control' });
  });

  it('skips other-verified trials within and after a streak without incrementing or resetting it', () => {
    const rows = [informative(), ...cleanTrials(POST_MISS_BAR),
      trial(2, { verifiedBy: 'other', findings: 'smoke finding' }),
      trial(POST_MISS_BAR + 1, { verifiedBy: 'other', findings: null }),
      trial(POST_MISS_BAR + 2, { verifiedBy: 'other', findings: 'latest smoke finding' })];
    const triple = soleTriple(rows);
    expect(triple).toMatchObject({ trials: 12, countedTrials: 9, cleanStreak: POST_MISS_BAR, evidenceLevel: 'spot-check', state: 'awaiting-promotion' });
    expect(triple.lastTrialAt).toBe(rows.at(-1).scoredAt);
  });

  it('immediately vetoes on a reworked/rejected most-recent trial, resetting the streak', () => {
    const miss = trial(8, { findings: 'new miss', outcome: 'reworked' });
    const triple = soleTriple([informative(), ...cleanTrials(7), miss]);
    expect(triple).toMatchObject({ cleanStreak: 0, hasInformative: true, mostRecentVetoed: true, evidenceLevel: 'full', state: 'vetoed' });
  });

  it('does NOT veto a landed outcome even when its `findings` text is non-null (the router-vs-old-report divergence this card fixes)', () => {
    const landedWithPraise = trial(8, { findings: 'nicely done', outcome: 'landed' });
    const triple = soleTriple([informative(), ...cleanTrials(7), landedWithPraise]);
    expect(triple).toMatchObject({ cleanStreak: 8, mostRecentVetoed: false, evidenceLevel: 'spot-check', state: 'awaiting-promotion' });
  });

  it('a triple with zero counted trials is unverified regardless of raw trial count', () => {
    const triple = soleTriple([trial(0, { verifiedBy: 'other', findings: null })]);
    expect(triple).toMatchObject({ trials: 1, countedTrials: 0, state: 'unverified', evidenceLevel: 'full' });
  });

  it('reports `failed` scorecards when records is not an array, without throwing', () => {
    const report = buildGraduationProgressReport({ records: null, asOfIso: AS_OF, promotions: ABSENT_SOURCE, probation: ABSENT_SOURCE, ...ROUTER });
    expect(report.sources.scorecards).toBe('failed');
    expect(report.agents).toEqual([]);
  });
});
