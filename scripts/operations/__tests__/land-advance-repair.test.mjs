import { describe, it, expect } from 'vitest';
import { planLandAdvance, renderTable, OWED_ACTIONS } from '../land-advance.mjs';
import { queueFirstHold, nyDayKey, isPreToday, followUpKindFor, REPAIR_RETRY_CAP } from '../land-advance-repair.mjs';
import { ALLOWED_TOOLS_BY_KIND, allowedToolsArg } from '../land-advance-tools.mjs';
// Tonight's live fixtures (2026-09-20): #2349 red with no fixer; #2344 conflicted, bounced, its fixer finished, a stale `fixing` tag.
const now = Date.parse('2026-09-20T20:00:00Z'); // 16:00 in New York
const base = { repo: 'we', slug: 'chalbert/web-everything', baseRefName: 'main', createdAt: '2026-09-20T13:00:00Z', updatedAt: '2026-09-20T15:00:00Z', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' };
const p2349 = { ...base, number: 2349, headRefName: 'lane/ci-red-thing', labels: ['ci:failed'], mergeStateStatus: 'UNSTABLE' };
const p2344 = { ...base, number: 2344, headRefName: 'lane/graduate-3443-fix-dispatch-pr-diff-scope', labels: ['review:changes', 'review-status:fixing'], mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', updatedAt: '2026-09-20T12:00:00Z' };
const planned = (pr, extra = {}) => ({ planned: { itemNum: null, attributionKind: 'PR', attributionNum: String(pr), pr, laneRef: `lane/x-${pr}`, scope: [`we:scripts/x-${pr}.mjs`], scopeSource: 'pr-diff', isConflict: false, ...extra } });
const fixPlans = { 'we#2349': planned(2349), 'we#2344': planned(2344, { isConflict: true }), 'we#2170': planned(2170) };
const finishedFix = { id: 's-2344', name: 'fix-2344', kind: 'background', liveness: 'live-idle', verdict: 'finished-unreaped' };
const plan = (extra = {}) => planLandAdvance({ now, freeLanes: 8, cap: 5, prs: [p2349, p2344], fixPlans, ...extra });
const row = (p, n) => p.rows.find((r) => r.pr === n);
const ledger = (kind, target, n) => Array.from({ length: n }, (_, i) => ({ session: `pid:${100 + i}`, kind, target, launchedAt: '2026-09-20T10:00:00Z', deadline: '2026-09-20T12:00:00Z', evidence: { liveness: 'dead-record' } }));

describe('dispatch-ci-heal', () => {
  it('#2349: ci:failed with no fixer is owed a ci-heal, proposed through the shared fix plan', () => {
    const p = plan(), r = row(p, 2349);
    expect(r).toMatchObject({ owedAction: 'dispatch-ci-heal', dispatchable: true, fixPlan: { pr: 2349, itemNum: null, attributionKind: 'PR', scopeSource: 'pr-diff' } });
    expect(r.evidence.join(' ')).toContain('ci:failed'); expect(p.proposed.map((x) => x.subject)).toContain('we#2349');
    expect(OWED_ACTIONS).toEqual(expect.arrayContaining(['dispatch-ci-heal', 'dispatch-conflict-fix']));
  });
  it('a live ci-heal, a live fix, or a live detached wrapper means nothing is owed', () => {
    for (const extra of [{ sessions: [{ id: 'c', name: 'ci-heal-2349', kind: 'background', liveness: 'live-active', verdict: 'progressing' }] },
      { sessions: [{ id: 'f', name: 'fix-2349', kind: 'background', liveness: 'live-idle', verdict: 'stalled' }] }, { detached: ['we#2349'] }]) {
      const p = plan({ prs: [p2349], ...extra }); expect(row(p, 2349).owedAction).toBe('none'); expect(p.proposed).toHaveLength(0);
    }
  });
  it('a finished session with a lingering process does not hide the owed ci-heal', () => {
    const p = plan({ prs: [p2349], sessions: [{ id: 'c', name: 'ci-heal-2349', kind: 'background', liveness: 'live-idle', verdict: 'finished-unreaped' }] });
    expect(row(p, 2349).owedAction).toBe('dispatch-ci-heal');
  });
  it('a spent retry cap escalates with a packet instead of dispatching, from the durable comment floor or the ledger', () => {
    for (const extra of [{ repairEvidence: { 'we#2349': { ciHealComments: REPAIR_RETRY_CAP } } }, { followUps: ledger('ci-heal', 'we#2349', REPAIR_RETRY_CAP) }]) {
      const p = plan({ prs: [p2349], ...extra }), r = row(p, 2349);
      expect(r).toMatchObject({ owedAction: 'escalate', kind: 'ci-heal-exhausted', packetId: 'ci-heal-exhausted-we-2349' });
      expect(r.packet).toContain('ci-heal-exhausted-we-2349.json'); expect(p.proposed).toHaveLength(0); expect(p.deferred).toHaveLength(0);
    }
    expect(row(plan({ prs: [p2349], repairEvidence: { 'we#2349': { ciHealComments: REPAIR_RETRY_CAP - 1 } } }), 2349).owedAction).toBe('dispatch-ci-heal');
    expect(row(plan({ prs: [p2349], retryCap: 1, repairRetryCap: 1, followUps: ledger('ci-heal', 'we#2349', 1) }), 2349).owedAction).toBe('escalate');
  });
  it('a fix agent that already stood down is terminal: escalate, never re-dispatch', () => {
    const r = row(plan({ prs: [p2349], repairEvidence: { 'we#2349': { standDownComments: 1 } } }), 2349);
    expect(r).toMatchObject({ owedAction: 'escalate', kind: 'ci-heal-exhausted' }); expect(r.evidence.join(' ')).toContain('stood down');
  });
});

describe('dispatch-conflict-fix', () => {
  it('#2344: DIRTY + review:changes + a finished fixer + a stale fixing tag is owed a conflict fix', () => {
    const p = plan({ sessions: [finishedFix] }), r = row(p, 2344);
    expect(r).toMatchObject({ owedAction: 'dispatch-conflict-fix', dispatchable: true, fixPlan: { attributionKind: 'PR', attributionNum: '2344', scopeSource: 'pr-diff', isConflict: true } });
    expect(r.evidence.join(' ')).toContain('review:changes'); expect(p.proposed.map((x) => x.subject)).toContain('we#2344');
  });
  it('an accepted PR that conflicts is fixed too, and the row names the label it leaves alone', () => {
    const accepted = { ...p2344, labels: ['review:accepted'], number: 2400 }, p = plan({ prs: [accepted], fixPlans: { 'we#2400': planned(2400, { isConflict: true }) } });
    expect(row(p, 2400)).toMatchObject({ owedAction: 'dispatch-conflict-fix', dispatchable: true }); expect(row(p, 2400).evidence.join(' ')).toContain('review:accepted');
    expect(planLandAdvance({ now, freeLanes: 3, prs: [{ ...accepted, baseRefName: 'lane/mechanical-dispatcher' }], fixPlans: {} }).rows[0].owedAction).toBe('fold-into-prototype'); // unchanged precedence
  });
  it('conflict outranks a red check, and a live fixer means nothing is owed', () => {
    const both = { ...p2344, labels: ['ci:failed', 'review:accepted'] };
    expect(row(plan({ prs: [both] }), 2344).owedAction).toBe('dispatch-conflict-fix');
    expect(row(plan({ prs: [p2344], sessions: [{ id: 'f', name: 'fix-2344', kind: 'background', liveness: 'live-active', verdict: 'progressing' }] }), 2344).owedAction).toBe('none');
  });
  it('the ledger caps conflict fixes, and a conflict marked only by `mergeable` counts', () => {
    expect(row(plan({ followUps: ledger('conflict-fix', 'we#2344', REPAIR_RETRY_CAP) }), 2344)).toMatchObject({ owedAction: 'escalate', kind: 'conflict-fix-exhausted' });
    expect(row(plan({ prs: [{ ...p2344, mergeStateStatus: 'UNKNOWN' }] }), 2344).owedAction).toBe('dispatch-conflict-fix');
    expect(row(plan({ prs: [{ ...p2344, mergeStateStatus: 'UNKNOWN', mergeable: 'MERGEABLE', labels: [] }] }), 2344).owedAction).toBe('none');
  });
  it('a hard refusal is an escalation packet, not a silent deferral and not an operator row', () => {
    for (const [plans, why] of [[{ 'we#2344': { refusal: { kind: 'no-scope', why: 'no fence' } } }, 'no fence'], [{}, 'fix planner evidence unavailable']]) {
      const p = plan({ prs: [p2344], fixPlans: plans }), r = row(p, 2344);
      expect(r).toMatchObject({ owedAction: 'escalate', kind: 'conflict-fix-refused', packetId: 'conflict-fix-refused-we-2344' }); expect(r.evidence.join(' ')).toContain(why);
      expect(p.proposed).toHaveLength(0); expect(p.deferred).toHaveLength(0);
    }
    const other = { ...p2349, repo: 'plateau-app', slug: 'chalbert/plateau-app' };
    expect(row(plan({ prs: [other], fixPlans: { 'plateau-app#2349': { refusal: { kind: 'unsupported-repo', why: 'we only' } } } }), 2349)).toMatchObject({ owedAction: 'escalate', kind: 'ci-heal-refused' });
  });
  it('an ambiguous session identity stays a named deferral (it may clear next pass)', () => {
    const twin = { ...p2349, repo: 'frontierui', slug: 'chalbert/frontierui' }, p = plan({ prs: [p2349, twin], sessions: [{ id: 'f', name: 'fix-2349', kind: 'background', liveness: 'live-active', verdict: 'progressing' }] });
    expect(p.rows.find((r) => r.subject === 'we#2349')).toMatchObject({ owedAction: 'dispatch-ci-heal', dispatchable: false, refusal: { kind: 'ambiguous' } });
    expect(p.proposed).toHaveLength(0); expect(p.deferred.map((r) => r.reason)).toEqual(['ambiguous', 'ambiguous']);
  });
});

describe('capacity and the pr-queue-first hold', () => {
  const oldPr = { ...base, number: 2170, headRefName: 'lane/old', labels: ['review:changes'], createdAt: '2026-09-12T13:00:00Z', updatedAt: '2026-09-20T19:00:00Z' };
  it('capacity defers with a named reason, and a draft PR is named too', () => {
    const p = plan({ freeLanes: 0 }); expect(p.proposed).toHaveLength(0); expect(p.deferred.map((r) => r.reason)).toEqual(['capacity', 'capacity']);
    expect(plan({ prs: [{ ...p2349, isDraft: true }] }).deferred[0].reason).toBe('draft');
    expect(plan({ freeLanes: 1 }).deferred.map((r) => r.reason)).toEqual(['capacity']); // one slot, today-only PRs: no hold, plain capacity
  });
  it('the hold names the oldest PR and is inactive when every open PR is from today', () => {
    expect(queueFirstHold([p2349, oldPr], now)).toEqual({ active: true, count: 1, oldest: 'we#2170' });
    expect(plan().queueFirst).toEqual({ active: false, count: 0, oldest: null }); expect(nyDayKey(Date.parse('2026-09-21T02:00:00Z'))).toBe('2026-09-20'); // 22:00 the 20th in New York
    expect(isPreToday({ createdAt: '2026-09-20T04:30:00Z' }, now)).toBe(false); expect(isPreToday({ createdAt: '2026-09-20T03:30:00Z' }, now)).toBe(true); // midnight NY is 04:00Z
  });
  it('while held, the PR opened before today gets the free slot first and the newer repair is deferred as queue-first', () => {
    const p = plan({ prs: [p2349, oldPr], freeLanes: 1 });
    expect(p.queueFirst).toMatchObject({ active: true, oldest: 'we#2170' });
    expect(p.proposed.map((r) => r.subject)).toEqual(['we#2170']); expect(p.deferred.map((r) => [r.subject, r.reason])).toEqual([['we#2349', 'queue-first']]);
    expect(renderTable(p)).toContain('Deferred we#2349: queue-first');
  });
  it('the hold never blocks PR-closing repair: with a free slot for both, both are proposed', () => {
    const p = plan({ prs: [p2349, p2344, oldPr], freeLanes: 3 }); expect(p.proposed.map((r) => r.subject).sort()).toEqual(['we#2170', 'we#2344', 'we#2349']); expect(p.deferred).toHaveLength(0);
  });
});

describe('the repair rows are deterministic, scoped and never operator work', () => {
  it('the same evidence gives the identical plan', () => {
    const inputs = () => ({ prs: [p2349, p2344], sessions: [finishedFix], followUps: ledger('ci-heal', 'we#2349', 1), repairEvidence: { 'we#2349': { ciHealComments: 1 } } });
    expect(JSON.stringify(plan(inputs()))).toBe(JSON.stringify(plan(JSON.parse(JSON.stringify(inputs())))));
  });
  it('nothing routes to the operator queue: exhausted, refused and dispatched rows are never needs-operator', () => {
    const p = plan({ prs: [p2349, { ...p2344, labels: ['review:human', 'review:changes'] }], followUps: ledger('ci-heal', 'we#2349', 3), fixPlans: {} });
    expect(p.rows.map((r) => r.owedAction).sort()).toEqual(['escalate', 'escalate']); expect(p.rows.some((r) => r.owedAction === 'needs-operator')).toBe(false);
    expect(renderTable(p)).not.toContain('needs-operator'); expect(p.rows.every((r) => r.packetId && !/operator/.test(r.kind))).toBe(true);
  });
  it('the repair kinds have their own scoped tool grant with no label-editing tool, and record the right follow-up kind', () => {
    for (const kind of ['ci-heal', 'conflict-fix']) {
      expect(ALLOWED_TOOLS_BY_KIND[kind]).toContain('Bash(git push:*)'); expect(ALLOWED_TOOLS_BY_KIND[kind]).not.toContain('Bash(gh pr edit:*)');
      expect(allowedToolsArg(kind)).toMatch(/^--allowedTools=/);
    }
    expect(['dispatch-review', 'dispatch-fix', 'dispatch-ci-heal', 'dispatch-conflict-fix'].map(followUpKindFor)).toEqual(['review', 'fix', 'ci-heal', 'conflict-fix']);
  });
});
