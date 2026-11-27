// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const script = fileURLToPath(new URL('../fetch-main-history.sh', import.meta.url));
const fetchArgs = '-c http.version=HTTP/1.1 fetch --no-tags --filter=blob:none --depth=1000000 origin +refs/heads/main:refs/remotes/origin/main';

// Execute the production shell, replacing only git and sleep. No network or Git writes.
function runFetch(failures, cache = undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-fetch-history-'));
  try {
    writeFileSync(join(dir, 'git'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FETCH_TEST_CALLS"
attempt=0
if [ -f "$FETCH_TEST_COUNT" ]; then read -r attempt < "$FETCH_TEST_COUNT"; fi
attempt=$((attempt + 1))
printf '%s\\n' "$attempt" > "$FETCH_TEST_COUNT"
if [ "$attempt" -le "$FETCH_TEST_FAILURES" ]; then
  echo 'fatal: unable to access remote: Error in the HTTP2 framing layer' >&2
  exit 128
fi
`, { mode: 0o755 });
    writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$FETCH_TEST_SLEEPS"\n', { mode: 0o755 });
    writeFileSync(join(dir, 'sleeps'), '');
    const env = { ...process.env };
    delete env.MAIN_HISTORY_CACHE_DIR;
    if (cache !== undefined) env.MAIN_HISTORY_CACHE_DIR = cache;
    const result = spawnSync('sh', [script], {
      cwd: dir, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
      env: {
        ...env, PATH: `${dir}:${process.env.PATH}`,
        FETCH_TEST_CALLS: join(dir, 'calls'), FETCH_TEST_COUNT: join(dir, 'count'),
        FETCH_TEST_SLEEPS: join(dir, 'sleeps'), FETCH_TEST_FAILURES: String(failures),
      },
    });
    if (result.error) throw result.error;
    return {
      ...result,
      calls: readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n'),
      sleeps: readFileSync(join(dir, 'sleeps'), 'utf8').trim().split('\n').filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('CI main history fetch transport recovery', () => {
  it('uses HTTP/1.1 and preserves blobless deep main history without retrying success', () => {
    const result = runFetch(0);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([fetchArgs]);
    expect(result.sleeps).toEqual([]);
  });

  it.each([1, 2])('recovers after %i framing failures and stops as soon as the fetch succeeds', (failures) => {
    const result = runFetch(failures);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(Array(failures + 1).fill(fetchArgs));
    expect(result.sleeps).toEqual(['5', '10'].slice(0, failures));
    expect(result.stderr).toContain('Error in the HTTP2 framing layer');
    expect(result.stderr).not.toContain('refusing unavailable history');
  });

  it('fails closed with the git exit status after three failures and never sleeps after exhaustion', () => {
    const result = runFetch(10);
    expect(result.status).toBe(128);
    expect(result.calls).toEqual(Array(3).fill(fetchArgs));
    expect(result.sleeps).toEqual(['5', '10']);
    expect(result.stderr).toContain('failed after 3 attempts; refusing unavailable history');
  });

  it('wires every CI history fetch to the bounded helper before dependency installation', () => {
    for (const name of ['ci.yml', 'test-selection-measure.yml']) {
      const raw = readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8');
      const { jobs } = yaml.load(raw);
      expect(raw).not.toMatch(/git fetch --no-tags --filter=blob:none/);
      for (const job of Object.values(jobs)) {
        for (const [index, step] of job.steps.entries()) {
          if (step.name !== 'Fetch main history (blobless)' && step.name !== 'Is this a card-only PR?') continue;
          expect(step.run).toContain('sh scripts/ci/fetch-main-history.sh');
          expect(step['timeout-minutes']).toBe(4);
          expect(step['continue-on-error']).toBeUndefined();
          expect(job.steps.slice(0, index).some((s) => s.name === 'Install')).toBe(false);
          if (step.name === 'Is this a card-only PR?') {
            expect(step.run).toContain('if sh scripts/ci/fetch-main-history.sh; then');
            expect(step.run).toContain('main fetch failed; full suite');
          }
        }
      }
    }
  });
});


// Real repositories, an isolated HOME/config/clock and local-only origin. All faults
// delegate to the real executable except the exact argv selected by the test.
function mirrorFixture(test) {
  const root = mkdtempSync(join(tmpdir(), 'main-mirror-'));
  const home = join(root, 'home'), bin = join(root, 'bin');
  mkdirSync(home); mkdirSync(bin);
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' };
  const source = join(root, 'source'), origin = join(root, 'origin'), checkout = join(root, 'checkout');
  const cache = join(root, 'mirror'), calls = join(root, 'calls');
  function command(cmd, args, cwd = source, extra = {}) {
    const result = spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    return result;
  }
  function git(...args) {
    const r = command('git', args); expect(r.status, r.stderr).toBe(0); return r.stdout.trim();
  }
  function commit(n) { writeFileSync(join(source, 'file'), String(n)); git('add', '.'); git('commit', '-qm', `commit ${n}`); }
  function snapshot(dir) {
    if (!existsSync(dir)) return null;
    return Object.fromEntries(readdirSync(dir).sort().map(n => [n, readFileSync(join(dir, n)).toString('hex')]));
  }
  function run(mode, fault = '', cacheDir = cache) {
    writeFileSync(calls, '');
    const result = command('sh', ['-c', 'exec sh "$@" 2>&1', 'mirror-test', script, ...(mode ? [mode] : [])], mode === 'save' ? source : checkout, {
      PATH: `${bin}:${env.PATH}`, MAIN_HISTORY_CACHE_DIR: cacheDir, MIRROR_FAULT: fault,
      MIRROR_CACHE: cache, MIRROR_CALLS: calls, MIRROR_ROOT: root,
    });
    expect(readdirSync(root).filter(n => n.startsWith('main-history-verify.'))).toEqual([]);
    return { ...result, output: result.stdout + result.stderr, calls: readFileSync(calls, 'utf8'), beforeFetch: existsSync(join(root, 'before-fetch')) ? JSON.parse(readFileSync(join(root, 'before-fetch'), 'utf8')) : null };
  }
  try {
    mkdirSync(source); git('init', '-q', '-b', 'main');
    commit(0); const oldTree = git('rev-parse', 'HEAD^{tree}');
    commit(1); const tip = git('rev-parse', 'HEAD');
    git('clone', '-q', '--bare', source, origin);
    git('--git-dir', origin, 'config', 'uploadpack.allowFilter', 'true');
    git('remote', 'add', 'origin', `file://${origin}`); git('fetch', '-q', 'origin');
    git('clone', '-q', '--depth=1', `file://${origin}`, checkout);
    git('-C', checkout, 'update-ref', '-d', 'refs/remotes/origin/main');
    mkdirSync(cache);
    function buildMirror(omit) {
      rmSync(cache, { recursive: true, force: true }); mkdirSync(cache);
      const objects = git('rev-list', '--objects', '--filter=blob:none', tip).split('\n').filter(l => !omit || !l.startsWith(omit)).join('\n') + '\n';
      const packed = spawnSync('git', ['pack-objects', '-q', join(cache, 'pack')], { cwd: source, env, input: objects, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
      expect(packed.status, packed.stderr).toBe(0);
      for (const n of readdirSync(cache).filter(n => n.endsWith('.pack'))) writeFileSync(join(cache, n.replace('.pack', '.promisor')), '');
      writeFileSync(join(cache, 'sha'), `${tip}\n`);
    }
    buildMirror();
    for (const name of ['git', 'cp', 'mv', 'rm', 'mktemp']) {
      const real = command('which', [name], root).stdout.trim();
      writeFileSync(join(bin, name), `#!${process.execPath}\n` + String.raw`
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const a=process.argv.slice(2), name=${JSON.stringify(name)}, real=${JSON.stringify(real)};
const f=process.env.MIRROR_FAULT, c=process.env.MIRROR_CACHE;
fs.appendFileSync(process.env.MIRROR_CALLS, name+' '+a.join(' ')+'\n');
const isGit=(s)=>name==='git'&&a.includes(s);
const dest=a[a.length-1];
const fail=()=>process.exit(1);
if (name==='git'&&a.includes('fetch')) {
 const dir=process.cwd()+'/.git/objects/pack';
 const files=Object.fromEntries(fs.readdirSync(dir).sort().map(n=>[n,fs.readFileSync(dir+'/'+n).toString('hex')]));
 const ref=spawnSync(real,['rev-parse','--verify','refs/remotes/origin/main'],{encoding:'utf8',timeout:10000,maxBuffer:65536});
 fs.writeFileSync(process.env.MIRROR_ROOT+'/before-fetch',JSON.stringify({files,ref:ref.status}));
}
if (name==='git'&&a.includes('fetch')&&f==='fetch') fail();
if (isGit('update-ref')&&['update-ref','rollback-rm'].includes(f)) fail();
if (isGit('pack-objects')&&f==='pack-objects') fail();
if (isGit('verify-pack')&&f==='verify-pack') fail();
if (name==='cp'&&f==='verify-copy'&&dest.includes('main-history-verify.')) fail();
if (name==='cp'&&f==='partial'&&!dest.includes('main-history-verify.')) {
  fs.writeFileSync(dest,fs.readFileSync(a[0]).subarray(0,16)); fail();
}
if (name==='mv'&&((f==='move-old'&&a[0]===c)||(f==='publish'&&a[0]===c+'.tmp.d')||(f==='rollback'&&[c+'.tmp.d',c+'.old'].includes(a[0])))) fail();
if (name==='rm'&&((f==='pre-clean'&&a.includes(c+'.tmp.d'))||(f==='cleanup'&&a.includes(c+'.old')&&!a.includes(c+'.tmp.d')&&fs.existsSync(c+'/sha'))||(f==='rollback-rm'&&a.some(p=>p.endsWith('.idx')&&p.includes('.git/objects/pack/'))))) fail();
if (name==='mktemp'&&f==='install-list'&&!a.includes('-d')) fail();
const r=spawnSync(real,a,{stdio:'inherit',timeout:10000});
if (isGit('rev-list')&&f==='rev-list') fail();
if (isGit('pack-objects')&&r.status===0&&['promisor','sha'].includes(f)) {
 const dir=c+'.tmp.d';
 fs.mkdirSync(f==='sha'?dir+'/sha':dir+'/'+fs.readdirSync(dir).find(n=>n.endsWith('.pack')).replace('.pack','.promisor'));
}
process.exit(r.status===null?1:r.status);
`, { mode: 0o755 });
    }
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const packs = join(checkout, '.git/objects/pack');
    const beforePacks = snapshot(packs);
    const fullFetch = r => { expect(r.status, r.output).toBe(0); expect(r.calls).toContain(fetchArgs); };
    const miss = (r, reason) => { fullFetch(r); expect(r.output).toContain(reason ? `unusable (${reason})` : 'no cached main history'); };
    test({ root, source, origin, checkout, cache, tip, oldTree, packs, beforePacks, run, git, commit, snapshot, buildMirror, fullFetch, miss });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('main-history mirror cache', () => {
  it('uses a restored mirror and then fetches the live tip', () => mirrorFixture(f => {
    const saved = spawnSync('sh', [script, 'save'], { cwd: f.source, env: { PATH: process.env.PATH, HOME: f.root, TMPDIR: f.root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', MAIN_HISTORY_CACHE_DIR: f.cache }, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    expect(saved.status, saved.stderr).toBe(0);
    const r = f.run(); f.fullFetch(r); expect(r.output).toContain(`seeded main history from cache (${f.tip})`);
    expect(f.git('-C', f.checkout, 'rev-parse', 'origin/main')).toBe(f.tip);
  }));
  it('corrupt mirror falls back', () => mirrorFixture(f => {
    const path = join(f.cache, readdirSync(f.cache).find(n => n.endsWith('.pack')));
    chmodSync(path, 0o600); const bytes = readFileSync(path); bytes[20] ^= 1; writeFileSync(path, bytes);
    const before = f.snapshot(f.cache), r = f.run(); f.miss(r, 'verify-pack'); expect(f.snapshot(f.cache)).toEqual(before);
    expect(r.beforeFetch.files).toEqual(f.beforePacks);
  }));
  it.each(['missing', 'unreadable', 'hex', 'uppercase', 'unknown', 'tree'])('missing, unreadable or malformed sha falls back, never aborts: %s', kind => mirrorFixture(f => {
    const path = join(f.cache, 'sha');
    if (kind === 'unreadable' && process.getuid?.() === 0) return;
    if (kind === 'missing') rmSync(path);
    else if (kind === 'unreadable') chmodSync(path, 0);
    else writeFileSync(path, ({ hex: 'not-hex', uppercase: 'A'.repeat(40), unknown: '0'.repeat(40), tree: f.git('rev-parse', 'HEAD^{tree}') })[kind] + '\n');
    f.miss(f.run(), kind === 'missing' ? null : ['tree', 'unknown'].includes(kind) ? 'not-a-commit' : 'bad-sha');
  }));
  it('mirror missing a tree beyond the shallow boundary is refused', () => mirrorFixture(f => { f.buildMirror(f.oldTree); f.miss(f.run(), 'missing-object'); }));
  it.each(['rev-list', 'pack-objects', 'promisor', 'sha', 'verify-pack', 'verify-copy', 'pre-clean'])('failed save publishes nothing and keeps the old mirror: %s', fault => mirrorFixture(f => {
    if (fault === 'pre-clean') mkdirSync(f.cache + '.tmp.d');
    const before = f.snapshot(f.cache); const r = f.run('save', fault);
    expect(r.status).not.toBe(0); expect(r.output).toContain(`save failed (${fault})`);
    expect(f.snapshot(f.cache)).toEqual(before); expect(existsSync(f.cache + '.tmp.d')).toBe(fault === 'pre-clean');
  }));
  it.each(['move-old', 'publish'])('failed rename during publish restores the old mirror: %s', fault => mirrorFixture(f => {
    const before = f.snapshot(f.cache), r = f.run('save', fault);
    expect(r.status).not.toBe(0); expect(r.output).toContain(`save failed (${fault})`);
    expect(f.snapshot(f.cache)).toEqual(before); expect(existsSync(f.cache + '.tmp.d')).toBe(false);
  }));
  it('stale mirror still converges', () => mirrorFixture(f => {
    for (let n = 2; n < 7; n++) f.commit(n);
    f.git('push', '-q', 'origin', 'main'); const next = f.git('rev-parse', 'HEAD');
    const r = f.run(); f.fullFetch(r); expect(r.output).toContain(`seeded main history from cache (${f.tip})`);
    expect(f.git('-C', f.checkout, 'rev-parse', 'origin/main')).toBe(next);
  }));
  it('seed succeeds but live fetch exhausts retries', () => mirrorFixture(f => {
    const r = f.run(undefined, 'fetch'); expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/seeded main history from cache[\s\S]*failed after 3 attempts; refusing unavailable history\n$/);
    expect(r.calls.split('\n').filter(l => l.includes(' fetch '))).toHaveLength(3);
  }));
  it.each([0, 1, 2, 10])('no cache dir means unchanged behaviour after %i failures', failures => {
    const absent = runFetch(failures), empty = runFetch(failures, '');
    for (const r of [absent, empty]) {
      expect(r.status).toBe(failures > 2 ? 128 : 0);
      expect(r.calls).toEqual(Array(Math.min(failures + 1, 3)).fill(fetchArgs));
      expect(r.sleeps).toEqual(['5', '10'].slice(0, Math.min(failures, 2)));
      expect(r.stdout).toBe('');
    }
    expect(empty.stderr).toBe(absent.stderr);
  });
  it('rollback failure leaves no half mirror', () => mirrorFixture(f => {
    const r = f.run('save', 'rollback'); expect(r.status).not.toBe(0); expect(r.output).toContain('rollback failed; no mirror at');
    expect(existsSync(f.cache)).toBe(false); f.miss(f.run(), null);
    expect(f.run('save').status).toBe(0); expect(existsSync(f.cache + '.old')).toBe(false);
  }));
  it('cleanup failure after the commit point still succeeds', () => mirrorFixture(f => {
    writeFileSync(join(f.cache, 'sha'), '0'.repeat(40) + '\n');
    const r = f.run('save', 'cleanup'); expect(r.status, r.output).toBe(0); expect(r.output).toContain('next save removes it');
    expect(readFileSync(join(f.cache, 'sha'), 'utf8').trim()).toBe(f.tip);
    expect(f.run().output).toContain('seeded main history'); expect(f.run('save').status).toBe(0); expect(existsSync(f.cache + '.old')).toBe(false);
  }));
  it('interrupted publication recovers', () => mirrorFixture(f => {
    rmSync(f.cache, { recursive: true });
    for (const suffix of ['.old', '.tmp.d']) { mkdirSync(f.cache + suffix); writeFileSync(join(f.cache + suffix, 'junk'), 'junk'); }
    f.miss(f.run(), null); expect(f.run('save').status).toBe(0);
    expect(existsSync(f.cache + '.old')).toBe(false); expect(existsSync(f.cache + '.tmp.d')).toBe(false); expect(f.run().output).toContain('seeded main history');
  }));
  it.each(['update-ref', 'partial'])('restore rollback keeps files that were already there: %s', fault => mirrorFixture(f => {
    const name = readdirSync(f.cache).find(n => n.endsWith('.pack'));
    copyFileSync(join(f.cache, name), join(f.packs, name)); writeFileSync(join(f.packs, 'unrelated.promisor'), 'keep');
    const before = f.snapshot(f.packs), r = f.run(undefined, fault);
    f.miss(r, fault === 'partial' ? 'install' : fault); expect(r.beforeFetch.files).toEqual(before); expect(r.beforeFetch.ref).not.toBe(0);
    if (fault === 'partial') expect(r.calls).not.toContain('git update-ref');
    expect(r.calls.indexOf('git -c http.version')).toBeGreaterThan(r.calls.indexOf('cp '));
  }));
  it.each(['pack', 'idx'])('same-name file with different bytes rejects the seed: %s', ext => mirrorFixture(f => {
    const name = readdirSync(f.cache).find(n => n.endsWith('.' + ext)); writeFileSync(join(f.packs, name), 'collision');
    const before = f.snapshot(f.packs), r = f.run(); f.miss(r, 'collision'); expect(r.beforeFetch.files).toEqual(before); expect(r.beforeFetch.ref).not.toBe(0); expect(r.calls).not.toContain('git update-ref');
  }));
  it('restore copy into the verify repo fails', () => mirrorFixture(f => { const r = f.run(undefined, 'verify-copy'); f.miss(r, 'verify-copy'); expect(r.beforeFetch.files).toEqual(f.beforePacks); }));
  it('created-files list cannot be made', () => mirrorFixture(f => { const r = f.run(undefined, 'install-list'); f.miss(r, 'install-list'); expect(r.beforeFetch.files).toEqual(f.beforePacks); }));
  it('rollback that cannot remove a seeded file warns and still fetches', () => mirrorFixture(f => {
    const r = f.run(undefined, 'rollback-rm'); f.miss(r, 'update-ref'); expect(r.output).toContain('could not remove seeded file');
  }));
});
