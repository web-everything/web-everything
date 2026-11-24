// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const script = fileURLToPath(new URL('../fetch-main-history.sh', import.meta.url));
const fetchArgs = '-c http.version=HTTP/1.1 fetch --no-tags --filter=blob:none --depth=1000000 origin +refs/heads/main:refs/remotes/origin/main';

// Execute the production shell, replacing only git and sleep. No network or Git writes.
function runFetch(failures) {
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
    const result = spawnSync('sh', [script], {
      cwd: dir, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`,
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

// Mirror cache: real git is replaced by a recorder; cat-file result is chosen per case.
function runCached({ catFileOk, withCache = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-fetch-cache-'));
  try {
    mkdirSync(join(dir, 'cache'));
    mkdirSync(join(dir, 'packs'));
    if (withCache) {
      writeFileSync(join(dir, 'cache', 'pack-abc.pack'), 'p');
      writeFileSync(join(dir, 'cache', 'pack-abc.idx'), 'i');
      writeFileSync(join(dir, 'cache', 'sha'), 'deadbeef\n');
    }
    writeFileSync(join(dir, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FETCH_TEST_CALLS"
case "$1" in
  rev-parse) echo "$FETCH_TEST_PACKS"; exit 0;;
  rev-list) [ "$FETCH_TEST_CATFILE" = ok ] && exit 0; exit 1;;
  *) exit 0;;
esac
`, { mode: 0o755 });
    const result = spawnSync('sh', [script], {
      cwd: dir, encoding: 'utf8', timeout: 5_000,
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, MAIN_HISTORY_CACHE_DIR: join(dir, 'cache'),
        FETCH_TEST_CALLS: join(dir, 'calls'), FETCH_TEST_PACKS: join(dir, 'packs'),
        FETCH_TEST_CATFILE: catFileOk ? 'ok' : 'bad',
      },
    });
    return { ...result, calls: readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n'), packs: readdirSync(join(dir, 'packs')).sort() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('CI main history mirror cache', () => {
  it('uses a restored mirror and then fetches the live tip', () => {
    const r = runCached({ catFileOk: true });
    expect(r.status).toBe(0);
    expect(r.packs).toEqual(['pack-abc.idx', 'pack-abc.pack', 'pack-abc.promisor']);
    expect(r.calls).toContain('update-ref refs/remotes/origin/main deadbeef');
    expect(r.calls.at(-1)).toBe(fetchArgs);
  });

  it('falls back to the full blobless fetch when the restored mirror is corrupt', () => {
    const r = runCached({ catFileOk: false });
    expect(r.status).toBe(0);
    expect(r.packs).toEqual([]);
    expect(r.calls.some((c) => c.startsWith('update-ref'))).toBe(false);
    expect(r.calls.at(-1)).toBe(fetchArgs);
  });

  it('does the plain full fetch when no cache was restored', () => {
    const r = runCached({ catFileOk: true, withCache: false });
    expect(r.calls).toEqual([fetchArgs]);
  });

  it('only saves the cache from main pushes in the standards job, restores in the fetching jobs', () => {
    const raw = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const { jobs } = yaml.load(raw);
    const saves = Object.values(jobs).flatMap((j) => j.steps.filter((s) => String(s.uses ?? '').startsWith('actions/cache/save')));
    expect(saves).toHaveLength(1);
    expect(saves[0].if).toContain("github.ref == 'refs/heads/main'");
    expect(saves[0].if).toContain("github.event_name == 'push'");
    const restores = Object.values(jobs).flatMap((j) => j.steps.filter((s) => String(s.uses ?? '').startsWith('actions/cache/restore') && String(s.with?.key).startsWith('main-history-v1-')));
    expect(restores.length).toBeGreaterThanOrEqual(5);
  });
});

// Real git, local file:// remote: save then restore round trip, and rejection of a damaged cache.
describe('CI main history mirror cache with real git', () => {
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-fetch-real-'));
    const origin = join(dir, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'config', 'uploadpack.allowFilter', 'true');
    for (const n of ['a', 'b', 'c']) {
      writeFileSync(join(origin, n), n);
      git(origin, 'add', n);
      git(origin, 'commit', '-q', '-m', n);
    }
    const clone = (name) => {
      const d = join(dir, name);
      mkdirSync(d);
      git(d, 'init', '-q', '-b', 'work');
      git(d, 'remote', 'add', 'origin', `file://${origin}`);
      return d;
    };
    return { dir, origin, clone };
  };
  const run = (cwd, cache, ...args) => spawnSync('sh', [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, MAIN_HISTORY_CACHE_DIR: cache } });

  it('saves a blobless mirror from a fetched repo and a fresh repo seeds from it', () => {
    const { dir, origin, clone } = setup();
    try {
      const a = clone('a');
      expect(run(a, join(dir, 'cache')).status).toBe(0);
      expect(run(a, join(dir, 'cache'), 'save').status).toBe(0);
      const tip = git(origin, 'rev-parse', 'main');
      expect(readFileSync(join(dir, 'cache', 'sha'), 'utf8').trim()).toBe(tip);
      const b = clone('b');
      const r = run(b, join(dir, 'cache'));
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('seeded main history from cache');
      expect(git(b, 'rev-parse', 'refs/remotes/origin/main')).toBe(tip);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects a cache whose pack lacks the recorded tip and still ends with the live tip', () => {
    const { dir, origin, clone } = setup();
    try {
      const a = clone('a');
      run(a, join(dir, 'cache'));
      run(a, join(dir, 'cache'), 'save');
      writeFileSync(join(dir, 'cache', 'sha'), `${git(origin, 'rev-parse', 'main~1')}\n`);
      writeFileSync(join(dir, 'cache', 'sha'), `${'1'.repeat(40)}\n`);
      const b = clone('b');
      const r = run(b, join(dir, 'cache'));
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('cached main history unusable');
      expect(git(b, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(origin, 'rev-parse', 'main'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('save fails closed and publishes nothing when the export fails', () => {
    const { dir, clone } = setup();
    try {
      const a = clone('a');
      const r = run(a, join(dir, 'cache'), 'save');
      expect(r.status).not.toBe(0);
      expect(readdirSync(dir)).not.toContain('cache');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
