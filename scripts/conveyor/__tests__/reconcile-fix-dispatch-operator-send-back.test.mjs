/** @file #101 — the operator send-back body leads the fixer's prompt as its must-fix items. */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchFix, readFixBriefTemplate, readLivePushHold, runReconcileFixDispatch, withOperatorSendBack } from '../reconcile-fix-dispatch.mjs';
import * as settingsFiles from '../../lib/settings-files.mjs';
import { FIX_SETTINGS_DEFAULTS } from '../fix-takeover.mjs';
import fixture from './fixtures/7490-operator-send-back-pending.json';

describe('withOperatorSendBack', () => {
  it('puts the body and the operator login in front of the prompt', () => {
    const out = withOperatorSendBack('BASE', { login: 'chalbert', body: 'MUST FIX: rename the export.' });
    expect(out.startsWith('# Operator send-back')).toBe(true);
    expect(out).toContain('@chalbert');
    expect(out).toContain('MUST FIX: rename the export.');
    expect(out.endsWith('BASE')).toBe(true);
  });
  it('leaves the prompt alone with no send-back', () => {
    expect(withOperatorSendBack('BASE', null)).toBe('BASE');
  });
  it('renders the real fresh-session brief with its re-arm step and operator exemption', () => {
    const spawnAgent = vi.fn(() => '');
    const sourceRoot = process.cwd();
    const result = dispatchFix({ pr: 1764, itemNum: '3438', lane: 9,
      laneRef: 'lane/3438-fix', scope: ['we:scripts/conveyor/reconcile-fix-dispatch.mjs'],
      operatorSendBack: { login: 'chalbert', body: 'Fix the export.' },
    }, {
      root: '/repo', readBrief: () => readFixBriefTemplate(sourceRoot),
      mintSessionId: () => '22222222-2222-4222-8222-222222222222', spawnAgent,
      wrapFix: false, readFixClaim: () => null, acquireClaim: () => ({ ok: true }), releaseClaim: () => {},
      postNotice: () => false, readHistoryInputs: () => null,
      ensureSessionCwd: (cwd) => cwd, grantConflictHelper: () => {},
      isolateSession: () => ({ write: { ok: true }, hooks: { ok: true } }),
      resolveSettingsEnv: () => null, advisorFor: () => ({ enabled: false }), recordAdvisor: () => {},
    });
    // The template documents these two literal placeholder examples.
    expect(result.unknownTokens).toEqual(['{{LIKE_THIS}}', '{{PLACEHOLDERS}}']);
    const prompt = spawnAgent.mock.calls[0][0].at(-1);
    expect(prompt).toContain('### 7. Re-arm the review');
    expect(prompt).toContain('scripts/conveyor/rearm-review.mjs" 1764 --repo=we');
    expect(prompt).toContain('Do not touch any review label, with ONE sanctioned exception: the re-arm step in your brief, running `node scripts/conveyor/rearm-review.mjs <pr> --repo=<repo>`, is authorized by the operator and you must run it.');
  });
});

describe('SENDBACK-FIX-ADMISSION E4 launch boundary', () => {
  let root, options, row, spawnAgent, acquireClaim, releaseClaim, events;
  const brief = '# Fix {{PR_NUM}} {{ITEM_NUM}}\n--lane={{LANE}} --session={{SESSION_SLUG}} --scope={{SCOPE}} --base={{LANE_REF}}';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sendback-launch-'));
    const home = join(root, 'home');
    mkdirSync(home);
    const preferences = join(home, 'preferences.json');
    writeFileSync(preferences, '{}');
    vi.stubEnv('WE_PLATFORM_PREFERENCES_FILE', preferences);
    vi.stubEnv('WE_MAIN_FIX_PAST_FIX_CAP', 'false');
    vi.spyOn(settingsFiles, 'readSettings').mockReturnValue({});
    vi.spyOn(settingsFiles, 'readDeclaredSettings').mockReturnValue({ settings: {}, errors: [], tainted: [], sources: {} });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixture.now));
    events = [];
    spawnAgent = vi.fn(() => '');
    acquireClaim = vi.fn(() => { events.push('claim'); return { ok: true }; });
    releaseClaim = vi.fn(() => events.push('release'));
    row = { kind: 'fix', prNumber: fixture.pr.number, headRefName: 'topic-e4', headRefOid: fixture.pr.headRefOid,
      mode: 'operator-send-back', operatorSendBack: { verdictId: 'SB1', login: 'chalbert', body: fixture.operatorBody },
      labels: fixture.pr.labels.map(l => l.name), reviewHuman: true, isConflict: false, attempts: 1, cap: 5 };
    options = {
      root, home, checkoutExists: () => true, readPackageJson: () => ({}),
      readBrief: () => brief, mintSessionId: () => '22222222-2222-4222-8222-222222222222',
      spawnAgent, wrapFix: false, executorDecision: { executor: 'claude', reason: 'fixture', source: 'fixture' },
      claimOwner: 'fixture-owner', claimRoot: join(root, 'claims'), acquireClaim, releaseClaim, readFixClaim: () => null,
      postNotice: () => false, readHistoryInputs: () => null, fixSettings: { ...FIX_SETTINGS_DEFAULTS, strongerModelFromRound: 0 },
      loadLadder: () => [], sessionCwdFor: () => join(root, 'session'), ensureSessionCwd: cwd => cwd,
      grantConflictHelper: () => {}, isolateSession: () => ({ write: { ok: true }, hooks: { ok: true } }),
      resolveSettingsEnv: () => null, advisorFor: () => ({ enabled: false }), recordAdvisor: () => {}, stampExecutor: () => {},
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const liveHold = (context, extra = {}) => readLivePushHold(context, {
    hermetic: false, run: () => JSON.stringify({ ...fixture.pr, ...extra }),
  });
  function run(extra = {}, rows = [row]) {
    return runReconcileFixDispatch({
      root, repo: 'we', dryRun: false, now: Date.parse(fixture.now), clock: () => Date.parse(fixture.now),
      stepNow: () => Date.parse(fixture.now), stepLog: () => {},
      reconcile: () => ({ dispatch: rows, refusals: [], notes: [], prs: rows.length, agents: 0 }),
      checkStaleness: () => ({ fresh: true, behind: 0 }), findItemFn: () => null, loadItems: () => [],
      fetchItemlessDiffPaths: () => ['scripts/fixture.mjs'], resolveFallbackScope: () => ['we:scripts/fixture.mjs'],
      pickFreeLanes: () => [23], listBuildClaims: () => [], listFixClaims: () => [], priorityShadow: null,
      prStack: null, prStackSettings: {}, landingBlockedState: null, readMainRedPriorityRecord: () => null,
      tryResume: () => ({ resumed: false }), tryResumeRound: null, fixSettings: options.fixSettings,
      readPushHold: liveHold, fixExecutorRoute: () => options.executorDecision,
      dispatch: (planned, dispatchOptions) => dispatchFix(planned, { ...options, ...dispatchOptions }), ...extra,
    });
  }

  it('E4 operator send-back launches through red-team:pending at admission and at the final dispatchFix re-read (#7490 supplied shape)', () => {
    const readPushHold = vi.fn(liveHold);
    const result = run({ readPushHold });
    expect(result.refusals).toEqual([]);
    expect(result.dispatched).toHaveLength(1);
    expect(readPushHold).toHaveBeenCalledTimes(3);
    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expect(spawnAgent.mock.calls[0][0].at(-1)).toContain('# Operator send-back');
    expect(spawnAgent.mock.calls[0][0].at(-1)).toContain(fixture.operatorBody);
    expect(events).toEqual(['claim']);
    expect(fixture.pr.labels.map(l => l.name)).toContain('red-team:pending');
  });

  it('E4 final dispatchFix re-read refuses when red-team:blocked appears: zero spawns, claim released', () => {
    const readPushHold = vi.fn(context => readPushHold.mock.calls.length < 3 ? liveHold(context)
      : { code: 'hold-label', reason: 'red-team:blocked' });
    const result = run({ readPushHold });
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'push-hold' }));
    expect(readPushHold).toHaveBeenCalledTimes(3);
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(events).toEqual(['claim', 'release']);
  });

  it('E4 throwing final dispatchFix hold read refuses unreadable and releases the claim', () => {
    const result = dispatchFix({ ...row, pr: row.prNumber, itemNum: null, laneRef: row.headRefName,
      scope: ['we:scripts/fixture.mjs'], lane: 23 }, { ...options, readPushHold: () => { throw Error('fixture timeout'); } });
    expect(result).toMatchObject({ refused: true, outcome: 'push-hold', hold: { code: 'unreadable' } });
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(events).toEqual(['claim', 'release']);
  });

  it.each([true, false])('E4 obeys the existing fixer throttle without borrowing (admitted=%s)', admitted => {
    const tryAdmit = vi.fn(() => admitted ? { admit: true } : { admit: false, kind: 'fix-cap', why: 'cap' });
    const dispatch = vi.fn(planned => dispatchFix(planned, { ...options, readPushHold: liveHold }));
    const result = run({ dispatch, dispatchThrottle: { tryAdmit }, borrowGate: null });
    expect(tryAdmit).toHaveBeenCalledTimes(1);
    if (admitted) {
      expect(result.refusals).toEqual([]);
      expect(spawnAgent).toHaveBeenCalledTimes(1);
    } else {
      expect(result.refusals).toContainEqual({ pr: row.prNumber, kind: 'fix-cap', why: 'cap' });
      expect(dispatch).not.toHaveBeenCalled();
      expect(acquireClaim).not.toHaveBeenCalled();
    }
  });

  it('E4 live fix claim holds and returns the unused lane to the next PR', () => {
    const lanes = [];
    const second = { ...row, prNumber: 7515, headRefName: 'topic-other' };
    const dispatch = (planned, dispatchOptions) => {
      lanes.push(planned.lane);
      return dispatchFix(planned, { ...options, ...dispatchOptions, readFixClaim: () => planned.pr === 7490 ? { owner: 'other' } : null });
    };
    const result = run({ dispatch, fetchItemlessDiffPaths: pr => [`scripts/fixture-${pr}.mjs`] }, [row, second]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ pr: 7490, kind: 'held', why: expect.stringContaining('fix-claimed') }));
    expect(lanes).toEqual([23, 23]);
    expect(result.dispatched).toHaveLength(1);
    expect(spawnAgent).toHaveBeenCalledTimes(1);
  });

  it('E4 with no free lane refuses no-lane without claiming', () => {
    expect(run({ pickFreeLanes: () => [] }).refusals).toContainEqual(expect.objectContaining({ kind: 'no-lane' }));
    expect(acquireClaim).not.toHaveBeenCalled();
  });

  it('E4 scope overlap retains the existing refusal without claiming', () => {
    const result = run({ listBuildClaims: () => [{ owner: 'builder', meta: { repo: 'we', pr: 9000, scope: ['we:scripts/fixture.mjs'] } }] });
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'scope-overlap' }));
    expect(acquireClaim).not.toHaveBeenCalled();
  });
});
