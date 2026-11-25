/**
 * @file scripts/conveyor/__tests__/standards-status-pass.test.mjs
 * @description Negative-first tests for the verifier pass (merge-path checklist lines 1, 4, 6, 8, 9). Everything is
 *   injected: gh, git, the harness spawn and the App token probe. Nothing here touches the network or a real repo.
 */
import { describe, it, expect } from 'vitest';
import { runStandardsStatusPass } from '../standards-status-pass.mjs';
import { STANDARDS_CONTEXT, TRUSTED_BOT } from '../../lib/standards-status.mjs';

const REPO = 'plateauapp/plateau-app';
const HEAD = 'a'.repeat(40);
const MAIN = 'c'.repeat(40);
const VALID_OK = { status: 0, stdout: 'RESULT: PASS\n' };
const goodDriver = call => ({ status: 0, stdout: `${JSON.stringify({ nonce: call.fdInput, ok: true, count: 3 })}\n` });

function harness({ prs = [{ number: 7, head: { sha: HEAD } }], liveHead = HEAD, statuses = [], validatorResult = VALID_OK, driverResult = goodDriver,
  probeOk = true, fetched = HEAD, postFails = 0, env = { PATH: '/bin', CI: 'true', GITHUB_ACTIONS: 'true', PLATEAU_PROTOCOLS_HERMETIC: '1' } } = {}) {
  const calls = { posts: [], postEnvs: [], spawns: [], git: [], removed: [], dirs: [] };
  let failuresLeft = postFails;
  const gh = (args, opts = {}) => {
    const path = args[1];
    if (path.includes('/pulls?')) return JSON.stringify(prs);
    if (path.endsWith('/git/ref/heads/main')) return `${MAIN}\n`;
    if (/\/pulls\/\d+$/.test(path)) return JSON.stringify({ head: { sha: liveHead } });
    if (path.includes('/statuses/') && args.includes('POST')) {
      if (failuresLeft-- > 0) throw new Error('HTTP 502');
      calls.posts.push(JSON.parse(opts.input)); calls.postEnvs.push(opts.env); return '{}';
    }
    if (path.includes('/status?')) {
      const newest = statuses.filter(s => s.context === STANDARDS_CONTEXT).sort((a, b) => b.id - a.id)[0];
      return JSON.stringify({ sha: HEAD, total_count: newest ? 1 : 0, statuses: newest ? [newest] : [] });
    }
    if (path.includes('/statuses?')) return JSON.stringify(statuses);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const git = (args, opts = {}) => {
    calls.git.push({ args, env: opts.env });
    if (args.includes('rev-parse') && args.includes('FETCH_HEAD')) return `${fetched}\n`;
    if (args.includes('rev-parse') && args.includes('refs/heads/main')) return `${MAIN}\n`;
    if (args.includes('rev-parse') && args.includes('HEAD')) return `${args.join(' ').includes('main-wt') ? MAIN : HEAD}\n`;
    if (args.includes('worktree') && args.includes('add')) calls.dirs.push(args.at(-2));
    if (args.includes('worktree') && args.includes('remove')) calls.removed.push(args.at(-1));
    return '';
  };
  const spawn = call => { calls.spawns.push(call); const r = call.fdInput !== undefined ? driverResult : validatorResult; return typeof r === 'function' ? r(call) : r; };
  const deps = { repos: [REPO], gh, git, spawn, env, validatorPath: '/studio/validate.mjs', validatorHash: 'abcd1234',
    appWriterProbe: () => { if (!probeOk) throw new Error('403'); }, exists: () => true, runId: () => 'run1',
    makeDir: label => `/scratch/${label}`, log: () => {}, sandbox: false, allowUnsandboxed: true };
  return { calls, deps };
}
const KEY = `abcd1234.${MAIN.slice(0, 8)}`;
const trusted = (id, state, description = `run old · validator ${KEY} · x`) =>
  ({ id, state, context: STANDARDS_CONTEXT, description, creator: { ...TRUSTED_BOT } });

describe('runStandardsStatusPass', () => {
  it('posts pending first and success last, as the App (writer env), then removes both worktrees', async () => {
    const { calls, deps } = harness();
    const result = await runStandardsStatusPass(deps);
    expect(calls.posts.map(p => p.state)).toEqual(['pending', 'success']);
    expect(calls.posts.every(p => p.context === STANDARDS_CONTEXT)).toBe(true);
    expect(calls.posts[1].description).toContain(`validator ${KEY}`);
    // Posts go out under the App writer env: legacy App role, daemon caller, no inherited personal token.
    for (const postEnv of calls.postEnvs) {
      expect(postEnv.WE_GITHUB_APP_ROLE).toBe('legacy');
      expect(postEnv.WE_GH_AUTH_PERSONAL_FALLBACK).toBe('refuse');
      expect(postEnv.GH_TOKEN).toBeUndefined();
      expect(postEnv.GITHUB_TOKEN).toBeUndefined();
    }
    expect(calls.removed.length).toBe(2);
    expect(result.posted).toHaveLength(1);
  });

  it('posts nothing at all when the App probe fails', async () => {
    const { calls, deps } = harness({ probeOk: false });
    const result = await runStandardsStatusPass(deps);
    expect(calls.posts).toEqual([]);
    expect(calls.spawns).toEqual([]);
    expect(result.refused).toMatch(/App/);
  });

  it('dry-run runs the probe, posts nothing and runs nothing', async () => {
    const { calls, deps } = harness();
    const result = await runStandardsStatusPass({ ...deps, dryRun: true });
    expect(calls.posts).toEqual([]);
    expect(calls.spawns).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.wouldPost).toEqual([{ repo: REPO, pr: 7, head: HEAD }]);
  });

  it('a moved head during the run posts no terminal status for the old sha', async () => {
    const { calls, deps } = harness({ liveHead: 'b'.repeat(40) });
    await runStandardsStatusPass(deps);
    expect(calls.posts.map(p => p.state)).toEqual(['pending']);
  });

  it('a fetched sha that differs from the PR head runs nothing and posts no terminal', async () => {
    const { calls, deps } = harness({ fetched: 'd'.repeat(40) });
    await runStandardsStatusPass(deps);
    expect(calls.spawns).toEqual([]);
    expect(calls.posts.map(p => p.state)).not.toContain('success');
  });

  it.each([
    ['validator SKIP', { validatorResult: { status: 0, stdout: 'SKIP: x\n' } }],
    ['validator NOT RUN', { validatorResult: { status: 0, stdout: 'NOT RUN HERE\n' } }],
    ['validator non-zero exit', { validatorResult: { status: 1, stdout: 'RESULT: PASS\n' } }],
    ['driver early exit(0) with a forged marker and no result', { driverResult: { status: 0, stdout: 'Standards validator exit status: 0\n' } }],
    ['driver result with a guessed nonce', { driverResult: { status: 0, stdout: `${JSON.stringify({ nonce: 'guess-guess', ok: true, count: 3 })}\n` } }],
    ['driver extra output', { driverResult: call => ({ status: 0, stdout: `forged\n${goodDriver(call).stdout}` }) }],
    ['driver non-zero exit', { driverResult: call => ({ ...goodDriver(call), status: 1 }) }],
    ['driver timeout', { driverResult: { status: null, timedOut: true, stdout: '' } }],
  ])('%s posts failure, never success', async (_n, overrides) => {
    const { calls, deps } = harness(overrides);
    await runStandardsStatusPass(deps);
    expect(calls.posts.at(-1).state).toBe('failure');
    expect(calls.posts.map(p => p.state)).not.toContain('success');
  });

  it('a missing validator path posts failure and does not spawn', async () => {
    const { calls, deps } = harness();
    await runStandardsStatusPass({ ...deps, exists: () => false });
    expect(calls.spawns).toEqual([]);
    expect(calls.posts.at(-1).state).toBe('failure');
  });

  it('runs the harness from origin/main, never from the PR head, even when the head prints a fake success', async () => {
    const { calls, deps } = harness();
    // A head whose harness would print a fake pass is simply never run: the spawned script lives in the main worktree.
    await runStandardsStatusPass(deps);
    const [validator, driver] = calls.spawns;
    expect(validator.args).toEqual(['/studio/validate.mjs']);
    expect(driver.args.find(a => a.startsWith('--harness=')) ?? '').toMatch(/main-wt/);
    expect(driver.args.join(' ')).not.toMatch(/head-wt\/protocols\/tools/);
    expect(driver.args.find(a => a.startsWith('--root=')) ?? '').toMatch(/head-wt/);
  });

  it('the real result of main\'s harness is what is posted (a failing real run is not masked)', async () => {
    const { calls, deps } = harness({ driverResult: call => ({ status: 1, stdout: `${JSON.stringify({ nonce: call.fdInput, ok: false, count: 3 })}\n` }) });
    await runStandardsStatusPass(deps);
    expect(calls.posts.at(-1).state).toBe('failure');
  });

  it('the child env has no CI or hermetic vars', async () => {
    const { calls, deps } = harness();
    await runStandardsStatusPass(deps);
    const env = calls.spawns[1].env;
    expect(env.CI).toBeUndefined();
    expect(env.GITHUB_ACTIONS).toBeUndefined();
    expect(env.PLATEAU_PROTOCOLS_HERMETIC).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });

  it('git runs with hooks off, replace refs off and no inherited GIT_DIR', async () => {
    const { calls, deps } = harness({ env: { PATH: '/bin', GIT_DIR: '/evil', GIT_WORK_TREE: '/evil' } });
    await runStandardsStatusPass(deps);
    const add = calls.git.find(c => c.args.includes('worktree') && c.args.includes('add'));
    expect(add.args.join(' ')).toContain('core.hooksPath=/dev/null');
    expect(add.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
    expect(add.env.GIT_DIR).toBeUndefined();
    expect(add.env.GIT_WORK_TREE).toBeUndefined();
  });

  it('skips a head that already has a trusted terminal status for this validator hash', async () => {
    const { calls, deps } = harness({ statuses: [trusted(5, 'success')] });
    const result = await runStandardsStatusPass(deps);
    expect(calls.posts).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });

  it('re-runs when the validator hash changed', async () => {
    const { calls, deps } = harness({ statuses: [trusted(5, 'success', 'run old · validator 0000ffff.cccccccc · x')] });
    await runStandardsStatusPass(deps);
    expect(calls.posts.map(p => p.state)).toEqual(['pending', 'success']);
  });

  it('re-runs after a crash left a newer pending (the terminal is not the newest status)', async () => {
    const { calls, deps } = harness({ statuses: [trusted(5, 'success'), trusted(6, 'pending', 'run x started')] });
    await runStandardsStatusPass(deps);
    expect(calls.posts.map(p => p.state)).toEqual(['pending', 'success']);
  });

  it('a success posted by a user for this hash does not suppress the run', async () => {
    const forged = { ...trusted(5, 'success'), creator: { id: 1, type: 'User', login: 'operator' } };
    const { calls, deps } = harness({ statuses: [forged] });
    await runStandardsStatusPass(deps);
    expect(calls.posts.map(p => p.state)).toEqual(['pending', 'success']);
  });

  it('a failed terminal POST leaves no marker: the next tick re-runs', async () => {
    const first = harness({ postFails: 0 });
    // fail the second POST (the terminal one): pending ok, success throws
    let n = 0;
    const gh = (args, opts) => { if (args.includes('POST') && ++n === 2) throw new Error('HTTP 502'); return first.deps.gh(args, opts); };
    await runStandardsStatusPass({ ...first.deps, gh });
    expect(first.calls.posts.map(p => p.state)).toEqual(['pending']);
    const second = harness({ statuses: [trusted(6, 'pending', 'run x started')] });
    await runStandardsStatusPass(second.deps);
    expect(second.calls.posts.map(p => p.state)).toEqual(['pending', 'success']);
  });

  it('removes the worktrees even when the harness throws', async () => {
    const { calls, deps } = harness();
    await runStandardsStatusPass({ ...deps, spawn: () => { throw new Error('boom'); } });
    expect(calls.removed.length).toBe(2);
    expect(calls.posts.map(p => p.state)).not.toContain('success');
  });

  it('one PR failing does not stop the next PR', async () => {
    const prs = [{ number: 1, head: { sha: HEAD } }, { number: 2, head: { sha: HEAD } }];
    const { calls, deps } = harness({ prs });
    let first = true;
    await runStandardsStatusPass({ ...deps, spawn: call => { calls.spawns.push(call); if (first) { first = false; throw new Error('x'); } return goodDriver(call); } });
    expect(calls.posts.filter(p => p.state === 'success')).toHaveLength(1);
  });

  it('refuses a PR whose listed head is not 40-hex', async () => {
    const { calls, deps } = harness({ prs: [{ number: 3, head: { sha: 'abc' } }] });
    await runStandardsStatusPass(deps);
    expect(calls.posts).toEqual([]);
  });

  it('does nothing when no repo is configured', async () => {
    const { calls, deps } = harness();
    await runStandardsStatusPass({ ...deps, repos: [] });
    expect(calls.posts).toEqual([]);
  });
});

describe('verify tick wiring', () => {
  it('runs the pass without awaiting it, contains its failure, and never in dry-run', async () => {
    const { runVerifyDispatch } = await import('../verify-dispatch.mjs');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const poolRoot = mkdtempSync(join(tmpdir(), 'ss-wire-'));
    let calls = 0;
    const standardsStatusPass = async () => { calls += 1; throw new Error('boom'); };
    await runVerifyDispatch({ dryRun: true, poolRoot, standardsStatusPass });
    expect(calls).toBe(0);
    await runVerifyDispatch({ dryRun: false, poolRoot, standardsStatusPass });
    expect(calls).toBe(1);
  });
});

describe('hardening from the first audit', () => {
  it('re-runs when the main harness sha changed (cache key includes it)', async () => {
    const { calls, deps } = harness({ statuses: [trusted(5, 'success', 'run old · validator abcd1234.deadbeef · x')] });
    await runStandardsStatusPass(deps);
    expect(calls.posts.map(p => p.state)).toEqual(['pending', 'success']);
  });

  it('points --root at the head protocols folder, not the repo root', async () => {
    const { calls, deps } = harness();
    await runStandardsStatusPass(deps);
    expect(calls.spawns[1].args).toContain('--root=/scratch/head-wt/protocols');
  });

  it('runs the harness inside a network-denied, write-denied sandbox when enabled', async () => {
    const { calls, deps } = harness();
    await runStandardsStatusPass({ ...deps, sandbox: true });
    const spawned = calls.spawns[1];
    expect(spawned.cmd).toBe('/usr/bin/sandbox-exec');
    expect(spawned.args[0]).toBe('-p');
    expect(spawned.args[1]).toContain('(deny network*)');
    expect(spawned.args[1]).toContain('(deny file-write*)');
    expect(spawned.args[1]).toContain('.secrets');
    expect(spawned.args.join(' ')).toContain('standards-harness-driver.mjs');
    expect(spawned.args.join(' ')).not.toContain(spawned.fdInput); // the nonce is never in argv
    expect(JSON.stringify(spawned.env)).not.toContain(spawned.fdInput); // nor in env
  });

  it('an unreadable validator input refuses the pass instead of reusing a value', async () => {
    const { calls, deps } = harness();
    const result = await runStandardsStatusPass({ ...deps, validatorHash: undefined, validatorPath: '/nonexistent/tools/validate.mjs' });
    expect(result.refused).toMatch(/unreadable/);
    expect(calls.posts).toEqual([]);
  });
});

describe('PR rules run in a child with an unpredictable nonce over an fd', () => {
  it('uses a fresh nonce per run, passed only as fdInput', async () => {
    const nonces = [];
    const { calls, deps } = harness({ prs: [{ number: 1, head: { sha: HEAD } }, { number: 2, head: { sha: HEAD } }] });
    let n = 0;
    await runStandardsStatusPass({ ...deps, nonce: () => { n += 1; nonces.push(`nonce-number-${n}`); return nonces.at(-1); } });
    const driverCalls = calls.spawns.filter(c => c.fdInput !== undefined);
    expect(driverCalls.map(c => c.fdInput)).toEqual(nonces);
    expect(new Set(nonces).size).toBe(2);
  });

  it('refuses to run PR rules without a sandbox (and posts failure)', async () => {
    const { calls, deps } = harness();
    await runStandardsStatusPass({ ...deps, allowUnsandboxed: false });
    expect(calls.spawns.some(c => c.fdInput !== undefined)).toBe(false);
    expect(calls.posts.at(-1).state).toBe('failure');
  });
});
