/**
 * @file scripts/conveyor/__tests__/infra-stall-not-a-miss.test.mjs — an infrastructure stall is not a fixer miss.
 * @description Live 2026-10-04, PR #3890: the fixer `fix-3890` waited on verify requests the verify daemon never
 *   ran (ENOTDIR on the lane-pool root, fixed by PR #3902), reported `blocked-on-infra`, and ran `fix-end` on an
 *   unchanged head. The fixer-escalation ladder (PR #3889) counts every fix-end on a sent-back head as one more
 *   miss, so an outage climbed the ladder (resend → stronger model → operator) for work no fixer ever got to try.
 *   Also: the 15-minute retry cool-off after a `blocked-on-infra` report was a hard-coded constant.
 *   Proves:
 *   1. `fix-end` after a `blocked-on-infra` completion stamps the fix-end comment with a durable infra mark;
 *   2. the ladder does not count a marked fix-end (opt back in with WE_FIXER_LADDER_COUNT_INFRA_STALLS=1);
 *   3. the retry cool-off is configurable (WE_INFRA_RETRY_COOLOFF_MINUTES), default unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fixBegin, fixEnd, buildFixEndComment, FIX_END_MARKER, FIX_END_INFRA_STALL_MARK,
} from '../fix-procedure.mjs';
import { enrichPrsWithIgnoredRulings } from '../reconcile-pass.mjs';
import {
  planReconcile, markSelfReportedDone, resolveInfraRetryCooloffMs, INFRA_RETRY_COOLOFF_MS,
} from '../reconcile-core.mjs';
import {
  renderRulingNotAddressed, fixerReturnsAfter, FIX_END_INFRA_STALL_PREFIX, resolveCountInfraStalls,
} from '../../lib/ruling-ledger.mjs';
import { H1, H2, ignoredRulingThread, iso } from './ruling-fixtures.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'infra-stall-test-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const T0 = Date.parse('2026-10-04T13:30:00.000Z');
const SHA = '0d1f5972d59ecdfbfcd76f06245a215337fde9b5';
const fakeGh = async (args) => (args[1] === 'view'
  ? JSON.stringify({ headRefName: 'lane/verify-scanners', headRefOid: SHA, isDraft: false, state: 'OPEN', labels: [] }) : '');
const capture = () => {
  const bodies = [];
  return { bodies, ensureLabel() {}, setLabels() {}, postComment: (r, p, body) => bodies.push(body) };
};
const rec = (over = {}) => ({
  v: 1, session: 'fix-3890', kind: 'fix', pr: '3890', status: 'done', outcome: 'blocked-on-infra',
  sessionId: 'ac5295cf-fd6c-4c1a-bc5f-1e79730e2156', updatedAt: '2026-10-04T16:43:49.990Z', ...over,
});

describe('fix-end stamps an infra stall (the #3890 shape)', () => {
  const run = async (record, sessionId = 'ac5295cf-fd6c-4c1a-bc5f-1e79730e2156') => {
    const b = await fixBegin({ repo: 'we', pr: 3890, who: 'fix-3890', why: 'address review', sessionId, gh: fakeGh, labels: capture(), lockRoot: root, nowMs: T0 });
    expect(b.ok).toBe(true);
    const labels = capture();
    const end = await fixEnd({ repo: 'we', pr: 3890, who: 'fix-3890', sessionId, gh: fakeGh, labels, lockRoot: root, readCompletion: () => record });
    return { end, body: labels.bodies.find((x) => x.startsWith(FIX_END_MARKER)) };
  };
  it('a blocked-on-infra completion from this session marks the fix-end comment and says it is not a fixer miss', async () => {
    const { end, body } = await run(rec());
    expect(end).toMatchObject({ ok: true, infraStall: true });
    expect(body).toContain(FIX_END_INFRA_STALL_MARK);
    expect(body).toMatch(/infrastructure/i);
  });
  it('any other outcome, a foreign session\'s record, or no record leaves the fix-end comment unmarked', async () => {
    for (const record of [rec({ outcome: 'gate-red' }), rec({ sessionId: 'someone-else' }), null, rec({ status: 'started' })]) {
      rmSync(root, { recursive: true, force: true }); root = mkdtempSync(join(tmpdir(), 'infra-stall-test-'));
      const { end, body } = await run(record);
      expect(end.infraStall).toBe(false);
      expect(body).not.toContain(FIX_END_INFRA_STALL_MARK);
    }
  });
  it('a record older than this claim (an earlier round) is not this turn\'s outcome', async () => {
    const { end } = await run(rec({ sessionId: null, updatedAt: '2026-10-04T12:00:00.000Z' }));
    expect(end.infraStall).toBe(false);
  });
  it('the ladder\'s prefix is the same mark fix-end writes (single source pinned)', () => {
    expect(FIX_END_INFRA_STALL_MARK.startsWith(FIX_END_INFRA_STALL_PREFIX)).toBe(true);
    expect(buildFixEndComment({ who: 'fix-1', headSha: SHA, infraStall: true })).toContain(FIX_END_INFRA_STALL_MARK);
    expect(buildFixEndComment({ who: 'fix-1', headSha: SHA })).not.toContain(FIX_END_INFRA_STALL_MARK);
  });
});

describe('the fixer-escalation ladder does not count an infra stall as a miss', () => {
  const trusted = (body, min) => ({ body, createdAt: iso(min), author: { login: 'web-everything' } });
  const basePr = (comments) => ({ number: 3794, state: 'OPEN', headRefName: 'lane/xcs4nce-policy', headRefOid: H2,
    labels: [{ name: 'review:human' }, { name: 'advisory:changes' }], mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], comments });
  const rung = (comments, opts) => {
    const [pr] = enrichPrsWithIgnoredRulings([basePr(comments)], opts);
    const p = planReconcile({ repo: 'we', prs: [pr], agents: [], now: Date.parse('2026-10-04T12:00:00Z'), requiredChecks: ['test'] });
    return p.dispatch.map((d) => d.rulingNotAddressed?.rung?.id);
  };
  const notice = trusted(renderRulingNotAddressed({ head: H2, matches: [{ finding: { file: 'policy/pointer.md', line: 12, summary: 's' }, ruling: 'block: x', priorHead: H1, misses: 1 }] }), 21);
  const infraEnd = (min) => trusted(buildFixEndComment({ who: 'fix-3794', headSha: H2, infraStall: true }), min);

  it('an infra-stalled fix-end leaves the PR on the same rung (resend again, not the stronger model)', () => {
    expect(rung([...ignoredRulingThread(), notice, infraEnd(30)])).toEqual(['resend']);
    expect(rung([...ignoredRulingThread(), notice, infraEnd(30), infraEnd(50)])).toEqual(['resend']);
  });
  it('control: an ordinary fix-end on the unchanged head still climbs (the #3889 rule stands)', () => {
    expect(rung([...ignoredRulingThread(), notice, trusted(`${FIX_END_MARKER}\n`, 30)])).toEqual(['stronger-model']);
  });
  it('configurable: WE_FIXER_LADDER_COUNT_INFRA_STALLS=1 counts infra stalls again', () => {
    expect(resolveCountInfraStalls({})).toBe(false);
    expect(resolveCountInfraStalls({ WE_FIXER_LADDER_COUNT_INFRA_STALLS: '1' })).toBe(true);
    expect(rung([...ignoredRulingThread(), notice, infraEnd(30)], { countInfraStalls: true })).toEqual(['stronger-model']);
    const sent = Date.parse(iso(21));
    expect(fixerReturnsAfter([infraEnd(30)], sent)).toBe(0);
    expect(fixerReturnsAfter([infraEnd(30)], sent, { countInfraStalls: true })).toBe(1);
  });
});

describe('the blocked-on-infra retry cool-off is configurable', () => {
  const agent = { name: 'fix-3890', state: 'blocked', sessionId: 'ac5295cf-fd6c-4c1a-bc5f-1e79730e2156', startedAt: Date.parse('2026-10-04T16:40:46.947Z') };
  const done = Date.parse('2026-10-04T16:43:49.990Z');
  it('defaults to 15 minutes; WE_INFRA_RETRY_COOLOFF_MINUTES overrides it; junk falls back to the default', () => {
    expect(resolveInfraRetryCooloffMs({})).toBe(INFRA_RETRY_COOLOFF_MS);
    expect(INFRA_RETRY_COOLOFF_MS).toBe(15 * 60 * 1000);
    expect(resolveInfraRetryCooloffMs({ WE_INFRA_RETRY_COOLOFF_MINUTES: '2' })).toBe(2 * 60 * 1000);
    expect(resolveInfraRetryCooloffMs({ WE_INFRA_RETRY_COOLOFF_MINUTES: 'x' })).toBe(INFRA_RETRY_COOLOFF_MS);
    expect(resolveInfraRetryCooloffMs({ WE_INFRA_RETRY_COOLOFF_MINUTES: '-3' })).toBe(INFRA_RETRY_COOLOFF_MS);
  });
  it('a shorter configured cool-off frees the session for redispatch sooner', () => {
    const at5 = done + 5 * 60 * 1000;
    expect(markSelfReportedDone([agent], () => rec(), at5)[0]).toMatchObject({ awaitingInfraCooloff: true });
    expect(markSelfReportedDone([agent], () => rec(), at5, { infraCooloffMs: 2 * 60 * 1000 })[0]).toMatchObject({ selfReportedDone: true });
  });
});
