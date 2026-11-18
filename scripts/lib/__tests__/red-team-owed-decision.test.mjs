// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { redTeamOwedDecision } from '../review-red-team-policy.mjs';

const payload = () => ({ verdict: { verdict: 'accept' }, findings: { read: {
  diffScored: true, diffText: '+card', netChangedFiles: ['backlog/123-card.md'],
} } });

describe('full evidence red-team owed decision', () => {
  it.each([
    ['unscored', r => { delete r.diffScored; }],
    ['false score', r => { r.diffScored = false; }],
    ['empty', r => { r.diffText = ''; }],
    ['whitespace', r => { r.diffText = ' \n'; }],
    ['unreadable', r => { delete r.diffText; }],
    ['non-text', r => { r.diffText = {}; }],
  ])('fails closed on any %s read despite a historical policy-clear or actual result', (_name, invalidate) => {
    for (const policyClear of [true, false]) {
      for (const source of ['read', 'loopPayload', 'status', 'liveStatus', 'carry', 'rawWriter', 'storedReview', 'newest']) {
        const e = { read: payload().findings.read, loopPayload: payload(), status: { loopPayload: payload() },
          liveStatus: { loopPayload: payload() }, carry: { loopPayload: payload() }, rawWriter: { parsed: { loopPayload: payload() } },
          storedReview: { newest: payload() }, newest: payload(), historicalResult: { policyClear } };
        invalidate(source === 'read' ? e.read : source === 'loopPayload' || source === 'newest' ? e[source].findings.read
          : source === 'rawWriter' ? e.rawWriter.parsed.loopPayload.findings.read
            : source === 'storedReview' ? e.storedReview.newest.findings.read : e[source].loopPayload.findings.read);
        expect(redTeamOwedDecision({ fullEvidence: e }), `${source}, policyClear=${policyClear}`)
          .toMatchObject({ owed: true, cleared: false, readReviewable: false, reason: 'unreviewable-read' });
      }
    }
  });
  it.each([undefined, {}, { fullEvidence: null }])('missing evidence %j cannot clear', input => {
    expect(redTeamOwedDecision(input)).toMatchObject({ owed: true, cleared: false, reason: 'unreviewable-read' });
  });
  it.each([{ read: null }, { read: undefined }, { carry: {} }, { status: { loopPayload: null } }])(
    'an explicitly unreadable source %j cannot fall back to a scored payload', extra => {
      expect(redTeamOwedDecision({ fullEvidence: { loopPayload: payload(), historicalResult: { policyClear: true }, ...extra } }))
        .toMatchObject({ owed: true, cleared: false, reason: 'unreviewable-read' });
    });
  it.each([{ inFlight: true }, { recorded: true }, { seatRecorded: true }, { seats: [{ status: 'ok' }] },
    { completedRecorded: true }, { cleanRecorded: true }, { ok: false }, { carryConflict: true }])(
    'current evidence %j defeats historical policy clearance', extra => {
      expect(redTeamOwedDecision({ fullEvidence: { loopPayload: payload(), historicalResult: { policyClear: true }, ...extra } }))
        .toMatchObject({ owed: true, cleared: false });
    });
  it('newly scheduled non-exempt work defeats historical policy clearance', () => {
    expect(redTeamOwedDecision({ fullEvidence: { loopPayload: payload(), skipCardOnly: false,
      scheduled: true, historicalResult: { policyClear: true } } })).toMatchObject({ owed: true, cleared: false, reason: 'pass-owed' });
  });
  it('a scored read and a recorded actual result pay execution debt', () => {
    expect(redTeamOwedDecision({ fullEvidence: { loopPayload: payload(), scheduled: true, recorded: true,
      disposition: { result: { policyClear: false } } } })).toMatchObject({ owed: false, cleared: true, reason: 'recorded-result' });
  });
  it('honors the producer skip setting before the caller default', () => {
    const e = { loopPayload: payload(), scheduled: true, defaultSkipCardOnly: false, status: { skipCardOnly: true } };
    expect(redTeamOwedDecision({ fullEvidence: e })).toMatchObject({ owed: false, reason: 'card-only-exempt' });
    expect(redTeamOwedDecision({ fullEvidence: { ...e, skipCardOnly: false } })).toMatchObject({ owed: true });
  });
});

// Extend this table as other decision modules migrate. Each function must delegate its own decision.
const sites = [{ path: '../drain-queue-safety.mjs', functions: ['postAcceptRedTeamOwed', 'redTeamEnqueueHold'] }];
function assertDelegation(source, functions) {
  const ast = ts.createSourceFile('module.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  for (const name of functions) {
    const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    expect(fn, name).toBeDefined();
    const localCalls = [];
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        expect(['redTeamOwedOnHead', 'redTeamOwedFor', 'redTeamCardOnly'].includes(node.expression.text), 'legacy local decision').toBe(false);
        if (node.expression.text === 'redTeamOwedDecision') localCalls.push(node);
      }
      expect(ts.isPropertyAccessExpression(node) && node.expression.getText(ast) === 'disposition'
        && node.name.text === 'result', 'historical result must not bypass the decision').toBe(false);
      ts.forEachChild(node, visit);
    };
    visit(fn);
    expect(localCalls, `${name} must call redTeamOwedDecision`).toHaveLength(1);
    const call = localCalls[0], arg = call.arguments[0];
    expect(ts.isObjectLiteralExpression(arg)).toBe(true);
    const full = arg.properties.find(p => p.name?.getText(ast) === 'fullEvidence')?.initializer;
    expect(full && ts.isObjectLiteralExpression(full), 'full evidence object').toBeTruthy();
    expect(full.properties.some(p => ts.isSpreadAssignment(p)
      && ['evidence', 'fullEvidence'].includes(p.expression.getText(ast))), 'unfiltered evidence spread').toBe(true);
    if (name === 'redTeamEnqueueHold') {
      const declaration = call.parent;
      expect(ts.isVariableDeclaration(declaration)).toBe(true);
      const nullReturns = [];
      const checkReturn = node => {
        if (ts.isReturnStatement(node) && node.expression?.kind === ts.SyntaxKind.NullKeyword) nullReturns.push(node);
        ts.forEachChild(node, checkReturn);
      };
      checkReturn(fn);
      expect(nullReturns).toHaveLength(1);
      const guard = nullReturns[0].parent;
      expect(ts.isIfStatement(guard) && guard.expression.getText(ast) === `!${declaration.name.getText(ast)}.owed`,
        'clearance must consume the shared decision').toBe(true);
    } else {
      expect(call.parent.getText(ast)).toBe(`${call.getText(ast)}.owed`);
    }
    calls.push(call);
  }
  return calls;
}
describe('red-team decision construction', () => {
  it.each(sites)('$path delegates every admission decision with full evidence', ({ path, functions }) => {
    assertDelegation(readFileSync(new URL(path, import.meta.url), 'utf8'), functions);
  });
  it.each(sites)('$path rejects removal of EACH decision call (mutation proof)', ({ path, functions }) => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const call of assertDelegation(source, functions)) {
      const mutated = source.slice(0, call.getStart()) + '({ owed: false })' + source.slice(call.end);
      expect(() => assertDelegation(mutated, functions)).toThrow(/must call redTeamOwedDecision/);
    }
  });
});
