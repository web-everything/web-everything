import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { withBareOrigin } from './helpers/real-repo.mjs';
import { createGraduateChainRunner, createGraduateChainSinks } from '../graduate-chain-io.mjs';
import { cascadePolicy } from '../../lib/policy-cascade.mjs';
import { LANE_GIT_CONFIG_PINS } from '../../lib/lane-git-hardening.mjs';
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
      if (args[0] === 'api') return value({ data: { viewer: { login: 'me' } } });
      if (args[1] === 'view') return value({ headRefName: 'lane/parent', headRefOid: base, isCrossRepository: false });
      return value([]);
    }
    if (cmd === 'git') {
      if (args[0] === 'merge-tree') return value(sha + '\n');
      if (args[0] === 'merge-base') return value(base);
      if (args[0] === 'rev-parse') return value(args.at(-1).startsWith('origin/') ? base : sha);
      if (args[0] === 'rev-list') return value(args.includes('--merges') ? '' : sha);
      if (args[0] === 'diff') return value(args.includes('--numstat') ? '12\t3\tscripts/file.mjs\n4\t1\tscripts/__tests__/file.test.mjs' : '2 files changed');
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
  for (const dryRun of [false, true]) {
    it(`hardens every Git subprocess after composing its environment (dryRun=${dryRun})`, () => {
      const inherited = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor',
        GIT_CONFIG_VALUE_0: 'untrusted-monitor', GIT_EXTERNAL_DIFF: 'untrusted-diff', KEEP_ME: 'present' };
      const objects = { GIT_OBJECT_DIRECTORY: '/temporary/objects',
        GIT_ALTERNATE_OBJECT_DIRECTORIES: '/source/objects' };
      const { result, calls } = fixture({ over: { dryRun }, options: {
        env: inherited, mergeEnvironment: () => objects,
      } });
      expect(result.ok).toBe(true);
      const gitCalls = calls.filter(c => c.cmd === 'git');
      expect(gitCalls.length).toBeGreaterThan(0);
      for (const call of gitCalls) {
        const config = Object.fromEntries(Array.from({ length: Number(call.env.GIT_CONFIG_COUNT) },
          (_, i) => [call.env[`GIT_CONFIG_KEY_${i}`], call.env[`GIT_CONFIG_VALUE_${i}`]]));
        expect(config, call.args.join(' ')).toMatchObject(Object.fromEntries(LANE_GIT_CONFIG_PINS));
        expect(call.env.GIT_EXTERNAL_DIFF).toBeUndefined();
        expect(call.env.GIT_NO_LAZY_FETCH).toBe('1');
        expect(call.env.KEEP_ME).toBe('present');
        if (call.args[0] === 'diff') expect(call.args).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']));
      }
      expect(gitCalls.find(c => c.args[0] === 'merge-tree').env).toMatchObject(objects);
      if (dryRun) expect(gitCalls.find(c => c.args.includes('--numstat')).env).toMatchObject(objects);
      else for (const name of ['reset', 'cherry-pick']) {
        expect(gitCalls.find(c => c.args[0] === name).env.LANE_SESSION).toBe('held');
      }
      expect(inherited.GIT_CONFIG_COUNT).toBe('1');
      expect(inherited.GIT_EXTERNAL_DIFF).toBe('untrusted-diff');
    });
  }
  it('Git resolves fsmonitor as disabled in the actual replay subprocess environment', () => {
    let resolved;
    const { result } = fixture({ options: { env: { GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'untrusted-monitor' } },
    change: (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'reset') resolved = spawnSync('git', ['config', '--get', 'core.fsmonitor'], {
        encoding: 'utf8', env: { ...process.env, ...opts.env }, timeout: 5000,
      });
    } });
    expect(result.ok).toBe(true);
    expect(resolved.status).toBe(0);
    expect(resolved.stdout.trim()).toBe('false');
  });
  for (const dryRun of [false, true]) {
    for (const login of ['slice-worker[bot]', 'app/slice-worker', 'app/Slice-Worker']) {
      it(`installation credentials count the posting bot (${login}, dryRun=${dryRun})`, () => {
        const change = (count) => (cmd, args) => {
          if (cmd !== 'gh') return;
          if (args[0] === 'repo') return reply('owner/repo');
          if (args[1] === 'list') return reply(prs(count).map(p => ({ ...p, author: { login } })));
          if (args[0] === 'api') return args[1] === 'user'
            ? reply({ message: 'Resource not accessible by integration' }, 403)
            : reply({ data: { viewer: { login: 'slice-worker[bot]' } } });
        };
        const below = fixture({ over: { dryRun }, change: change(3) });
        expect(below.result.ok).toBe(true);
        const identity = below.calls.find(c => c.cmd === 'gh' && c.args[0] === 'api');
        expect(identity.args).toEqual(['api', 'graphql', '-f', 'query={ viewer { login } }']);
        expect(identity.env.GH_REPO).toBe('owner/repo');
        const capped = fixture({ over: { dryRun }, change: change(4) });
        expect(capped.result.stopReason).toBe('cap-caller');
        expect(capped.calls.some(c => c.cmd === 'node')).toBe(false);
      });
    }
    for (const source of ['lane/source', 'old..new']) {
      it(`rejects merge history before replay (${source}, dryRun=${dryRun})`, () => {
        const merge = 'c'.repeat(40);
        const { result, calls } = fixture({ over: { source, dryRun }, change: (cmd, args) => {
          if (cmd === 'git' && args[0] === 'rev-list') return reply(args.includes('--merges') ? merge : `${sha}\n${merge}`);
        } });
        expect(result).toMatchObject({ ok: false, stopReason: 'source-merges', merges: [merge] });
        expect(result.detail).toContain('linear');
        expect(calls.some(c => ['merge-tree', 'reset', 'cherry-pick'].includes(c.args[0]))).toBe(false);
        expect(released(calls)).toBe(!dryRun);
        const check = calls.find(c => c.args.includes('--merges'));
        expect(check.args).toContain(`^${base}`);
        expect(check.cwd).toBe(dryRun ? '/repo' : '/lane');
      });
    }
  }
  for (const response of [null, {}, { data: { viewer: null } }, { data: { viewer: { login: '' } } },
    { data: { viewer: { login: 'me\n' } } },
    { data: { viewer: { login: 'me' } }, errors: [{ message: 'partial response' }] }]) {
    it(`installation identity fails closed on incomplete GraphQL evidence: ${JSON.stringify(response)}`, () => {
      const { result, calls } = fixture({ change: (cmd, args) => cmd === 'gh' && args[0] === 'api' && reply(response) });
      expect(result.stopReason).toBe('caps-unreadable');
      expect(calls.some(c => c.cmd === 'node')).toBe(false);
    });
  }
  it('merge history checks fail closed and release the acquired lane', () => {
    const { result, calls } = fixture({ change: (cmd, args) =>
      cmd === 'git' && args.includes('--merges') && reply('', 128) });
    expect(result.stopReason).toBe('source');
    expect(released(calls)).toBe(true);
    expect(calls.some(c => c.args[0] === 'cherry-pick')).toBe(false);
  });
  it('installation identity command failures stop before acquisition', () => {
    const { result, calls } = fixture({ change: (cmd, args) =>
      cmd === 'gh' && args[0] === 'api' && reply('', 1) });
    expect(result.stopReason).toBe('caps');
    expect(calls.some(c => c.cmd === 'node')).toBe(false);
  });
  it('installation identity cannot turn a truncated PR list into cap evidence', () => {
    const { result, calls } = fixture({ change: (cmd, args) =>
      cmd === 'gh' && args[1] === 'list' && reply(prs(1000)) });
    expect(result.stopReason).toBe('caps-unreadable');
    expect(calls.some(c => c.cmd === 'node')).toBe(false);
  });
  it('installation bot identity does not conflate a human with the same bare login', () => {
    const { result } = fixture({ change: (cmd, args) => {
      if (cmd === 'gh' && args[0] === 'api') return reply({ data: { viewer: { login: 'me[bot]' } } });
      if (cmd === 'gh' && args[1] === 'list') return reply(prs(4));
    } });
    expect(result.ok).toBe(true);
  });
  it('real merge history is refused in both modes; a merge already in the stack base is excluded', async () => {
    await withBareOrigin(ctx => {
      ctx.seedOriginBranch('lane/left', { 'left.mjs': 'export const left = 1;\n' });
      ctx.seedOriginBranch('lane/right', { 'right.mjs': 'export const right = 1;\n' });
      ctx.git(['fetch', 'origin']);
      ctx.git(['switch', '-c', 'source', 'origin/lane/left']);
      ctx.git(['merge', '--no-edit', 'origin/lane/right']);
      const merge = ctx.git(['rev-parse', 'HEAD']).trim();
      const start = ctx.git(['rev-parse', 'origin/main']).trim();
      const calls = [];
      const exec = (cmd, args, opts) => {
        calls.push({ cmd, args });
        if (cmd === 'gh') return reply(args[0] === 'api' ? { data: { viewer: { login: 'me' } } }
          : args[0] === 'repo' ? 'owner/repo' : args[1] === 'view'
            ? { headRefName: 'lane/merged', headRefOid: merge, isCrossRepository: false } : []);
        if (cmd === 'node' && args[1] === 'acquire') return reply({ lane: 8, path: ctx.clone, holder: 'held' });
        if (cmd === 'node' && args[1] === 'release') return reply({ released: 1 });
        if (cmd !== 'git') throw Error('unexpected publication');
        return spawnSync(cmd, args, { ...opts, encoding: 'utf8', maxBuffer: 1024 * 1024 });
      };
      const run = createGraduateChainRunner({ exec, cwd: ctx.clone, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
      for (const dryRun of [true, false]) {
        for (const source of [merge, `${start}..${merge}`]) {
          calls.length = 0;
          expect(run({ ...input, source, dryRun })).toMatchObject({ ok: false, stopReason: 'source-merges', merges: [merge] });
          expect(calls.some(c => ['reset', 'cherry-pick', 'merge-tree'].includes(c.args[0]))).toBe(false);
          expect(released(calls)).toBe(!dryRun);
        }
      }
      ctx.commit({ 'slice.mjs': 'export const slice = 1;\n' });
      const tip = ctx.git(['rev-parse', 'HEAD']).trim();
      const result = run({ ...input, source: `${start}..${tip}`, stackOn: '7', dryRun: true });
      expect(result).toMatchObject({ ok: true, size: { nonTest: 1, test: 0, files: 1 } });
      expect(result.steps.find(s => s.step === 'cherry-pick').would).toBe(`apply ${tip} over ${merge}`);
    });
  });
  for (const source of ['lane/source', 'old..new']) {
    for (const dryRun of [false, true]) {
      it(`refuses the parent destination before any mutation (${source}, dryRun=${dryRun})`, () => {
        const { result, calls, bodies, cleaned } = fixture({ over: { source, dryRun, stackOn: '7', purpose: 'parent' },
          change: (cmd, args) => cmd === 'node' && args[1] === 'open-pr'
            && reply({ findings: { submit: { effects: [{ result: { outcome: 'opened', pr: 7 } }] } } }) });
        expect(result).toMatchObject({ ok: false, pr: null, stopReason: 'stack-destination' });
        expect(calls.some(c => c.cmd === 'node')).toBe(false);
        expect(calls.some(c => ['fetch', 'reset', 'cherry-pick', 'push'].includes(c.args[0]))).toBe(false);
        expect(bodies).toEqual([]);
        expect(cleaned).toBe(true);
      });
    }
  }
  for (const source of ['lane/source', 'old..new']) {
    for (const dryRun of [false, true]) {
      it(`excludes commits reachable from the stack base: ${source}, dryRun=${dryRun}`, () => {
        const ancestor = 'c'.repeat(40);
        const { result, calls } = fixture({ over: { source, stackOn: '7', dryRun }, change: (cmd, args) => {
          if (cmd === 'git' && args[0] === 'merge-base') return reply(ancestor);
          if (cmd === 'git' && args[0] === 'rev-list') return reply(args.includes('--merges') ? '' : args.includes(`^${base}`) ? sha : `${base}\n${sha}`);
        } });
        expect(result.ok).toBe(true);
        expect(calls.find(c => c.args[0] === 'rev-list').args).toContain(`^${base}`);
        if (dryRun) expect(result.steps.find(s => s.step === 'cherry-pick').would).toBe(`apply ${sha} over ${base}`);
        else {
          expect(calls.find(c => c.args[0] === 'cherry-pick').args).toEqual(['cherry-pick', sha]);
          expect(calls.find(c => c.args[0] === 'log').args).toEqual(['log', '--oneline', '--no-walk', sha]);
        }
      });
    }
  }
  it('sizes a dry-run against the selected base using the quarantined merged tree', () => {
    const ancestor = 'c'.repeat(40), tree = 'd'.repeat(40);
    const mergeEnv = { GIT_OBJECT_DIRECTORY: '/quarantine' };
    const { result, calls } = fixture({ over: { stackOn: '7', dryRun: true },
      options: { mergeEnvironment: () => mergeEnv }, change: (cmd, args) => {
        if (cmd === 'git' && args[0] === 'merge-base') return reply(ancestor);
        if (cmd === 'git' && args[0] === 'merge-tree') return reply(tree);
        if (cmd === 'git' && args.includes('--numstat')) return reply(args.at(-1) === `${base}..${tree}` ? '1\t0\tslice.mjs' : '301\t0\tparent.mjs');
      } });
    expect(result).toMatchObject({ ok: true, size: { nonTest: 1, test: 0, files: 1 } });
    expect(calls.find(c => c.args.includes('--numstat')).env).toMatchObject(mergeEnv);
  });
  it('refuses a source wholly reachable from the stack base and releases the lane', () => {
    const { result, calls } = fixture({ over: { stackOn: '7' }, change: (cmd, args) =>
      cmd === 'git' && args[0] === 'rev-list' && reply(args.includes(`^${base}`) ? '' : base) });
    expect(result).toMatchObject({ ok: false, stopReason: 'empty-source' });
    expect(released(calls)).toBe(true);
  });
  it('selects the slice in the acquired lane after fetching a base absent from the source checkout', () => {
    const { result, calls } = fixture({ over: { stackOn: '7' }, change: (cmd, args, opts) =>
      cmd === 'git' && args[0] === 'rev-list' && opts.cwd !== '/lane' && reply('missing base object', 128) });
    expect(result.ok).toBe(true);
    const selection = calls.findIndex(c => c.args[0] === 'rev-list');
    expect(calls[selection].cwd).toBe('/lane');
    expect(calls.slice(0, selection).some(c => c.args[0] === 'fetch' && c.args.includes(base))).toBe(true);
  });
  it('delegates publication to open-pr so a foreign fix claim can refuse it', () => {
    const { result, calls } = fixture({ over: { source: 'old..new', stackOn: '7', purpose: 'victim' },
      change: (cmd, args) => cmd === 'node' && args[1] === 'open-pr'
        && reply({ findings: { submit: { effects: [{ result: { outcome: 'refused', reason: 'fix-claimed', pr: 7 } }] } } }, 1) });
    expect(result).toMatchObject({ ok: false, stopReason: 'open-pr' });
    expect(calls.filter(c => c.cmd === 'git' && c.args[0] === 'push')).toEqual([]);
    expect(calls.find(c => c.args[1] === 'open-pr').args).toEqual(expect.arrayContaining([
      '--ref=lane/victim', `--sha=${sha}`, '--base=lane/parent',
    ]));
    expect(released(calls)).toBe(true);
  });
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
        if (cmd === 'gh') return reply(args[0] === 'api' ? { data: { viewer: { login: 'me' } } } : args[1] === 'view'
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
  it('real linear stack selects only B over A and excludes the large parent from dry-run sizing', async () => {
    await withBareOrigin(ctx => {
      ctx.seedOriginBranch('lane/stack', { 'parent.mjs': 'export const parent = 1;\n'.repeat(301) });
      ctx.seedOriginBranch('lane/source', { 'slice.mjs': 'export const slice = 1;\n' }, 'lane/stack');
      for (const ref of ['lane/source', 'lane/stack']) ctx.git(['fetch', 'origin', `refs/heads/${ref}:refs/remotes/origin/${ref}`]);
      const stackSha = ctx.git(['rev-parse', 'origin/lane/stack']).trim();
      const sourceSha = ctx.git(['rev-parse', 'origin/lane/source']).trim();
      const exec = (cmd, args, opts) => {
        if (cmd === 'gh') return reply(args[0] === 'api' ? { data: { viewer: { login: 'me' } } } : args[1] === 'view'
          ? { headRefName: 'lane/stack', headRefOid: stackSha, isCrossRepository: false } : []);
        if (cmd !== 'git') throw Error('dry-run attempted mutation');
        return spawnSync(cmd, args, { ...opts, encoding: 'utf8', maxBuffer: 1024 * 1024 });
      };
      const result = createGraduateChainRunner({ exec, cwd: ctx.clone, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })(
        { ...input, source: 'origin/lane/source', stackOn: '7', dryRun: true });
      expect(result).toMatchObject({ ok: true, size: { nonTest: 1, test: 0, files: 1 } });
      expect(result.steps.find(s => s.step === 'cherry-pick').would).toBe(`apply ${sourceSha} over ${stackSha}`);
    });
  });
  for (const dryRun of [true, false]) {
    for (const explicitRange of [false, true]) {
      it(`preflights only B when the stack advances shared A (dryRun=${dryRun}, range=${explicitRange})`, async () => {
        await withBareOrigin(ctx => {
          ctx.seedOriginBranch('main', { 'f.txt': 'v0\n' });
          ctx.seedOriginBranch('lane/shared', { 'f.txt': 'v1\n' });
          ctx.seedOriginBranch('lane/source', { 'slice.mjs': 'export const slice = 1;\n' }, 'lane/shared');
          ctx.seedOriginBranch('lane/stack', { 'f.txt': 'v2\n' }, 'lane/shared');
          ctx.git(['fetch', 'origin']);
          const start = ctx.git(['rev-parse', 'origin/main']).trim();
          const tip = ctx.git(['rev-parse', 'origin/lane/source']).trim();
          const stack = ctx.git(['rev-parse', 'origin/lane/stack']).trim();
          const calls = [];
          const exec = (cmd, args, opts) => {
            calls.push({ cmd, args, cwd: opts.cwd });
            if (cmd === 'gh') return reply(args[0] === 'api' ? { data: { viewer: { login: 'me' } } }
              : args[0] === 'repo' ? 'owner/repo' : args[1] === 'view'
                ? { headRefName: 'lane/stack', headRefOid: stack, isCrossRepository: false } : []);
            if (cmd === 'node') {
              if (args[1] === 'acquire') return reply({ lane: 8, path: ctx.clone, holder: 'held' });
              if (args[1] === 'release') return reply({ released: 1 });
              if (args[0].endsWith('graduation-import-check.mjs')) return reply({ findings: [] });
              if (args[1] === 'verify') return reply(goodVerify);
              if (args[1] === 'open-pr') return reply(opened);
            }
            if (cmd !== 'git') throw Error('unexpected command');
            return spawnSync(cmd, args, { ...opts, encoding: 'utf8', maxBuffer: 1024 * 1024 });
          };
          const result = createGraduateChainRunner({ exec, cwd: ctx.clone,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })({ ...input,
            source: explicitRange ? `${start}..${tip}` : 'origin/lane/source',
            stackOn: '7', dryRun, bodyTemplate: 'README.md' });
          expect(result.stopReason).not.toBe('conflict');
          expect(result).toMatchObject({ ok: true, size: { nonTest: 1, test: 0, files: 1 } });
          if (dryRun) {
            expect(result.steps.find(s => s.step === 'cherry-pick').would).toBe(`apply ${tip} over ${stack}`);
            expect(calls.some(c => c.args[0] === 'cherry-pick')).toBe(false);
          } else {
            expect(calls.find(c => c.args[0] === 'cherry-pick').args).toEqual(['cherry-pick', tip]);
            expect(ctx.git(['rev-parse', 'HEAD^']).trim()).toBe(stack);
            expect(ctx.git(['show', 'HEAD:f.txt'])).toBe('v2\n');
            expect(ctx.git(['show', 'HEAD:slice.mjs'])).toBe('export const slice = 1;\n');
          }
        });
      });
    }
  }
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
    for (const c of calls.filter(c => ['reset', 'cherry-pick'].includes(c.args[0]) || c.args[1] === 'open-pr')) expect(c.env.LANE_SESSION).toBe('held');
    expect(calls.some(c => c.cmd === 'git' && c.args[0] === 'push')).toBe(false);
    expect(calls.find(c => c.args[1] === 'open-pr').args).toEqual(expect.arrayContaining([
      '--title=A slice $(inert)', '--ref=lane/slice', `--sha=${sha}`,
    ]));
    expect(bodies[0]).toContain('verify: pass');
    expect(released(calls)).toBe(true); expect(cleaned).toBe(true);
  });
  it('dry-run runs caps, merge-tree and selected slice numstat without mutation', () => {
    const { result, calls, bodies } = fixture({ over: { dryRun: true } });
    expect(result.ok).toBe(true);
    expect(calls.every(c => c.cmd !== 'node')).toBe(true);
    expect(calls.some(c => ['fetch', 'reset', 'cherry-pick', 'push', 'checkout', 'switch'].includes(c.args[0]))).toBe(false);
    expect(result.steps.filter(s => s.would).map(s => s.step)).toEqual(['acquire', 'cherry-pick', 'import-check', 'verify', 'body', 'open-pr', 'release']);
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
    ['empty-source', (c, a) => a[0] === 'rev-list' && reply(''), true],
    ['source', (c, a) => a[0] === 'rev-list' && reply('', 128), true],
    ['too-large', (c, a) => a.includes('--numstat') && reply('301\t0\tscripts/big.mjs'), true],
    ['size-unreadable', (c, a) => a.includes('--numstat') && reply('-\t-\timage.png'), true],
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
  for (const step of ['acquire', 'fetch', 'reset', 'cherry-pick', 'open-pr']) it(`releases after ${step} command failure`, () => {
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
  for (const reason of [null, 'verify-red', 'release', 'stack-destination']) {
    it(`exposes the full effect result as the CLI verdict: ${reason ?? 'success'}`, async () => {
      const result = fixture({ over: reason === 'stack-destination' ? { stackOn: '7', purpose: 'parent' } : {},
        change: (c, a) => reason === 'verify-red' && a[1] === 'verify'
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
