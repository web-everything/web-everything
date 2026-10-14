import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as current from '../dispatch-contracts.mjs';
import { inheritedRoutingPolicy } from './inherited-routing-policy.mjs';
const c = { ...current, decideDispatchRoute: (dispatch, options) => current.decideDispatchRoute(dispatch, { routingPolicy: inheritedRoutingPolicy, ...options }) };
import { workerTierFor, CRITICAL_WORK_GATE } from '../provider-routing.mjs';

const profile = (extra = {}) => c.buildDispatchProfile({ taskType: 'doc-fix', estimatedLoc: 30, filesTouched: ['docs/readme.md'], acceptanceTestable: true, dependsOn: [], ...extra }).profile;
const card = (extra = {}) => ({ kind: 'story', size: 3, scope: ['src/example.js'], preparedDate: '2026-09-20', ...extra });
const record = (extra = {}) => ({ provider: 'codex', model: 'gpt-5', taskType: 'doc-fix', scoredAt: '2026-09-20T00:00:00Z', outcome: 'landed', verifiedBy: 'independent-claude', findings: null, subjectClass: 'work-agent', ...extra });
// #3889 (Rule 5): the historical miss needs a rootCause note on record, and the post-miss bar is
// minCleanStreak(5) + k(3) = 8 clean trials, not the cold-start bar of 5.
const history = () => [record({ scoredAt: '2026-09-01T00:00:00Z', outcome: 'reworked', findings: 'Corrected assertion', rootCause: 'Assertion relied on unstable map iteration order; fixed and diagnosed.' }), ...Array.from({ length: 8 }, (_, i) => record({ scoredAt: `2026-09-1${i}T00:00:00Z` }))];
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

describe('story routing', () => {
  it('routes cold builds to the fallback with a cheaper shadow', () => {
    expect(c.routeDispatch(profile(), { stage: 'story', kind: 'build' })).toMatchObject({ role: c.SUPERVISOR_ROLE, provider: 'claude', model: 'claude-opus-5-5', tier: 'opus', mode: 'acting', backend: 'claude-native', spotCheck: null, shadow: { provider: 'antigravity', mode: 'shadow' } });
  });
  // #3857 — the standalone STORY_KIND_RUNGS table is folded into workerTierFor (provider-routing.mjs); a
  // non-build story kind's tier is now the SAME table a code-change dispatch's tier is. `investigate` no
  // longer forces Opus by kind alone (the table has no such row) — only `prepare-decision` does.
  it('retains RUNG_KINDS as the non-build story kinds and raises only for risk (#3857 model-tier table)', () => {
    expect(c.RUNG_KINDS).toEqual(['prepare', 'prepare-decision', 'investigate', 'fix', 'ci-heal']);
    const expectedTier = { prepare: 'sonnet', 'prepare-decision': 'opus', investigate: 'sonnet', fix: 'sonnet', 'ci-heal': 'sonnet' };
    for (const kind of c.RUNG_KINDS) {
      const tier = expectedTier[kind];
      const out = c.routeDispatch(profile(), { stage: 'story', kind });
      expect(out).toMatchObject({ role: 'lane-agent', provider: 'claude', tier, model: c.CLAUDE_NATIVE_MODEL_BY_TIER[tier], supervision: 'full', alternateBackend: null });
      expect(out.auditTrail[0].criterion).toBe('story-kind-tier');
      expect(out.auditTrail.some((a) => a.criterion === 'trailing-clean-streak')).toBe(true);
      expect(c.routeDispatch(profile({ risk: 'high' }), { stage: 'story', kind }).tier).toBe('opus');
    }
  });
});

describe('task routing', () => {
  it('uses Claude fallback, including the router alternate backend', () => {
    // #3857 — the model-tier table never outputs Haiku; a doc-fix with no table row stays at the Sonnet
    // default, so `alternateBackend` is now offered (Sonnet has an agy equivalent) rather than null.
    expect(c.routeDispatch(profile(), { stage: 'task' })).toMatchObject({ role: 'task-agent', provider: 'claude', model: c.CLAUDE_NATIVE_MODEL_BY_TIER.sonnet, tier: 'sonnet', supervision: 'full' });
    expect(c.routeDispatch(profile({ estimatedLoc: 80 }), { stage: 'task' }).alternateBackend).toMatchObject({ tool: 'scripts/gemini-direct-task.mjs' });
    expect(c.routeDispatch(profile({ filesTouched: ['docs/agent/rules.md'] }), { stage: 'task', scorecards: history() })).toMatchObject({ provider: 'claude', tier: 'opus', alternateBackend: null });
  });
  it('keeps thin, unqualified history on both with full supervision', () => {
    const out = c.routeDispatch(profile(), { stage: 'task', scorecards: [record({ verifiedBy: 'other' }), record({ verifiedBy: 'other', model: 'gpt-6' })] });
    expect(out).toMatchObject({ provider: 'both', model: null, tier: null, supervision: 'full', alternateBackend: null });
    expect(out.auditTrail[0].criterion).toBe('both-supervision');
  });
  it('recovers the fit model by replaying fitness and records the actual provider', () => {
    for (const provider of ['gemini', 'antigravity']) {
      const out = c.routeDispatch(profile(), { stage: 'task', scorecards: [record({ provider, model: 'gemini-flash' })] });
      expect(out).toMatchObject({ provider, model: 'gemini-flash', tier: null, supervision: 'full' });
    }
    const out = c.routeDispatch(profile(), { stage: 'task', scorecards: [record({ model: 'bad-new', outcome: 'rejected' }), record({ model: 'good-old', scoredAt: '2026-09-01T00:00:00Z' })] });
    expect(out).toMatchObject({ provider: 'codex', model: 'good-old' });
    const mixed = [record({ provider: 'gemini', model: 'flash', scoredAt: '2026-09-01T00:00:00Z' }), record({ provider: 'antigravity', model: 'flash' })];
    expect(c.routeDispatch(profile(), { stage: 'task', scorecards: mixed }).provider).toBe('antigravity');
  });
  it('sorts missing timestamps last and honors Gemini cascade priority', () => {
    const rows = [record({ model: 'missing-date', scoredAt: undefined }), record({ model: 'dated' })];
    expect(c.routeDispatch(profile(), { stage: 'task', scorecards: rows }).model).toBe('dated');
    expect(c.routeDispatch(profile(), { stage: 'task', scorecards: [...rows, record({ provider: 'gemini', model: 'flash' })] }).provider).toBe('gemini');
  });
  it('raises graduated high-risk work back to full supervision, with own audit entries first', () => {
    expect(c.routeDispatch(profile(), { stage: 'task', scorecards: history() }).supervision).toBe('spot-check');
    const out = c.routeDispatch(profile({ risk: 'high' }), { stage: 'task', scorecards: history() });
    expect(out.supervision).toBe('full');
    expect(out.spotCheck).toBeNull();
  });
  it('returns byte-identical output for repeated, shuffled, key-reordered and frozen inputs', () => {
    const rows = [...history(), record({ model: 'another', handle: 'b' }), record({ model: 'another', handle: 'a' })];
    const p = freeze(profile()), frozen = freeze(rows);
    const before = JSON.stringify(frozen);
    const first = JSON.stringify(c.routeDispatch(p, { stage: 'task', scorecards: frozen }));
    expect(JSON.stringify(c.routeDispatch(p, { stage: 'task', scorecards: frozen }))).toBe(first);
    expect(JSON.stringify(c.routeDispatch(p, { stage: 'task', scorecards: { records: [...rows].reverse() } }))).toBe(first);
    const reorder = (x) => Object.fromEntries(Object.entries(x).reverse());
    expect(JSON.stringify(c.routeDispatch(reorder(p), { stage: 'task', scorecards: rows.map(reorder) }))).toBe(first);
    expect(JSON.stringify(frozen)).toBe(before);
  });
  it('ignores free text and cyclic irrelevant metadata', () => {
    const p = profile(); p.description = 'secret'; p.title = 'arbitrary'; p.metadata = p;
    const out = c.routeDispatch(p, { stage: 'task' });
    expect(JSON.stringify(out)).toBe(JSON.stringify(c.routeDispatch(profile(), { stage: 'task' })));
    expect(JSON.stringify(out)).not.toContain('secret');
  });
  it('fails closed with one audit entry per input error', () => {
    const out = c.routeDispatch({ ...profile(), risk: 'extreme' }, { stage: 'story', kind: 'unknown' });
    expect(out).toMatchObject({ role: 'refused', provider: null, model: null, tier: null, supervision: 'full', alternateBackend: null });
    expect(out.auditTrail).toHaveLength(2);
    for (const entry of out.auditTrail) expect(Object.keys(entry)).toEqual(['criterion', 'result', 'dataConsulted', 'reasoning']);
    for (const p of [null, [], 1, 'x']) expect(c.routeDispatch(p, { stage: 'task' }).role).toBe('refused');
    for (const options of [null, {}, { stage: 'unknown' }]) expect(c.routeDispatch(profile(), options).role).toBe('refused');
  });
});

// #3801 Fork 3 — the role path's interim tier: prepare/prepare-decision/investigate keep `routed: null` and no
// provider decision, but now record the model-tier table's (#3857 `workerTierFor`) rung for their own
// authoring-role trust record. `investigate` no longer earns Opus by kind alone (no table row names it).
describe('the role path\'s interim tier (#3801 Fork 3, #3857 model-tier table)', () => {
  const roleDispatch = (kind) => ({ kind, scopePaths: ['we:backlog/1.md'] });
  it('records the model-tier table rung for prepare, prepare-decision and investigate, with routed still null', () => {
    const expectedTier = { prepare: 'sonnet', 'prepare-decision': 'opus', investigate: 'sonnet' };
    for (const kind of ['prepare', 'prepare-decision', 'investigate']) {
      const out = c.decideDispatchRoute(roleDispatch(kind));
      expect(out).toMatchObject({ outcome: 'role', role: kind, taskType: null, routed: null, model: null, tier: expectedTier[kind], supervision: 'full' });
    }
    expect(c.decideDispatchRoute(roleDispatch('prepare')).tier).toBe('sonnet');
    expect(c.decideDispatchRoute(roleDispatch('prepare-decision')).tier).toBe('opus');
    expect(c.decideDispatchRoute(roleDispatch('investigate')).tier).toBe('sonnet');
  });
  it('leaves review at tier: null — its subject key and positive control are the sibling slice', () => {
    expect(c.decideDispatchRoute(roleDispatch('review'))).toMatchObject({ outcome: 'role', role: 'review', routed: null, tier: null });
  });
});

// #3840 (Fork 5 of #3801) — the item's `deliveryAgent:` marker + required `deliveryAgentReason:` is the one override.
describe('the deliveryAgent marker override', () => {
  const dispatch = (extra = {}) => ({ kind: 'build', scopePaths: ['we:scripts/operations/example.mjs'], size: 3, ...extra });
  const trials = () => history().map((r) => ({ ...r, taskType: 'build-new-feature' }));
  it('refuses a marker with no reason, naming the field, and a reason with no marker', () => {
    expect(c.decideDispatchRoute(dispatch({ deliveryAgent: 'codex' })).refusal).toContain('deliveryAgentReason');
    expect(c.decideDispatchRoute(dispatch({ deliveryAgentReason: 'x' })).refusal).toContain('deliveryAgent:');
  });
  // #3906 — a `build` routes to Codex only once #4034 lifts the critical-work gate, and a computed spot-check
  // survives only when the promotion record names its triple (#3784 rule 6). This block tests the override
  // mechanics in that post-#4034, promoted world, so both are stated explicitly.
  const opened = (extra = {}) => {
    const deps = { scorecards: trials(), criticalWorkGate: { kinds: [], reason: 'post-#4034 (test)' }, ...extra };
    const plain = c.decideDispatchRoute(dispatch(), deps);
    return { ...deps, promotions: { promotions: [{ provider: plain.routed, model: plain.model, taskType: 'build-new-feature', level: 'spot-check', ratifiedOn: '2026-09-26', ratifiedBy: '#3784', anchor: 'we:docs/agent/platform-decisions.md#delegation-trial-record-graduation' }] } };
  };
  it('leaves routed as the criteria chose it and records the override beside it', () => {
    const plain = c.decideDispatchRoute(dispatch(), opened());
    const over = c.decideDispatchRoute(dispatch({ deliveryAgent: 'claude-restricted', deliveryAgentReason: 'pin' }), opened());
    expect(plain).toMatchObject({ routed: 'codex', supervision: 'spot-check' });
    expect(over).toMatchObject({ routed: 'codex', model: plain.model, override: { requestedVendor: 'claude-restricted', executedVendor: 'claude-restricted', reason: 'pin' } });
  });
  it('with the critical-work gate in force (today), the same build routes to Claude despite the Codex trials', () => {
    expect(c.decideDispatchRoute(dispatch(), { scorecards: trials() })).toMatchObject({ routed: 'claude', executed: 'claude', tier: 'sonnet' });
  });
  it('gives an override the supervision of its own triple: no trials means full, the routed spot-check is not inherited', () => {
    const over = c.decideDispatchRoute(dispatch({ deliveryAgent: 'claude-restricted', deliveryAgentReason: 'pin' }), opened());
    expect(over.supervision).toBe('full');
    expect(over.spotCheck).toBeNull();
  });
});

// #3784 — RULE 6 of #3690 (`#delegation-trial-record-graduation`): the promotion record. A computed
// `spot-check` survives only when its own `{provider, model, taskType}` triple is named at that level in a
// VALID promotion row; a computed `full` is never lifted; an invalid/missing/unparseable candidate fails
// CLOSED to no promotions — unlike the size-policy precedent (fails open), and it NEVER refuses the route.
// #3906 landed the critical-work gate, which by default holds `build` off Codex entirely — these tests pass
// `criticalWorkGate: { kinds: [] }` (see the `deliveryAgent` marker describe block above, which does the
// same) to reach a computed, pre-clamp Codex spot-check on a `build` dispatch.
describe('the supervision-promotion record (#3784, rule 6 of #3690)', () => {
  const gate = { kinds: [] };
  const dispatch = (extra = {}) => ({ kind: 'build', scopePaths: ['we:scripts/operations/example.mjs'], size: 3, taskKey: { storyRef: '3784', round: 1, taskId: 'build' }, ...extra });
  const trials = () => history().map((r) => ({ ...r, taskType: 'build-new-feature' }));
  const row = (extra = {}) => ({
    provider: 'codex', model: 'gpt-5', taskType: 'build-new-feature', level: 'spot-check',
    ratifiedOn: '2026-09-22', ratifiedBy: '#3690',
    anchor: 'we:docs/agent/platform-decisions.md#delegation-trial-record-graduation',
    ...extra,
  });

  it('validatePromotions accepts a well-formed row, and an empty record is ok', () => {
    expect(c.validatePromotions({ promotions: [row()] })).toEqual({ ok: true, promotions: [row()] });
    expect(c.validatePromotions({ promotions: [] })).toEqual({ ok: true, promotions: [] });
    expect(c.validatePromotions({})).toEqual({ ok: false, errors: expect.any(Array) });
  });

  it('validatePromotions refuses each missing/invalid field, by name', () => {
    const cases = [
      { extra: { provider: 'openai' }, name: 'provider' },
      { extra: { model: '' }, name: 'model' },
      { extra: { taskType: 'not-a-real-task-type' }, name: 'taskType' },
      { extra: { level: 'sometimes' }, name: 'level' },
      { extra: { ratifiedOn: '9/22/2026' }, name: 'ratifiedOn' },
      { extra: { ratifiedBy: '3690' }, name: 'ratifiedBy' },
      { extra: { ratifiedBy: undefined }, name: 'ratifiedBy' },
      { extra: { anchor: 'docs/agent/platform-decisions.md#x' }, name: 'anchor' },
      { extra: { anchor: undefined }, name: 'anchor' },
    ];
    for (const { extra, name } of cases) {
      const result = c.validatePromotions({ promotions: [row(extra)] });
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toContain(name);
    }
  });

  it('a missing, unparseable or invalid promotions candidate fails CLOSED to no promotions, never refusing the route', () => {
    for (const bad of [undefined, null, {}, { promotions: 'nope' }, { promotions: [{ provider: 'codex' }] }, 'not an object']) {
      const out = c.decideDispatchRoute(dispatch(), { scorecards: trials(), criticalWorkGate: gate, promotions: bad });
      expect(out.outcome).toBe('routed');
      expect(out.supervision).toBe('full');
      expect(out.spotCheck).toBeNull();
    }
  });

  it('a computed spot-check for a triple named at spot-check in a valid row records spot-check', () => {
    const out = c.decideDispatchRoute(dispatch(), { scorecards: trials(), criticalWorkGate: gate, promotions: { promotions: [row()] } });
    expect(out.supervision).toBe('spot-check');
    expect(out.spotCheck).not.toBeNull();
  });

  it('the same computed spot-check for a triple NOT named is clamped to full, with a reason naming the missing act', () => {
    // A row for a DIFFERENT taskType does not name this triple.
    const out = c.decideDispatchRoute(dispatch(), { scorecards: trials(), criticalWorkGate: gate, promotions: { promotions: [row({ taskType: 'doc-fix' })] } });
    expect(out.supervision).toBe('full');
    expect(out.spotCheck).toBeNull();
    const entry = out.auditTrail.find((a) => a.criterion === 'promotion-required');
    expect(entry).toBeTruthy();
    expect(entry.reasoning).toContain('no ratified promotion act');
  });

  it('a computed full for a triple that IS named still records full — a promotion never lifts a demotion', () => {
    const out = c.decideDispatchRoute(dispatch({ risk: 'high' }), { scorecards: trials(), criticalWorkGate: gate, promotions: { promotions: [row()] } });
    expect(out.supervision).toBe('full');
  });

  it('the checked-in promotions file exists, parses, and ships empty', () => {
    const raw = JSON.parse(readFileSync('scripts/lib/dispatch-supervision-promotions.json', 'utf8'));
    // #3906 — main's shared registry shape (`{version, entries}`), the one graduation-progress-report reads too.
    expect(raw).toEqual({ version: 1, entries: [] });
    expect(c.validatePromotions(raw)).toEqual({ ok: true, promotions: [] });
    expect(c.DEFAULT_PROMOTIONS).toEqual({ promotions: [] });
  });

  it('accepts an `entries` row with no `level` as a spot-check promotion, and it lifts the clamp', () => {
    const { level, ...noLevel } = row();
    expect(level).toBe('spot-check');
    expect(c.validatePromotions({ version: 1, entries: [noLevel] })).toMatchObject({ ok: true, promotions: [{ level: 'spot-check' }] });
    const out = c.decideDispatchRoute(dispatch(), { scorecards: trials(), criticalWorkGate: gate, promotions: { version: 1, entries: [noLevel] } });
    expect(out.supervision).toBe('spot-check');
  });
});

// #3839 (Fork 4 field of #3801) — a task-only `estimatedLoc:` frontmatter field, distinct from a story's
// `size:` points, that `deriveDispatchProfile` reads for a task and refuses on any other kind.
describe('the task-only estimatedLoc field', () => {
  it('routes a task on its declared estimatedLoc and records sized: true, with no size required', () => {
    const out = c.deriveDispatchProfile(card({ kind: 'task', taskType: 'doc-fix', estimatedLoc: 80, size: undefined }));
    expect(out).toMatchObject({ ready: true, sized: true, profile: { estimatedLoc: 80 } });
  });
  it('refuses a story that declares estimatedLoc, as invalid', () => {
    expect(c.deriveDispatchProfile(card({ estimatedLoc: 80 }))).toEqual({ ready: false, missing: ['estimatedLoc:task-only'] });
  });
  it('refuses a non-numeric or non-positive estimatedLoc on a task', () => {
    for (const value of ['80', 0, 1.5, -1]) {
      const out = c.deriveDispatchProfile(card({ kind: 'task', taskType: 'doc-fix', estimatedLoc: value, size: undefined }));
      expect(out.ready).toBe(false);
      expect(out.missing).toContain('estimatedLoc:invalid');
    }
  });
});

// #3843 (Fork 4 (b) of #3801) — the checked-in unsized-card size policy: `unsizedCardPolicy` / `defaultSize` /
// `fixSizeSource`, as one setting, with every fallback recorded.
describe('the size-policy setting', () => {
  it('the checked-in setting loads as block, 13, and the three-step chain', () => {
    const raw = JSON.parse(readFileSync('scripts/lib/dispatch-size-policy.json', 'utf8'));
    expect(c.validateSizePolicy(raw)).toMatchObject({
      ok: true,
      policy: { unsizedCardPolicy: 'block', defaultSize: 13, fixSizeSource: ['card-size', 'measured-diff', 'assumed'] },
    });
    expect(c.DEFAULT_SIZE_POLICY).toEqual({ unsizedCardPolicy: 'block', defaultSize: 13, fixSizeSource: ['card-size', 'measured-diff', 'assumed'] });
  });
  it('refuses `fixSizeSource: [policy]` under `unsizedCardPolicy: block` as invalid', () => {
    const result = c.validateSizePolicy({ unsizedCardPolicy: 'block', defaultSize: 13, fixSizeSource: ['policy'] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('`policy`');
    expect(c.validateSizePolicy({ unsizedCardPolicy: 'default-size', defaultSize: 13, fixSizeSource: ['policy'] }).ok).toBe(true);
  });
  it('refuses a `defaultSize` below 13, naming #3784', () => {
    const result = c.validateSizePolicy({ unsizedCardPolicy: 'default-size', defaultSize: 2, fixSizeSource: ['card-size'] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('#3784');
    expect(c.validateSizePolicy({ unsizedCardPolicy: 'default-size', defaultSize: 13, fixSizeSource: ['card-size'] }).ok).toBe(true);
  });
  it('under default-size an unsized route records the setting as the source; a sized route records the card', () => {
    const base = { kind: 'build', scopePaths: ['we:scripts/operations/example.mjs'] };
    const unsized = c.decideDispatchRoute({ ...base }, {
      sizePolicy: { unsizedCardPolicy: 'default-size', defaultSize: 13, fixSizeSource: ['card-size', 'measured-diff', 'assumed'] },
    });
    expect(unsized.outcome).toBe('routed');
    expect(unsized.sized).toBe(false);
    expect(unsized.sizeSource).toBe('defaultSize=13');
    const sized = c.decideDispatchRoute({ ...base, size: 3 });
    expect(sized.outcome).toBe('routed');
    expect(sized.sized).toBe(true);
    expect(sized.sizeSource).toBe('card');
  });
});

// #3857 — the model-tier table's rows, exercised through decideDispatchRoute (a size-13 or unsized `build` no
// longer forces Opus by size; a statute-path or dispatch-machinery-path scope, or a `security` tag, does).
describe('the model-tier table (#3857)', () => {
  it('a size-13 build and an unsized build are sonnet (today opus, pre-#3857)', () => {
    const base = { kind: 'build', scopePaths: ['we:scripts/operations/example.mjs'] };
    expect(c.decideDispatchRoute({ ...base, size: 13 }).tier).toBe('sonnet');
    expect(c.decideDispatchRoute({ ...base }).tier).toBe('sonnet'); // unsized, largest band under the default policy
  });

  it('a scope on docs/agent/platform-decisions.md is opus', () => {
    const out = c.decideDispatchRoute({ kind: 'build', scopePaths: ['we:docs/agent/platform-decisions.md'], size: 3 });
    expect(out.tier).toBe('opus');
  });

  it.each(['build', 'fix'])('normal-risk dispatch machinery %s is sonnet; high risk is opus', (kind) => {
    const dispatch = { kind, scopePaths: ['we:scripts/operations/dispatch-lane-io.mjs'], size: 3 };
    expect(c.decideDispatchRoute(dispatch).tier).toBe('sonnet');
    const high = c.decideDispatchRoute({ ...dispatch, risk: 'high' });
    expect(high.tier).toBe('opus');
    expect(high.auditTrail.some(a => a.reasoning === 'high-risk work')).toBe(true);
  });

  it('a security-tagged card is opus', () => {
    const out = c.decideDispatchRoute({ kind: 'fix', scopePaths: ['we:scripts/operations/example.mjs'], size: 3, tags: ['security'] });
    expect(out.tier).toBe('opus');
  });

  it('the output tier set is exactly sonnet and opus', () => {
    const cases = [
      { kind: 'build', scopePaths: ['we:scripts/operations/example.mjs'], size: 3 },
      { kind: 'fix', scopePaths: ['we:scripts/operations/example.mjs'], size: 3 },
      { kind: 'ci-heal', scopePaths: ['we:scripts/operations/example.mjs'], size: 3 },
      { kind: 'build', scopePaths: ['we:docs/agent/platform-decisions.md'], size: 3 },
      { kind: 'fix', scopePaths: ['we:scripts/operations/example.mjs'], size: 3, tags: ['security'] },
    ];
    for (const dispatch of cases) expect(['sonnet', 'opus']).toContain(c.decideDispatchRoute(dispatch).tier);
  });

  it("routeDispatch's tier equals workerTierFor's answer for the same dispatch", () => {
    const p = profile({ taskType: 'bugfix', filesTouched: ['scripts/lib/foo.mjs'] });
    const out = c.routeDispatch(p, { stage: 'task', kind: 'fix', tags: [] });
    expect(out.tier).toBe(workerTierFor({ kind: 'fix', taskType: 'bugfix', scopePaths: p.filesTouched, tags: [] }).tier);
  });
});

// #4034 — routeDispatch (via decideDispatchRoute) wires criticalWorkVerdict (from the dispatch's own profile)
// and criticalMissesFor (from the RAW scorecards) into selectProvider's critical-work gate, end to end. The
// bugfix envelope is 250 LOC / 4 files (`PROVEN_TASK_ENVELOPES.bugfix`); `size: 2` -> 80 LOC, comfortably inside
// it for every scope below (at most 3 files), so envelope fit is never what is under test here.
describe('#4034 — routeDispatch wires the critical-work verdict and critical-miss vetoes', () => {
  // Explicitly opens bugfix; its Codex-only probation roster keeps Claude as the recommendation.
  const openBugfix = { ...CRITICAL_WORK_GATE, openForNonCritical: { ...CRITICAL_WORK_GATE.openForNonCritical, bugfix: true } };
  const cleanCodexBugfixTrials = () => [
    record({ provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix', verifiedBy: 'claude-subagent', outcome: 'landed', scoredAt: '2026-09-10T00:00:00Z' }),
    record({ provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix', verifiedBy: 'claude-subagent', outcome: 'landed', scoredAt: '2026-09-12T00:00:00Z' }),
    record({ provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix', verifiedBy: 'claude-subagent', outcome: 'landed', scoredAt: '2026-09-15T00:00:00Z' }),
  ];
  // Real card #4081's scope: not critical (no proxy fires).
  const dispatch4081 = (extra = {}) => ({ kind: 'fix', scopePaths: ['we:scripts/operations/operator-queue.mjs'], size: 2, ...extra });
  // Real card #4124's scope: critical (never-spot-check + gate-self + daemon-drain all fire).
  const dispatch4124 = (extra = {}) => ({
    kind: 'fix',
    scopePaths: ['we:scripts/merge-ai-prs.mjs', 'we:scripts/lane-drain.mjs', 'we:scripts/readiness/drain-lock.mjs'],
    size: 2,
    ...extra,
  });

  it('#4081 (non-critical, gate open, clean codex track record) offers untried agy Claude probation, routed and executed stay claude', () => {
    const out = c.decideDispatchRoute(dispatch4081(), { scorecards: cleanCodexBugfixTrials(), criticalWorkGate: openBugfix });
    expect(out).toMatchObject({ routed: 'claude', executed: 'claude', probationWorker: { id: 'antigravity-claude', review: 'full' } });
  });

  it('#4124 (critical scope) stays on claude despite the gate being open and a clean codex track record', () => {
    const out = c.decideDispatchRoute(dispatch4124(), { scorecards: cleanCodexBugfixTrials(), criticalWorkGate: openBugfix });
    expect(out.routed).toBe('claude');
    expect(out.probationWorker).toBeNull();
  });

  it('#4081 with the DEFAULT gate offers untried agy Claude probation; conflict-resolution stays closed', () => {
    const out = c.decideDispatchRoute(dispatch4081(), { scorecards: cleanCodexBugfixTrials() });
    expect(out).toMatchObject({ routed: 'claude', probationWorker: { id: 'antigravity-claude', review: 'full' } });
    expect(out.auditTrail.find((a) => a.criterion === 'critical-work-gate').result).toBe('open-non-critical');
    const closed = c.decideDispatchRoute(dispatch4081({ cause: 'conflict' }), { scorecards: cleanCodexBugfixTrials() });
    expect(closed).toMatchObject({ taskType: 'conflict-resolution', routed: 'claude', probationWorker: null });
    expect(closed.auditTrail.find((a) => a.criterion === 'critical-work-gate').result).toBe('claude-only');
  });

  it('#4081 with a reworked codex bugfix row for the same model and NO filesTouched (legacy shape) vetoes Codex but still offers agy Claude', () => {
    const scorecards = [
      ...cleanCodexBugfixTrials(),
      record({ provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix', verifiedBy: 'claude-subagent', outcome: 'reworked', scoredAt: '2026-09-05T00:00:00Z' }),
    ];
    const out = c.decideDispatchRoute(dispatch4081(), { scorecards, criticalWorkGate: openBugfix });
    expect(out.routed).toBe('claude');
    expect(out.probationWorker).toMatchObject({ id: 'antigravity-claude' });
  });

  it('the same reworked row carrying filesTouched (a non-critical scope) AND a later clean landed row (most recent is clean) offers untried agy Claude probation', () => {
    const scorecards = [
      ...cleanCodexBugfixTrials(),
      record({
        provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix', verifiedBy: 'claude-subagent', outcome: 'reworked',
        scoredAt: '2026-09-05T00:00:00Z', filesTouched: ['scripts/codex-direct-task.mjs'],
      }),
      record({ provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix', verifiedBy: 'claude-subagent', outcome: 'landed', scoredAt: '2026-09-25T00:00:00Z' }),
    ];
    const out = c.decideDispatchRoute(dispatch4081(), { scorecards, criticalWorkGate: openBugfix });
    expect(out).toMatchObject({ routed: 'claude', probationWorker: { id: 'antigravity-claude', review: 'full' } });
  });
});
