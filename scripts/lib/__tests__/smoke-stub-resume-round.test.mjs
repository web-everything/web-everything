import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { DISPATCH_DRY_RUN_SCRIPT, resolveSmokeBudgets, SMOKE_CHECKS } from '../daemon-live-smoke.mjs';
import b, { probeDryRun } from '../../conveyor/soak/breaks/smoke-dryrun-resumes-real-session.mjs';

const host = { load: () => 0, cores: () => 1 };
const passes = ['reconcile-fix-pass', 'reconcile-ci-heal-pass', 'reconcile-review-pass'];
const dispatchCheck = SMOKE_CHECKS.find(check => check.name === 'dispatch-dry-run').run;

// Evaluate each actual call's options without importing production modules or running live reads.
function dryRunOptions(callee) {
  const options = DISPATCH_DRY_RUN_SCRIPT.match(new RegExp(`\\b${callee}\\((\\{[\\s\\S]*?\\n  \\})\\);`));
  expect(options, `${callee} must remain explicitly configured in the dry-run script`).not.toBeNull();
  return runInNewContext(`(${options[1]})`, {
    process: { env: {}, pid: 1 }, WE_SLUG: 'fixture/repo',stubDispatch: () => {}, skipStaleness: () => ({ fresh: true, behind: 0 }),
  });
}

describe('smoke dry-run side-effect stubs', () => {
  it('stubs CI-heal pollAttempts with no observations', () => {
    expect(dryRunOptions('runReconcileCiHealDispatch').pollAttempts()).toEqual([]);
  });

  it('stubs CI-heal flushTimeouts with no followups', async () => {
    expect(await dryRunOptions('runReconcileCiHealDispatch').flushTimeouts()).toEqual([]);
  });

  it('stubs CI-heal retryTimeout with an explicit refusal', async () => {
    expect(await dryRunOptions('runReconcileCiHealDispatch').retryTimeout()).toEqual({
      status: 'refused', reason: 'smoke-dry-run',
    });
  });

  it('stubs CI-heal salvage with no recovered commit', async () => {
    expect(await dryRunOptions('runReconcileCiHealDispatch').salvage()).toBeNull();
  });

  it('stubs CI-heal postParkComment with a no-op', () => {
    expect(dryRunOptions('runReconcileCiHealDispatch').postParkComment()).toBeUndefined();
  });

  it('stubs review notifyReferral with a no-op', () => {
    expect(dryRunOptions('runReviewTick').notifyReferral()).toBeUndefined();
  });

  it('disables fix idle-restack shadow logging with hermetic no-op dependencies', () => {
    const { shadowDeps } = dryRunOptions('runReconcileFixDispatch');
    expect(shadowDeps.hermetic).toBe(true);
    expect(shadowDeps.mode).toBe('off');
    expect(shadowDeps.appendLine('fixture evidence')).toBeUndefined();
  });
});

describe('smoke dry-run fix-pass isolation', () => {
  it('stubs tryResumeRound with an explicit unsuccessful resume result', async () => {
    const { fixCalls } = await probeDryRun();
    expect(fixCalls).toHaveLength(1);
    expect(fixCalls[0].tryResumeRound).toBeTypeOf('function');
    expect(fixCalls[0].tryResumeRound()).toEqual({ resumed: false, resumeAttempt: null });
  });

  // Keep real reconcile/PR/scope reads: they are the purpose of the live smoke. Override the write,
  // worker-resume, coordination and shadow-log seams even when today's fixture does not reach them.
  it.each([
    'dispatch', 'tryResume', 'tryResumeRound', 'pickFreeLanes', 'checkStaleness',
    'postQueueCapComment', 'notifyQueueCapOperator', 'listBuildClaims', 'listFixClaims',
  ])('explicitly stubs external-effect injectable %s', async name => {
    const { fixCalls } = await probeDryRun();
    expect(fixCalls).toHaveLength(1);
    expect(Object.hasOwn(fixCalls[0], name)).toBe(true);
    expect(fixCalls[0][name]).toBeTypeOf('function');
  });

  it.each(['writeStacks', 'priorityShadow'])('disables external-effect injectable %s with null', async name => {
    const { fixCalls } = await probeDryRun();
    expect(fixCalls).toHaveLength(1);
    expect(fixCalls[0][name]).toBeNull();
  });

  it('keeps stand-down writes disabled', async () => {
    const { fixCalls } = await probeDryRun();
    expect(fixCalls[0].allowStandDownAutoProceed).toBe(false);
  });

  it('never reaches the production round-resume default', async () => {
    const report = await b.run();
    expect(b.judge(report)).toEqual([]);
  });

  it('the soak break catches a missing round-resume stub', async () => {
    const broken = DISPATCH_DRY_RUN_SCRIPT.replace(
      /tryResumeRound\s*:\s*\(\)\s*=>\s*\(\{\s*resumed:\s*false,\s*resumeAttempt:\s*null\s*\}\)\s*,?/, '',
    );
    const report = await probeDryRun(broken);
    expect(report.fixCalls).toHaveLength(1);
    expect(report.resumeAttempts).toEqual([{ sessionSlug: 'existing-live-session' }]);
  });

  it('fails closed when the dry-run script cannot be exercised', async () => {
    await expect(probeDryRun('unrecognized loader')).rejects.toThrow('refusing to import production modules');
  });
});

describe('smoke dispatch per-pass timeout', () => {
  it('defaults dispatchPassMs to 600000ms', () => {
    expect(resolveSmokeBudgets({}, host).dispatchPassMs).toBe(600_000);
  });

  it('overrides dispatchPassMs from WE_SMOKE_DISPATCH_PASS_MS', () => {
    expect(resolveSmokeBudgets({ WE_SMOKE_DISPATCH_PASS_MS: '1234' }, host).dispatchPassMs).toBe(1234);
  });

  it.each(['0', '-1', 'garbage'])('falls back to the bounded default for invalid pass budget %s', value => {
    expect(resolveSmokeBudgets({ WE_SMOKE_DISPATCH_PASS_MS: value }, host).dispatchPassMs).toBe(600_000);
  });

  it('runs each reconcile pass in its own child with dispatchPassMs', async () => {
    const runChild = vi.fn(async (_cmd, _args, options) => JSON.stringify([
      { kind: options.env.WE_SMOKE_DRYRUN_ONLY ?? 'review', ok: true, ms: 1 },
    ]));
    const result = await dispatchCheck({ root: tmpdir(), env: { WE_SMOKE_DISPATCH_PASSES: "3" },
      budgets: { dispatchDryRunMs: 9999, dispatchPassMs: 1234 }, runChild });
    expect(result.ok).toBe(true);
    expect(runChild).toHaveBeenCalledTimes(3);
    expect(runChild.mock.calls.map(([, , options]) => options.env.WE_SMOKE_DRYRUN_ONLY)).toEqual(passes);
    for (const [cmd, args, options] of runChild.mock.calls) {
      expect(cmd).toBe('node');
      expect(args).toEqual(['--input-type=module', '-e', DISPATCH_DRY_RUN_SCRIPT]);
      expect(options.timeoutMs).toBe(1234);
    }
  });

  it.each(passes)('runs only %s and keeps direct dispatch calls in the first child', async kind => {
    const report = await probeDryRun(DISPATCH_DRY_RUN_SCRIPT, kind);
    expect(report.rows.filter(row => row.kind.startsWith('reconcile-')).map(row => row.kind)).toEqual([kind]);
    expect(report.directCalls).toEqual(kind === passes[0] ? ['review', 'fix', 'ci-heal', 'ci-heal'] : []);
  });

  it('names reconcile-fix-pass and the elapsed budget when its child times out', async () => {
    const runChild = vi.fn(async (_cmd, _args, options) => {
      if (options.env.WE_SMOKE_DRYRUN_ONLY === 'reconcile-fix-pass') {
        throw Object.assign(new Error('timed out after 1234ms (process group killed)'), { code: 'ETIMEDOUT' });
      }
      return JSON.stringify([{ kind: 'review', ok: true, ms: 1 }]);
    });
    const result = await dispatchCheck({ root: tmpdir(), env: { WE_SMOKE_DISPATCH_PASSES: "3" },
      budgets: { dispatchDryRunMs: 9999, dispatchPassMs: 1234 }, runChild });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('reconcile-fix-pass timed out after 1234ms');
  });
});
