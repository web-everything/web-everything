import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { ciUnitPlan, ciGatePlan, urgentMarker, urgentLedger, urgentSignature, urgentKeyPath, normalizeUrgentRepo, urgentFuiRepo } from '../urgent-verify-marker.mjs';
import { createUrgentDeps, urgentVerify } from '../urgent-verify.mjs';
import { resolveOperation } from '../run.mjs';
import { parseOperationArgv } from '../cli-adapter.mjs';

const sha = 'a'.repeat(40), now = Date.parse('2026-11-18T12:00:00Z');
const key = Buffer.alloc(32, 7);
const sign = m => ({ ...m, sig: urgentSignature(m, key) });
const expectedSteps = ['fetch-main-history', 'install-fui', 'install', ...Array.from({ length: 10 }, (_, i) => `unit:unit:${i + 1}/10`), 'coverage', 'hostPaths', 'integration', 'standards'];
const marker = sign( { sha, fuiSha: sha, fuiRepo: urgentFuiRepo, suite: 'full', shards: 10, result: 'green', startedAt: new Date(now - 2000).toISOString(), finishedAt: new Date(now - 1000).toISOString(), host: 'host', repo: 'https://example.com/org/repo', steps: expectedSteps });
const check = (m = marker, input = {}) => urgentMarker({ urgent: true, reason: 'Urgent daemon repair', sha, shards: 10, expectedSteps, now, repo: marker.repo, readKey: () => key, ledger: JSON.stringify(m), ...input });

describe('urgent marker', () => {
  it('accepts an exact full green marker', () => expect(check()).toMatchObject({ ok: true, evidence: { source: 'urgent-local-full', marker } }));
  it.each([
    ['wrong sha', { sha: 'b'.repeat(40) }], ['short sha record', { sha: sha.slice(0, 8) }],
    ['scoped suite', { suite: 'scoped' }], ['red result', { result: 'red' }],
    ['stale', { finishedAt: new Date(now - 7200001).toISOString() }],
    ['future', { finishedAt: new Date(now + 300001).toISOString() }],
    ['legacy receipt without FUI SHA', { fuiSha: undefined }], ['short FUI SHA', { fuiSha: 'abc' }],
    ['wrong shard count', { shards: 9 }], ['missing host', { host: '' }],
    ['non-string host', { host: 42 }], ['invalid finish', { finishedAt: 'invalid' }],
    ['invalid start', { startedAt: null }], ['reversed times', { startedAt: marker.finishedAt }],
  ])('rejects %s', (_, change) => expect(check({ ...marker, ...change })).toMatchObject({ ok: false, fallback: expect.stringContaining('urgent-verify') }));
  it.each([
    ['missing reason', { reason: undefined }], ['short reason', { reason: 'short' }],
    ['missing urgent flag', { urgent: false }], ['short input sha', { sha: sha.slice(0, 8) }],
    ['unreadable ledger', { ledger: undefined }], ['malformed ledger', { ledger: '{oops' }],
    ['unreadable shard count', { shards: undefined }], ['missing key', { readKey: () => { throw new Error('missing'); } }],
    ['wrong key', { readKey: () => Buffer.alloc(32, 8) }], ['short key', { readKey: () => Buffer.alloc(1) }],
    ['wrong repo', { repo: 'https://example.com/other/repo' }],
  ])('rejects %s', (_, input) => expect(check(marker, input).ok).toBe(false));
  it.each([
    ['legacy without main history', expectedSteps.slice(1)], ['empty', []], ['partial', expectedSteps.slice(2)],
    ['reordered', [...expectedSteps].reverse()], ['extra', [...expectedSteps, 'extra']],
    ['wrong group', expectedSteps.map(s => s.replace('unit:unit:', 'unit:covered:'))],
  ])('refuses correctly signed %s steps', (_, steps) => {
    expect(check(sign({ ...marker, steps }))).toMatchObject({ ok: false, detail: 'no-urgent-marker' });
  });
  it.each([undefined, 'https://github.com/other/frontierui', 'https://example.com/frontier-ui/frontierui'])(
    'refuses correctly signed missing or foreign FUI origin %s', fuiRepo => {
      expect(check(sign({ ...marker, fuiRepo }))).toMatchObject({ ok: false, fallback: expect.stringContaining('urgent-verify') });
    });
  it('refuses an unreadable expected step list', () => expect(check(marker, { expectedSteps: undefined }).ok).toBe(false));
  it.each([undefined, '0'.repeat(64), 'bad'])('refuses forged signature %s', sig => expect(check({ ...marker, sig }).ok).toBe(false));
  it('signature covers every evidence field', () => {
    for (const field of ['sha', 'suite', 'shards', 'result', 'startedAt', 'finishedAt', 'host', 'repo', 'steps', 'fuiSha', 'fuiRepo'])
      expect(urgentSignature({ ...marker, [field]: 'tampered' }, key)).not.toBe(marker.sig);
  });
  it('later red for same sha supersedes green, regardless of its timestamp', () => {
    expect(check(marker, { ledger: [marker, { ...marker, result: 'red' }].map(JSON.stringify).join('\n') }).ok).toBe(false);
  });
  it('ignores a later red for a different sha', () => {
    expect(check(marker, { ledger: [marker, { ...marker, sha: 'b'.repeat(40), result: 'red' }].map(JSON.stringify).join('\n') }).ok).toBe(true);
  });
});

function fixture() {
  let tick = now - 1000;
  return { 'fetch-main-history': vi.fn(), verifyFui: vi.fn(() => ({ sha, repo: urgentFuiRepo })), 'install-fui': vi.fn(), install: vi.fn(), repo: () => marker.repo, readKey: () => key, host: 'host', now: () => new Date(tick += 1000).toISOString(), clean: vi.fn(() => true), head: vi.fn(() => sha),
    plan: () => [{ shard: '1/2' }, { shard: '2/2' }], shard: vi.fn(), standards: vi.fn(), coverage: vi.fn(), hostPaths: vi.fn(), integration: vi.fn(), append: vi.fn() };
}
describe('urgent verifier', () => {
  it('records green only after all shards sequentially and standards', async () => {
    const d = fixture(), order = [];
    d.shard = async s => { order.push(s.shard); await Promise.resolve(); order.push('done'); };
    for (const step of ['fetch-main-history', 'install-fui', 'install', 'coverage', 'hostPaths', 'integration', 'standards']) d[step] = () => order.push(step);
    expect(await urgentVerify({ sha, result: 'red' }, d)).toMatchObject({ ok: true });
    expect(order).toEqual(['fetch-main-history', 'install-fui', 'install', '1/2', 'done', '2/2', 'done', 'coverage', 'hostPaths', 'integration', 'standards']);
    expect(d.append).toHaveBeenCalledTimes(1);
    expect(d.append).toHaveBeenCalledWith(expect.objectContaining({ sha, fuiSha: sha, fuiRepo: urgentFuiRepo, suite: 'full', result: 'green', shards: 2, host: 'host', repo: marker.repo, steps: ['fetch-main-history', 'install-fui', 'install', 'unit:unit:1/2', 'unit:unit:2/2', 'coverage', 'hostPaths', 'integration', 'standards'], sig: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });
  it.each(['fetch-main-history', 'install-fui', 'install', 'shard', 'coverage', 'hostPaths', 'integration', 'standards'])('records red when %s fails', async stage => {
    const d = fixture(); d[stage] = vi.fn(() => { throw new Error('failed'); });
    expect(await urgentVerify({ sha, result: 'green' }, d)).toMatchObject({ ok: false, marker: { result: 'red' } });
    expect(d.append).toHaveBeenCalledTimes(1);
    if (stage === 'shard') { expect(d.shard).toHaveBeenCalledTimes(1); expect(d.standards).not.toHaveBeenCalled(); }
  });
  it.each(['dirty', 'wrong head', 'short sha', 'unreadable workflow'])('refuses %s before suites and writes no marker', async kind => {
    const d = fixture();
    if (kind === 'dirty') d.clean.mockReturnValue(false);
    if (kind === 'wrong head') d.head.mockReturnValue('b'.repeat(40));
    if (kind === 'unreadable workflow') d.plan = () => { throw new Error('unreadable'); };
    expect(await urgentVerify({ sha: kind === 'short sha' ? 'abc' : sha }, d)).toMatchObject({ ok: false, fallback: expect.stringContaining('wait for passing CI') });
    expect(d.shard).not.toHaveBeenCalled(); expect(d.append).not.toHaveBeenCalled();
  });
  it('records red if the checkout changes during suites', async () => {
    const d = fixture(); d.clean.mockReturnValueOnce(true).mockReturnValue(false);
    expect(await urgentVerify({ sha }, d)).toMatchObject({ marker: { result: 'red' } });
  });
  it.each([
    ['HEAD', { sha: 'b'.repeat(40), repo: urgentFuiRepo }],
    ['origin', { sha, repo: 'https://example.com/foreign/repo' }],
    ['missing evidence', undefined],
  ])('records red if final FUI %s differs from the recorded checkout', async (_, finalFui) => {
    const d = fixture();
    d.verifyFui.mockReturnValueOnce({ sha, repo: urgentFuiRepo }).mockReturnValueOnce(finalFui);
    expect(await urgentVerify({ sha }, d)).toMatchObject({ ok: false, marker: { result: 'red', fuiSha: sha, fuiRepo: urgentFuiRepo } });
    expect(d.verifyFui).toHaveBeenLastCalledWith({ sha, repo: urgentFuiRepo });
    expect(d.verifyFui.mock.invocationCallOrder.at(-1)).toBeGreaterThan(d.standards.mock.invocationCallOrder[0]);
    expect(d.append).toHaveBeenCalledTimes(1);
  });
  it('binds the operation and exposes sha in generated argv parsing', () => {
    const { declaration, sinks } = resolveOperation('urgent-verify');
    expect(parseOperationArgv(declaration, [`--sha=${sha}`])).toMatchObject({ input: { sha } });
    expect(sinks['urgent-verify.run']).toBeTypeOf('function');
  });
  it('declares urgent as opt-in and parses its reason for prototype-load', () => {
    const { declaration } = resolveOperation('prototype-load');
    expect(declaration.input.urgent.default).toBe(false);
    expect(parseOperationArgv(declaration, ['--urgent', '--reason=Critical daemon repair'])).toMatchObject({ input: { urgent: true, reason: 'Critical daemon repair' } });
  });
});

describe('real adapter contract with injected filesystem and subprocesses', () => {
  it.each(['dirty worktree', 'changed HEAD', 'changed origin', 'unreadable status'])(
    'records red when the real FUI adapter detects %s after all suites', async change => {
      let finished = false;
      const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
      const packageText = readFileSync('package.json', 'utf8');
      const fs = { readFileSync: p => p.endsWith('.key') ? key : p.endsWith('package.json') ? packageText : workflow,
        mkdirSync: vi.fn(), appendFileSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn(), copyFileSync: vi.fn() };
      const spawnSync = vi.fn((cmd, args, opts) => {
        const sibling = opts.cwd === '/frontierui';
        if (finished && sibling && change === 'unreadable status' && args[0] === 'status') return { status: 1 };
        let stdout = '';
        if (args[0] === 'remote') stdout = sibling ? (finished && change === 'changed origin' ? marker.repo : urgentFuiRepo) : marker.repo;
        if (args[0] === 'rev-parse') stdout = finished && sibling && change === 'changed HEAD' ? 'b'.repeat(40) : sha;
        if (args[0] === 'status' && finished && sibling && change === 'dirty worktree') stdout = '?? unexpected-file';
        if (args[0]?.includes('shard-assign')) stdout = 'scripts/example.test.mjs\n';
        return { status: 0, stdout };
      });
      const d = createUrgentDeps({ cwd: '/repo', home: '/home/test', fs, spawnSync });
      const standards = d.standards;
      d.standards = () => { standards(); finished = true; };
      expect(await urgentVerify({ sha }, d)).toMatchObject({ ok: false, marker: { result: 'red', fuiSha: sha, fuiRepo: urgentFuiRepo } });
      expect(finished).toBe(true);
      expect(spawnSync.mock.calls.filter(([, args]) => args[0] === 'fetch')).toHaveLength(1);
      expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
    });
  it('strips CI markers from every subprocess so host admission cannot be bypassed', () => {
    const markers = ['CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION', 'GITLAB_CI',
      'BUILDKITE', 'CIRCLECI', 'TRAVIS', 'JENKINS_URL', 'TEAMCITY_VERSION', 'TF_BUILD', 'BUILD_NUMBER'];
    const env = { PATH: '/bin', HOME: '/home/test', ...Object.fromEntries(markers.map(k => [k, 'true'])) };
    const spawnSync = vi.fn(() => ({ status: 0, stdout: '' }));
    const deps = createUrgentDeps({ env, spawnSync });
    deps.standards(); deps.shard({ shard: '1/1' });
    expect(spawnSync).toHaveBeenCalledTimes(2);
    for (const [, args, options] of spawnSync.mock.calls) {
      expect(args[0]).toBe('scripts/readiness/heavy-admission.mjs');
      expect(options.env).toEqual({ PATH: '/bin', HOME: '/home/test' });
      for (const marker of markers) expect(options.env).not.toHaveProperty(marker);
    }
    expect(env.CI).toBe('true');
  });
  it('reads the current ten CI groups, runs every shard through admission and appends privately', async () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const plan = ciUnitPlan(workflow);
    expect(plan).toHaveLength(10);
    expect(plan[0]).toEqual({ group: 'covered', shard: '1/9' });
    expect(plan[9]).toEqual({ group: 'nocov', shard: '1/1' });
    const packageText = readFileSync('package.json', 'utf8');
    const fs = { readFileSync: vi.fn(p => p.endsWith('.key') ? key : p.endsWith('package.json') ? packageText : workflow), mkdirSync: vi.fn(), appendFileSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn(), copyFileSync: vi.fn() };
    const spawnSync = vi.fn((cmd, args, opts) => ({ status: 0, stdout: args[0] === 'status' ? '' : args[0] === 'rev-parse' ? sha : args[0] === 'remote' ? `${opts.cwd === '/frontierui' ? urgentFuiRepo : marker.repo}.git/\n` : args[0]?.includes('shard-assign') ? 'scripts/example.test.mjs\n' : '' }));
    const d = createUrgentDeps({ cwd: '/repo', home: '/home/test', fs, spawnSync,
      env: { PATH: '/bin', HOME: '/home/test', URGENT_KEY: urgentKeyPath('/home/test'), NODE_OPTIONS: urgentKeyPath('/home/test') } });
    expect((await urgentVerify({ sha }, d)).ok).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith('sh', ['scripts/ci/fetch-main-history.sh'], expect.objectContaining({ cwd: '/repo' }));
    const heavy = spawnSync.mock.calls.filter(([, args]) => args[0].endsWith('scripts/readiness/heavy-admission.mjs'));
    expect(heavy).toHaveLength(17);
    expect(heavy.slice(0, 3).map(([, a, o]) => [a.slice(4), o.cwd])).toEqual([
      [['npm', 'ci'], '/frontierui'], [['npm', 'run', 'build:tools'], '/frontierui'], [['npm', 'ci'], '/repo']]);
    expect(spawnSync.mock.calls.every(([, , o]) => !JSON.stringify(o.env).includes(urgentKeyPath('/home/test')) && !Object.keys(o.env).some(k => k.startsWith('URGENT_')))).toBe(true);
    const keyReadOrder = fs.readFileSync.mock.invocationCallOrder[fs.readFileSync.mock.calls.findIndex(([p]) => p.endsWith('.key'))];
    expect(keyReadOrder).toBeGreaterThan(spawnSync.mock.invocationCallOrder.at(-1));
    expect(heavy.every(([, args, opts]) => args.includes('--wait-ms=60000') && opts.maxBuffer > 0 && opts.timeout > 0)).toBe(true);
    expect(heavy.slice(3, 13).every(([, args]) => args.includes('vitest') && args.includes('scripts/example.test.mjs'))).toBe(true);
    const coverageArgs = JSON.parse(packageText).scripts['test:coverage:shard'].split(' -- ')[1].split(' ');
    expect(heavy[3][1].slice(4, -1)).toEqual(coverageArgs);
    expect(heavy[13][1].slice(4)).toEqual(['npm', 'run', 'coverage:merge', '--', 'coverage-shards', '--threshold=80', '--expect=9']);
    expect(heavy[14][1].slice(4)).toEqual(['node', 'scripts/lint-host-paths.mjs']);
    expect(heavy[15][1].slice(4)).toEqual(['npm', 'run', 'test:integration:vitest', '--']);
    expect(heavy[16][1]).toContain('check:standards');
    expect(fs.copyFileSync.mock.calls).toEqual(Array.from({ length: 9 }, (_, i) => ['/repo/coverage/coverage-final.json', `/repo/coverage-shards/coverage-shard-${i + 1}/coverage-final.json`]));
    expect(fs.rmSync).toHaveBeenCalledWith('/repo/coverage-shards', { recursive: true, force: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(urgentKeyPath('/home/test'), expect.any(Buffer), { flag: 'wx', mode: 0o600 });
    expect(fs.appendFileSync).toHaveBeenCalledWith(urgentLedger('/home/test'), expect.stringMatching(/"suite":"full".*\n$/), { encoding: 'utf8', mode: 0o600 });
  });
  it.each(['broken', 'jobs: {}', 'jobs:\n  test-shard:\n    strategy:\n      matrix:\n        shard: [1, 3]', `jobs:\n  test-shard:\n    strategy:\n      matrix:\n        shard: [${Array.from({ length: 65 }, (_, i) => i + 1)}]`])('refuses unreadable or oversized CI plans with a diagnostic', workflow => {
    expect(() => ciUnitPlan(workflow)).toThrow();
  });
  it('refuses unknown npm command syntax without running a shard', () => {
    const spawnSync = vi.fn(() => ({ status: 0, stdout: 'scripts/example.test.mjs\n' }));
    const d = createUrgentDeps({ fs: { readFileSync: () => JSON.stringify({ scripts: { 'test:unit': 'vitest run; echo bypass' } }) }, spawnSync });
    expect(() => d.shard({ group: 'nocov', shard: '1/1' })).toThrow('unreadable CI Vitest command');
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
  it('signs red and stops before suites when the workflow main-history script fails', async () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const fs = { readFileSync: p => p.endsWith('.key') ? key : workflow, mkdirSync: vi.fn(), appendFileSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn() };
    const spawnSync = vi.fn((cmd, args) => ({ status: cmd === 'sh' ? 1 : 0, stdout: args[0] === 'status' ? '' : args[0] === 'rev-parse' ? sha : marker.repo }));
    const result = await urgentVerify({ sha }, createUrgentDeps({ cwd: '/repo', fs, spawnSync }));
    expect(result).toMatchObject({ ok: false, marker: { result: 'red', steps: ['fetch-main-history'], sig: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(spawnSync).toHaveBeenCalledWith('sh', ['scripts/ci/fetch-main-history.sh'], expect.objectContaining({ cwd: '/repo' }));
    expect(spawnSync.mock.calls.some(([, args]) => args[0].includes('heavy-admission'))).toBe(false);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
  });
  it('treats admission failure as red and appends once without retrying', async () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8'), packageText = readFileSync('package.json', 'utf8');
    const fs = { readFileSync: p => p.endsWith('.key') ? key : p.endsWith('package.json') ? packageText : workflow, mkdirSync: vi.fn(), appendFileSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn() };
    const spawnSync = vi.fn((cmd, args, opts) => ({ status: args[0].includes('heavy-admission') ? 75 : 0, stdout: args[0] === 'status' ? '' : args[0] === 'rev-parse' ? sha : args[0] === 'remote' ? (opts.cwd.endsWith('/frontierui') ? urgentFuiRepo : marker.repo) : 'scripts/example.test.mjs\n' }));
    expect(await urgentVerify({ sha }, createUrgentDeps({ fs, spawnSync }))).toMatchObject({ ok: false, marker: { result: 'red' } });
    expect(spawnSync.mock.calls.filter(([, args]) => args[0].includes('heavy-admission'))).toHaveLength(1);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
  });
});


describe('CI gate mirroring fails closed', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  it('accepts every run and uses step in the real CI workflow', () => {
    expect(ciGatePlan(workflow)).toMatchObject({
      fetchMain: ['sh', 'scripts/ci/fetch-main-history.sh'],
      coverage: ['npm', 'run', 'coverage:merge', '--', 'coverage-shards', '--threshold=80', '--expect=9'],
      hostPaths: ['node', 'scripts/lint-host-paths.mjs'],
      integration: ['npm', 'run', 'test:integration:vitest'],
    });
  });
  const real = yaml.safeLoad(workflow);
  const mirroredJobs = ['changes', 'test-shard', 'coverage-merge', 'host-paths', 'integration', 'test', 'standards'];
  it.each(mirroredJobs)('refuses an added download-artifact step in %s', job => {
    const changed = yaml.safeLoad(workflow);
    changed.jobs[job].steps.push({ name: 'Additional required artifact', uses: 'actions/download-artifact@v4', with: { name: 'required' } });
    expect(() => ciGatePlan(yaml.safeDump(changed))).toThrow('unreadable-ci-gates: update the urgent verification mirror');
  });
  const actionSteps = mirroredJobs.flatMap(job => real.jobs[job].steps.flatMap((step, index) => 'uses' in step ? [[job, index]] : []));
  it.each(actionSteps)('refuses a removed uses step in %s at %i', (job, index) => {
    const changed = yaml.safeLoad(workflow);
    changed.jobs[job].steps.splice(index, 1);
    expect(() => ciGatePlan(yaml.safeDump(changed))).toThrow('unreadable-ci-gates');
  });
  it.each(actionSteps)('pins the name, action reference and with options in %s at %i', (job, index) => {
    for (const mutate of [
      step => { step.name = 'Changed action name'; },
      step => { step.uses = 'actions/download-artifact@v4'; },
      step => { step.with = { ...step.with, unexpected: true }; },
      step => { step.with = {}; },
      step => { step.with = Object.fromEntries(Object.keys(step.with ?? {}).map(key => [key, 'changed'])); },
    ]) {
      const changed = yaml.safeLoad(workflow), step = changed.jobs[job].steps[index];
      const before = yaml.safeDump(step);
      mutate(step);
      if (yaml.safeDump(step) === before) continue;
      expect(() => ciGatePlan(yaml.safeDump(changed))).toThrow('unreadable-ci-gates');
    }
  });
  it.each(actionSteps)('pins condition, environment and error policy in %s action %i', (job, index) => {
    for (const [key, value] of [['if', '${{ false }}'], ['if', undefined], ['env', { NODE_OPTIONS: '--require=unexpected' }], ['env', {}], ['continue-on-error', true], ['continue-on-error', false]]) {
      const changed = yaml.safeLoad(workflow), step = changed.jobs[job].steps[index];
      if (step[key] === value) continue;
      if (value === undefined) delete step[key];
      else step[key] = value;
      expect(() => ciGatePlan(yaml.safeDump(changed)), key).toThrow('unreadable-ci-gates');
    }
  });
  it.each(mirroredJobs.filter(job => actionSteps.filter(([name]) => name === job).length > 1))(
    'refuses reordered uses steps in %s', job => {
      const changed = yaml.safeLoad(workflow), steps = changed.jobs[job].steps;
      const [first, second] = actionSteps.filter(([name]) => name === job).map(([, index]) => index);
      [steps[first], steps[second]] = [steps[second], steps[first]];
      expect(() => ciGatePlan(yaml.safeDump(changed))).toThrow('unreadable-ci-gates');
    });
  it.each(['test-shard', 'standards', 'coverage-merge', 'host-paths', 'integration'])(
    'refuses extra previously allowlisted commands in %s even with matching context', job => {
      for (const run of ['npm run build:tools', 'npm ci --ignore-scripts', 'npm ci',
        'sh scripts/ci/fetch-main-history.sh', 'npm ci\nnpm run build:tools']) {
        const changed = yaml.safeLoad(workflow);
        changed.jobs[job].steps.push({ run,
          'working-directory': run.includes('\n') ? 'frontierui' : 'web-everything',
          ...(job === 'test-shard' ? { if: "${{ needs.changes.outputs.light != 'true' }}" }
            : job === 'integration' ? { if: "${{ steps.gate.outputs.run == 'true' }}" } : {}),
        });
        expect(() => ciGatePlan(yaml.safeDump(changed)), run).toThrow('unreadable-ci-gates');
      }
    });
  const checkoutSteps = Object.entries(real.jobs)
    .filter(([job]) => ['changes', 'test-shard', 'coverage-merge', 'host-paths', 'integration', 'standards'].includes(job))
    .flatMap(([job, spec]) => spec.steps.flatMap((step, index) => step.uses === 'actions/checkout@v4' ? [[job, index, step.with?.path === 'frontierui']] : []));
  it.each(checkoutSteps)('pins checkout source and directory for %s step %i (FUI=%s)', (job, index, fui) => {
    for (const [key, value] of [['ref', 'other-branch'], ['ref', null], ['path', 'unexpected'],
      ['repository', fui ? 'other/frontierui' : 'frontier-ui/frontierui'],
      ...(fui ? [['repository', undefined]] : [])]) {
      const changed = yaml.safeLoad(workflow), checkout = changed.jobs[job].steps[index];
      checkout.with = { ...checkout.with, [key]: value };
      if (value === undefined) delete checkout.with[key];
      expect(() => ciGatePlan(yaml.safeDump(changed)), key).toThrow('unreadable-ci-gates');
    }
  });

  const runSteps = Object.entries(real.jobs).filter(([job]) => ['changes', 'test-shard', 'coverage-merge', 'host-paths', 'integration', 'test', 'standards'].includes(job))
    .flatMap(([job, spec]) => spec.steps.flatMap((step, index) => typeof step.run === 'string' ? [[job, index, step.name]] : []));
  it.each(runSteps)('refuses changed execution context for %s step %i (%s)', (job, index) => {
    for (const [key, value] of Object.entries({ 'working-directory': 'unexpected', env: { NODE_OPTIONS: '--require=unexpected' }, shell: 'bash', if: '${{ false }}', 'continue-on-error': true })) {
      const changed = yaml.safeLoad(workflow);
      changed.jobs[job].steps[index][key] = value;
      expect(() => ciGatePlan(yaml.safeDump(changed)), key).toThrow('unreadable-ci-gates');
    }
  });
  it.each(Object.keys(real.jobs).filter(job => runSteps.some(([name]) => name === job)))(
    'refuses job execution overrides in %s', job => {
      for (const [key, value] of Object.entries({ defaults: { run: { shell: 'bash' } }, env: {}, container: 'node:22', 'continue-on-error': true })) {
        const changed = yaml.safeLoad(workflow); changed.jobs[job][key] = value;
        expect(() => ciGatePlan(yaml.safeDump(changed)), key).toThrow('unreadable-ci-gates');
      }
    });
  it.each(['test-shard', 'coverage-merge', 'host-paths', 'integration', 'test', 'standards'])(
    'refuses an extra unknown run step in %s and tells the operator to update the mirror', job => {
      const changed = yaml.safeLoad(workflow);
      changed.jobs[job].steps.push({ name: 'Additional validation', run: 'npm run new-validation' });
      expect(() => ciGatePlan(yaml.safeDump(changed))).toThrow('unreadable-ci-gates: update the urgent verification mirror');
    });
  it.each(['test-shard', 'coverage-merge', 'host-paths', 'integration', 'test', 'standards'])(
    'refuses an unknown uses action in %s and tells the operator to update the mirror', job => {
      const changed = yaml.safeLoad(workflow);
      changed.jobs[job].steps.push({ uses: 'unknown/validation@v1' });
      expect(() => ciGatePlan(yaml.safeDump(changed))).toThrow('unreadable-ci-gates: update the urgent verification mirror');
    });
  it.each(['actions/checkout@unknown', 'docker/unknown@v1', './local-action', 42, null, ''])(
    'refuses unlisted or malformed action reference %s', uses => {
      const changed = yaml.safeLoad(workflow);
      changed.jobs.standards.steps.push({ uses });
      expect(() => ciGatePlan(yaml.safeDump(changed))).toThrow('unreadable-ci-gates');
    });
  it.each(['npm ci\nnpm run new-validation', 42, ''])(
    'refuses changed setup or unreadable run text %s', run => {
      const changed = yaml.safeLoad(workflow);
      changed.jobs.standards.steps.push({ run });
      expect(() => ciGatePlan(yaml.safeDump(changed))).toThrow('unreadable-ci-gates');
    });
  it.each([
    ['merge', 'npm run coverage:merge -- coverage-shards --threshold=80 --expect=9'],
    ['lint', 'node scripts/lint-host-paths.mjs'],
    ['integration', 'npm run test:integration:vitest -- $(node scripts/ci/quarantine-skip.mjs --job="integration")'],
    ['upload', 'path: web-everything/coverage/coverage-final.json'],
    ['download', 'pattern: coverage-shard-*'],
  ])('refuses changed %s before running suites', (_, command) => {
    expect(() => ciGatePlan(workflow.replace(command, command + ' changed'))).toThrow('unreadable-ci-gates');
  });
  it('passes quarantine output as one literal argv, refusing unexpected syntax', () => {
    for (const output of ['', '--exclude={scripts/a.test.mjs,scripts/b.test.mjs}', '$(touch injected)']) {
      const spawnSync = vi.fn((cmd, args) => ({ status: 0, stdout: args[0].includes('quarantine-skip') ? output : '' }));
      const fs = { readFileSync: () => workflow, rmSync: vi.fn() };
      const deps = createUrgentDeps({ fs, spawnSync }); deps.plan();
      if (output.startsWith('$')) { expect(() => deps.integration()).toThrow(); expect(spawnSync).toHaveBeenCalledTimes(1); }
      else {
        deps.integration();
        expect(spawnSync.mock.calls[1][1].slice(4)).toEqual(['npm', 'run', 'test:integration:vitest', '--', ...(output ? [output] : [])]);
        expect(spawnSync.mock.calls.every(([, , opts]) => !opts.shell)).toBe(true);
      }
    }
  });
  it('reuses the existing private key without overwriting it', () => {
    const fs = { mkdirSync: vi.fn(), writeFileSync: vi.fn(() => { throw Object.assign(new Error(), { code: 'EEXIST' }); }), readFileSync: vi.fn(() => key) };
    expect(createUrgentDeps({ fs }).readKey()).toBe(key);
    expect(fs.writeFileSync.mock.calls[0][2]).toEqual({ flag: 'wx', mode: 0o600 });
  });
  it('normalizes trailing origin whitespace and git suffix', () => expect(normalizeUrgentRepo(' https://example.com/org/repo.git/\n')).toBe(marker.repo));
});

 describe('required dependency closure and clean FUI', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  it.each(['test', 'changes'])('refuses an unknown needed job in %s', job => {
    const doc = yaml.safeLoad(workflow); doc.jobs.unknown = { steps: [] };
    const needs = doc.jobs[job].needs ?? []; doc.jobs[job].needs = [...(Array.isArray(needs) ? needs : [needs]), 'unknown'];
    expect(() => ciGatePlan(yaml.safeDump(doc))).toThrow('unreadable-ci-gates');
  });
  it('refuses even a known setup run added to test itself', () => {
    const doc = yaml.safeLoad(workflow); doc.jobs.test.steps.push({ run: 'npm ci' });
    expect(() => ciGatePlan(yaml.safeDump(doc))).toThrow('unreadable-ci-gates');
  });
  it.each(['command', 'directory', 'order'])('refuses changed install %s', kind => {
    const doc = yaml.safeLoad(workflow), steps = doc.jobs.standards.steps;
    const fui = steps.find(s => s.name === 'Install + build FUI tools');
    if (kind === 'command') fui.run = 'npm ci --ignore-scripts';
    if (kind === 'directory') fui['working-directory'] = 'wrong';
    if (kind === 'order') steps.push(steps.splice(steps.indexOf(fui), 1)[0]);
    expect(() => ciGatePlan(yaml.safeDump(doc))).toThrow('unreadable-ci-gates');
  });
  it.each(['missing', 'dirty', 'stale', 'fetch failed'])('refuses %s sibling before any install or suite', async kind => {
    const spawnSync = vi.fn((cmd, args, opts) => ({ status: opts.cwd === '/frontierui' && (kind === 'missing' || (kind === 'fetch failed' && args[0] === 'fetch')) ? 1 : 0,
      stdout: args[0] === 'status' ? (opts.cwd === '/frontierui' && kind === 'dirty' ? '?? untracked' : '')
        : args[0] === 'remote' ? (opts.cwd.endsWith('/frontierui') ? urgentFuiRepo : marker.repo) : kind === 'stale' && args.includes('origin/HEAD^{commit}') ? 'b'.repeat(40) : sha }));
    const fs = { readFileSync: p => p.endsWith('.key') ? key : workflow, rmSync: vi.fn(), mkdirSync: vi.fn(), writeFileSync: vi.fn(), appendFileSync: vi.fn() };
    expect((await urgentVerify({ sha }, createUrgentDeps({ cwd: '/repo', fs, spawnSync }))).ok).toBe(false);
    expect(spawnSync.mock.calls.some(([, args]) => args[0].includes('heavy-admission'))).toBe(false);
  });
  it('falls back to fetched origin/main when origin/HEAD is unavailable', () => {
    const calls = [];
    const d = createUrgentDeps({ spawnSync: (cmd, args) => { calls.push(args); return { status: args.includes('origin/HEAD^{commit}') ? 1 : 0, stdout: args[0] === 'status' ? '' : args[0] === 'remote' ? urgentFuiRepo : sha }; } });
    expect(d.verifyFui()).toEqual({ sha, repo: urgentFuiRepo }); expect(calls.some(a => a.includes('origin/main^{commit}'))).toBe(true);
  });
});

describe('FUI origin binding', () => {
  it.each([
    'https://github.com/frontier-ui/frontierui.git',
    'git@github.com:frontier-ui/frontierui.git',
    'ssh://git@github.com/frontier-ui/frontierui.git',
  ])('accepts and records normalized origin %s', origin => {
    const spawnSync = vi.fn((cmd, args) => ({ status: 0, stdout: args[0] === 'remote' ? origin : args[0] === 'status' ? '' : sha }));
    const deps = createUrgentDeps({ cwd: '/repo', spawnSync });
    expect(deps.verifyFui()).toEqual({ sha, repo: urgentFuiRepo });
    expect(spawnSync.mock.calls[0]).toMatchObject(['git', ['remote', 'get-url', 'origin'], { cwd: '/frontierui' }]);
  });
  it.each([
    '', 'https://github.com/other/frontierui.git', 'git@example.com:frontier-ui/frontierui.git',
    'https://github.com.example.com/frontier-ui/frontierui.git',
    'https://github.com/frontier-ui/frontierui/extra',
    'https://github.com/frontier-ui/frontierui?ignored',
  ])('refuses foreign or unreadable sibling origin %s before fetch or install', async origin => {
    const d = fixture();
    const spawnSync = vi.fn(() => ({ status: 0, stdout: origin }));
    d.verifyFui = createUrgentDeps({ cwd: '/repo', spawnSync }).verifyFui;
    expect(await urgentVerify({ sha }, d)).toMatchObject({ ok: false, marker: { result: 'red' }, fallback: expect.stringContaining('wait for passing CI') });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(d['install-fui']).not.toHaveBeenCalled(); expect(d.shard).not.toHaveBeenCalled();
  });
  it('refuses an origin command failure before fetch', () => {
    const spawnSync = vi.fn(() => ({ status: 1, stdout: '' }));
    expect(() => createUrgentDeps({ spawnSync }).verifyFui()).toThrow();
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
});
