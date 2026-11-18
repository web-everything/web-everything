// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { recordRedTeamStatus, readDrainRedTeamEvidence, readRecoveryWitness, redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { redTeamOwedDecision, RED_TEAM_HOLDS, redTeamReadReviewable, RED_TEAM_EXEMPTION_INPUTS, RED_TEAM_CLEARANCE_INPUTS, RED_TEAM_BREAK_INPUTS } from '../review-red-team-policy.mjs';
import { redTeamAdmissionHold } from '../drain-queue-safety.mjs';
import { drainRedTeamDecisionInput, RED_TEAM_ADMISSION_INPUTS } from '../drain-red-team-input.mjs';
import { planRedTeamStatusLabels } from '../red-team-status-labels.mjs';
import { failedRedTeamRetry } from '../red-team-run-result.mjs';
import { reviewedRead, completedSeat, completedComment, exemptInput, completedExecution, runIdentity } from './fixtures/red-team-owed.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(over = {}, rows = []) {
  const root = mkdtempSync(join(process.env.TMPDIR, 'red-team-owed-v2-')); roots.push(root);
  const head = 'a'.repeat(40), repo = 'fixture/repo', pr = 42, runsDir = join(root, 'runs');
  const env = { WE_UNDER_TEST: '1', WE_SHARED_RUNS_DIR: runsDir, CONVEYOR_STATE_ROOT: root };
  const read = { ...reviewedRead(head, ['backlog/123-card.md']), ...over };
  const loopPayload = { verdict: { verdict: 'accept' }, findings: { read } };
  const store = resolveScorecardStorePath(env); mkdirSync(dirname(store), { recursive: true });
  writeFileSync(store, JSON.stringify({ version: 1, records: rows.map(row => ({ ...row, head })) }));
  writeRun({ ...newRunRecord({ id: 'review-pr-42', op: 'review-pr', input: { repo, pr } }), ...loopPayload }, runsDir);
  recordRedTeamStatus({ repo, pr, head, loopPayload, status: 'finished', result: rows.length ? completedExecution(head).result : { status: 'skipped', policy: 'card-only' } }, { env });
  return { repo, pr, head, env, runsDir, comments: [], labels: [] };
}
const decide = f => redTeamOwedDecision(readDrainRedTeamEvidence(f).decisionInput);
describe('PR-A v2 acceptance over persisted review, status and scorecard files', () => {
  it('amendment 3 audit probe: newer failed execution and stored changes defeat an older clean comment and seat and preserve blocked', () => {
    const f = fixture({ netChangedFiles: ['scripts/example.mjs'] }, [completedSeat('a'.repeat(40))]);
    f.comments = [completedComment(f.pr, f.head)];
    const raw = readDrainRedTeamEvidence(f);
    const newer = { runId: 'newer-failed-run', order: 1 };
    const evidence = { ...raw, status: { ...newer, head: f.head, status: 'finished',
      result: { ...newer, status: 'failed', foldedVerdict: 'changes' } } };
    const normalized = readDrainRedTeamEvidence({ ...f, evidence });
    expect(normalized.decisionInput.runs.execution[0]).toMatchObject({ ...newer, outcome: 'break' });
    expect(redTeamOwedDecision(normalized.decisionInput).reasons).toContainEqual(RED_TEAM_HOLDS.break);
    expect(planRedTeamStatusLabels({ ...f, evidence, labels: ['red-team:blocked'] })).toMatchObject({ add: null, remove: [] });
  });
  it('1: empty-diff card-only remains owed with unreviewable-read', () => {
    const f = fixture({ diffText: '' });
    expect(decide(f)).toMatchObject({ owed: true, cleared: false });
    expect(redTeamAdmissionHold({ ...f, ...readDrainRedTeamEvidence(f) })).toMatchObject({ kind: 'unreviewable-read', blocking: true });
  });
  it('2: unscored read is unreviewable-read', () => {
    const f = fixture({ diffScored: false });
    expect(decide(f).reasons.map(h => h.kind)).toContain('unreviewable-read');
  });
  it.each([{ diffText: '' }, { diffScored: false }])('3: recovery, carry and merge all refuse unreadable/unscored input %j', over => {
    const f = fixture(over), evidence = readDrainRedTeamEvidence(f), witness = readRecoveryWitness(f);
    const recovery = readDrainRedTeamEvidence({ ...f, evidence: { ...evidence, loopPayload: witness.newest } }).decisionInput;
    const fromRev = 'b'.repeat(40);
    const source = { ...recovery, head: fromRev, read: { ...recovery.read, netBasis: { rev: fromRev } } };
    const carry = { ...evidence.decisionInput, carry: { fromRev, proof: source } };
    for (const input of [recovery, carry, evidence.decisionInput]) expect(redTeamOwedDecision(input).cleared).toBe(false);
    expect(redTeamAdmissionHold({ ...f, ...evidence }).blocking).toBe(true);
  });
  it('4: one malformed seat row stays visible as seat-rows-invalid and cannot authorize a retry', () => {
    const f = fixture({}, [completedSeat('a'.repeat(40), { provider: null, status: 'error' })]);
    const evidence = readDrainRedTeamEvidence(f);
    expect(evidence.seats).toHaveLength(1);
    expect(evidence.seats[0].valid).toBe(false);
    expect(decide(f).reasons.map(h => h.kind)).toContain('seat-rows-invalid');
    expect(redTeamAdmissionHold({ ...f, ...evidence })).toMatchObject({ kind: 'seat-rows-invalid', blocking: true });
    expect(failedRedTeamRetry({ status: 'finished', result: 'failed' }, evidence)).toBe(false);
  });
  it('canonical audit: persisted null plus a valid completed seat and completed comment yields seat-rows-invalid', () => {
    const f = fixture({ netChangedFiles: ['scripts/example.mjs'] });
    writeFileSync(resolveScorecardStorePath(f.env), JSON.stringify({ version: 1, records: [null, completedSeat(f.head)] }));
    f.comments = [completedComment(f.pr, f.head)];
    const evidence = readDrainRedTeamEvidence(f);
    expect(evidence.seats).toHaveLength(2);
    expect(evidence.seats.map(row => row.valid)).toEqual([false, true]);
    expect(redTeamOwedDecision(evidence.decisionInput)).toMatchObject({ owed: true, cleared: false });
    expect(redTeamAdmissionHold({ ...f, ...evidence })).toMatchObject({ kind: 'seat-rows-invalid', blocking: true });
  });
  it.each([
    ['null', null], ['undefined', undefined], ['string', 'bad'], ['number', 3], ['array', []], ['missing fields', {}],
    ['wrong provider type', { ...completedSeat('a'.repeat(40)), provider: 3 }],
    ['wrong PR type', { ...completedSeat('a'.repeat(40)), pr: '42' }],
    ['wrong status type', { ...completedSeat('a'.repeat(40)), status: [] }],
    ['wrong deductions type', { ...completedSeat('a'.repeat(40)), deductions: {} }],
    ['non-finite criteria', { ...completedSeat('a'.repeat(40)), criteriaEvaluated: NaN }],
  ])('malformed row shape %s stays invalid beside completed proof', (_name, bad) => {
    const f = fixture({ netChangedFiles: ['scripts/example.mjs'] });
    f.comments = [completedComment(f.pr, f.head)];
    // Inject only the store IO seam so undefined and NaN survive; the real normalizer/validator/decision run.
    const evidence = readDrainRedTeamEvidence({ ...f, readScorecards: () => [bad, completedSeat(f.head)] });
    expect(evidence.seats).toHaveLength(2);
    expect(evidence.seats[0].valid).toBe(false);
    expect(redTeamAdmissionHold({ ...f, ...evidence })).toMatchObject({ kind: 'seat-rows-invalid', blocking: true });
    // Already-read snapshots use the identical row normalization path, including array holes.
    const snapshot = readDrainRedTeamEvidence({ ...f, evidence: { ...evidence, seats: [bad, completedSeat(f.head)] } });
    expect(snapshot.seats[0].valid).toBe(false);
    expect(redTeamOwedDecision(snapshot.decisionInput).reasons).toContainEqual(RED_TEAM_HOLDS['seat-rows-invalid']);
  });
  it('a sparse row array cannot skip its missing entry during normalization', () => {
    const f = fixture(), seats = Array(2); seats[1] = completedSeat(f.head);
    const evidence = readDrainRedTeamEvidence({ ...f, readScorecards: () => seats });
    expect(evidence.seats.map(row => row.valid)).toEqual([false, true]);
    expect(redTeamOwedDecision(evidence.decisionInput).reasons).toContainEqual(RED_TEAM_HOLDS['seat-rows-invalid']);
  });
  it.each([null, [], 'snapshot', 1])('explicit malformed snapshot %j never falls back to readable live evidence', evidence => {
    const f = fixture();
    const normalized = readDrainRedTeamEvidence({ ...f, evidence, readScorecards: () => { throw Error('must not fall back'); } });
    expect(normalized.ok).toBe(false);
    expect(redTeamOwedDecision(normalized.decisionInput)).toMatchObject({ owed: true, cleared: false });
    expect(redTeamOwedDecision(normalized.decisionInput).reasons.map(hold => hold.kind)).toContain('evidence-unknown');
  });
  it.each([{}, [], 'carry', 1])('malformed carry %j cannot disappear beside a completed pass', carry => {
    const f = fixture({ netChangedFiles: ['scripts/example.mjs'] }, [completedSeat('a'.repeat(40))]);
    f.comments = [completedComment(f.pr, f.head)];
    const completed = readDrainRedTeamEvidence(f);
    expect(redTeamOwedDecision(completed.decisionInput).cleared).toBe(true);
    const normalized = readDrainRedTeamEvidence({ ...f, evidence: { ...completed, carry } });
    expect(redTeamOwedDecision(normalized.decisionInput).reasons).toContainEqual(RED_TEAM_HOLDS['carry-conflict']);
  });
  it('5: marker-only result comment is result-incomplete', () => {
    const f = fixture({}, [completedSeat('a'.repeat(40))]);
    f.comments = [{ author: { login: 'web-everything' }, body: `<!-- we:red-team-advisory pr=42 rev=${f.head} -->` }];
    expect(decide(f).reasons.map(h => h.kind)).toContain('result-incomplete');
    expect(redTeamAdmissionHold({ ...f, ...readDrainRedTeamEvidence(f) }).kind).toBe('result-incomplete');
  });
  it('6: carryConflict blocks even with ok unset', () => {
    const f = fixture(), evidence = { ...readDrainRedTeamEvidence(f), carryConflict: true };
    delete evidence.ok;
    expect(evidence.ok).toBeUndefined();
    expect(redTeamAdmissionHold({ ...f, ...evidence })).toMatchObject({ kind: 'carry-conflict', blocking: true });
  });
  it.each(['ran', 'failed', 'error', 'partial', 'unknown', null, {}, { status: 'unknown' }, { status: 'skipped', policy: 'unknown' }])('canonical audit: finished execution %j with a clean seal, no seats and no comment still owes its result', result => {
    const f = fixture(), loopPayload = readDrainRedTeamEvidence(f).loopPayload;
    recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result }, { env: f.env });
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    const status = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...status, sealedBreaks: [], sealedPosted: [] }));
    const evidence = readDrainRedTeamEvidence(f);
    expect(evidence).toMatchObject({ recorded: true, seats: [], status: { status: 'finished', result } });
    expect(evidence.decisionInput).toMatchObject({ result: null, pendingPublish: false, scheduling: { recorded: true } });
    expect(redTeamOwedDecision(evidence.decisionInput)).toMatchObject({ owed: true, cleared: false });
    expect(redTeamAdmissionHold({ ...f, ...evidence })).toMatchObject({ kind: 'result-incomplete', blocking: true });
  });
  it('canonical audit: a scored code-to-backlog rename without source metadata is unreadable and owed', () => {
    const f = fixture({ netRenameSources: undefined,
      diffText: 'diff --git a/scripts/source.mjs b/backlog/123-card.md\nsimilarity index 100%\nrename from scripts/source.mjs\nrename to backlog/123-card.md\n' });
    const evidence = readDrainRedTeamEvidence(f), input = evidence.decisionInput;
    expect(input.read.diffScored).toBe(true);
    expect(Object.hasOwn(input.read, 'netRenameSources')).toBe(false);
    expect(redTeamReadReviewable(input.read, f.head)).toBe(false);
    expect(redTeamOwedDecision(input)).toMatchObject({ owed: true, cleared: false });
    expect(redTeamAdmissionHold({ ...f, ...evidence })).toMatchObject({ kind: 'unreviewable-read', blocking: true });
  });
  it('a real completed comment and valid completed seat clear a scored code head', () => {
    const f = fixture({ netChangedFiles: ['scripts/example.mjs'] }, [completedSeat('a'.repeat(40))]);
    f.comments = [completedComment(f.pr, f.head)];
    expect(decide(f)).toEqual({ owed: true, cleared: true, reasons: [] });
  });
});


it.each(['queued', 'running', 'unknown'])('a recorded failed execution remains debt even with state %s', status => {
  const f = fixture(), loopPayload = readDrainRedTeamEvidence(f).loopPayload;
  recordRedTeamStatus({ ...f, loopPayload, status, result: 'failed' }, { env: f.env });
  const evidence = readDrainRedTeamEvidence(f);
  expect(evidence.recorded).toBe(true);
  expect(redTeamOwedDecision(evidence.decisionInput)).toMatchObject({ owed: true, cleared: false });
});

const exemptionKeys = [
  'head', 'read.netBasis.rev', 'read.diffScored', 'read.diffText', 'read.netChangedFiles', 'read.netRenameSources',
  'seats', 'ok', 'result', 'carry', 'carryConflict', 'hasBreak', 'blocked', 'storedVerdict', 'pendingPublish',
  'scheduling.skipCardOnly', 'scheduling.settingsReadable', 'scheduling.commentsReadable', 'scheduling.sealClear',
  'scheduling.execution', 'scheduling.recorded', 'scheduling.inFlight', 'scheduling.queued', 'scheduling.scheduled', 'runs',
];
it.each(exemptionKeys)('exemption requires explicit positive input: %s (omitted, null, object, wrong scalar)', key => {
  const baseline = exemptInput('a'.repeat(40));
  expect(redTeamOwedDecision(baseline)).toEqual({ owed: false, cleared: true, reasons: [] });
  for (const value of [undefined, ...(key === 'result' || key === 'carry' || key === 'storedVerdict' ? [false] : [null]), {}, 7]) {
    const input = structuredClone(baseline), parts = key.split('.'), leaf = parts.pop();
    const parent = parts.reduce((node, part) => node[part], input);
    if (value === undefined) delete parent[leaf]; else parent[leaf] = value;
    expect(redTeamOwedDecision(input).owed, `${key}=${JSON.stringify(value)}`).toBe(true);
  }
});
it.each(['unknown', 'ran', 'failed', 'error', 'partial', 'skipped', 'false'])('unrecognized execution proof %s never exempts', execution => {
  const input = exemptInput('a'.repeat(40)); input.scheduling.execution = execution;
  expect(redTeamOwedDecision(input).owed).toBe(true);
});
it.each([undefined, null, false, 'true', 'unknown'])('a seat row without valid:true never exempts: %j', valid => {
  const input = exemptInput('a'.repeat(40)); input.seats = [{ ...completedSeat(input.head), valid }];
  expect(redTeamOwedDecision(input)).toMatchObject({ owed: true, cleared: false });
  expect(redTeamOwedDecision(input).reasons.map(h => h.kind)).toContain('seat-rows-invalid');
});
it('canonical audit: explicitly configured missing preferences are unreadable and hold; unconfigured defaults still clear', () => {
  const f = fixture();
  const defaultInput = readDrainRedTeamEvidence(f).decisionInput;
  expect(defaultInput.scheduling.settingsReadable).toBe(true);
  expect(redTeamOwedDecision(defaultInput)).toMatchObject({ owed: false, cleared: true });
  const configured = { ...f, env: { ...f.env, WE_PLATFORM_PREFERENCES_FILE: join(f.env.CONVEYOR_STATE_ROOT, 'missing-prefs.json') } };
  const evidence = readDrainRedTeamEvidence(configured);
  expect(evidence.decisionInput.scheduling.settingsReadable).toBe(false);
  expect(redTeamOwedDecision(evidence.decisionInput)).toMatchObject({ owed: true, cleared: false });
  expect(redTeamOwedDecision(evidence.decisionInput).reasons.map(hold => hold.kind)).toContain('evidence-unknown');
  expect(redTeamAdmissionHold({ ...configured, ...evidence })).toMatchObject({ blocking: true });
});
it.each(['EACCES', 'missing', 'malformed JSON', 'invalid object', 'invalid setting', 'invalid env', 'unreadable platform', 'invalid platform'])(
  'canonical audit: %s settings cannot prove the card-only exemption', variant => {
    const f = fixture(), path = join(f.env.CONVEYOR_STATE_ROOT, 'red-team-settings.json');
    writeFileSync(path, JSON.stringify({ redTeam: { skipCardOnly: true } }));
    const options = { ...f, settingsPath: path };
    expect(redTeamOwedDecision(readDrainRedTeamEvidence(options).decisionInput).owed).toBe(false);
    if (variant === 'EACCES') options.readSettings = (file, ...args) => {
      if (file === path) throw Object.assign(Error('permission denied'), { code: 'EACCES' });
      return readFileSync(file, ...args);
    };
    if (variant === 'missing') rmSync(path);
    if (variant === 'malformed JSON') writeFileSync(path, '{');
    if (variant === 'invalid object') writeFileSync(path, '[]');
    if (variant === 'invalid setting') writeFileSync(path, JSON.stringify({ redTeam: { skipCardOnly: 'unknown' } }));
    if (variant === 'invalid env') options.env = { ...f.env, WE_RED_TEAM_SKIP_CARD_ONLY: 'unknown' };
    if (variant.endsWith('platform')) {
      const platform = join(f.env.CONVEYOR_STATE_ROOT, 'platform.json');
      writeFileSync(platform, variant.startsWith('unreadable') ? '{' : JSON.stringify({ redTeam: { skipCardOnly: 'unknown' } }));
      options.env = { ...f.env, WE_PLATFORM_PREFERENCES_FILE: platform };
    }
    const evidence = readDrainRedTeamEvidence(options);
    expect(evidence.decisionInput.scheduling.settingsReadable).toBe(false);
    expect(redTeamOwedDecision(evidence.decisionInput)).toMatchObject({ owed: true, cleared: false });
    expect(redTeamAdmissionHold({ ...options, ...evidence })).not.toBeNull();
  });
it.each([
  ['status omitted', e => { delete e.status; }],
  ['unknown state', e => { e.status.status = 'unknown'; }],
  ['unknown result', e => { e.status.result = 'unknown'; }],
  ['unknown skip policy', e => { e.status.result.policy = 'unknown'; }],
  ['invalid seal', e => { e.status.sealedBreaks = 'unknown'; }],
  ['unposted seal', e => { e.status.sealedPosted = 'unknown'; }],
  ['unknown recorded', e => { e.recorded = 'false'; }],
  ['missing seats', e => { delete e.seats; }],
  ['unknown carry', e => { e.carry = {}; }],
  ['unknown queued', e => { e.queued = 'false'; }],
  ['invalid seat flag', e => { e.seats = [{ ...completedSeat(e.decisionInput.head), valid: false }]; }],
  ['unknown carry conflict', e => { e.carryConflict = null; }],
])('normalization preserves unproven %s as owed', (_name, corrupt) => {
  const f = fixture(), evidence = readDrainRedTeamEvidence(f);
  expect(redTeamOwedDecision(evidence.decisionInput).owed).toBe(false);
  corrupt(evidence);
  expect(redTeamOwedDecision(readDrainRedTeamEvidence({ ...f, evidence }).decisionInput).owed).toBe(true);
});

it.each(Object.keys(RED_TEAM_ADMISSION_INPUTS))('all admission boundaries reject omitted required input: %s', key => {
  const f = fixture(), evidence = readDrainRedTeamEvidence(f);
  const complete = { ...f, evidence };
  const boundaries = {
    'normalizer': options => redTeamOwedDecision(drainRedTeamDecisionInput(options)),
    'reader used by publication/recovery/carry': options => redTeamOwedDecision(readDrainRedTeamEvidence(options).decisionInput),
    'queue admission used by check-run/prestage/enqueue': options => redTeamAdmissionHold({ ...options.evidence, ...options }),
    'status-label planner': options => planRedTeamStatusLabels(options),
  };
  for (const [caller, invoke] of Object.entries(boundaries)) {
    const baseline = invoke(complete);
    if (caller === 'status-label planner') expect(baseline.add).toBe('red-team:clear');
    else if (caller.startsWith('queue')) expect(baseline).toBeNull();
    else expect(baseline.cleared).toBe(true);
    const missing = { ...complete, evidence: { ...evidence } };
    if (key.startsWith('evidence.')) delete missing.evidence[key.slice('evidence.'.length)];
    else if (key === 'settings') missing.settingsPath = join(f.env.CONVEYOR_STATE_ROOT, 'missing-settings.json');
    else delete missing[key];
    const actual = invoke(missing);
    if (caller === 'status-label planner') expect(actual.add, `${caller}: ${key}`).not.toBe('red-team:clear');
    else if (caller.startsWith('queue')) expect(actual, `${caller}: ${key}`).toMatchObject({ kind: 'evidence-unknown', blocking: true });
    else {
      expect(actual, `${caller}: ${key}`).toMatchObject({ owed: true, cleared: false });
      expect(actual.reasons.map(hold => hold.kind), `${caller}: ${key}`).toContain('evidence-unknown');
    }
  }
});

// Parse the actual source: call deletion and prose-based routing must fail independently of runtime fixtures.
const sources = () => Object.fromEntries(['drain-queue-safety.mjs', 'drain-merge-strategy.mjs', 'drain-red-team-input.mjs', 'review-red-team-policy.mjs', 'red-team-status-labels.mjs', 'drain-red-team-evidence.mjs']
  .map(file => [file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')]).concat([['merge-ai-prs.mjs', readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8')]]));
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function all(node, predicate) {
  const found = [];
  const visit = n => { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); };
  visit(node); return found;
}
const calls = (node, name) => all(node, n => ts.isCallExpression(n) && n.expression.getText() === name);
function assertStructure(source) {
  expect(source['drain-red-team-input.mjs']).toMatch(/recorded: raw\.recorded/);
  expect(source['drain-red-team-input.mjs']).toContain('Object.entries(RED_TEAM_ADMISSION_INPUTS)');
  expect(source['review-red-team-policy.mjs']).toContain('Array.isArray(input.missingInputs) && input.missingInputs.length === 0');
  const rowSource = source['drain-red-team-evidence.mjs'];
  expect(rowSource).toContain('Array.from(readScorecards(), (row, appendIndex) => ({ ...normalizeRedTeamSeatRow(row, false), appendIndex }))');
  expect(rowSource).toContain('.filter(row => row.valid === false ||');
  expect(rowSource).toContain('Array.from(raw.seats, row => normalizeRedTeamSeatRow(row))');
  expect(rowSource).toContain('if (!plain) return { valid: false }');
  const publication = parse('drain-red-team-evidence.mjs', rowSource);
  const publisher = all(publication, node => ts.isFunctionDeclaration(node) && node.name?.text === 'recordRedTeamStatus')[0];
  const publicationRead = calls(publisher, 'readDrainRedTeamEvidence').find(call => call.arguments[0]?.properties?.some(property => property.name?.getText() === 'readScorecards'));
  expect(publicationRead.arguments[0].properties.find(property => property.name?.getText() === 'labels')?.initializer?.getText()).toBe('live.labels');
  expect(calls(publisher, 'readDrainRedTeamEvidence')).toHaveLength(1);
  const refreshSource = parse('merge-ai-prs.mjs', source['merge-ai-prs.mjs']);
  const refresh = all(refreshSource, node => ts.isFunctionDeclaration(node) && node.name?.text === 'enqueueWithSameHeadGuard')[0];
  const refreshHold = calls(refresh, 'redTeamEnqueueHold')[0];
  expect(refreshHold.arguments[0].properties.find(property => property.name?.getText() === 'labels')?.initializer?.getText()).toBe('live.labels');
  expect(refresh.getText()).not.toContain('waitForRedTeamBeforeEnqueue');
  const policy = parse('review-red-team-policy.mjs', source['review-red-team-policy.mjs']);
  const holds = all(policy, n => ts.isPropertyAssignment(n) && ['pass-owed', 'pending-publish'].includes(n.name?.text));
  expect(holds.map(n => [n.name.text, n.initializer.elements[0].kind])).toEqual([
    ['pending-publish', ts.SyntaxKind.FalseKeyword], ['pass-owed', ts.SyntaxKind.TrueKeyword],
  ]);
  expect(Object.values(RED_TEAM_HOLDS).filter(hold => !hold.blocking).map(hold => hold.kind)).toEqual(['pending-publish']);
  expect(policy.text).toContain("['result', 'comment', 'seats', 'execution', 'verdict', 'carry']");
  expect(policy.text).toContain('const runHold = !exempt');
  expect(policy.text).toContain('redTeamRunProof(input)');
  expect(policy.text).toContain('const completedPass = !runHold && completedResult');
  expect(policy.text).toContain('carried = !runHold && completedResult');
  expect(policy.text).toContain('byRun.get(row.runId) !== row.order');
  expect(policy.text).toContain('byOrder.get(row.order) !== row.runId');
  expect(policy.text).toContain('row.order > candidate.order');
  expect(policy.text).toContain('runs[key].at(-1).runId !== candidate.runId');
  expect(source['drain-red-team-input.mjs']).toContain('runs: normalizeRedTeamRuns({ raw, comments, head, pr, carry, noExecution, hit })');
  const decisionFn = all(policy, n => ts.isFunctionDeclaration(n) && n.name?.text === 'redTeamOwedDecision');
  expect(decisionFn).toHaveLength(1);
  expect(decisionFn[0].getText()).toContain('reasons.push(RED_TEAM_HOLDS[kind])');
  expect(policy.text).not.toContain('function redTeamHold');
  const table = all(policy, n => ts.isVariableDeclaration(n) && n.name?.getText() === 'RED_TEAM_EXEMPTION_INPUTS');
  expect(table).toHaveLength(1);
  const properties = table[0].initializer.arguments[0].properties;
  expect(properties.map(p => p.name.text)).toEqual(exemptionKeys);
  for (const property of properties) expect(property.initializer.getText()).toBe(RED_TEAM_EXEMPTION_INPUTS[property.name.text].toString());
  expect(properties.find(p => p.name.text === 'scheduling.scheduled').initializer.getText())
    .toBe('x => x.scheduling?.scheduled === false');
  expect(policy.text).toContain('Object.values(RED_TEAM_EXEMPTION_INPUTS).every(proven => proven(input))');
  expect(source['review-red-team-policy.mjs']).toMatch(/&& Array\.isArray\(read\.netRenameSources\)/);
  const clearance = all(policy, n => ts.isVariableDeclaration(n) && n.name?.getText() === 'RED_TEAM_CLEARANCE_INPUTS');
  expect(clearance).toHaveLength(1);
  const clearanceProperties = clearance[0].initializer.arguments[0].properties;
  expect(clearanceProperties.map(p => [p.name.text, p.initializer.text])).toEqual([
    ['scheduling.settingsReadable', 'evidence-unknown'], ['scheduling.commentsReadable', 'evidence-unknown'],
    ['scheduling.inFlight', 'pass-owed'], ['scheduling.queued', 'pass-owed'],
  ]);
  expect(Object.keys(RED_TEAM_CLEARANCE_INPUTS).every(key => exemptionKeys.includes(key))).toBe(true);
  expect(policy.text).toContain('Object.entries(RED_TEAM_CLEARANCE_INPUTS)');
  expect(policy.text).toContain('!RED_TEAM_EXEMPTION_INPUTS[key](input)');
  expect(source['drain-queue-safety.mjs']).not.toContain('WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE');
  expect(source['drain-red-team-input.mjs']).toContain('!configuredRead ||');
  expect(source['drain-red-team-input.mjs']).toContain('path === operatorPreferencesPath(env)');
  const breakTable = all(policy, n => ts.isVariableDeclaration(n) && n.name?.getText() === 'RED_TEAM_BREAK_INPUTS');
  expect(breakTable).toHaveLength(1);
  const breakProperties = breakTable[0].initializer.arguments[0].properties;
  expect(breakProperties.map(property => property.name.text)).toEqual(['blocked', 'storedVerdict']);
  for (const property of breakProperties) expect(property.initializer.getText()).toBe(RED_TEAM_BREAK_INPUTS[property.name.text].toString());
  expect(policy.text).toContain('Object.values(RED_TEAM_BREAK_INPUTS).some(proven => proven(input))');
  expect(policy.text).toContain('if (recordedBreak && !completedPass && !carried && !hasBreak) reasons.unshift(RED_TEAM_HOLDS.break)');
  expect(source['drain-red-team-input.mjs']).toContain('hasBreak, blocked, storedVerdict, breakResolved, pendingPublish');
  expect(source['drain-red-team-input.mjs']).toContain("status.result?.foldedVerdict ?? status.foldedVerdict ?? null");
  expect(source['drain-red-team-input.mjs']).toContain("=== 'red-team:blocked'");
  const inputLeaf = parse('drain-red-team-input.mjs', source['drain-red-team-input.mjs']);
  const resolution = all(inputLeaf, n => ts.isVariableDeclaration(n) && n.name?.getText() === 'breakResolved');
  expect(resolution).toHaveLength(1);
  expect(resolution[0].initializer.getText()).not.toMatch(/storedVerdict|accept|status/);
  expect(resolution[0].initializer.getText()).toContain('!hasBreak && releases.length > 0');
  const labels = parse('red-team-status-labels.mjs', source['red-team-status-labels.mjs']);
  const planner = all(labels, n => ts.isFunctionDeclaration(n) && n.name?.text === 'planRedTeamStatusLabels');
  expect(planner).toHaveLength(1);
  expect(calls(planner[0], 'redTeamOwedDecision')).toHaveLength(1);
  expect(calls(planner[0], 'readDrainRedTeamEvidence')[0].arguments[0].properties.map(property => property.name?.getText())).toContain('labels');
  const labelDecision = all(planner[0], n => ts.isVariableDeclaration(n) && n.name.getText() === 'decision');
  expect(labelDecision).toHaveLength(1);
  expect(labelDecision[0].initializer.getText()).toBe('redTeamOwedDecision(decisionInput)');
  expect(labels.text).not.toMatch(/disposition\.result|foldedVerdict|redTeamForHead|readRedTeamDisposition/);
  const desired = all(planner[0], n => ts.isVariableDeclaration(n) && n.name.getText() === 'desired');
  expect(desired).toHaveLength(1);
  expect(desired[0].initializer.condition.getText()).toBe('decision.cleared');
  expect(desired[0].initializer.whenTrue.text).toBe('red-team:clear');
  const clearValues = all(planner[0], n => ts.isStringLiteral(n) && n.text === 'red-team:clear');
  expect(clearValues).toHaveLength(1);
  expect(clearValues[0].parent).toBe(desired[0].initializer);
  const queue = parse('drain-queue-safety.mjs', source['drain-queue-safety.mjs']);
  const merge = parse('drain-merge-strategy.mjs', source['drain-merge-strategy.mjs']);
  for (const file of [queue, merge]) {
    expect(file.text).not.toMatch(/disposition\.result|policyClear/);
    const proseIncludes = all(file, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && n.expression.name.text === 'includes' && /(?:reason|hold)/i.test(n.expression.expression.getText())
      && !/label/i.test(n.expression.expression.getText()));
    expect(proseIncludes.map(n => n.getText())).toEqual([]);
  }
  expect(merge.text).not.toMatch(/waitForRedTeamBeforeEnqueue|WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE/);
  const admission = all(queue, n => ts.isFunctionDeclaration(n) && n.name?.text === 'redTeamAdmissionHold');
  expect(admission).toHaveLength(1);
  expect(calls(admission[0], 'redTeamOwedDecision')).toHaveLength(1);
  expect(calls(queue, 'redTeamOwedDecision')).toHaveLength(1);
  for (const name of ['checkRunDispositionHold', 'prestage', 'enqueue']) {
    const fn = all(merge, n => (name === 'checkRunDispositionHold' ? ts.isVariableDeclaration(n) : ts.isMethodDeclaration(n)) && n.name?.getText() === name);
    expect(fn).toHaveLength(1);
    expect(calls(fn[0], 'redTeamAdmissionHold')).toHaveLength(1);
    const decision = calls(fn[0], 'redTeamAdmissionHold')[0];
    expect(decision.arguments[0].properties.map(property => property.name?.getText())).toEqual(expect.arrayContaining(['labels', 'comments', 'pr', 'head', 'repo', 'env']));
    const conditions = [];
    for (let parent = decision.parent; parent && parent !== fn[0]; parent = parent.parent) {
      if (ts.isIfStatement(parent)) conditions.push(parent.expression.getText());
    }
    expect(conditions).toEqual(name === 'enqueue' ? ['!checkRunOnly'] : []);
    if (name === 'enqueue') {
      const alternate = calls(fn[0], 'checkRunDispositionHold');
      expect(alternate).toHaveLength(2);
      for (const call of alternate) {
        const guards = [];
        for (let parent = call.parent; parent && parent !== fn[0]; parent = parent.parent) {
          if (ts.isIfStatement(parent)) guards.push(parent.expression.getText());
        }
        expect(guards).toEqual(['checkRunOnly']);
      }
    }
    if (name === 'prestage') {
      const returns = all(fn[0], n => ts.isReturnStatement(n));
      const earlySuccesses = returns.filter(n => n.pos < decision.pos && n.expression && ts.isObjectLiteralExpression(n.expression)
        && n.expression.properties.some(p => p.name?.getText() === 'allowed' && p.initializer?.kind !== ts.SyntaxKind.FalseKeyword));
      expect(earlySuccesses.map(n => n.getText())).toEqual([]);
    }

  }
}
it('structural: each admission delegates exactly once; holds never branch on includes or duplicate result policy', () => {
  assertStructure(sources());
});
it.each([
  ['scheduled exemption guard loosened', 'review-red-team-policy.mjs', text => text.replace(
    "'scheduling.scheduled': x => x.scheduling?.scheduled === false",
    "'scheduling.scheduled': x => typeof x.scheduling?.scheduled === 'boolean'")],
  ['refresh labels omitted', 'merge-ai-prs.mjs', text => text.replace('redTeamEnqueueHold({ ...evidence, repo, pr: c.num, head: sha, comments, labels: live.labels,', 'redTeamEnqueueHold({ ...evidence, repo, pr: c.num, head: sha, comments,')],
  ['refresh setting bypass restored', 'merge-ai-prs.mjs', text => text.replace('if (redTeamEnqueueHold({ ...evidence, repo, pr: c.num, head: sha, comments, labels:', 'if (safety.value.waitForRedTeamBeforeEnqueue && redTeamEnqueueHold({ ...evidence, repo, pr: c.num, head: sha, comments, labels:')],
  ['publication labels omitted', 'drain-red-team-evidence.mjs', text => text.replace('comments, labels: live.labels,', 'comments,')],
  ['required input contract bypassed', 'drain-red-team-input.mjs', text => text.replace('Object.entries(RED_TEAM_ADMISSION_INPUTS)', 'Object.entries({})')],
  ['completeness gate removed', 'review-red-team-policy.mjs', text => text.replace('Array.isArray(input.missingInputs) && input.missingInputs.length === 0', 'true')],
  ['run identity comparison removed', 'review-red-team-policy.mjs', text => text.replace('runs[key].at(-1).runId !== candidate.runId', 'false')],
  ['run order comparison removed', 'review-red-team-policy.mjs', text => text.replace('row.order > candidate.order', 'false')],
  ['run proof delegation removed', 'review-red-team-policy.mjs', text => text.replace('redTeamRunProof(input)', 'null')],
  ['run normalization removed', 'drain-red-team-input.mjs', text => text.replace('runs: normalizeRedTeamRuns({ raw, comments, head, pr, carry, noExecution, hit })', 'runs: null')],
  ['stored acceptance resolution shortcut restored', 'drain-red-team-input.mjs', text => text.replace(
    'const breakResolved = !hasBreak && releases.length > 0',
    "const breakResolved = (status?.head === head && storedVerdict === 'accept') || !hasBreak && releases.length > 0")],
  ['invalid rows silently filtered', 'drain-red-team-evidence.mjs', text => text.replace('.filter(row => row.valid === false ||', '.filter(row =>')],
  ['null rows silently dropped before normalization', 'drain-red-team-evidence.mjs', text => text.replace('Array.from(readScorecards(), (row, appendIndex) => ({ ...normalizeRedTeamSeatRow(row, false), appendIndex }))', 'Array.from(readScorecards()).filter(Boolean).map(row => normalizeRedTeamSeatRow(row, false))')],
  ['sparse snapshot normalization bypassed', 'drain-red-team-evidence.mjs', text => text.replace('Array.from(raw.seats, row => normalizeRedTeamSeatRow(row))', 'raw.seats.map(row => normalizeRedTeamSeatRow(row))')],
  ['blocked label input removed', 'red-team-status-labels.mjs', text => text.replace('comments, labels, standingRuling', 'comments, standingRuling')],
  ['stored verdict normalization removed', 'drain-red-team-input.mjs', text => text.replace('status.result?.foldedVerdict ?? status.foldedVerdict ?? null', 'null')],
  ['blocked normalization removed', 'drain-red-team-input.mjs', text => text.replace("=== 'red-team:blocked'", "=== 'unused'")],
  ['recorded break table bypassed', 'review-red-team-policy.mjs', text => text.replace('Object.values(RED_TEAM_BREAK_INPUTS).some(proven => proven(input))', 'false')],
  ['recorded break hold removed', 'review-red-team-policy.mjs', text => text.replace('reasons.unshift(RED_TEAM_HOLDS.break)', "reasons.unshift(RED_TEAM_HOLDS['pass-owed'])")],
  ['configured preferences proof removed', 'drain-red-team-input.mjs', text => text.replace('!configuredRead || ', '')],
  ['label decision deleted', 'red-team-status-labels.mjs', text => text.replace('redTeamOwedDecision(decisionInput)', '({ cleared: true, reasons: [] })')],
  ['label decision conditionally bypassed', 'red-team-status-labels.mjs', text => text.replace('const decision = redTeamOwedDecision', 'const decision = comments.length ? { cleared: true, reasons: [] } : redTeamOwedDecision')],
  ['label comment shortcut restored', 'red-team-status-labels.mjs', text => text.replace('decision.cleared ?', 'comments.length ?')],
  ['label early marker clear restored', 'red-team-status-labels.mjs', text => text.replace('  const decision = redTeamOwedDecision', "  if (comments.length) return { add: 'red-team:clear', remove: [] };\n  const decision = redTeamOwedDecision")],
  ['owed debt made non-blocking', 'review-red-team-policy.mjs', text => text.replace("'pass-owed': [true,", "'pass-owed': [false,")],
  ['pending publication made blocking', 'review-red-team-policy.mjs', text => text.replace("'pending-publish': [false,", "'pending-publish': [true,")],
  ['fixed hold lookup bypassed', 'review-red-team-policy.mjs', text => text.replace('reasons.push(RED_TEAM_HOLDS[kind])', 'reasons.push({ kind, blocking: false })')],
  ['prestage setting bypass restored', 'drain-merge-strategy.mjs', text => text.replace(
    'const comments = pages.flat();\n        const evidence',
    'const comments = pages.flat();\n        if (!safety.value.waitForRedTeamBeforeEnqueue) return { allowed: true };\n        const evidence')],
  ['enqueue setting guard restored', 'drain-merge-strategy.mjs', text => text.replace('if (!checkRunOnly) {', 'if (!checkRunOnly && safety.value.waitForRedTeamBeforeEnqueue) {')],
  ['prestage environment bypass restored', 'drain-merge-strategy.mjs', text => text.replace(
    'const comments = pages.flat();\n        const evidence',
    "const comments = pages.flat();\n        if (env.WE_REVIEW_RED_TEAM === '0') return { allowed: true };\n        const evidence")],
  ['enqueue environment guard restored', 'drain-merge-strategy.mjs', text => text.replace('if (!checkRunOnly) {', "if (!checkRunOnly && env.WE_REVIEW_RED_TEAM !== '0') {")],
  ...[0, 1].map(index => [`check-run alternate decision ${index + 1} deleted`, 'drain-merge-strategy.mjs', text => {
    let seen = 0;
    return text.replaceAll('checkRunDispositionHold(', call => seen++ === index ? 'removedDisposition(' : call);
  }]),
  ['check-run preparation bypass restored', 'drain-merge-strategy.mjs', text => text.replace(
    'const comments = pages.flat();\n        const evidence',
    'const comments = pages.flat();\n        if (checkRunOnly) return { allowed: true };\n        const evidence')],
  ...Object.keys(RED_TEAM_CLEARANCE_INPUTS).map(key => [`completed-pass prerequisite ${key} deleted`, 'review-red-team-policy.mjs', text =>
    text.replace(new RegExp(`^  '${key.replaceAll('.', '\\.')}': '[^']+',\n`, 'm'), '')]),
  ['completed-pass table call deleted', 'review-red-team-policy.mjs', text => text.replace('Object.entries(RED_TEAM_CLEARANCE_INPUTS)', 'Object.entries({})')],
  ['completed-pass predicate call deleted', 'review-red-team-policy.mjs', text => text.replace('!RED_TEAM_EXEMPTION_INPUTS[key](input)', 'false')],
  ['environment bypass restored', 'drain-queue-safety.mjs', text => `${text}\nconst bypass = env => env.WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE;\n`],
  ['recorded normalization deleted', 'drain-red-team-input.mjs', text => text.replace('recorded: raw.recorded,', '')],
  ...exemptionKeys.map(key => [`exemption prerequisite ${key} deleted`, 'review-red-team-policy.mjs', text => {
    const line = text.split('\n').find(line => line.trimStart().startsWith(`${key.includes('.') ? `'${key}'` : key}: x =>`));
    return text.replace(line, '');
  }]),
  ['exemption table call deleted', 'review-red-team-policy.mjs', text => text.replace('Object.values(RED_TEAM_EXEMPTION_INPUTS).every(proven => proven(input))', 'true')],
  ['rename readability guard deleted', 'review-red-team-policy.mjs', text => text.replace('&& Array.isArray(read.netRenameSources)', '')],
  ['policy delegation deleted', 'drain-queue-safety.mjs', text => text.replace('redTeamOwedDecision(decisionInput)', '({ reasons: [] })')],
  ...[0, 1, 2].map(index => [`merge admission call ${index + 1} deleted`, 'drain-merge-strategy.mjs', text => {
    let seen = 0;
    return text.replaceAll('redTeamAdmissionHold(', hit => seen++ === index ? 'removedAdmission(' : hit);
  }]),
  ...['drain-queue-safety.mjs', 'drain-merge-strategy.mjs'].map(file => [`hold.includes restored in ${file}`, file,
    text => `${text}\nconst mutantRoute = hold => hold.message.includes('requiring send-back');\n`]),
])('mutation proof: structural test rejects %s', (_name, file, mutate) => {
  const source = sources(), mutant = { ...source, [file]: mutate(source[file]) };
  expect(mutant[file]).not.toBe(source[file]);
  expect(() => assertStructure(mutant)).toThrow();
});
