// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as seatAdapter from '../seat-assessment.mjs';
import { derivePanelVerdict } from '../jury-core.mjs';
import { buildAcceptanceRubric } from '../seat-ac-rubric.mjs';
import { reviewPrOperation, shapeReadFinding } from '../../operations/review-pr.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'checklist-enforce-')); dirs.push(cwd);
  const head = 'a'.repeat(40), base = 'b'.repeat(40), runId = 'isolated-review';
  const at = '2026-11-26T12:00:00Z';
  const card = '## Acceptance\n- [A1] The result is complete.\n';
  writeFileSync(join(cwd, 'card.md'), card);
  writeFileSync(join(cwd, 'proof.js'), 'export const complete = true;\n');
  const readFileAtRevision = vi.fn((revision, path) => {
    if (revision === base && path === 'card.md') return readFileSync(join(cwd, path), 'utf8');
    if (revision === head && path === 'proof.js') return readFileSync(join(cwd, path), 'utf8');
    throw new Error('citation absent at pinned head');
  });
  const security = { rubricType: 'https://everstandards.dev/core/rubric/v0.1',
    id: 'https://example.org/security', version: '1',
    items: [{ id: 'SB1', text: 'Check the boundary.', minKind: 'resolved-citation', naAllowed: false }] };
  const correctness = buildAcceptanceRubric({ head, mergeBase: base, cardPath: 'card.md', readFileAtRevision });
  const rubrics = { security, correctness };
  const policy = { policyType: 'https://everstandards.dev/core/rubric-policy/v0.1',
    id: 'https://example.org/policy', level: 'company', seats: [
      { lens: 'security', rubric: { uri: security.id, digest: seatAdapter.digestOf(security) }, required: 'all' },
      { lens: 'correctness', rubricFrom: 'subject', required: 'all', evidence: { minKind: 'resolved-citation' } },
    ] };
  const answers = lens => ({ items: rubrics[lens].items.map(item => ({ itemId: item.id, outcome: 'pass',
    evidence: [{ kind: 'resolved-citation', revisionId: head, location: { uri: 'proof.js', startLine: 1 } }] })) });
  const context = { cwd, env: {}, head, base, mergeBase: base, runId, at, policy, rubrics,
    cardPath: 'card.md', expectedRubric: correctness, readFileAtRevision, readFileAtHead: readFileAtRevision,
    readDiff: () => ['proof.js'], readGateSettings: () => ({ settings: {}, errors: [], duplicates: [] }),
    settingsLog: () => {}, settings: { mode: 'enforce', modeValid: true, policy, securityRubric: security, problems: [] },
    assessmentRunIds: { security: runId, correctness: runId },
    assessments: { security: answers('security'), correctness: answers('correctness') } };
  const authorization = { decision: 'CKLST-B-ENFORCE', authorizedBy: 'https://example.org/operator',
    authorizedAt: '2026-11-26T11:00:00Z', head, runId, policyDigest: seatAdapter.digestOf(policy),
    rubricDigests: Object.fromEntries(Object.entries(rubrics).map(([lens, rubric]) => [lens, seatAdapter.digestOf(rubric)])) };
  const recordPath = join(cwd, 'activation.json');
  const events = [];
  let locked = false;
  const io = {
    withLock: fn => { locked = true; try { return fn(); } finally { locked = false; } },
    readState: () => { expect(locked).toBe(true); events.push('state'); return context; },
    readAuthorization: () => { expect(locked).toBe(true); events.push('authorization'); return authorization; },
    persist: record => { expect(locked).toBe(true); events.push('persist'); writeFileSync(recordPath, JSON.stringify(record)); },
    readRecord: () => { events.push('read-back'); return JSON.parse(readFileSync(recordPath, 'utf8')); },
  };
  return { context, authorization, answers, io, events, recordPath };
}
const panel = { lensVerdicts: { security: 'accept', correctness: 'accept' }, findings: [] };

describe('CKLST-B enforce activation', () => {
  it.each(['missing', 'unreadable', 'malformed', 'failed persistence', 'non-durable persistence', 'no lock'])(
    'enforce activation refuses absent or non-durable authorization: %s', variant => {
      const f = fixture();
      if (variant === 'missing') f.io.readAuthorization = () => null;
      if (variant === 'unreadable') f.io.readAuthorization = () => { throw new Error('authorization timed out'); };
      if (variant === 'malformed') f.authorization.authorizedBy = '';
      if (variant === 'failed persistence') f.io.persist = () => { throw new Error('disk full'); };
      if (variant === 'non-durable persistence') f.io.persist = () => {};
      if (variant === 'no lock') delete f.io.withLock;
      const result = seatAdapter.recordEnforceAuthorization(f.io);
      expect(result.active).toBe(false); expect(result.holdReason).toMatch(/hold.*operator/i);
      if (['missing', 'unreadable', 'malformed', 'no lock'].includes(variant)) expect(f.events).not.toContain('persist');
    });
  it.each(['policy', 'security', 'correctness'].flatMap(key => [[key, 'missing'], [key, 'mismatched']]))(
    'enforce activation refuses missing or mismatched policy and rubric digests: %s %s', (key, variant) => {
      const f = fixture(), target = key === 'policy' ? f.authorization : f.authorization.rubricDigests;
      const field = key === 'policy' ? 'policyDigest' : key;
      if (variant === 'missing') delete target[field]; else target[field] = { sha256: '0'.repeat(64) };
      expect(seatAdapter.recordEnforceAuthorization(f.io).active).toBe(false);
      expect(f.events).not.toContain('persist');
    });
  it('authorized activation records exact policy and rubric digests before enforce takes effect', () => {
    const f = fixture();
    expect(seatAdapter.recordEnforceAuthorization(f.io)).toMatchObject({ active: true, record: f.authorization });
    expect(f.events).toEqual(['state', 'authorization', 'state', 'authorization', 'persist', 'read-back']);
    const restart = { ...f.context, mode: 'enforce', activationRequired: true,
      readActivation: () => JSON.parse(readFileSync(f.recordPath, 'utf8')) };
    expect(seatAdapter.assessReviewSeats(restart).seatGates).toEqual({ security: 'pass', correctness: 'pass' });
    f.context.policy.id = 'https://example.org/changed-policy';
    const changed = seatAdapter.assessReviewSeats(restart);
    expect(changed.seatGates).toEqual({ security: 'not-pass', correctness: 'not-pass' });
    expect(changed.holdReason).toMatch(/activation/);
  });
  it.each(['head', 'run', 'policy', 'authorization'])(
    'changed evidence before effect refuses: %s', variant => {
      const f = fixture(), read = f.io.readState; let reads = 0;
      f.io.readState = () => {
        if (++reads === 2) {
          if (variant === 'head') f.context.head = 'c'.repeat(40);
          if (variant === 'run') f.context.runId = 'foreign-run';
          if (variant === 'policy') f.context.policy.id = 'https://example.org/changed';
          if (variant === 'authorization') f.authorization.authorizedBy = 'https://example.org/other';
        }
        return read();
      };
      expect(seatAdapter.recordEnforceAuthorization(f.io).active).toBe(false);
      expect(f.events).not.toContain('persist');
    });
  it('oversized authorization holds with an operator fallback', () => {
    const f = fixture(); f.authorization.authorizedBy = 'x'.repeat(4 * 1024 * 1024);
    expect(seatAdapter.recordEnforceAuthorization(f.io)).toMatchObject({ active: false, holdReason: expect.stringMatching(/operator/) });
    expect(f.events).not.toContain('persist');
  });
});

describe('CKLST-B evidence and panel', () => {
  it.each([
    ['bare repro refuses', x => x.assessments.security.items[0].evidence = [{ kind: 'repro' }]],
    ['relative evidence identity refuses', x => x.assessments.security.items[0].evidence[0].ref = { uri: 'proof.js' }],
    ['stale head refuses', x => x.head = 'c'.repeat(40)],
    ['wrong run refuses', x => x.assessmentRunIds.security = 'foreign-run'],
    ['citation absent at head refuses', x => x.assessments.security.items[0].evidence[0].location.uri = 'absent.js'],
    ['unreadable policy not-pass', x => x.policy = null],
    ['invalid mode refuses', x => x.mode = 'unknown'],
    ['merge-path n/a cannot waive gate', x => Object.assign(x.assessments.security.items[0], { outcome: 'n/a', reason: 'skip merge path' })],
  ])('%s', (_name, mutate) => {
    const { context } = fixture(); context.mode = 'enforce'; mutate(context);
    // A repro would otherwise meet the configured evidence floor.
    if (_name === 'bare repro refuses') context.policy.seats[0].evidence = { minKind: 'repro' };
    const result = seatAdapter.assessReviewSeats(context);
    expect(result.seatGates.security).toBe('not-pass');
    expect(derivePanelVerdict({ ...panel, seatGates: result.seatGates })).toBe('changes');
  });
  it('valid repo-relative citation is a location rather than an evidence identity', () => {
    const { context } = fixture();
    expect(seatAdapter.assessReviewSeats(context).seatGates).toEqual({ security: 'pass', correctness: 'pass' });
  });
  it('expired shadow requests decision even without a row sink and never silently flips mode', () => {
    const { context } = fixture();
    const result = seatAdapter.assessReviewSeats({ ...context, mode: 'shadow', settings: undefined,
      shadowStartedAt: '2026-11-19T12:00:00Z', maxDays: 7 });
    expect(result).toMatchObject({ effectiveMode: 'shadow', decisionRequired: true });
    expect(result.seatGates).toBeUndefined(); expect(result.holdReason).toContain('decide CKLST-B enforce');
  });
  it.each(['complete', 'blank', 'invalid'])(
    'person model and tool seats derive identical results under the same pinned policy: %s', variant => {
      const { context } = fixture();
      const results = ['person', 'model', 'tool'].map(evaluator => {
        const assessments = Object.fromEntries(['security', 'correctness'].map(lens => {
          const statement = seatAdapter.wrapSeatAnswers({ ...context, lens, rubric: context.rubrics[lens], answers: context.assessments[lens] });
          statement.predicate.seat.evaluator = `https://example.org/${evaluator}`;
          if (variant === 'invalid') statement.predicate.items[0].evidence = [{ kind: 'repro' }];
          return [lens, variant === 'blank' ? null : statement];
        }));
        const result = seatAdapter.assessReviewSeats({ ...context, assessments });
        return { seats: result.seats, seatGates: result.seatGates, verdict: derivePanelVerdict({ ...panel, seatGates: result.seatGates }) };
      });
      expect(results[0]).toEqual(results[1]); expect(results[1]).toEqual(results[2]);
      expect(results[0].verdict).toBe(variant === 'complete' ? 'accept' : 'changes');
    });
  it.each(['blank', 'complete', 'authorization missing', 'context unreadable'])(
    'review-pr → assessReviewSeats → panel at the same pinned head: %s', variant => {
      const f = fixture();
      const raw = { state: 'OPEN', body: '', comments: [], detail: { title: 'Isolated review', labels: ['review:pending'],
        diffStat: [], disposition: { mode: 'converge', autoLand: false } },
        net: { paths: ['proof.js'], base: f.context.base, rev: f.context.head, scored: true },
        diff: { text: '--- a/proof.js\n+++ b/proof.js\n+export const complete = true;\n', scored: true } };
      if (variant !== 'authorization missing') expect(seatAdapter.recordEnforceAuthorization(f.io).active).toBe(true);
      const readContext = () => {
        if (variant === 'context unreadable') throw new Error('policy timed out');
        return { ...f.context, readActivation: f.io.readRecord };
      };
      const declaration = reviewPrOperation({ readPr: () => raw, minNonClaudeSeats: 0, seatChecklist: { readContext } });
      const read = shapeReadFinding(raw, { pr: 7, repo: 'example/repo' });
      const answer = lens => ({ summary: 'No blocking findings', findings: [],
        ...(variant !== 'blank' ? { assessment: f.answers(lens) } : {}) });
      const result = declaration.steps.find(s => s.name === 'reduce').step.fn({ input: { lens: 'correctness' },
        findings: { read, judge: answer('correctness'), judgeSecurity: answer('security') } });
      expect(result.verdict).toBe(variant === 'complete' ? 'accept' : 'changes');
      expect(result.seatChecklist).toMatchObject({ effectiveMode: 'enforce', modeSource: expect.any(String) });
      expect(result.seatChecklist.seats.security.head).toBe(f.context.head);
    });
});
