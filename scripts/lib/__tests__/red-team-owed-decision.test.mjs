// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { redTeamOwedDecision } from '../review-red-team-policy.mjs';
import { redTeamEnqueueHold, postAcceptRedTeamOwed } from '../drain-queue-safety.mjs';
import { redTeamMarker } from '../red-team-gate.mjs';
import { settleUnknownEvidenceByComment } from '../drain-red-team-evidence.mjs';

const head = 'a'.repeat(40);
const payload = () => ({ verdict: null, carriedFrom: 'b'.repeat(40), findings: { read: {
  diffScored: true, diffText: '+card', netChangedFiles: ['backlog/123-card.md'], netBasis: { rev: head },
} } });

describe('full evidence red-team owed decision', () => {
  it.each([
    ['unscored', read => { delete read.diffScored; }],
    ['false score', read => { read.diffScored = false; }],
    ['empty', read => { read.diffText = ''; }],
    ['whitespace', read => { read.diffText = ' \n'; }],
    ['unreadable', read => { delete read.diffText; }],
  ])('fails closed for any %s read, including status and carry contradictions', (_name, invalidate) => {
    for (const source of ['read', 'loopPayload', 'status', 'liveStatus', 'carry']) {
      const e = { read: payload().findings.read, loopPayload: payload(), status: { loopPayload: payload() },
        liveStatus: { loopPayload: payload() }, carry: { loopPayload: payload() },
        historicalResult: { policyClear: true } };
      invalidate(source === 'read' ? e.read : source === 'loopPayload' ? e.loopPayload.findings.read : e[source].loopPayload.findings.read);
      expect(redTeamOwedDecision({ fullEvidence: e })).toMatchObject({ owed: true, cleared: false,
        settlementEligible: false, skipNeedsSettlement: false, reason: 'unreviewable-read' });
    }
  });
  it('missing evidence is owed and cannot clear or settle', () => {
    expect(redTeamOwedDecision()).toMatchObject({ owed: true, cleared: false, settlementEligible: false,
      reason: 'unreviewable-read' });
  });
  it.each([{ read: null }, { read: undefined }, { carry: {} }])('an explicitly unreadable source %j cannot fall back to a scored payload', extra => {
    expect(redTeamOwedDecision({ fullEvidence: { loopPayload: payload(), historicalResult: { policyClear: true }, ...extra } }))
      .toMatchObject({ owed: true, cleared: false, settlementEligible: false, reason: 'unreviewable-read' });
  });
  it('merge admission holds an unscored carry despite a trusted historical policy-clear', () => {
    const root = mkdtempSync(join(tmpdir(), 'red-team-owed-'));
    const env = { WE_SHARED_RUNS_DIR: join(root, 'runs') };
    try {
    const loopPayload = payload();
    delete loopPayload.findings.read.diffScored;
    const e = { ok: true, loopPayload, carry: { loopPayload }, scheduled: false, recorded: false, inFlight: false,
      status: { status: 'finished', result: { status: 'skipped', policy: 'card-only' }, loopPayload }, skipCardOnly: true };
    const comments = [{ author: { login: 'web-everything' }, body: `${redTeamMarker(42, head)}\n\nRed team not required on this head: card-only diff (policy redTeam.skipCardOnly)` }];
    expect(postAcceptRedTeamOwed(loopPayload, env, e)).toBe(true);
    expect(redTeamEnqueueHold({ ...e, repo: 'o/r', pr: 42, head, comments, env })).toMatch(/no recorded result/);
    // Positive control: the identical fully scored evidence supports the exemption.
    loopPayload.findings.read.diffScored = true;
    expect(redTeamEnqueueHold({ ...e, repo: 'o/r', pr: 42, head, comments, env })).toBeNull();
    // A policy-clear cannot pay newly scheduled non-exempt work either.
    loopPayload.findings.read.netChangedFiles = ['scripts/code.mjs'];
    expect(redTeamEnqueueHold({ ...e, status: undefined, skipCardOnly: false, scheduled: true,
      repo: 'o/r', pr: 42, head, comments, env })).toMatch(/no recorded result/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([{ inFlight: true }, { recorded: true }, { seatRecorded: true }, { seats: [{ status: 'ok' }] },
    { ok: false }, { carryConflict: true }])('full evidence %j refuses policy clearance and settlement', extra => {
    expect(redTeamOwedDecision({ fullEvidence: { loopPayload: payload(), historicalResult: { policyClear: true }, ...extra } }))
      .toMatchObject({ owed: true, cleared: false, settlementEligible: false });
  });
  it('comment settlement retains an unscored carry instead of discarding its debt', () => {
    const loopPayload = payload();
    delete loopPayload.findings.read.diffScored;
    const at = Date.parse('2026-11-05T12:00:00Z');
    const evidence = Object.defineProperty({ ok: false, reason: 'scan-capped', carry: { loopPayload },
      read: payload().findings.read }, 'settleBounds', { value: {
      unfinishedUndecided: true, unfinishedStartedAt: at - 3600e3, unfinishedActiveAt: at - 24 * 3600e3,
      evaluatedAt: at, completeHeadRead: () => ({ complete: true, blocked: false }),
    } });
    const comments = [{ author: { login: 'web-everything' }, createdAt: new Date(at).toISOString(),
      body: `${redTeamMarker(42, head)}\nRed team not required on this head: card-only diff (policy redTeam.skipCardOnly)` }];
    expect(settleUnknownEvidenceByComment(evidence, comments, 42, head)).toBe(evidence);
  });
});

// Each entry pins every decision call site, not just an import or a token somewhere in the file.
// Removing any single call must fail the shipped-source test, even if other calls in that module remain.
const sites = [
  ['lib/red-team-skip-outcome.mjs', 2], ['lib/red-team-carry-machine.mjs', 2],
  ['lib/red-team-carry-io.mjs', 2], ['lib/red-team-status-labels.mjs', 1],
  ['lib/review-red-team-on-skip.mjs', 11], ['lib/drain-queue-safety.mjs', 2],
  ['lib/drain-merge-strategy.mjs', 1], ['lib/drain-red-team-evidence.mjs', 5],
  ['operations/review-job.mjs', 6], ['operations/review-extra-seats.mjs', 5],
  ['operations/review-pr.mjs', 1],
];
function inspect(source) {
  const ast = ts.createSourceFile('module.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [], violations = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (['redTeamOwedOnHead', 'redTeamReadReviewable', 'redTeamOwedFor', 'redTeamCardOnly'].includes(name))
        violations.push(`local/legacy decision: ${name}`);
      if (name === 'redTeamSkipNeedsSettlement' && node.arguments.length < 2)
        violations.push('status-only settlement call missing fullEvidence');
      if (name === 'redTeamOwedDecision') {
        calls.push(node);
        const arg = node.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg) || !arg.properties.some(p => p.name?.getText(ast) === 'fullEvidence'))
          violations.push('decision missing fullEvidence');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { calls, violations };
}
function assertSites(source, count) {
  const { calls, violations } = inspect(source);
  expect(violations).toEqual([]);
  expect(calls.length, 'every owed/clearance/settlement decision site must call redTeamOwedDecision').toBe(count);
}
describe('red-team decision construction', () => {
  it('rejects a status-only compatibility call in a runtime consumer', () => {
    const source = readFileSync(new URL('../../operations/review-job.mjs', import.meta.url), 'utf8');
    const mutated = source.replace('redTeamSkipNeedsSettlement(admissionPrior, admissionEvidence)', 'redTeamSkipNeedsSettlement(admissionPrior)');
    expect(mutated).not.toBe(source);
    expect(() => assertSites(mutated, 6)).toThrow(/status-only settlement call/);
  });

  it('both check publishers hand complete evidence to the canonical admission decision', () => {
    const source = readFileSync(new URL('../red-team-check-run.mjs', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('writer.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const handoffs = [];
    const visit = node => {
      if (ts.isCallExpression(node) && ['holdFn', 'readResultHold'].includes(node.expression.getText(ast))) {
        handoffs.push(node.expression.getText(ast));
        const properties = node.arguments[0].properties;
        expect(properties.some(p => ts.isSpreadAssignment(p) && p.expression.getText(ast) === 'evidence')).toBe(true);
        expect(properties.some(p => p.name?.getText(ast) === 'recorded')).toBe(false);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(handoffs.sort()).toEqual(['holdFn', 'readResultHold']);
  });
  it.each(sites)('%s delegates all %i decision sites to the full-evidence function', (path, count) => {
    assertSites(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'), count);
  });
  it.each(sites)('%s detects removal of EACH call (mutation proof)', (path, count) => {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    const { calls } = inspect(source);
    expect(calls).toHaveLength(count);
    for (const call of calls) {
      const mutated = source.slice(0, call.getStart()) + '({})' + source.slice(call.end);
      expect(() => assertSites(mutated, count)).toThrow(/every owed\/clearance\/settlement decision site/);
    }
  });
});
