// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { recordRedTeamStatus, readDrainRedTeamEvidence, readRecoveryWitness, redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { redTeamOwedDecision, redTeamReadReviewable } from '../review-red-team-policy.mjs';
import { redTeamAdmissionHold } from '../drain-queue-safety.mjs';
import { failedRedTeamRetry } from '../red-team-run-result.mjs';
import { reviewedRead, completedSeat, completedComment } from './fixtures/red-team-owed.mjs';

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
    expect(evidence.ok).toBeUndefined();
    expect(redTeamAdmissionHold({ ...f, ...evidence })).toMatchObject({ kind: 'carry-conflict', blocking: true });
  });
  it('canonical audit: a finished ran status with a clean seal, no seats and no comment still owes its result', () => {
    const f = fixture(), loopPayload = readDrainRedTeamEvidence(f).loopPayload;
    recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: 'ran' }, { env: f.env });
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    const status = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...status, sealedBreaks: [], sealedPosted: [] }));
    const evidence = readDrainRedTeamEvidence(f);
    expect(evidence).toMatchObject({ recorded: true, seats: [], status: { status: 'finished', result: 'ran' } });
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
  expect(source['drain-red-team-input.mjs']).toMatch(/recorded: !!raw\.recorded/);
  expect(source['review-red-team-policy.mjs']).toMatch(/!scheduling\.recorded/);
  expect(source['review-red-team-policy.mjs']).toMatch(/&& Array\.isArray\(read\.netRenameSources\)/);
  const queue = parse('drain-queue-safety.mjs', source['drain-queue-safety.mjs']);
  const merge = parse('drain-merge-strategy.mjs', source['drain-merge-strategy.mjs']);
  for (const file of [queue, merge]) {
    expect(file.text).not.toMatch(/disposition\.result|policyClear/);
    const proseIncludes = all(file, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && n.expression.name.text === 'includes' && /(?:reason|hold)/i.test(n.expression.expression.getText())
      && !/label/i.test(n.expression.expression.getText()));
    expect(proseIncludes.map(n => n.getText())).toEqual([]);
  }
  const admission = all(queue, n => ts.isFunctionDeclaration(n) && n.name?.text === 'redTeamAdmissionHold');
  expect(admission).toHaveLength(1);
  expect(calls(admission[0], 'redTeamOwedDecision')).toHaveLength(1);
  expect(calls(queue, 'redTeamOwedDecision')).toHaveLength(1);
  for (const name of ['checkRunDispositionHold', 'prestage', 'enqueue']) {
    const fn = all(merge, n => (name === 'checkRunDispositionHold' ? ts.isVariableDeclaration(n) : ts.isMethodDeclaration(n)) && n.name?.getText() === name);
    expect(fn).toHaveLength(1);
    expect(calls(fn[0], 'redTeamAdmissionHold')).toHaveLength(1);
  }
}
it('structural: each admission delegates exactly once; holds never branch on includes or duplicate result policy', () => {
  assertStructure(sources());
});
it.each([
  ['recorded normalization deleted', 'drain-red-team-input.mjs', text => text.replace('recorded: !!raw.recorded,', '')],
  ['recorded exemption guard deleted', 'review-red-team-policy.mjs', text => text.replace(' && !scheduling.recorded', '')],
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
