import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMandatoryReferralsCleared, runReviewLabelCli } from '../review-set-label.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../lib/jury-core.mjs';
import { newRunRecord, writeRun } from '../operations/run-store.mjs';
import { DAEMON_ENTRY_MODULES } from '../lib/daemon-boot-smoke.mjs';
import { BOOKKEEPING_MARKERS } from '../conveyor/reconcile-core.mjs';
import { REARM_COMMENT_MARKER } from '../conveyor/rearm-review.mjs';

const conveyorDir = resolve(dirname(fileURLToPath(import.meta.url)), '../conveyor');
// Include direct main checks and checks using an intermediate SELF/IS_CLI variable.
const conveyorEntryModules = readdirSync(conveyorDir).filter(name => {
  if (!name.endsWith('.mjs')) return false;
  const source = readFileSync(join(conveyorDir, name), 'utf8');
  return source.includes('import.meta.url') && /process\.argv\[\s*1\s*\]/.test(source);
}).map(name => `scripts/conveyor/${name}`);

const repo = 'o/r', pr = 3481, head = '8dad651' + 'a'.repeat(33);
const authorBody = '<!-- authored-by-actor: author -->';
function referral(recordHead, seat = 'judge', summary = 'xuznx3v status: open but delivered') {
  const original = { summary, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const runId = `review-pr-${recordHead}-${seat}`;
  return { version: 1, repo, pr, head: recordHead, runId, reviewer: mandatoryReferralReviewer(runId),
    authorBody, attempted: true, referrals: [{ seat, original, finding: normalizeFinding(original),
      key: referralFindingKey(seat, original) }], rulings: [] };
}
function ruled(record, result = 'not-real') {
  return { ...record, rulings: [{ id: 'r1', key: record.referrals[0].key, reviewerId: record.reviewer.id,
    lens: 'correctness', result, rationale: 'Checked the current diff', evidence: ['diff'] }] };
}
const comment = record => ({ body: renderReferralRecord(record), author: { login: 'web-everything' } });
const stateFor = comments => ({ state: 'OPEN', labels: ['review:human'], headRefOid: head, body: authorBody, comments });

describe('current-head mandatory referral acceptance', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'referral-acceptance-'));
    vi.stubEnv('OPERATION_RUNS_DIR', join(dir, 'runs'));
    vi.stubEnv('WE_VERDICT_LEDGER_DIR', join(dir, 'ledger'));
    vi.stubEnv('REVIEW_PR_ANTIGRAVITY_REVIEW', '0');
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_GEMINI', '0');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

  it.each([...new Set(['scripts/operations/review-dispatch.mjs', ...DAEMON_ENTRY_MODULES, ...conveyorEntryModules])])('loads %s in a fresh process without an initialization cycle', entry => {
    const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(`./${entry}`)})`],
      { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
  });

  it('starts the re-arm CLI with --help in a fresh process', () => {
    const result = spawnSync(process.execPath, ['scripts/conveyor/rearm-review.mjs', '--help'],
      { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), encoding: 'utf8', timeout: 10000 });
    expect(result.stderr).not.toContain('ReferenceError');
    // The shared CLI prints usage and exits 2 when no PR number is supplied.
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain('usage: rearm-review.mjs');
  });

  it('keeps the reconcile first-line re-arm matcher equal to the canonical marker', () => {
    expect(BOOKKEEPING_MARKERS).toContain(REARM_COMMENT_MARKER);
  });

  function review({ failure = false, time = 0, reviewedHead = head, subject = repo } = {}) {
    // Shaped as `newRunId('review-pr')` mints it: a run under a chosen id never counts as a clean review (PR #5520).
    const id = `review-pr-00000000-0000-4000-8000-${String(time).padStart(12, '0')}`;
    const run = newRunRecord({ id, op: 'review-pr', input: { repo: subject, pr } });
    const verdict = { verdict: failure ? 'needs-human' : 'accept',
      pendingReferrals: failure ? ['referral-persistence-failed'] : [] };
    run.findings = { read: { repo: subject, pr, netBasis: { rev: reviewedHead } }, referralVerdict: verdict,
      ...Object.fromEntries(['judge', 'judgeSecurity', 'judgeCorrectnessAdvisory', 'judgeStandardsConformance']
        .map(seat => [seat, { verdict: 'accept', findings: [] }])) };
    run.verdict = verdict;
    run.stepTimings = ['read', 'advise'].map((step, index) => ({ step, stepIndex: index,
      startedAt: new Date(1791037740000 + time + index * 1000).toISOString(),
      finishedAt: new Date(1791037740001 + time + index * 1000).toISOString(), durationMs: 1 }));
    writeRun(run);
  }
  function clear(state, to = 'clear-human') {
    const writes = [], output = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => { throw Object.assign(new Error('exit'), { exitCode: code }); });
    let code;
    try {
      runReviewLabelCli({ argv: [String(pr), `--repo=${repo}`, `--to=${to}`, '--actor=operator', '--reason=approve reviewed head'],
        allowClearHuman: true, defaultActor: 'operator', emit: line => output.push(line),
        provider: { readPostingIdentity: () => ({ login: 'chalbert', type: 'User' }), readPrState: () => state, readLabels: () => state.labels,
          postComment: () => writes.push('comment'), setLabels: (_, __, { add, remove }) => {
            writes.push('label'); state.labels = [...state.labels.filter(l => !remove.includes(l)), add];
          } },
        buildComment: () => 'Operator approves the reviewed head', successResult: () => ({ ok: true }), refusalResult: x => x,
      });
    } catch (error) { if (!Object.hasOwn(error, 'exitCode')) throw error; code = error.exitCode; }
    finally { exit.mockRestore(); }
    return { code, writes, output: output.join('') };
  }

  it.each(['clear-human', 'accepted'])('replays #3481: %s ignores 55 old referrals and a currently disabled seat', to => {
    const old = Array.from({ length: 55 }, (_, i) => comment(referral((i + 1).toString(16).padStart(40, '0'),
      i % 2 ? 'judgeAntigravityReview' : 'judge', `old finding ${i}`)));
    old.push(comment(ruled(referral('b'.repeat(40)), 'block')));
    review();
    const state = stateFor([...old, comment(ruled(referral(head))), comment(referral(head, 'judgeAntigravityReview'))]);
    if (to === 'accepted') state.labels = ['review:pending'];
    const result = clear(state, to);
    expect(result).toMatchObject({ code: 0, writes: ['comment', 'label'] });
    expect(state.labels).toEqual(['review:accepted']);
  });
  it('allows a clean current review with no current-head referral record', () => {
    review();
    expect(clear(stateFor([comment(referral('b'.repeat(40)))]))).toMatchObject({ code: 0, writes: ['comment', 'label'] });
  });
  it.each(['clear-human', 'accepted'])('%s still refuses a current-head pending referral despite an old ruling', to => {
    review();
    const state = stateFor([comment(ruled(referral('b'.repeat(40)))), comment(referral(head))]);
    if (to === 'accepted') state.labels = ['review:pending'];
    const result = clear(state, to);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('mandatory referral hold');
    expect(result.output).toContain('xuznx3v');
    expect(result.writes).toEqual([]);
  });
  it('still refuses a disabled seat with a standing block', () => {
    expect(() => assertMandatoryReferralsCleared(stateFor([comment(ruled(referral(head, 'judgeAntigravityReview'), 'block'))]), { repo, pr }))
      .toThrow(/mandatory referral hold/);
  });
  it('keeps an enabled optional seat pending, using the same operator config helper', () => {
    const state = stateFor([comment(referral(head, 'judgeAntigravityReview'))]);
    const options = { repo, pr, env: { REVIEW_PR_ANTIGRAVITY_REVIEW: '1' } };
    expect(() => assertMandatoryReferralsCleared(state, options)).toThrow(/mandatory referral hold/);
    options.env.WE_REVIEW_SEAT_CAP_AGY_GEMINI = '0';
    expect(() => assertMandatoryReferralsCleared(state, options)).not.toThrow();
  });
  it.each(['clear-human', 'accepted'])('%s refuses missing current records after failed persistence with a clear reason', to => {
    review({ failure: true });
    expect(() => assertMandatoryReferralsCleared(stateFor([]), { repo, pr })).toThrow(/referral-persistence-failed/);
    const state = stateFor([comment(ruled(referral('b'.repeat(40))))]);
    if (to === 'accepted') state.labels = ['review:pending'];
    const result = clear(state, to);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('referral-persistence-failed');
    expect(result.output).toContain(`no readable referral record for current head ${head}`);
    expect(result.writes).toEqual([]);
  });
  it('a later clean review or a record written by the failed review resolves the persistence hold', () => {
    review({ failure: true });
    const written = { ...comment(ruled(referral(head))), createdAt: new Date(1791037741000).toISOString() };
    expect(() => assertMandatoryReferralsCleared(stateFor([written]), { repo, pr })).not.toThrow();
    review({ time: 10000 });
    expect(() => assertMandatoryReferralsCleared(stateFor([]), { repo, pr })).not.toThrow();
  });
  it('an earlier ruled record does not clear a later persistence failure on the same head', () => {
    const earlier = { ...comment(ruled(referral(head))), createdAt: new Date(1791037740000).toISOString() };
    review({ failure: true, time: 10000 });
    expect(() => assertMandatoryReferralsCleared(stateFor([earlier]), { repo, pr })).toThrow(/referral-persistence-failed/);
    const undated = comment(ruled(referral(head)));
    expect(() => assertMandatoryReferralsCleared(stateFor([undated]), { repo, pr })).toThrow(/referral-persistence-failed/);
    const state = stateFor([earlier]);
    const result = clear(state);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('referral-persistence-failed');
    expect(result.writes).toEqual([]);
  });
  it.each(['pending', 'block'])('an old-head %s hold with no current-head record and no run evidence fails closed', kind => {
    const old = kind === 'block' ? ruled(referral('b'.repeat(40)), 'block') : referral('b'.repeat(40));
    const state = stateFor([comment(old)]);
    expect(() => assertMandatoryReferralsCleared(state, { repo, pr, readRuns: () => [] }))
      .toThrow(/mandatory referral hold: no-current-head-review-evidence/);
    expect(() => assertMandatoryReferralsCleared(state, { readRuns: () => [] })).toThrow(/no-current-head-review-evidence/);
    const result = clear(stateFor([comment(old)]));
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('no-current-head-review-evidence');
    expect(result.writes).toEqual([]);
  });
  it('an old-head hold passes once a completed clean review of the current head exists', () => {
    const state = stateFor([comment(ruled(referral('b'.repeat(40)), 'block'))]);
    expect(() => assertMandatoryReferralsCleared(state, { repo, pr, readRuns: () => [] })).toThrow();
    review();
    expect(() => assertMandatoryReferralsCleared(state, { repo, pr })).not.toThrow();
  });
  it('persistence failures from other heads and repositories do not hold this head', () => {
    review({ failure: true, reviewedHead: 'b'.repeat(40) });
    review({ failure: true, subject: 'o/other', time: 10000 });
    expect(() => assertMandatoryReferralsCleared(stateFor([]), { repo, pr })).not.toThrow();
  });
});
