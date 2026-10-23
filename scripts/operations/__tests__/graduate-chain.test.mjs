import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { withBareOrigin } from './helpers/real-repo.mjs';
import { createGraduateChainRunner, createGraduateChainSinks } from '../graduate-chain-io.mjs';
import { cascadePolicy } from '../../lib/policy-cascade.mjs';
import { describe, it, expect } from 'vitest';
import { runGraduateChain, graduateChainOperation, measureSize, suggestedSplit, finishGraduateChain } from '../graduate-chain.mjs';
import { driveRun, parseOperationArgv } from '../cli-adapter.mjs';
import { createRegistry } from '../registry.mjs';
import { startRun } from '../engine.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { isReadOnlyOperation } from '../registry.mjs';

const sha = 'a'.repeat(40), base = 'b'.repeat(40);
const input = { source: 'lane/source', purpose: 'slice', title: 'A slice $(inert)' };
const goodVerify = { verdict: { ok: true, checks: [{ outcome: 'pass' }] } };
const opened = { findings: { submit: { effects: [{ result: { outcome: 'opened', pr: 42 } }] } } };
// Parse the stubbed submit response locally: this suite exercises graduate-chain's
// git mechanism, so importing open-pr would falsely credit its network IO too.
function extractSubmitResult(payload) {
  const result = payload?.findings?.submit?.effects?.[0]?.result;
  if (result && typeof result === 'object') return result;
  return {
    outcome: 'unrun',
    reason: payload?.error
      ?? `open-pr: run ${JSON.stringify(payload?.stopped ?? 'unknown')} never reached its submit step — no PR was opened`,
    pr: null,
    url: null,
  };
}
function fixture({ change = () => undefined, over = {}, options = {} } = {}) {
  const calls = [], bodies = [];
  let cleaned = false;
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, ...opts });
    const override = change(cmd, args, opts);
    if (override) return override;
    const value = v => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
    if (cmd === 'gh') {
      if (args[0] === 'api') return value({ login: 'me' });
      if (args[1] === 'view') return value({ headRefName: 'lane/parent', headRefOid: base, isCrossRepository: false });
      return value([]);
    }
    if (cmd === 'git') {
      if (args[0] === 'merge-tree') return value(sha + '\n');
      if (args[0] === 'merge-base') return value(base);
      if (args[0] === 'rev-parse') return value(args.at(-1).startsWith('origin/') ? base : sha);
      if (args[0] === 'rev-list') return value(sha);
      if (args[0] === 'diff') return value(args[1] === '--numstat' ? '12\t3\tscripts/file.mjs\n4\t1\tscripts/__tests__/file.test.mjs' : '2 files changed');
      if (args[0] === 'log') return value('abc A commit');
      return value('');
    }
    if (args[0].endsWith('lane-pool.mjs')) return value(args[1] === 'acquire' ? { lane: 8, path: '/lane', holder: 'held' } : { released: 1 });
    if (args[0].endsWith('graduation-import-check.mjs')) return value({ findings: [] });
    if (args[1] === 'verify') return value(goodVerify);
    if (args[1] === 'open-pr') return value(opened);
    throw new Error('unexpected command');
  };
  const result = runGraduateChain({ ...input, ...over }, { exec, cwd: '/repo', env: {}, cascadePolicy, extractSubmitResult,
    capsPlatform: {},
    readTemplate: () => '{{commits}} {{diffStat}} {{testResult}} {{audit}}',
    writeBody: body => { bodies.push(body); return '/tmp/body.md'; }, cleanup: () => { cleaned = true; }, ...options });
  return { result, calls, bodies, cleaned, exec };
}
const reply = (stdout, status = 0) => ({ stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), status, stderr: '' });
const released = calls => calls.some(c => c.args[1] === 'release');
const prs = n => Array.from({ length: n }, (_, i) => ({ number: i + 1, author: { login: 'me' }, headRefName: `lane/${i}` }));

describe('graduate-chain', () => {
  it('real dry-run merge preserves repository refs, index and objects', async () => {
    await withBareOrigin(ctx => {
      ctx.seedOriginBranch('lane/source', { 'source.mjs': 'export const source = 1;\n' });
      ctx.seedOriginBranch('lane/stack', { 'stack.mjs': 'export const stack = 1;\n' });
      for (const ref of ['lane/source', 'lane/stack']) ctx.git(['fetch', 'origin', `refs/heads/${ref}:refs/remotes/origin/${ref}`]);
      const stackSha = ctx.git(['rev-parse', 'origin/lane/stack']).trim();
      const snapshot = () => ({ refs: ctx.git(['for-each-ref']), index: readFileSync(join(ctx.clone, '.git/index')).toString('hex'),
        objects: readdirSync(join(ctx.clone, '.git/objects'), { recursive: true }).sort() });
      const before = snapshot();
      const calls = [];
      const exec = (cmd, args, opts) => {
        calls.push({ cmd, args });
        if (cmd === 'gh') return reply(args[0] === 'api' ? { login: 'me' } : args[1] === 'view'
          ? { headRefName: 'lane/stack', headRefOid: stackSha, isCrossRepository: false } : []);
        if (cmd !== 'git') throw Error('dry-run attempted mutation');
        return spawnSync(cmd, args, { ...opts, encoding: 'utf8', maxBuffer: 1024 * 1024 });
      };
      const result = createGraduateChainRunner({ exec, cwd: ctx.clone, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })(
        { ...input, source: 'origin/lane/source', stackOn: '2', dryRun: true });
      expect(result).toMatchObject({ ok: true, size: { nonTest: 1, test: 0, files: 1 } });
      expect(calls.some(c => c.args[0] === 'merge-tree')).toBe(true);
      expect(snapshot()).toEqual(before);
    });
  });
  it('IO isolates merge objects and cleans temporary files with fake exec', () => {
    const f = fixture();
    f.calls.length = 0;
    const result = createGraduateChainRunner({ exec: f.exec, cwd: '/repo', env: {} })(input);
    expect(result.ok).toBe(true);
    const merge = f.calls.find(c => c.args[0] === 'merge-tree');
    expect(merge.env.GIT_OBJECT_DIRECTORY).toBeTruthy();
    expect(existsSync(merge.env.GIT_OBJECT_DIRECTORY)).toBe(false);
    const body = f.calls.find(c => c.args[1] === 'open-pr').args.find(a => a.startsWith('--bodyFile=')).split('=')[1];
    expect(existsSync(body)).toBe(false);
  });
  it('graduates once, pins commands to the holder and releases', () => {
    const { result, calls, bodies, cleaned } = fixture();
    expect(result).toMatchObject({ ok: true, pr: 42, branch: 'lane/slice', sha, stopReason: null,
      capSources: { callerMax: 'standard', repoMax: 'standard' }, size: { nonTest: 15, test: 5, files: 2 } });
    expect(calls.filter(c => c.args[1] === 'verify')).toHaveLength(1);
    for (const c of calls.filter(c => ['reset', 'cherry-pick', 'push'].includes(c.args[0]))) expect(c.env.LANE_SESSION).toBe('held');
    expect(calls.find(c => c.args[0] === 'push').args).toEqual(['push', 'origin', 'HEAD:refs/heads/lane/slice']);
    expect(calls.find(c => c.args[1] === 'open-pr').args).toContain('--title=A slice $(inert)');
    expect(bodies[0]).toContain('verify: pass');
    expect(released(calls)).toBe(true); expect(cleaned).toBe(true);
  });
  it('dry-run runs caps, merge-tree and source numstat without mutation', () => {
    const { result, calls, bodies } = fixture({ over: { dryRun: true } });
    expect(result.ok).toBe(true);
    expect(calls.every(c => c.cmd !== 'node')).toBe(true);
    expect(calls.some(c => ['fetch', 'reset', 'cherry-pick', 'push', 'checkout', 'switch'].includes(c.args[0]))).toBe(false);
    expect(result.steps.filter(s => s.would).map(s => s.step)).toEqual(['acquire', 'cherry-pick', 'import-check', 'verify', 'body', 'push', 'open-pr', 'release']);
    expect(bodies).toEqual([]);
  });
  it('uses stack head and an explicit source range', () => {
    const { result, calls } = fixture({ over: { source: 'old..new', stackOn: '7', bodyTemplate: 'body.md', audit: 'clear' } });
    expect(result.ok).toBe(true);
    expect(calls.find(c => c.args[1] === 'open-pr').args).toContain('--base=lane/parent');
    expect(calls.find(c => c.args[0] === 'merge-tree').args).toContain(`--merge-base=${sha}`);
  });
  it('honours environment cap provenance and leaves the final gate to the cascade', () => {
    const { result, calls } = fixture({ options: { env: { WE_GRADUATION_CALLER_MAX: '6' } } });
    expect(result.capSources.callerMax).toBe('env');
    expect(result.caps.callerMax).toBe(6);
    const venv = calls.find(c => c.args[1] === 'verify').env;
    expect(venv).toMatchObject({ WE_HEAVY_ADMISSION_CEILING_MS: '7200000' });
    expect(venv).not.toHaveProperty('WE_BUILD_FINAL_GATE');
  });
  for (const [reason, change, acquired] of [
    ['cap-caller', (c, a) => c === 'gh' && a[1] === 'list' && reply(prs(4)), false],
    ['cap-repo', (c, a) => c === 'gh' && a[1] === 'list' && reply(prs(19).map(p => ({ ...p, author: { login: 'other' } }))), false],
    ['caps-unreadable', (c, a) => c === 'gh' && a[0] === 'api' && reply({}), false],
    ['conflict', (c, a) => a[0] === 'merge-tree' && reply(`${sha}\nfile.mjs\n\nconflict`, 1), true],
    ['merge-tree', (c, a) => a[0] === 'merge-tree' && reply('', 128), true],
    ['empty-source', (c, a) => a[0] === 'rev-list' && reply(''), false],
    ['too-large', (c, a) => a[1] === '--numstat' && reply('301\t0\tscripts/big.mjs'), true],
    ['size-unreadable', (c, a) => a[1] === '--numstat' && reply('-\t-\timage.png'), true],
    ['import-check', (c, a) => a[0].endsWith('graduation-import-check.mjs') && reply({ findings: [{}] }), true],
    ['verify-red', (c, a) => a[1] === 'verify' && reply({ verdict: { ok: false, checks: [{ outcome: 'fail' }] } }, 1), true],
    ['verify-unrun', (c, a) => a[1] === 'verify' && reply({ verdict: { ok: false, checks: [{ outcome: 'unrun' }] } }), true],
    ['open-pr', (c, a) => a[1] === 'open-pr' && reply({}), true],
    ['release', (c, a) => a[1] === 'release' && reply('', 1), true],
  ]) it(`stops closed on ${reason} and releases any acquired lane`, () => {
    const { result, calls } = fixture({ change });
    expect(result.ok).toBe(false); expect(result.stopReason).toBe(reason);
    expect(released(calls)).toBe(acquired);
    if (reason === 'conflict') expect(result.files).toEqual(['file.mjs']);
    if (reason === 'too-large') {
      expect(result.suggestedSplit[0].requiresManualSplit).toBe(true);
      expect(result.suggestedSplit.every(g => g.nonTest <= 300)).toBe(true);
    }
  });
  for (const step of ['acquire', 'fetch', 'reset', 'cherry-pick', 'push']) it(`releases after ${step} command failure`, () => {
    const { result, calls } = fixture({ change: (c, a) => (a[0] === step || a[1] === step) && reply('', 1) });
    expect(result.ok).toBe(false); expect(released(calls)).toBe(step !== 'acquire');
  });
  it('reports release failure when the CLI released no lease', () => {
    expect(fixture({ change: (c, a) => a[1] === 'release' && reply({ released: 0 }) }).result)
      .toMatchObject({ ok: false, stopReason: 'release', releaseFailed: true });
  });
  it('surfaces release failure even after another stop', () => {
    const { result } = fixture({ change: (c, a) =>
      (a[0] === 'cherry-pick' || a[1] === 'release') && reply('', 1) });
    expect(result).toMatchObject({ ok: false, stopReason: 'release', releaseFailed: true });
  });
  it('reports cleanup failure', () => {
    expect(fixture({ options: { cleanup: () => { throw Error('cleanup'); } } }).result.stopReason).toBe('cleanup');
  });
  it('refuses an invalid acquisition response', () => {
    const f = fixture({ change: (c, a) => a[1] === 'acquire' && reply({ lane: 8 }) });
    expect(f.result.stopReason).toBe('acquire-invalid'); expect(released(f.calls)).toBe(true);
  });
  it('refuses failed source resolution before leasing', () => {
    const f = fixture({ change: (c, a) => a[0] === 'rev-parse' && reply('', 1) });
    expect(f.result.stopReason).toBe('source'); expect(released(f.calls)).toBe(false);
  });
  it('keeps conflicting dry-runs read-only', () => {
    const f = fixture({ over: { dryRun: true }, change: (c, a) => a[0] === 'merge-tree' && reply(`${sha}\nfile\n\nconflict`, 1) });
    expect(f.result.stopReason).toBe('conflict'); expect(f.calls.every(c => c.cmd !== 'node')).toBe(true);
  });
  for (const verdict of [null, { checks: [] }, { ok: true, checks: [{ outcome: 'unknown' }] }]) {
    it('refuses incomplete verification evidence', () => {
      expect(fixture({ change: (c, a) => a[1] === 'verify' && reply({ verdict }) }).result.stopReason).toBe('verify-unrun');
    });
  }
  it('refuses malformed import-check evidence', () => {
    expect(fixture({ change: (c, a) => a[0].endsWith('graduation-import-check.mjs') && reply('bad') }).result.stopReason).toBe('import-check');
  });
  it('refuses unsafe input before commands', () => {
    const { result, calls } = fixture({ over: { purpose: '../bad' } });
    expect(result.stopReason).toBe('input'); expect(calls).toEqual([]);
  });
  it('refuses missing stack evidence', () => {
    expect(fixture({ over: { stackOn: '1' }, change: (c, a) => a[1] === 'view' && reply({}) }).result.stopReason).toBe('stack-base');
  });
  it('releases when evidence cannot parse or template IO throws', () => {
    expect(fixture({ change: (c, a) => a[1] === 'verify' && reply('broken') }).result.stopReason).toBe('verify-unrun');
    const f = fixture({ over: { bodyTemplate: 'missing' }, options: { readTemplate: () => { throw new Error('missing'); } } });
    expect(f.result.ok).toBe(false); expect(released(f.calls)).toBe(true);
  });
  it('counts a directory containing .test. as production code', () => {
    expect(measureSize('301\t0\tproduction.test.data/source.mjs').nonTest).toBe(301);
  });
  it('refuses a successful merge command with no tree evidence', () => {
    expect(fixture({ change: (c, a) => a[0] === 'merge-tree' && reply('') }).result.stopReason).toBe('merge-tree');
  });
  it('suggests bounded directory groups and names oversized file fallback', () => {
    const m = measureSize('200\t0\ta/one\n120\t0\ta/two\n50\t0\tb/three\n9\t1\tx/__fixtures__/fixture');
    expect(m).toMatchObject({ nonTest: 370, test: 10, files: 4 });
    expect(suggestedSplit(m.entries).map(g => g.nonTest)).toEqual([200, 120, 50]);
  });
  it('declares a pure plan, a non-idempotent effect and its result verdict', () => {
    const declaration = graduateChainOperation({});
    const parsed = parseOperationArgv(declaration, ['--source=lane/a', '--purpose=slice', '--title=t', '--body-template=b', '--stack-on=2', '--dry-run']);
    expect(parsed.input).toMatchObject({ 'dry-run': true, 'body-template': 'b', 'stack-on': '2' });
    expect(declaration.steps.map(({ name, step }) => [name, step.kind])).toEqual([
      ['plan', 'compute'], ['run', 'effect'], ['result', 'compute'],
    ]);
    expect(isReadOnlyOperation(declaration)).toBe(false);
    expect(declaration.verdictFrom).toBe('result');
    const plan = declaration.steps[0].step.fn({ input: parsed.input });
    expect(plan).toMatchObject({ source: 'lane/a', purpose: 'slice', title: 't', bodyTemplate: 'b', stackOn: '2', dryRun: true });
    expect(declaration.steps[1].step.effects({ findings: { plan } })).toEqual([
      { type: 'graduate-chain.run', idempotent: false, payload: plan },
    ]);
  });
  for (const over of [{ purpose: '../bad' }, { title: ' ' }, { source: '-bad' }, { source: 'a...b' },
    { source: 'a..' }, { source: 'a..b..c' }, { 'stack-on': 'bad' }]) {
    it(`refuses invalid input in the plan: ${JSON.stringify(over)}`, () => {
      const plan = graduateChainOperation({}).steps[0].step;
      expect(() => plan.fn({ input: { ...input, ...over } })).toThrow('input');
    });
  }
  for (const reason of [null, 'verify-red', 'release']) {
    it(`exposes the full effect result as the CLI verdict: ${reason ?? 'success'}`, async () => {
      const result = fixture({ change: (c, a) => reason === 'verify-red' && a[1] === 'verify'
        ? reply({ verdict: { ok: false, checks: [{ outcome: 'fail' }] } }, 1)
        : reason === 'release' && a[1] === 'release' && reply('', 1) }).result;
      const registry = createRegistry();
      registry.register(graduateChainOperation({}));
      const calls = [];
      const sinks = createGraduateChainSinks({ run: payload => { calls.push(payload); return result; } });
      const run = startRun({ op: 'graduate-chain', id: 'graduate-test', input, registry });
      const outcome = await driveRun({ run, registry, store: createMemoryRunStore(), sinks });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject(input);
      expect(outcome.run.findings.run.effects[0]).toMatchObject({ status: 'applied', result });
      expect(outcome.run.verdict).toEqual(result);
      expect(result.stopReason).toBe(reason);
      expect(finishGraduateChain({ run: outcome.run, code: 0, lines: [] })).toEqual({
        code: reason === null ? 0 : 1, lines: [JSON.stringify(result)],
      });
    });
  }
  it('preserves the CLI failure when no verdict was reached', () => {
    expect(finishGraduateChain({ run: { verdict: null }, code: 1, lines: ['input failed'] }))
      .toEqual({ code: 1, lines: ['input failed'] });
  });
});
