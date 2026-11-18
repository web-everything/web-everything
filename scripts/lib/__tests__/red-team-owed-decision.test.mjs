// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { recordRedTeamStatus, readDrainRedTeamEvidence, readRecoveryWitness, redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { redTeamOwedDecision, redTeamHold, redTeamReadReviewable, RED_TEAM_EXEMPTION_INPUTS, RED_TEAM_CLEARANCE_INPUTS } from '../review-red-team-policy.mjs';
import { redTeamAdmissionHold } from '../drain-queue-safety.mjs';
import { failedRedTeamRetry } from '../red-team-run-result.mjs';
import { reviewedRead, completedSeat, completedComment, exemptInput } from './fixtures/red-team-owed.mjs';

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
  recordRedTeamStatus({ repo, pr, head, loopPayload, status: 'finished', result: { status: 'skipped', policy: 'card-only' } }, { env });
  return { repo, pr, head, env, runsDir, comments: [] };
}
const decide = f => redTeamOwedDecision(readDrainRedTeamEvidence(f).decisionInput);
describe('PR-A v2 acceptance over persisted review, status and scorecard files', () => {
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
  'seats', 'ok', 'result', 'carry', 'carryConflict', 'hasBreak', 'pendingPublish',
  'scheduling.skipCardOnly', 'scheduling.settingsReadable', 'scheduling.commentsReadable', 'scheduling.sealClear',
  'scheduling.execution', 'scheduling.recorded', 'scheduling.inFlight', 'scheduling.queued', 'scheduling.scheduled',
];
it.each(exemptionKeys)('exemption requires explicit positive input: %s (omitted, null, object, wrong scalar)', key => {
  const baseline = exemptInput('a'.repeat(40));
  expect(redTeamOwedDecision(baseline)).toEqual({ owed: false, cleared: true, reasons: [] });
  for (const value of [undefined, ...(key === 'result' || key === 'carry' ? [false] : [null]), {}, 7]) {
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

// Parse the actual source: call deletion and prose-based routing must fail independently of runtime fixtures.
const sources = () => Object.fromEntries(['drain-queue-safety.mjs', 'drain-merge-strategy.mjs', 'drain-red-team-input.mjs', 'review-red-team-policy.mjs']
  .map(file => [file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')]));
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function all(node, predicate) {
  const found = [];
  const visit = n => { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); };
  visit(node); return found;
}
const calls = (node, name) => all(node, n => ts.isCallExpression(n) && n.expression.getText() === name);
function assertStructure(source) {
  expect(source['drain-red-team-input.mjs']).toMatch(/recorded: raw\.recorded/);
  const policy = parse('review-red-team-policy.mjs', source['review-red-team-policy.mjs']);
  const factory = all(policy, n => ts.isFunctionDeclaration(n) && n.name?.text === 'redTeamHold');
  expect(factory).toHaveLength(1);
  expect(factory[0].getText().replace(/^export /, '')).toBe(redTeamHold.toString());
  const decisionFn = all(policy, n => ts.isFunctionDeclaration(n) && n.name?.text === 'redTeamOwedDecision');
  expect(decisionFn).toHaveLength(1);
  expect(calls(decisionFn[0], 'redTeamHold').map(call => call.arguments.map(arg => arg.getText())))
    .toEqual([['kind', 'scheduling']]);
  expect(redTeamHold('pass-owed', { inFlight: false, queued: false }).blocking).toBe(false);
  expect(redTeamHold('pass-owed', { inFlight: true, queued: false }).blocking).toBe(true);
  expect(redTeamHold('pass-owed', { inFlight: false, queued: true }).blocking).toBe(true);
  expect(redTeamHold('pending-publish', { inFlight: true, queued: true }).blocking).toBe(false);
  const table = all(policy, n => ts.isVariableDeclaration(n) && n.name?.getText() === 'RED_TEAM_EXEMPTION_INPUTS');
  expect(table).toHaveLength(1);
  const properties = table[0].initializer.arguments[0].properties;
  expect(properties.map(p => p.name.text)).toEqual(exemptionKeys);
  for (const property of properties) expect(property.initializer.getText()).toBe(RED_TEAM_EXEMPTION_INPUTS[property.name.text].toString());
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
  ['running debt blocking guard deleted', 'review-red-team-policy.mjs', text => text.replace('scheduling.inFlight !== false || ', '')],
  ['queued debt blocking guard deleted', 'review-red-team-policy.mjs', text => text.replace(' || scheduling.queued !== false', '')],
  ['live debt forced non-blocking', 'review-red-team-policy.mjs', text => text.replace('scheduling.inFlight !== false || scheduling.queued !== false', 'false')],
  ['typed blocking construction bypassed', 'review-red-team-policy.mjs', text => text.replace('redTeamHold(kind, scheduling)', 'RED_TEAM_HOLDS[kind]')],
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
