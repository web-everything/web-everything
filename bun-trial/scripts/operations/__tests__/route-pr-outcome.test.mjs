/**
 * @file route-pr-outcome.test.mjs — proof of the `route-pr-outcome` operation (#xrpo1): the first path through
 *   the operations engine that reaches `deriveReviewDisposition` (`we:scripts/lib/review-core.mjs`).
 *
 * THE PROPERTY UNDER TEST IS THAT THIS FILE DECIDES NOTHING. Every disposition case below is pulled straight
 * from `deriveReviewDisposition`'s own three return branches — a deadlock reason, a human-sensitivity reason,
 * and an ordinary sensitivity reason — and if this operation ever disagreed with the real function on any of
 * them, that would mean a second, drifted implementation had crept in despite the whole point of the file being
 * not to have one. So most of the assertions below are really assertions ABOUT `deriveReviewDisposition`,
 * exercised through this operation's plumbing rather than restated by it.
 *
 * The SECOND property under test is the boundary: a reader that returns something malformed, or fails outright,
 * must never present as a PR that is simply not escalated. `disposition: null` is this operation's "safe to
 * auto-land past" reading in one sense (nothing routes) and its most dangerous misreading in another (an
 * unreadable PR looking like a clean one) — so the refusal tests below matter as much as the happy-path ones.
 */
import { describe, it, test, expect, afterEach, mock } from 'bun:test';
const __ORIG_URL = new URL('../../../../scripts/operations/__tests__/route-pr-outcome.test.mjs', import.meta.url).href;
const __ORIG_FILE = new URL(__ORIG_URL).pathname;
const __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\/$/, '');
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRegistry } from '../../../../scripts/operations/registry.mjs';
import { startRun, advanceWhileRunning } from '../../../../scripts/operations/engine.mjs';
import { isReadOnlyDeclaration } from '../../../../scripts/operations/http-adapter.mjs';
import { importGraph } from '../../../../scripts/operations/__tests__/import-graph.mjs';
import { OPERATIONS } from '../../../../scripts/operations/run.mjs';
import { buildEscalationReasonBlock } from '../../../../scripts/lib/review-escalation.mjs';
import { deriveReviewDisposition, UnknownReasonError } from '../../../../scripts/lib/review-core.mjs';
import {
  routePrOutcomeOperation, shapeRouteRead, planRouteOutcome,
  ROUTE_PR_OUTCOME_OP, ROUTE_OUTCOME_REFUSALS, ROUTE_ACTIONS,
} from '../../../../scripts/operations/route-pr-outcome.mjs';
import {
  deriveRouteFinding, shapeGhView, viewArgv, labelNames, createRouteOutcomeReader,
} from '../../../../scripts/operations/route-pr-outcome-io.mjs';

// `deriveReviewDisposition` is wrapped, not replaced: it delegates to the REAL function unless a test queues a
// throw with `mockImplementationOnce`, so every other test in this file still exercises the real disposition
// logic. ESM exports cannot be spied on in place, so the module has to be mocked up front (#3495).
const __actual0 = { ...(await import('../../../../scripts/lib/review-core.mjs')) };
mock.module('../../../../scripts/lib/review-core.mjs', () => {
  const actual = __actual0;
  return { ...actual, deriveReviewDisposition: mock(actual.deriveReviewDisposition) };
});

const HERE = dirname(fileURLToPath(__ORIG_URL));

/** A `gh pr view` shaped body: prose, then the drain's real escalation-reason block. */
const bodyWith = (reasons) => `Some PR description.\n\nMore prose.${buildEscalationReasonBlock(reasons)}`;

const view = (over = {}) => ({
  number: 1234, title: 'a PR', url: 'https://github.com/o/r/pull/1234', body: '', labels: [], ...over,
});

afterEach(() => { deriveReviewDisposition.mockClear(); });

describe('deriveRouteFinding — pulls its three cases straight from deriveReviewDisposition', () => {
  it('a DEADLOCK reason (non-convergence) routes to human, never auto-land — the loop already failed to converge', () => {
    const f = deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['non-convergence']) }) });
    expect(f.disposition).toEqual({ mode: 'human', autoLand: false });
    expect(f.refusal).toBeNull();
  });

  it('the OTHER deadlock reason (mandate-conflict) routes to human too', () => {
    const f = deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['mandate-conflict']) }) });
    expect(f.disposition.mode).toBe('human');
    expect(f.disposition.autoLand).toBe(false);
  });

  it('a HUMAN-SENSITIVITY reason (gate-self) converges but never auto-lands — an agent may fix it, never clear it', () => {
    const f = deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['gate-self']) }) });
    expect(f.disposition).toEqual({ mode: 'converge', autoLand: false });
  });

  it('the OTHER human-sensitivity reason (statute) converges without auto-land too', () => {
    const f = deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['statute']) }) });
    expect(f.disposition).toEqual({ mode: 'converge', autoLand: false });
  });

  it('an ORDINARY sensitivity reason (blast-radius) converges AND may auto-land — agent-reviewable', () => {
    const f = deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['blast-radius']) }) });
    expect(f.disposition).toEqual({ mode: 'converge', autoLand: true });
  });

  it('the rest of the auto-land family agree too (size, dismissed-findings, cross-repo, gate-derivation)', () => {
    for (const reason of ['size', 'dismissed-findings', 'cross-repo', 'gate-derivation']) {
      const f = deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith([reason]) }) });
      expect(f.disposition, reason).toEqual({ mode: 'converge', autoLand: true });
    }
  });

  it('several reasons at once: strictest wins, deadlock beats everything', () => {
    const f = deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['blast-radius', 'non-convergence']) }) });
    expect(f.disposition.mode).toBe('human');
  });

  it('accepts the DECORATED reason strings the drain actually writes, not just bare tokens', () => {
    // `buildEscalationReasonBlock` writes decorated text ("size (1080 ≥ 400 changed lines)"), and
    // `parseEscalationReason` hands those bare decorated strings straight to `deriveReviewDisposition`, which
    // canonicalizes them. Proven against the real builder, not a synthetic bare-token fixture.
    const f = deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['size (1080 ≥ 400 changed lines)']) }) });
    expect(f.escalationReason).toEqual(['size (1080 ≥ 400 changed lines)']);
    expect(f.disposition).toEqual({ mode: 'converge', autoLand: true });
  });
});

describe('deriveRouteFinding — the null-disposition cases are NOT the same case', () => {
  it('no escalation block at all → `no-escalation-reasons`, the ORDINARY unparked-PR state', () => {
    // This is the common case for most open PRs, so `deriveReviewDisposition` (which throws on an empty
    // reason list) is never even called with one — see the io file's header for why that is a refusal
    // category, not a bug caught after the fact.
    const f = deriveRouteFinding({ repo: 'o/r', view: view({ body: 'Just a description, nothing escalated.' }) });
    expect(f.disposition).toBeNull();
    expect(f.refusal).toBe('no-escalation-reasons');
    expect(f.escalationReason).toEqual([]);
  });

  it('an unrecognized reason → `unrecognized-reasons`, a DIFFERENT fact than "not escalated"', () => {
    // A block exists (so this PR WAS parked) but its content canonicalizes to nothing this repo's
    // disposition vocabulary knows — a corrupted body, or scorer/disposition drift. Collapsing this into
    // `no-escalation-reasons` would hide exactly that drift behind the same "nothing to route" reading an
    // ordinary unparked PR gets.
    const f = deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['some-future-reason-token']) }) });
    expect(f.disposition).toBeNull();
    expect(f.refusal).toBe('unrecognized-reasons');
    expect(f.escalationReason).toEqual(['some-future-reason-token']);
  });

  it('the unknown-token throw IS the dedicated `UnknownReasonError` — the type the catch is keyed on', () => {
    // Not stubbed: the real function, so this pins that the refusal above is reached through the same error
    // class `deriveRouteFinding` narrows to, not through a message coincidence.
    const err = (() => { try { deriveReviewDisposition({ reasons: ['some-future-reason-token'] }); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(UnknownReasonError);
    expect(err.unknownReasons).toEqual(['some-future-reason-token']);
    expect(err.message).toMatch(/unknown reason\(s\): some-future-reason-token/);
  });

  it('an UNRELATED throw from `deriveReviewDisposition` PROPAGATES — it is not an `unrecognized-reasons` refusal (#3495)', () => {
    // A future precondition check or an internal bug must surface, not be reclassified as the ordinary
    // "nothing to route" reading. The reason token here is VALID, so the only thing that can fail is the stub.
    deriveReviewDisposition.mockImplementationOnce(() => { throw new TypeError('cannot read properties of undefined'); });
    expect(() => deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['blast-radius']) }) }))
      .toThrow(TypeError);
  });

  it('an unrelated throw that merely SOUNDS like the unknown-token one still propagates — the match is on the type, not the text', () => {
    deriveReviewDisposition.mockImplementationOnce(() => { throw new Error('deriveReviewDisposition: unknown reason(s): impostor'); });
    expect(() => deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['blast-radius']) }) }))
      .toThrow(/impostor/);
  });

  it('refusal is always one of the declared, closed set', () => {
    for (const body of ['', bodyWith(['nope-not-a-real-token'])]) {
      const f = deriveRouteFinding({ repo: 'o/r', view: view({ body }) });
      expect(ROUTE_OUTCOME_REFUSALS).toContain(f.refusal);
    }
  });
});

describe('deriveRouteFinding — reviewClass/humanRequired come from the label vocabulary, not guessed', () => {
  it('review:human wins over review:pending when (implausibly) both are present', () => {
    const f = deriveRouteFinding({ repo: 'o/r', view: view({ labels: ['review:human', 'review:pending'] }) });
    expect(f.humanRequired).toBe(true);
    expect(f.reviewClass).toBe('human');
  });

  it('review:pending alone', () => {
    const f = deriveRouteFinding({ repo: 'o/r', view: view({ labels: ['review:pending'] }) });
    expect(f.humanRequired).toBe(false);
    expect(f.reviewClass).toBe('pending');
  });

  it('neither label → "none"', () => {
    const f = deriveRouteFinding({ repo: 'o/r', view: view({ labels: ['ready-to-merge'] }) });
    expect(f.reviewClass).toBe('none');
    expect(f.humanRequired).toBe(false);
  });

  it('carries repo/pr/title/url through unchanged', () => {
    const f = deriveRouteFinding({ repo: 'o/r', view: view({ number: 42, title: 't', url: 'u' }) });
    expect(f).toMatchObject({ repo: 'o/r', pr: 42, title: 't', url: 'u' });
  });
});

describe('the io shell — argv, shaping, and the reader', () => {
  it('asks for exactly the fields this operation needs: body + labels, no comments/files', () => {
    // Fetching comments/files would be this thin operation paying for a read `review-detail.mjs`'s heavier
    // console question needs and this one does not.
    const argv = viewArgv({ repo: 'o/r', pr: 7 });
    expect(argv).toEqual(['pr', 'view', '7', '--repo', 'o/r', '--json', 'number,title,url,body,labels']);
  });

  it('normalizes gh label objects and bare strings alike', () => {
    expect(labelNames([{ name: 'review:human' }, 'lane', { name: '' }, null])).toEqual(['review:human', 'lane']);
  });

  it('shapeGhView tolerates a missing/malformed body rather than throwing', () => {
    expect(shapeGhView({}).body).toBe('');
    expect(shapeGhView(null).body).toBe('');
    expect(shapeGhView({ body: 42 }).body).toBe('');
  });

  it('reads a PR end to end through one injected runner', () => {
    const seen = [];
    const read = createRouteOutcomeReader({ run: (_bin, argv) => {
      seen.push(argv.join(' '));
      return JSON.stringify({ number: 9, title: 't', url: 'u', body: bodyWith(['blast-radius']), labels: [{ name: 'review:pending' }] });
    } });
    const f = read({ repo: 'o/r', pr: 9 });
    expect(seen[0]).toBe('pr view 9 --repo o/r --json number,title,url,body,labels');
    expect(f).toMatchObject({ pr: 9, reviewClass: 'pending', disposition: { mode: 'converge', autoLand: true } });
  });

  it('THROWS when `gh` fails, rather than yielding a safe-looking empty read', () => {
    // The most important line in this file. `no-escalation-reasons` is read downstream as "nothing to route" —
    // the do-nothing, safe answer. A reader that turned a network error into that same shape would manufacture
    // the single most dangerous misreading a routing operation can produce: an uninspectable PR presenting as
    // one that is definitely clean.
    const read = createRouteOutcomeReader({ run: () => { throw new Error('gh: network unreachable'); } });
    expect(() => read({ repo: 'o/r', pr: 1 })).toThrow(/network unreachable/);
  });
});

describe('shapeRouteRead — the boundary refuses a shape this operation cannot act on', () => {
  const finding = (over = {}) => ({
    repo: 'o/r', pr: 1, title: 't', url: 'u', labels: [], humanRequired: false, reviewClass: 'none',
    escalationReason: [], disposition: null, refusal: 'no-escalation-reasons', ...over,
  });

  it('refuses a non-object reader result outright — never a permissive default', () => {
    for (const bad of [null, undefined, 'x', 7, []]) {
      expect(() => shapeRouteRead(bad, { repo: 'o/r', pr: 1 })).toThrow(/not a route finding|no usable PR number/);
    }
  });

  it('refuses a missing/invalid PR number', () => {
    expect(() => shapeRouteRead(finding({ pr: 0 }))).toThrow(/no usable PR number/);
    expect(() => shapeRouteRead(finding({ pr: 'nope' }))).toThrow(/no usable PR number/);
  });

  it('refuses a non-array `labels` or `escalationReason`', () => {
    expect(() => shapeRouteRead(finding({ labels: 'not-an-array' }))).toThrow(/`labels` array/);
    expect(() => shapeRouteRead(finding({ escalationReason: null }))).toThrow(/`escalationReason` array/);
  });

  it('refuses an unknown `refusal` value', () => {
    expect(() => shapeRouteRead(finding({ refusal: 'because-i-said-so' }))).toThrow(/unknown refusal/);
  });

  it('refuses a malformed `disposition` shape', () => {
    for (const bad of [{ mode: 'human' }, { mode: 'nope', autoLand: true }, { autoLand: 'yes' }]) {
      expect(() => shapeRouteRead(finding({ disposition: bad, refusal: null }))).toThrow(/disposition.*must be/);
    }
  });

  it('refuses BOTH disposition and refusal present — the reader must decide one thing, not two', () => {
    expect(() => shapeRouteRead(finding({ disposition: { mode: 'human', autoLand: false } })))
      .toThrow(/exactly one of/);
  });

  it('refuses NEITHER present — an undecided reader is not a "nothing to route" reader', () => {
    expect(() => shapeRouteRead(finding({ refusal: null }))).toThrow(/exactly one of/);
  });

  it('accepts a genuinely valid shape and normalizes it', () => {
    const shaped = shapeRouteRead(finding({ refusal: null, disposition: { mode: 'converge', autoLand: true } }));
    expect(shaped).toMatchObject({ pr: 1, disposition: { mode: 'converge', autoLand: true }, refusal: null });
  });
});

describe('planRouteOutcome — reduces {disposition, refusal} to the one flat `action`, deciding nothing new', () => {
  const read = (over = {}) => ({
    repo: 'o/r', pr: 1, title: 't', url: 'u', labels: [], humanRequired: false, reviewClass: 'none',
    escalationReason: [], disposition: null, refusal: null, ...over,
  });

  it('human disposition → action "human"', () => {
    expect(planRouteOutcome(read({ disposition: { mode: 'human', autoLand: false } })).action).toBe('human');
  });

  it('converge + autoLand → action "land"', () => {
    expect(planRouteOutcome(read({ disposition: { mode: 'converge', autoLand: true } })).action).toBe('land');
  });

  it('converge + no autoLand → action "converge"', () => {
    expect(planRouteOutcome(read({ disposition: { mode: 'converge', autoLand: false } })).action).toBe('converge');
  });

  it('EITHER refusal reason → action "unrouted", but the reason survives on `refusal`', () => {
    // `action` collapses the two refusal cases on purpose (see the declaration's own header); `refusal` is the
    // uncollapsed field for a caller that needs to tell them apart (an operator/alerting consumer, say).
    for (const refusal of ROUTE_OUTCOME_REFUSALS) {
      const v = planRouteOutcome(read({ refusal }));
      expect(v.action).toBe('unrouted');
      expect(v.refusal).toBe(refusal);
    }
  });

  it('every action it can produce is in the declared closed set', () => {
    const cases = [
      read({ disposition: { mode: 'human', autoLand: false } }),
      read({ disposition: { mode: 'converge', autoLand: true } }),
      read({ disposition: { mode: 'converge', autoLand: false } }),
      read({ refusal: 'no-escalation-reasons' }),
    ];
    for (const r of cases) expect(ROUTE_ACTIONS).toContain(planRouteOutcome(r).action);
  });
});

describe('the declaration', () => {
  it('refuses to build without an injected reader', () => {
    expect(() => routePrOutcomeOperation({})).toThrow(/needs a `readPrView/);
  });

  it('declares repo/pr as required inputs, no optional flags to hide a scope', () => {
    const decl = routePrOutcomeOperation({ readPrView: () => ({}) });
    expect(decl.name).toBe(ROUTE_PR_OUTCOME_OP);
    expect(Object.keys(decl.input)).toEqual(['repo', 'pr']);
    expect(decl.input.repo.required).toBe(true);
    expect(decl.input.pr.required).toBe(true);
  });

  it('is READ-ONLY — both steps are compute, so no effect exists for a sink to apply', () => {
    const decl = routePrOutcomeOperation({ readPrView: () => ({}) });
    expect(decl.steps.map((s) => s.step.kind)).toEqual(['compute', 'compute']);
    expect(isReadOnlyDeclaration(decl)).toBe(true);
  });

  it('the `read` step threads BOTH inputs into the reader, and declares both reads', () => {
    let seen = null;
    const decl = routePrOutcomeOperation({ readPrView: (a) => {
      seen = a;
      return { repo: 'o/r', pr: 42, title: 't', url: 'u', labels: [], humanRequired: false, reviewClass: 'none', escalationReason: [], disposition: null, refusal: 'no-escalation-reasons' };
    } });
    const readStep = decl.steps.find((s) => s.name === 'read').step;
    for (const r of ['input.repo', 'input.pr']) expect(readStep.reads).toContain(r);
    readStep.fn({ input: { repo: 'o/r', pr: 42 } });
    expect(seen).toEqual({ repo: 'o/r', pr: 42 });
  });

  it('drives read → route end to end and lands the verdict on `route`', () => {
    const registry = createRegistry();
    const declaration = routePrOutcomeOperation({
      readPrView: () => deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['gate-self']) }) }),
    });
    registry.register(declaration);
    const run = advanceWhileRunning(
      startRun({ op: ROUTE_PR_OUTCOME_OP, id: 'run-rpo-1', input: { repo: 'o/r', pr: 1234 }, registry }),
      { registry },
    );
    expect(run.verdict).toMatchObject({ action: 'converge', disposition: { mode: 'converge', autoLand: false } });
    // Completed, not suspended — no `judge`/`confirm`/`effect` step exists to stop it, so the run reaches the
    // end of the declared step sequence in one `advanceWhileRunning` pass.
    expect(run.pending).toBeNull();
    expect(run.cursor).toBe(declaration.steps.length);
  });

  it('the same wiring reaches "land" for an ordinary sensitivity reason', () => {
    const registry = createRegistry();
    const declaration = routePrOutcomeOperation({
      readPrView: () => deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['blast-radius']) }) }),
    });
    registry.register(declaration);
    const run = advanceWhileRunning(
      startRun({ op: ROUTE_PR_OUTCOME_OP, id: 'run-rpo-2', input: { repo: 'o/r', pr: 1234 }, registry }),
      { registry },
    );
    expect(run.verdict.action).toBe('land');
  });

  it('an unrelated throw from `deriveReviewDisposition` fails the run instead of reporting `unrouted` (#3495)', () => {
    // The real operation, driven read → route through the registry (#2949) — the run record is what a caller
    // reads, so it is the run that must NOT come out as a clean `unrouted`/`unrecognized-reasons` verdict.
    deriveReviewDisposition.mockImplementationOnce(() => { throw new TypeError('cannot read properties of undefined'); });
    const registry = createRegistry();
    registry.register(routePrOutcomeOperation({
      readPrView: () => deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['blast-radius']) }) }),
    }));
    // The engine has no catch around a step's fn, so the reader's throw reaches the caller: the run cannot
    // complete with a verdict at all, let alone the `unrecognized-reasons` one.
    expect(() => advanceWhileRunning(
      startRun({ op: ROUTE_PR_OUTCOME_OP, id: 'run-rpo-4', input: { repo: 'o/r', pr: 1234 }, registry }),
      { registry },
    )).toThrow(TypeError);
  });

  it('while a GENUINE unknown token through the same wiring still yields `unrouted` / `unrecognized-reasons`', () => {
    const registry = createRegistry();
    registry.register(routePrOutcomeOperation({
      readPrView: () => deriveRouteFinding({ repo: 'o/r', view: view({ body: bodyWith(['some-future-reason-token']) }) }),
    }));
    const run = advanceWhileRunning(
      startRun({ op: ROUTE_PR_OUTCOME_OP, id: 'run-rpo-5', input: { repo: 'o/r', pr: 1234 }, registry }),
      { registry },
    );
    expect(run.verdict).toMatchObject({ action: 'unrouted', refusal: 'unrecognized-reasons', disposition: null });
  });

  it('and "unrouted" for a PR that never carried an escalation block', () => {
    const registry = createRegistry();
    const declaration = routePrOutcomeOperation({
      readPrView: () => deriveRouteFinding({ repo: 'o/r', view: view({ body: 'nothing escalated here' }) }),
    });
    registry.register(declaration);
    const run = advanceWhileRunning(
      startRun({ op: ROUTE_PR_OUTCOME_OP, id: 'run-rpo-3', input: { repo: 'o/r', pr: 1234 }, registry }),
      { registry },
    );
    expect(run.verdict).toMatchObject({ action: 'unrouted', refusal: 'no-escalation-reasons', disposition: null });
  });
});

describe('the operation is REGISTERED and its declaring module stays an import-graph leaf', () => {
  it('run.mjs can resolve it', () => {
    // Mirrors gate-health's own regression pin (PR #1163 shipped a declaration nothing could reach): a
    // declaration that exists but is not wired into `OPERATIONS` is a script with extra steps, not an
    // operation.
    expect(Object.keys(OPERATIONS)).toContain(ROUTE_PR_OUTCOME_OP);
  });

  it('reaches no `node:`/external specifier and not its own io module', () => {
    // `deriveReviewDisposition`'s home (`review-core.mjs`) and the label vocabulary's home
    // (`review-escalation.mjs`) are NOT leaves — `review-escalation.mjs` imports `node:crypto` directly, and
    // `review-core.mjs` reaches `markdown-it` through `jury-core.mjs`. This declaration must never import
    // either directly, or `__tests__/http-adapter.test.mjs`'s "a read-only operation declares in a module that
    // reaches nothing that can act" assertion goes red. The actual calls live in `route-pr-outcome-io.mjs`,
    // reached only through the injected `readPrView`.
    const { files, external } = importGraph(resolve(HERE, '..', 'route-pr-outcome.mjs'));
    expect(external).toEqual([]);
    expect(files.filter((f) => f.endsWith('route-pr-outcome-io.mjs'))).toEqual([]);
  });
});
