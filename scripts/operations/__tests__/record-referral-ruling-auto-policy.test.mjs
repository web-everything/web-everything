/** #5963: synthetic #4715 regression through the sanctioned reader, operation and sinks. */
import { describe, expect, it } from 'vitest';
import { buildOperatorRulingComment, mandatoryReferralReviewer, mandatoryReferralState, normalizeFinding,
  referralFindingKey, renderReferralRecord, REFERRAL_CARRY_REASON } from '../../lib/jury-core.mjs';
import { recordReferralRulingOperation } from '../record-referral-ruling.mjs';
import { createRecordReferralRulingReader, createRecordReferralRulingSinks } from '../record-referral-ruling-io.mjs';
import { advanceWhileRunning, startRun } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { createRegistry } from '../registry.mjs';

const repo = 'o/r', pr = 4715, head = 'a'.repeat(40), oldHead = 'b'.repeat(40);
const body = '<!-- authored-by-actor: author -->';
const now = '2026-10-13T10:00:00Z';
const card = 'we:backlog/123-follow-up.md';
const comment = (body, login = 'web-everything') => ({ body, author: { login } });
function record({ runId = 'review-pr-1', h = head, file = 'scripts/x.mjs', line = 20,
  summary = 'protected list misses edits', reviewerResult, ...rest } = {}) {
  const seat = 'judgeCorrectnessAdvisory';
  const finding = normalizeFinding({ file, line, summary, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' });
  const key = referralFindingKey(seat, finding), reviewer = mandatoryReferralReviewer(runId);
  return { version: 1, repo, pr, head: h, runId, reviewer, authorBody: body, attempted: true,
    referrals: [{ key, seat, original: finding, finding }],
    rulings: reviewerResult ? [{ id: `${runId}:0`, key, reviewerId: reviewer.id, lens: 'correctness',
      result: reviewerResult, rationale: 'checked', evidence: ['diff'] }] : [], ...rest };
}
function ruling(rec, result = 'not-real', extra = {}) {
  return comment(buildOperatorRulingComment({ version: 1, repo: rec.repo, pr: rec.pr, head: rec.head,
    actor: 'chalbert', channel: 'chat', reason: 'Operator decision', at: now, clearerId: 'operator-session',
    rulings: [{ runId: rec.runId, key: rec.referrals[0].key, result, ...(result === 'card' ? { card } : {}) }], ...extra }));
}
function harness(initial, { changedLines, compare = { status: 'identical', files: [] }, fileExists = true } = {}) {
  const comments = [...initial], trace = [], warnings = [];
  let liveHead = head;
  const readJson = (args) => args[0] === 'pr' ? { headRefOid: liveHead, body, comments }
    : args[1].includes('/compare/') ? (compare instanceof Error ? (() => { throw compare; })() : compare) : { type: fileExists ? 'file' : 'dir' };
  const reader = createRecordReferralRulingReader({ readJson, changedLines, assertFresh: () => {},
    readable: () => true, now: () => now, env: { CLAUDE_SESSION_ID: 'auto-session' } });
  const operation = recordReferralRulingOperation({ readRulingContext: reader });
  const inputFor = (extra) => ({ repo, pr, finding: 'all-open', actor: 'auto-policy', ruling: 'block', channel: 'policy', reason: 'Policy', ...extra });
  const sinks = createRecordReferralRulingSinks({ readJson, changedLines, readable: () => true,
    appendEvents: async (events) => trace.push(['ledger', events]),
    post: (_repo, _pr, text) => { trace.push(['post', text]); comments.push(comment(text)); },
    warn: (text) => warnings.push(text), readPr: () => ({ headRefOid: liveHead, labels: [] }),
    runSetLabel: () => { trace.push(['label']); return '{"ok":true}'; },
    setLabels: () => trace.push(['label']) });
  const step = (name) => operation.steps.find((s) => s.name === name).step;
  const plan = (extra = {}) => {
    const input = inputFor(extra);
    const read = step('read').fn({ input });
    const verdict = step('plan').fn({ input, findings: { read } });
    return { verdict, effects: step('write').effects({ input, verdict }) };
  };
  const execute = async ({ effects }) => { for (const effect of effects) await sinks[effect.type](effect.payload); };
  const enginePlan = () => {
    const registry = createRegistry(); registry.register(operation);
    return advanceWhileRunning(startRun({ id: 'policy-regression', op: operation.name, input: inputFor(), registry }), { registry });
  };
  const engineExecute = (run) => {
    const store = createMemoryRunStore(); store.write(run);
    return applyPendingEffects(run, { sinks, store });
  };
  return { comments, trace, warnings, plan, execute, enginePlan, engineExecute, moveHead: () => { liveHead = oldHead; } };
}
const thread = (...records) => records.map((r) => comment(renderReferralRecord(r)));

describe('automatic policy respects authenticated operator decisions', () => {
  it.each(['block', 'card', 'not-real'])('skips exact and equivalent fresh-run %s rulings (#4715 finding 4)', async (result) => {
    const source = record(), fresh = record({ runId: 'review-pr-fresh', line: 21 });
    const h = harness([...thread(source), ruling(source, result), ...thread(fresh)]);
    const planned = h.plan();
    expect(planned.verdict.skipped).toHaveLength(2);
    expect(planned.verdict.skipped.find((s) => s.runId === fresh.runId)).toMatchObject({ repo, pr, head, runId: fresh.runId,
      key: fresh.referrals[0].key, protectingRulings: [expect.objectContaining({ actor: 'chalbert', result,
        repo, pr, head, runId: source.runId, key: source.referrals[0].key })] });
    expect(planned.verdict).toMatchObject({ noop: true, record: null, body: null, followUp: null });
    await h.execute(planned);
    expect(h.trace).toEqual([]);
    expect(h.plan({ finding: fresh.referrals[0].key, preview: true }).effects).toEqual([]);
  });
  it('preserves open selector numbering and posts only the eligible finding in a mixed selection', async () => {
    const source = record(), fresh = record({ runId: 'review-pr-fresh', line: 21 });
    const other = record({ runId: 'review-pr-other', summary: 'unrelated claim' });
    const h = harness([...thread(source), ruling(source), ...thread(fresh, other)]);
    expect(h.plan({ finding: '1' }).verdict.noop).toBe(true);
    const planned = h.plan({ finding: '1,2' });
    const preview = h.plan({ finding: '1,2', preview: true });
    expect(preview.verdict).toEqual(planned.verdict);
    expect(preview.effects).toEqual([]);
    expect(planned.verdict.record.rulings).toEqual([{ runId: other.runId, key: other.referrals[0].key, result: 'block' }]);
    expect(planned.verdict.skipped).toHaveLength(1);
    await h.execute(planned);
    expect(h.trace.map(([kind]) => kind)).toEqual(['post', 'ledger']);
    expect(h.warnings.join('\n')).toContain(fresh.runId);
    const state = mandatoryReferralState(h.comments, { repo, pr, head, body, cardReadable: () => true });
    expect(state.blocked).toContain(other.referrals[0].key);
    expect(state.blocked).not.toContain(source.referrals[0].key);
    expect(state.pending).toContain(fresh.referrals[0].key); // A skip grants no gate clearance.
  });
  it('refuses explicit automatic supersession and preserves the operator path', () => {
    const source = record(), h = harness([...thread(source), ruling(source)]);
    expect(() => h.plan({ supersedes: 'any' })).toThrow(/auto-policy.*supersed/i);
    const protecting = h.plan().verdict.skipped[0].protectingRulings[0].id;
    expect(h.plan({ actor: 'chalbert', supersedes: protecting }).verdict.record.rulings[0].supersedes).toEqual([protecting]);
    expect(() => h.plan({ ruling: 'not-real' })).toThrow(/only rule/);
  });
  it.each(['auto-policy', 'reviewer'])('does not treat %s as operator protection', (actor) => {
    const source = record({ reviewerResult: actor === 'reviewer' ? 'block' : undefined });
    const comments = [...thread(source), ...(actor === 'auto-policy' ? [ruling(source, 'block', { actor })] : [])];
    expect(harness(comments).plan().verdict.record.rulings).toHaveLength(1);
  });
  it('recognizes registered operator logins with the same case rules as authentication', () => {
    const source = record();
    expect(harness([...thread(source), ruling(source, 'not-real', { actor: 'Chalbert' })]).plan().verdict.noop).toBe(true);
  });
  it.each([{ repo: 'other/repo' }, { pr: 12 }, { summary: 'a completely unrelated claim' }])('scopes proof to subject and claim: %j', (over) => {
    const source = record(over), target = record({ runId: 'review-pr-target' });
    expect(harness([...thread(source), ruling(source), ...thread(target)]).plan({ finding: target.referrals[0].key }).verdict.record.rulings)
      .toContainEqual({ runId: target.runId, key: target.referrals[0].key, result: 'block' });
  });
  it.each(['scripts/x.mjs', 'docs/policy.md', 'config/settings.json', 'data/rows.csv'])('protects unchanged historical citations for %s', (file) => {
    for (const line of [20, null]) {
      const source = record({ h: oldHead, file, line }), target = record({ runId: 'review-pr-target', file, line });
      expect(harness([...thread(source), ruling(source), ...thread(target)]).plan().verdict.noop).toBe(true);
      const changed = new Set([20]); changed.old = new Set([20]);
      expect(harness([...thread(source), ruling(source), ...thread(target)], { changedLines: () => changed })
        .plan().verdict.record.rulings).toHaveLength(1);
    }
  });
  it('checks old and new citation windows and allows unrelated changes', () => {
    const source = record({ h: oldHead }), target = record({ runId: 'review-pr-target', line: 21 });
    const comments = [...thread(source), ruling(source), ...thread(target)];
    const oldTouch = new Set([100]); oldTouch.old = new Set([20]);
    expect(harness(comments, { changedLines: () => oldTouch }).plan().verdict.record).not.toBeNull();
    const distant = new Set([100]); distant.old = new Set([100]);
    expect(harness(comments, { changedLines: () => distant }).plan().verdict.noop).toBe(true);
  });
  it.each([
    new Error('compare unavailable'), { status: 'ahead' },
    { status: 'ahead', files: Array.from({ length: 300 }, (_, i) => ({ filename: `file${i}` })) },
    { status: 'ahead', files: [{ filename: 'scripts/x.mjs', status: 'modified', patch: '@@ -100 +100 @@' },
      ...Array.from({ length: 299 }, (_, i) => ({ filename: `file${i}` }))] },
    { status: 'ahead', files: [{ filename: 'scripts/x.mjs', status: 'modified' }] },
    { status: 'ahead', files: [{ filename: 'scripts/x.mjs', status: 'renamed', patch: '@@ -100 +100 @@' }] },
    { status: 'ahead', files: [{ filename: 'scripts/x.mjs', status: 'removed', patch: '@@ -100 +100 @@' }] },
  ])('refuses unavailable or incomplete earlier-head evidence: %j', (compare) => {
    const source = record({ h: oldHead }), target = record({ runId: 'review-pr-target' });
    expect(() => harness([...thread(source), ruling(source), ...thread(target)], { compare }).plan()).toThrow(/protection.*unknown/i);
  });
  it('resolves operator carries and refuses unbacked carries or missing source records', () => {
    const source = record({ h: oldHead }), target = record({ runId: 'review-pr-target' });
    target.carried = [{ key: target.referrals[0].key, result: 'not-real', reason: REFERRAL_CARRY_REASON,
      from: { head: oldHead, runId: source.runId, key: source.referrals[0].key } }];
    expect(harness([...thread(source), ruling(source), ...thread(target)]).plan().verdict.noop).toBe(true);
    expect(() => harness([...thread(source, target)]).plan()).toThrow(/protection.*unknown/i);
    expect(() => harness([ruling(source), ...thread(target)]).plan()).toThrow(/protection.*unknown/i);
    expect(() => harness([...thread(source), ruling(source, 'not-real', { rulings: [{ runId: 'wrong-run', key: source.referrals[0].key, result: 'not-real' }] }), ...thread(target)]).plan()).toThrow(/protection.*unknown/i);
  });
  it('requires real files at both ends even for an identical compare', () => {
    const source = record({ h: oldHead }), target = record({ runId: 'review-pr-target' });
    expect(() => harness([...thread(source), ruling(source), ...thread(target)], { fileExists: false }).plan()).toThrow(/protection.*unknown/i);
  });
  it('a proven current-head operator decision does not need an older comparison to skip', () => {
    const source = record({ h: oldHead }), target = record({ runId: 'review-pr-target' });
    const h = harness([...thread(source), ruling(source), ...thread(target), ruling(target)], { compare: new Error('unavailable') });
    expect(h.plan().verdict.noop).toBe(true);
  });
  it('never turns a reviewer-only carry into operator protection', () => {
    const source = record({ h: oldHead, reviewerResult: 'not-real' }), carried = record({ runId: 'review-pr-carried' });
    carried.carried = [{ key: carried.referrals[0].key, result: 'not-real', reason: REFERRAL_CARRY_REASON,
      from: { head: oldHead, runId: source.runId, key: source.referrals[0].key, rulingId: source.rulings[0].id } }];
    const fresh = record({ runId: 'review-pr-fresh', line: 21 });
    const planned = harness(thread(source, carried, fresh)).plan({ finding: fresh.referrals[0].key });
    expect(planned.verdict.skipped).toEqual([]);
    expect(planned.verdict.record.rulings).toEqual([{ runId: fresh.runId, key: fresh.referrals[0].key, result: 'block' }]);
  });
  it('skips an operator-backed carried block without implicitly superseding it', () => {
    const source = record({ h: oldHead }), target = record({ runId: 'review-pr-target' });
    target.carried = [{ key: target.referrals[0].key, result: 'block', reason: REFERRAL_CARRY_REASON,
      from: { head: oldHead, runId: source.runId, key: source.referrals[0].key } }];
    const planned = harness([...thread(source), ruling(source, 'block'), ...thread(target)]).plan({ finding: target.referrals[0].key });
    expect(planned.verdict).toMatchObject({ noop: true, supersedes: [], record: null });
  });
  it('refuses forged and malformed historical rulings', () => {
    const source = record({ h: oldHead }), target = record({ runId: 'review-pr-target' });
    const valid = ruling(source);
    for (const bad of [{ ...valid, author: { login: 'mallory' } }, { ...valid, body: valid.body.replace('> Operator decision', '> altered') }]) {
      expect(() => harness([...thread(source), bad, ...thread(target)]).plan()).toThrow(/malformed/i);
    }
  });
  it('refuses a malformed earlier-head referral snapshot', () => {
    const source = record({ h: oldHead }), target = record({ runId: 'review-pr-target' });
    expect(() => harness([...thread(source, { ...source, attempted: false }), ruling(source), ...thread(target)]).plan()).toThrow(/malformed/i);
  });
  it('refuses the whole stale batch before post, ledger, label or follow-up', async () => {
    const target = record(), h = harness(thread(target));
    const planned = h.plan();
    h.comments.push(ruling(target));
    await expect(h.execute(planned)).rejects.toThrow(/protection.*changed.*fresh plan/i);
    expect(h.trace).toEqual([]);
    expect(h.warnings.join('\n')).toContain(target.runId);
  });
  it('the real executor halts before the planned follow-up on a same-head late operator ruling', async () => {
    const target = record(), h = harness(thread(target));
    const run = h.enginePlan();
    expect(run.effects).toHaveLength(2);
    h.comments.push(ruling(target));
    const result = await h.engineExecute(run);
    expect(result.error.message).toMatch(/protection.*changed.*fresh plan/i);
    expect(result.applied).toEqual([]);
    expect(h.trace).toEqual([]);
    expect(h.enginePlan().effects).toEqual([]); // Fresh planning consumes the protection as a no-op.
  });
  it('refuses if historical proof disappears between planning and the final read', async () => {
    const source = record({ h: oldHead }), target = record({ runId: 'review-pr-target' });
    let available = true;
    const changed = new Set([20]); changed.old = new Set([20]);
    const h = harness([...thread(source), ruling(source), ...thread(target)], { changedLines: () => available ? changed : null });
    const planned = h.plan(); available = false;
    await expect(h.execute(planned)).rejects.toThrow(/protection.*changed/i);
    expect(h.trace).toEqual([]);
  });
  it('checks run identity and retains byte-identical automatic comment deduplication', async () => {
    const target = record(), h = harness(thread(target));
    const planned = h.plan({ sendBack: false });
    const tampered = structuredClone(planned);
    tampered.effects[0].payload.rulings[0].runId = 'wrong-run';
    await expect(h.execute(tampered)).rejects.toThrow(/protection.*unknown/i);
    expect(h.trace).toEqual([]);
    await h.execute(planned);
    await h.execute(planned);
    expect(h.trace.filter(([kind]) => kind === 'post')).toHaveLength(1);
  });
  it('retains moved-head refusal and the ordinary unprotected block path', async () => {
    const target = record(), h = harness(thread(target));
    await h.execute(h.plan());
    expect(h.trace.map(([kind]) => kind)).toEqual(['post', 'ledger', 'label', 'ledger']);
    const moved = harness(thread(target)), planned = moved.plan(); moved.moveHead();
    await expect(moved.execute(planned)).rejects.toThrow(/head moved/);
    expect(moved.trace).toEqual([]);
  });
});
