import { describe, it, expect } from 'vitest';
// Phase 1 deliberately imports the absent module: no implementation or substitute lives in this fixture.
import { recordSweep, owedTakeovers, resolveEscalationActorSettings } from '../escalation-actor.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { planTakeover, threadMayBeTruncated } from '../takeover-budget.mjs';
import { takeoverMarkerBody, takeoverMarkers } from '../fix-takeover.mjs';
import { LIST_COMMENTS_PAGE_SIZE } from '../pr-comments-complete.mjs';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const item = (over = {}) => ({ pr: 6023, head: HEAD, cause: 'fix-cap-exhausted', ...over });
const entry = (over = {}) => ({ head: HEAD, cause: 'fix-cap-exhausted', streak: 2, lastSweepId: 's2', ...over });
const deepFreeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

describe('recordSweep', () => {
  it('starts at one and increments the same PR, head and cause on the next sweep without mutation', () => {
    const items = deepFreeze([item()]);
    const first = deepFreeze(recordSweep({ ledger: {}, items, sweepId: 's1' }));
    expect(first).toEqual({ 6023: entry({ streak: 1, lastSweepId: 's1' }) });
    const next = recordSweep({ ledger: first, items, sweepId: 's2' });
    expect(next).toEqual({ 6023: entry() });
    expect(next).not.toBe(first);
    expect(first[6023].streak).toBe(1);
  });

  it.each([
    ['head', { head: NEXT }], ['cause', { cause: 'review-idle' }],
  ])('resets to one when the %s changes', (_, change) => {
    expect(recordSweep({ ledger: { 6023: entry() }, items: [item(change)], sweepId: 's3' }))
      .toEqual({ 6023: entry({ ...change, streak: 1, lastSweepId: 's3' }) });
  });

  it('drops absent PRs and restarts an escalation after a missing sweep', () => {
    const empty = recordSweep({ ledger: { 6023: entry() }, items: [], sweepId: 's3' });
    expect(empty).toEqual({});
    expect(recordSweep({ ledger: empty, items: [item()], sweepId: 's4' }))
      .toEqual({ 6023: entry({ streak: 1, lastSweepId: 's4' }) });
  });

  it('tracks PRs independently and drops only those absent from the new sweep', () => {
    expect(recordSweep({ ledger: { 6023: entry(), 6024: entry() },
      items: [item(), item({ pr: 6025 })], sweepId: 's3' }))
      .toEqual({ 6023: entry({ streak: 3, lastSweepId: 's3' }), 6025: entry({ streak: 1, lastSweepId: 's3' }) });
  });

  it('replaying the same sweepId is idempotent', () => {
    const ledger = deepFreeze({ 6023: entry() });
    expect(recordSweep({ ledger, items: [item()], sweepId: 's2' })).toEqual(ledger);
  });

  it.each(['pr', 'head', 'cause'])('ignores unknown state with missing %s, including an already tracked PR', key => {
    for (const value of [undefined, null, '']) {
      expect(recordSweep({ ledger: { 6023: entry() }, items: [item({ [key]: value })], sweepId: 's3' })).toEqual({});
    }
  });

  it.each([undefined, null, false, 7, 'corrupt', []])('treats corrupt/non-object ledger %j as empty', ledger => {
    expect(recordSweep({ ledger, items: [item()], sweepId: 's1' }))
      .toEqual({ 6023: entry({ streak: 1, lastSweepId: 's1' }) });
  });
});

describe('owedTakeovers', () => {
  it('defaults to two consecutive sweeps and emits only the contracted fields without mutation', () => {
    const ledger = deepFreeze({ 6023: entry(), 6024: entry({ streak: 1 }), 6025: entry({ streak: 3 }) });
    expect(owedTakeovers({ ledger, takeoverCountsByHead: {}, cap: 1 }))
      .toEqual([item({ streak: 2 }), item({ pr: 6025, streak: 3 })]);
    expect(ledger[6023]).toEqual(entry());
  });

  it('honors a configured threshold, including equality', () => {
    expect(owedTakeovers({ ledger: { 6023: entry({ streak: 3 }) }, threshold: 3, takeoverCountsByHead: {}, cap: 1 }))
      .toEqual([item({ streak: 3 })]);
    expect(owedTakeovers({ ledger: { 6023: entry() }, threshold: 3, takeoverCountsByHead: {}, cap: 1 })).toEqual([]);
  });

  it('counts takeovers by PR AND head, excluding counts equal to or above the cap', () => {
    const ledger = deepFreeze({ 6023: entry() });
    for (const count of [1, 2, 1000000]) {
      expect(owedTakeovers({ ledger, takeoverCountsByHead: { [`6023@${HEAD}`]: count }, cap: 1 })).toEqual([]);
    }
    expect(owedTakeovers({ ledger, takeoverCountsByHead: { [`6023@${NEXT}`]: 9, [`6024@${HEAD}`]: 9 }, cap: 1 }))
      .toEqual([item({ streak: 2 })]);
    expect(owedTakeovers({ ledger, takeoverCountsByHead: { [`6023@${HEAD}`]: 1 }, cap: 2 }))
      .toEqual([item({ streak: 2 })]);
  });

  it.each([undefined, null, NaN, Infinity, -Infinity, -1, 0.5, '1', false, 0])
    ('fails closed for unusable or zero cap %j', cap => {
      expect(owedTakeovers({ ledger: { 6023: entry({ streak: 1000000 }) }, takeoverCountsByHead: {}, cap })).toEqual([]);
    });
});

describe('resolveEscalationActorSettings', () => {
  const defaults = { enabled: true, threshold: 2, takeoverCapPerHead: 1 };
  const resolve = (env = {}, actor = {}) => resolveEscalationActorSettings({ env,
    readSettings: () => ({ escalation: { actor } }) });
  const provenance = (result, pattern) => {
    for (const key of Object.keys(defaults)) expect(String(result.sources[key])).toMatch(pattern);
  };

  it('defaults to enabled, two sweeps and one takeover per head, with provenance', () => {
    const result = resolve();
    expect(result).toMatchObject(defaults);
    provenance(result, /standard|default/i);
  });

  it('reads escalation.actor settings and names their source', () => {
    const result = resolve({}, { enabled: false, threshold: 4, takeoverCapPerHead: 0 });
    expect(result).toMatchObject({ enabled: false, threshold: 4, takeoverCapPerHead: 0 });
    provenance(result, /settings|tool/i);
  });

  it('environment overrides settings, including explicit false and zero', () => {
    const result = resolve({ WE_ESCALATION_ACTOR_ENABLED: 'false', WE_ESCALATION_ACTOR_THRESHOLD: '3',
      WE_ESCALATION_ACTOR_TAKEOVER_CAP: '0' }, { enabled: true, threshold: 7, takeoverCapPerHead: 5 });
    expect(result).toMatchObject({ enabled: false, threshold: 3, takeoverCapPerHead: 0 });
    provenance(result, /env/i);
  });

  it.each([
    ['enabled', 'WE_ESCALATION_ACTOR_ENABLED', 'perhaps'],
    ['threshold', 'WE_ESCALATION_ACTOR_THRESHOLD', '0'],
    ['threshold', 'WE_ESCALATION_ACTOR_THRESHOLD', '-1'],
    ['threshold', 'WE_ESCALATION_ACTOR_THRESHOLD', '1.5'],
    ['threshold', 'WE_ESCALATION_ACTOR_THRESHOLD', 'Infinity'],
    ['takeoverCapPerHead', 'WE_ESCALATION_ACTOR_TAKEOVER_CAP', '-1'],
    ['takeoverCapPerHead', 'WE_ESCALATION_ACTOR_TAKEOVER_CAP', '1.5'],
    ['takeoverCapPerHead', 'WE_ESCALATION_ACTOR_TAKEOVER_CAP', 'Infinity'],
  ])('invalid env %s=%s (%s) disables the actor and names the invalid source', (key, variable, value) => {
    const result = resolve({ [variable]: value }, { enabled: false, threshold: 8, takeoverCapPerHead: 8 });
    expect(result.enabled).toBe(false);
    if (key !== 'enabled') expect(result[key]).toBe(0);
    expect(String(result.sources[key])).toMatch(/invalid/i);
    expect(String(result.sources[key])).toMatch(/env|WE_ESCALATION_ACTOR/i);
  });

  it.each([['enabled', 'perhaps'], ['threshold', 0], ['threshold', 1.5], ['takeoverCapPerHead', -1], ['takeoverCapPerHead', Infinity]])
    ('invalid settings %s=%j disables the actor with provenance', (key, value) => {
      const result = resolve({}, { [key]: value });
      expect(result.enabled).toBe(false);
      if (key !== 'enabled') expect(result[key]).toBe(0);
      expect(String(result.sources[key])).toMatch(/invalid/i);
      expect(String(result.sources[key])).toMatch(/settings|tool/i);
    });

  it.each([
    ['enabled', 'WE_ESCALATION_ACTOR_ENABLED', 'perhaps'],
    ['threshold', 'WE_ESCALATION_ACTOR_THRESHOLD', 'bad'],
    ['takeoverCapPerHead', 'WE_ESCALATION_ACTOR_TAKEOVER_CAP', '-1'],
  ])('audit: invalid higher-layer %s cannot grant an actor over a valid lower layer', (key, variable, value) => {
    for (const enabled of [false, true]) {
      const result = resolve({ [variable]: value }, { enabled, threshold: 3, takeoverCapPerHead: 2 });
      expect(result.enabled).toBe(false);
      expect(result.sources[key]).toMatch(/env.*invalid/);
      expect(result.sources.enabled).toMatch(/invalid/);
    }
  });

  it('audit: invalid tool threshold disables a valid platform actor even when env explicitly enables it', () => {
    const result = resolveEscalationActorSettings({ env: { WE_ESCALATION_ACTOR_ENABLED: 'true' },
      readPlatform: () => ({ enabled: true, threshold: 3, takeoverCapPerHead: 2 }),
      readSettings: () => ({ escalation: { actor: { threshold: 'bad' } } }) });
    expect(result.enabled).toBe(false);
    expect(result.sources.threshold).toMatch(/tool.*invalid/);
    expect(result.sources.enabled).toMatch(/tool.*invalid/);
  });

  it.each([
    ['both readers', true, true], ['tool reader', true, false], ['platform reader', false, true],
  ])('audit: %s throwing disables the actor despite valid settings elsewhere', (_name, toolFails, platformFails) => {
    const actor = { enabled: true, threshold: 2, takeoverCapPerHead: 1 };
    const result = resolveEscalationActorSettings({ env: { WE_ESCALATION_ACTOR_ENABLED: 'true' },
      readSettings: () => { if (toolFails) throw new Error('tool unreadable'); return { escalation: { actor } }; },
      readPlatform: () => { if (platformFails) throw new Error('platform unreadable'); return actor; } });
    expect(result.enabled).toBe(false);
    if (toolFails) expect(result.sources.enabled).toMatch(/tool.*read.*fail/);
    if (platformFails) expect(result.sources.enabled).toMatch(/platform.*read.*fail/);
  });

  it.each([null, [], 'unreadable', 42])('audit: unreadable tool settings %j cannot enable the actor', value => {
    const result = resolveEscalationActorSettings({ env: {}, readSettings: () => value, readPlatform: () => undefined });
    expect(result.enabled).toBe(false);
    expect(result.sources.enabled).toMatch(/tool.*read.*fail/);
  });
});

describe('planReconcile escalation takeovers (R392(1))', () => {
  const fixerLadder = { policy: { rungs: [
    { id: 'resend', at: 1, action: 'dispatch', provider: 'claude' },
    { id: 'stronger-model', at: 2, action: 'dispatch', provider: 'claude', taskType: 'ruling-escalation-stronger' },
  ] }, routes: { resend: { provider: 'claude', model: 'sonnet' },
    'stronger-model': { provider: 'claude', model: 'opus', effort: 'high' } } };
  const finding = (head = HEAD) => ({ author: { login: 'web-everything' }, createdAt: '2026-11-02T10:00:00Z',
    body: `🔁 review — changes requested\n\nRecorded by auto-policy\n\nruled \`block\` for head \`${head}\`.\n\n### Findings\n\n**correctness/logic** (1)\n- \`src/a.mjs:1\` — repair the open defect` });
  const pr = (over = {}) => ({ number: 6023, state: 'OPEN', isDraft: false, baseRefName: 'main',
    headRefName: 'lane/6023-repair', headRefOid: HEAD, mergeStateStatus: 'CLEAN',
    labels: [{ name: 'review:changes' }], comments: [finding()],
    statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: HEAD }], ...over });
  const plan = (over = {}, options = {}) => planReconcile({ repo: 'we', prs: [pr(over)], agents: [],
    now: Date.parse('2026-11-02T12:00:00Z'), requiredChecks: ['gate'], roundCap: 5, durableCounts: {},
    roundCapAction: 'takeover', takeoverBudget: 1, fixerLadder,
    reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false },
    escalationStreaks: [item({ streak: 2 })], ...options });
  const marker = (head = HEAD, author = { login: 'web-everything' }) => ({ author,
    createdAt: '2026-11-02T10:00:00Z', body: takeoverMarkerBody({ pr: 6023, head, attempts: 0, cap: 5, rung: { id: 'stronger-model' } }) });
  const takeovers = result => result.dispatch.filter(row => row.kind === 'fix' && row.mode === 'takeover');

  it('dispatches exactly one takeover before ordinary rounds are spent, using the existing takeover rung and route', () => {
    const expected = planTakeover({ pr: pr(), roundCapAction: 'takeover', takeoverBudget: 1, fixerLadder });
    expect(expected.ok).toBe(true);
    const result = plan({}, { escalationStreaks: [item({ streak: 2 }), item({ streak: 2 })] });
    expect(result.dispatch).toHaveLength(1);
    expect(result.dispatch[0]).toMatchObject({ prNumber: 6023, kind: 'fix', mode: 'takeover',
      findings: 1,
      takeover: { rung: expected.rung, route: expected.route, n: expected.n, budget: expected.budget } });
  });

  it('omitting escalationStreaks preserves the ordinary fix pass', () => {
    // An ordinary fix requires a real finding; an empty thread is correctly refused as no-findings.
    const comments = [{ author: { login: 'web-everything' }, createdAt: '2026-11-02T10:00:00Z',
      body: `🔁 review — changes requested\n\nRecorded by auto-policy\n\nruled \`block\` on head \`${HEAD}\`.\n\n### Findings\n\n**correctness/logic** (1)\n- \`src/a.mjs:1\` — repair the open defect` }];
    const result = plan({ comments }, { escalationStreaks: undefined });
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 6023, kind: 'fix' })]);
    expect(takeovers(result)).toEqual([]);
  });

  it('a trusted same-head marker consumes the cap and prevents another takeover', () => {
    const comments = [finding(), marker()];
    expect(takeoverMarkers(comments)).toHaveLength(1);
    expect(takeovers(plan({ comments }))).toEqual([]);
  });

  it('a forged same-head marker does not consume the trusted takeover allowance', () => {
    const comments = [finding(), marker(HEAD, { login: 'mallory' })];
    expect(takeoverMarkers(comments)).toEqual([]);
    expect(takeovers(plan({ comments }))).toHaveLength(1);
  });

  it('audit: an empty-thread review:human escalation falls through to the ordinary review flow', () => {
    const over = { labels: [{ name: 'review:human' }], comments: [] };
    const result = plan(over);
    expect(takeovers(result)).toEqual([]);
    expect(result).toEqual(plan(over, { escalationStreaks: undefined }));
  });

  it.each(['review:accepted', 'ready-to-merge'])('audit: %s with historical defects is never owed an escalation takeover', label => {
    const over = { labels: [{ name: label }] };
    const result = plan(over);
    expect(takeovers(result)).toEqual([]);
    expect(result.dispatch).toEqual([]);
    expect(result).toEqual(plan(over, { escalationStreaks: undefined }));
  });

  it('audit: an empty bounced thread cannot manufacture an escalation finding', () => {
    const result = plan({ comments: [] });
    expect(takeovers(result)).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'no-findings', findings: 0 }));
  });

  it('audit: an escalated card batch still routes to extraction rather than an in-place takeover', () => {
    const over = { headRefName: 'lane/card-batch-prevention-4-r1' };
    const result = plan(over, { cardBatchExtract: true });
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'card-batch-extract', prNumber: 6023 })]);
    expect(takeovers(result)).toEqual([]);
    expect(result).toEqual(plan(over, { cardBatchExtract: true, escalationStreaks: undefined }));
  });

  it('audit: a defect on an older head cannot authorize a current-head escalation takeover', () => {
    expect(takeovers(plan({ comments: [finding(NEXT)] }))).toEqual([]);
  });

  it('ignores an escalation for a stale head', () => {
    expect(takeovers(plan({}, { escalationStreaks: [item({ head: NEXT, streak: 9 })] }))).toEqual([]);
  });

  it.each(['CLOSED', 'MERGED'])('does not take over a %s PR', state => {
    expect(takeovers(plan({ state }))).toEqual([]);
  });

  it.each([undefined, null, {}])('missing/unreadable comments %j fail closed with an explicit refusal reason', comments => {
    const result = plan({ comments });
    expect(takeovers(result)).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ prNumber: 6023,
      why: expect.stringMatching(/comment|thread|unknown|incomplete|unreadable/i) }));
  });

  it('a potentially truncated thread fails closed with an explicit refusal reason', () => {
    const over = { comments: Array.from({ length: LIST_COMMENTS_PAGE_SIZE }, () => ({ body: 'ordinary comment' })) };
    expect(threadMayBeTruncated(pr(over))).toBe(true);
    const result = plan(over);
    expect(takeovers(result)).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ prNumber: 6023,
      why: expect.stringMatching(/truncat|incomplete|thread/i) }));
  });
});
