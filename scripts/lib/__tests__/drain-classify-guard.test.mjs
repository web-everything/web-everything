// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isMutatingGhCall } from '../drain-classify-guard.mjs';

const writes = [
  ['gh', ['api', 'repos/o/r', '-X', 'POST']], ['gh', ['api', 'x', '--method=PATCH']],
  ['gh', ['api', 'x', '-XDELETE']], ['gh', ['api', 'x', '--method', 'PUT']],
  ['gh', ['api', 'x', '-f', 'body=x']], ['gh', ['api', 'x', '-Fbody=x']],
  ['gh', ['api', 'x', '--raw-field=x=y']], ['gh', ['api', 'x', '--field', 'a=b']],
  ['gh', ['api', 'x', '--input=body.json']], ['gh', ['api', 'graphql', '-f', 'query=mutation{}']],
  ...['edit', 'comment', 'merge', 'close', 'review', 'ready'].map(s => ['gh', ['pr', s, '7']]),
  ['gh', ['pr', 'merge', '7', '--auto']], ...['edit', 'comment'].map(s => ['gh', ['issue', s, '7']]),
  ['gh', ['label', 'list']], ['gh', ['extension', 'exec', 'x']], ['gh', ['pr', 'unknown']],
  ['git', ['push', 'origin', 'main']], ['git', ['-C', '.', 'push']],
  ['node', ['scripts/enqueue-pr.mjs']], ['node', ['scripts/refresh-approved-head.mjs']],
  ['node', ['scripts/numbering.mjs']], ['sh', ['-c', 'gh pr merge 7']],
  ['env', ['GH_REPO=o/r', 'gh', 'pr', 'merge', '7']], ['env', ['-u', 'DRAIN_CLASSIFY_ONLY', 'gh', 'pr', 'merge', '7']],
];
const gitWriteOptions = [
  ...['diff', 'show', 'log'].flatMap(command => [
    ['git', [command]],
    ...(command === 'diff' ? [] : [['git', [command, '--no-ext-diff']]]), // diff alone is the drain's real read; admitted below
    ['git', [command, '--no-textconv']],
    ['git', [command, '--', '--no-ext-diff', '--no-textconv']],
    ['git', [command, '--no-ext-diff', '--no-textconv', '--ext-diff']],
    ['git', [command, '--no-ext-diff', '--no-textconv', '--textconv']],
    ['git', [command, '--no-ext-diff', '--no-textconv', '--ext']],
    ['git', [command, '--no-ext-diff', '--no-textconv', '--no-no-ext-diff']],
    ['git', [command, '--no-ext-diff', '--no-textconv', '--no-no-textconv']],
  ]),
  ...['diff', 'show', 'log'].flatMap(command => [
    ['git', [command, '--output=blocked-file']],
    ['git', [command, '--output', 'blocked-file']],
    ['git', [command, '--out=blocked-file']],
    ['git', [command, '--out', 'blocked-file']],
    ['git', [command, '--ext-diff']],
    ['git', [command, '--textconv']],
  ]),
  ['git', ['cat-file', '--filters', 'HEAD:README.md']],
  ['git', ['cat-file', '--textconv', 'HEAD:README.md']],
];
const reads = [
  ...['view', 'list', 'diff', 'checks'].map(s => ['gh', ['pr', s, '7']]),
  ['gh', ['api', 'repos/o/r']], ['gh', ['api', 'x', '-X', 'GET']],
  ['gh', ['api', 'x', '--method=GET', '-f', 'q=x']], ['gh', ['repo', 'view']],
  ['gh', ['run', 'list']], ['gh', ['run', 'view', '7']], ['gh', ['auth', 'status']],
  ['git', ['rev-parse', 'HEAD']],
  ['git', ['diff', '--no-ext-diff', '--no-textconv', '--stat']],
  ['git', ['show', '--no-ext-diff', '--no-textconv', 'HEAD']],
  ['git', ['log', '--no-textconv', '--no-ext-diff', '-1']],
];

describe('classify write guard', () => {
  it.each(['environment external diff', 'repository external diff', 'repository textconv'])('never executes configured helpers for default Git diff calls: %s', configuration => {
    const dir = mkdtempSync(join(process.env.TMPDIR, 'drain-helper-'));
    try {
      const source = `
        import cp from 'node:child_process';
        import { writeFileSync, existsSync, rmSync } from 'node:fs';
        import assert from 'node:assert/strict';
        const configuration = ${JSON.stringify(configuration)};
        const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
        delete env.GIT_EXTERNAL_DIFF;
        delete env.GIT_CONFIG_COUNT;
        const run = args => cp.execFileSync('git', args, { env, encoding: 'utf8' });
        run(['init', '--quiet']);
        writeFileSync('helper.sh', '#!/bin/sh\\nprintf invoked >> helper-marker\\nprintf helper-output\\n', { mode: 0o700 });
        writeFileSync('file.txt', 'before\\n');
        writeFileSync('.gitattributes', 'file.txt diff=guard\\n');
        run(['add', 'file.txt', '.gitattributes']);
        writeFileSync('file.txt', 'after\\n');
        if (configuration === 'environment external diff') env.GIT_EXTERNAL_DIFF = './helper.sh';
        if (configuration === 'repository external diff') run(['config', 'diff.external', './helper.sh']);
        if (configuration === 'repository textconv') run(['config', 'diff.guard.textconv', './helper.sh']);
        // Positive control: this configuration really invokes the helper on default argv.
        run(['diff']);
        assert.ok(existsSync('helper-marker'), 'fixture must exercise configured helper execution');
        rmSync('helper-marker');
        const { installGuard } = await import(${JSON.stringify(new URL('../drain-classify-guard.mjs', import.meta.url).href)});
        installGuard();
        assert.throws(() => run(['diff']), /DRAIN_CLASSIFY_ONLY/);
        for (const override of ['--ext-diff', '--textconv', '--no-no-ext-diff', '--no-no-textconv']) {
          assert.throws(() => run(['diff', '--no-ext-diff', '--no-textconv', override]), /DRAIN_CLASSIFY_ONLY/);
        }
        const output = run(['diff', '--no-ext-diff', '--no-textconv']);
        assert.match(output, /-before/);
        assert.match(output, /\\+after/);
        assert.equal(existsSync('helper-marker'), false, 'guarded calls must never execute the helper');
        process.stdout.write('helpers blocked');
      `;
      expect(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
        cwd: dir, encoding: 'utf8', maxBuffer: 1024 * 1024,
        env: { ...process.env, DRAIN_CLASSIFY_ONLY: '0' },
      })).toBe('helpers blocked');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(writes)('classifies mutating/unknown %s %j', (cmd, args) => expect(isMutatingGhCall(cmd, args)).toBe(true));
  it.each(gitWriteOptions)('refuses Git write-capable options %s %j', (cmd, args) => expect(isMutatingGhCall(cmd, args)).toBe(true));
  it.each(reads)('allows read %s %j', (cmd, args) => expect(isMutatingGhCall(cmd, args)).toBe(false));
  it.each([['mutating/unknown commands', writes], ['Git write-capable options', gitWriteOptions]])('throws for %s through all six wrapped seams and custom promisify without executing them', (_name, cases) => {
    // Fake originals record delegation; the wrappers themselves are the real installed seam.
    const source = `
      import cp from 'node:child_process';
      import { promisify } from 'node:util';
      import { syncBuiltinESMExports } from 'node:module';
      import assert from 'node:assert/strict';
      let calls = 0;
      const names = ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync'];
      for (const name of names) {
        const fn = () => { calls++; return 'read'; };
        fn[promisify.custom] = async () => { calls++; return { stdout: 'read' }; };
        cp[name] = fn;
      }
      syncBuiltinESMExports();
      const { installGuard } = await import(${JSON.stringify(new URL('../drain-classify-guard.mjs', import.meta.url).href)});
      installGuard(); installGuard();
      const named = await import('node:child_process');
      for (const [cmd, args] of ${JSON.stringify(cases)}) {
        for (const name of names) {
          const invoke = () => name === 'exec' || name === 'execSync' ? cp[name]([cmd, ...args].join(' ')) : cp[name](cmd, args);
          assert.throws(invoke, /DRAIN_CLASSIFY_ONLY/);
        }
        assert.throws(() => named.execFileSync(cmd, args), /DRAIN_CLASSIFY_ONLY/);
        await assert.rejects(async () => promisify(cp.execFile)(cmd, args), /DRAIN_CLASSIFY_ONLY/);
      }
      assert.equal(calls, 0);
      for (const [cmd, args] of ${JSON.stringify(reads)}) {
        for (const name of names) {
          name === 'exec' || name === 'execSync' ? cp[name]([cmd, ...args].join(' ')) : cp[name](cmd, args);
        }
        await promisify(cp.execFile)(cmd, args);
      }
      assert.equal(calls, ${reads.length} * 7);
      assert.throws(() => cp.spawn('gh', ['pr', 'view', '7; gh pr merge 7'], { shell: true }), /shell/);
      assert.throws(() => cp.exec('gh pr view 7 && gh pr merge 7'), /shell/);
      process.stdout.write('guard verified');
    `;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', env: { ...process.env, DRAIN_CLASSIFY_ONLY: '0' }, maxBuffer: 1024 * 1024,
    })).toBe('guard verified');
  });
  it('activates automatically as a node --import preload', () => {
    const source = `import { execFileSync } from 'node:child_process';
      try { execFileSync('gh', ['pr', 'merge', '7']); } catch (e) {
        if (!e.message.includes('DRAIN_CLASSIFY_ONLY')) throw e;
        process.stdout.write('blocked');
      }`;
    expect(execFileSync(process.execPath, ['--import', new URL('../drain-classify-guard.mjs', import.meta.url).href,
      '--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, DRAIN_CLASSIFY_ONLY: '1' } })).toBe('blocked');
  });
});

describe('git fetch admission', () => {
  it('admits plain fetches into local storage and refuses helpers or non-remote destinations', () => {
    expect(isMutatingGhCall('git', ['fetch', 'origin', 'lane/x'])).toBe(false);
    expect(isMutatingGhCall('git', ['fetch', '--quiet', 'origin', '+refs/heads/x:refs/remotes/origin/x'])).toBe(false);
    expect(isMutatingGhCall('git', ['fetch', 'origin', 'x:refs/heads/main'])).toBe(true);
    expect(isMutatingGhCall('git', ['fetch', '--upload-pack=sh', 'origin'])).toBe(true);
    expect(isMutatingGhCall('git', ['fetch', 'ext::sh -c x'])).toBe(true);
    expect(isMutatingGhCall('git', ['push', 'origin', 'x'])).toBe(true);
  });
});

describe('the drain\'s real diff reads stay admitted', () => {
  it('admits numstat and --no-ext-diff --end-of-options diffs, still refuses ext-diff', () => {
    expect(isMutatingGhCall('git', ['diff', '--numstat', 'a...b'])).toBe(false);
    expect(isMutatingGhCall('git', ['diff', '--no-ext-diff', '--end-of-options', 'a...b'])).toBe(false);
    expect(isMutatingGhCall('git', ['diff', '--no-ext-diff', '--ext-diff', 'a'])).toBe(true);
    expect(isMutatingGhCall('git', ['diff', '--end-of-options', 'a'])).toBe(true);
  });
});

describe('fail-closed executables and forwarded commands', () => {
  it('refuses unknown executables and forwarded gh mutations, admits forwarded reads and read-only tools', () => {
    expect(isMutatingGhCall('rm', ['-rf', 'x'])).toBe(true);
    expect(isMutatingGhCall('curl', ['-X', 'POST', 'https://x'])).toBe(true);
    expect(isMutatingGhCall('node', ['scripts/lib/gh-throttle.mjs', 'pr', 'merge', '1'])).toBe(true);
    expect(isMutatingGhCall('node', ['scripts/lib/gh-throttle.mjs', 'pr', 'view', '1'])).toBe(false);
    expect(isMutatingGhCall('ls', ['-la'])).toBe(false);
  });
  it('injects --no-ext-diff and --no-textconv into every admitted git diff', async () => {
    const { hardenGitArgs } = await import('../drain-classify-guard.mjs');
    expect(hardenGitArgs('git', ['diff', '--no-ext-diff', '--end-of-options', 'a'])).toEqual(['diff', '--no-textconv', '--no-ext-diff', '--end-of-options', 'a']);
    expect(hardenGitArgs('git', ['diff', '--numstat', 'a'])).toEqual(['diff', '--no-ext-diff', '--no-textconv', '--numstat', 'a']);
    expect(hardenGitArgs('git', ['status'])).toEqual(['status']);
  });
});

describe('read-only git metadata forms', () => {
  it('admits remote/config/branch/ref reads and refuses their write forms', () => {
    for (const args of [['remote'], ['remote', '-v'], ['remote', 'get-url', 'origin'], ['config', '--get', 'remote.origin.url'], ['branch', '--show-current'], ['for-each-ref', 'refs/heads'], ['rev-list', '-n1', 'HEAD'], ['symbolic-ref', 'HEAD']]) {
      expect(isMutatingGhCall('git', args)).toBe(false);
    }
    for (const args of [['remote', 'add', 'x', 'y'], ['remote', 'set-url', 'origin', 'x'], ['config', 'user.name', 'x'], ['config', '--unset', 'a'], ['branch', '-D', 'x'], ['branch', 'new'], ['symbolic-ref', 'HEAD', 'refs/heads/x'], ['symbolic-ref', '-d', 'HEAD']]) {
      expect(isMutatingGhCall('git', args)).toBe(true);
    }
  });
});

describe('read-only graphql', () => {
  it('admits a plain query and refuses mutations, extra input and method overrides', () => {
    expect(isMutatingGhCall('gh', ['api', 'graphql', '-f', 'query=query{viewer{login}}'])).toBe(false);
    expect(isMutatingGhCall('gh', ['api', 'graphql', '-f', 'query=mutation{x}'])).toBe(true);
    expect(isMutatingGhCall('gh', ['api', 'graphql', '-f', 'query={a} mutation{b}'])).toBe(true);
    expect(isMutatingGhCall('gh', ['api', 'graphql', '--input', 'x.json'])).toBe(true);
    expect(isMutatingGhCall('gh', ['api', 'graphql', '-X', 'GET', '-f', 'query=query{a}'])).toBe(true);
    expect(isMutatingGhCall('gh', ['api', 'graphql'])).toBe(true);
  });
});

describe('shell wrappers and exec string hardening', () => {
  it('refuses every shell wrapper and rewrites exec/execSync git diff strings with both protections', () => {
    for (const sh of ['sh', 'bash', 'zsh']) expect(isMutatingGhCall(sh, ['-c', 'rm some-file'])).toBe(true);
    const source = `
      import childProcess from 'node:child_process';
      import assert from 'node:assert/strict';
      const seen = [];
      for (const k of ['exec', 'execSync']) childProcess[k] = (...a) => { seen.push(a[0]); return ''; };
      const { installGuard } = await import(${JSON.stringify(new URL('../drain-classify-guard.mjs', import.meta.url).href)});
      installGuard();
      childProcess.execSync('git diff --no-ext-diff a...b');
      childProcess.exec('git diff --numstat a...b');
      assert.deepEqual(seen, ['git diff --no-textconv --no-ext-diff a...b', 'git diff --no-ext-diff --no-textconv --numstat a...b']);
      assert.throws(() => childProcess.execSync("sh -c 'rm x'"), /DRAIN_CLASSIFY_ONLY/);
      process.stdout.write('ok');
    `;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, DRAIN_CLASSIFY_ONLY: '0' } })).toBe('ok');
  });
});
