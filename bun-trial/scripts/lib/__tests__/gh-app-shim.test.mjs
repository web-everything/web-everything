/**
 * @file scripts/lib/__tests__/gh-app-shim.test.mjs
 * @description Unit + live proof of #x8mpubm's real fix: a dispatched `claude --bg` session does not inherit
 *   its spawner's ambient env, so getting a fresh App token into one needs a PATH-shadowing `gh` wrapper that
 *   reads the shared token cache on every call, plumbed in via `--settings`. Every pure function here is
 *   tested with no real fs/network; {@link ensureGhShim}/{@link buildGhShimSettingsEnv} additionally get a
 *   REAL tmpdir round trip, and the rendered shim script is REALLY EXECUTED (as `dispatch-spawn-live.test.mjs`
 *   does for the CLI argv) against a fake "real gh" — the one thing a purely-textual assertion on
 *   {@link renderGhShimScript}'s output could not prove.
 *
 *   #4064: the generated shim now routes every real-`gh` call through `gh-throttle.mjs`'s own CLI, which
 *   derives its cross-process lock root from `defaultPoolRoot` (HOME-based, HOST-SHARED — the same root the
 *   real conveyor/review daemons write their own live `.admission/gh/calls.jsonl` into). Every "live" test
 *   below that REALLY EXECUTES the shim now also really spawns that CLI, so `beforeAll`/`afterAll` here pin
 *   `LANE_POOL_ROOT` to a throwaway tmpdir for the whole file — never the real shared admission root (mirrors
 *   decision #2274's "ephemeral throwaway clone, never the shared lane pool" discipline, applied to this
 *   module's own shared lock instead of the lane pool).
 */
import { describe, it, test, expect, beforeAll, afterAll, mock } from 'bun:test';
const __ORIG_URL = new URL('../../../../scripts/lib/__tests__/gh-app-shim.test.mjs', import.meta.url).href;
const __ORIG_FILE = new URL(__ORIG_URL).pathname;
const __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\/$/, '');
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, statSync, mkdirSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributeSpend } from '../../../../scripts/lib/gh-spend.mjs';
import {
  defaultShimDir, shimGhPath, resolveRealGhBinary, renderGhShimScript, ensureGhShim, ghShimPathOverride,
  buildGhShimSettingsEnv, looksLikeAppTokenAuthFailure, ensureSettingsFileEnv, ensureSettingsFilePermissions, sanitizeSpawnEnv,
  defaultGhThrottleCliPath, checkoutShimDir, shimCallerScriptFromCommand,
} from '../../../../scripts/lib/gh-app-shim.mjs';

const CONFIGURED_ENV = {
  WE_GITHUB_APP_ID: '5037855',
  WE_GITHUB_APP_INSTALLATION_ID: '167640002',
  WE_GITHUB_APP_PRIVATE_KEY_PATH: '/Users/x/.secrets/github-apps/web-everything.pem',
};

// #4064 — isolate every "live" test's gh-throttle admission lock from the REAL, host-shared one for the
// duration of this file (restored after). `LANE_POOL_ROOT` is the existing, already-recognized override
// `defaultPoolRoot`/`ghThrottleLockRoot` both honor — no new plumbing, just pinning it here.
let PRE_EXISTING_LANE_POOL_ROOT;
let THROTTLE_TEST_LOCK_ROOT;
beforeAll(() => {
  PRE_EXISTING_LANE_POOL_ROOT = process.env.LANE_POOL_ROOT;
  THROTTLE_TEST_LOCK_ROOT = mkdtempSync(join(tmpdir(), 'we-gh-shim-throttle-lock-'));
  process.env.LANE_POOL_ROOT = THROTTLE_TEST_LOCK_ROOT;
});
afterAll(() => {
  if (PRE_EXISTING_LANE_POOL_ROOT === undefined) delete process.env.LANE_POOL_ROOT;
  else process.env.LANE_POOL_ROOT = PRE_EXISTING_LANE_POOL_ROOT;
  rmSync(THROTTLE_TEST_LOCK_ROOT, { recursive: true, force: true });
});

describe('defaultShimDir / shimGhPath — deterministic, always named literally `gh`', () => {
  it('is deterministic for a given home dir', () => {
    expect(defaultShimDir('/Users/op')).toBe(defaultShimDir('/Users/op'));
    expect(defaultShimDir('/Users/op')).toContain('/Users/op/.claude/github-app-token/');
  });

  it('shimGhPath always ends in a bare `gh`, never an extension', () => {
    expect(shimGhPath('/tmp/shim')).toBe('/tmp/shim/gh');
  });
});

describe('checkoutShimDir — one shim per checkout, never the machine-wide file every dispatcher rewrote (#4044)', () => {
  it('is deterministic per throttle path, distinct across checkouts, and never the legacy shared dir', () => {
    const a = checkoutShimDir({ ghThrottleCliPath: '/w/wev-review-daemon/scripts/lib/gh-throttle.mjs', home: '/Users/op' });
    const b = checkoutShimDir({ ghThrottleCliPath: '/w/.lanes/lane-46/scripts/lib/gh-throttle.mjs', home: '/Users/op' });
    expect(a).toBe(checkoutShimDir({ ghThrottleCliPath: '/w/wev-review-daemon/scripts/lib/gh-throttle.mjs', home: '/Users/op' }));
    expect(a).not.toBe(b);
    expect(a.startsWith('/Users/op/.claude/github-app-token/gh-shim.d/')).toBe(true);
    expect(a).not.toBe(defaultShimDir('/Users/op'));
  });
  it('buildGhShimSettingsEnv writes THIS checkout\'s shim dir by default (a lane dispatch can no longer repoint the daemon\'s gh)', () => {
    const writeFile = mock();
    const out = buildGhShimSettingsEnv({
      env: CONFIGURED_ENV, pathEnv: '/opt/homebrew/bin', exists: (p) => p === '/opt/homebrew/bin/gh',
      ghThrottleCliPath: '/w/wev-review-daemon/scripts/lib/gh-throttle.mjs', writeFile, chmod: mock(), mkdir: mock(), rename: mock(),
    });
    const dir = checkoutShimDir({ ghThrottleCliPath: '/w/wev-review-daemon/scripts/lib/gh-throttle.mjs' });
    expect(out.PATH).toBe(`${dir}:/opt/homebrew/bin`);
    expect(writeFile.mock.calls[0][0]).toBe(join(dir, 'gh'));
  });
});

describe('defaultGhThrottleCliPath — resolved through primaryCheckout, never wherever this module happens to run (gh-shim-stable-path)', () => {
  it('resolves through the injected primaryCheckout inputs to a checkout OUTSIDE a lane, even when `root` names one', () => {
    const laneRoot = '/w/.lanes/web-everything/lane-22';
    // `exists` answers true for the PRIMARY checkout dir itself (what `primaryCheckout`'s own alias probe
    // checks) AND its `gh-throttle.mjs` (what this function checks next) — never anything under the lane — so
    // a correct implementation can only return the primary path; the wrong (old) behavior would bake `root`'s
    // own sibling-of-this-file path in instead and never even consult `exists` this way.
    const exists = (p) => p === '/w/webeverything' || p === '/w/webeverything/scripts/lib/gh-throttle.mjs';
    const path = defaultGhThrottleCliPath({ root: laneRoot, exists, realpath: (p) => p });
    expect(path).toBe('/w/webeverything/scripts/lib/gh-throttle.mjs');
    expect(path).not.toContain('.lanes');
    expect(path).not.toContain('lane-22');
  });

  it('canonicalizes through a symlink alias — gh-throttle.mjs\'s own CLI entry check compares against the REAL path', () => {
    // Live bug this guards: the primary checkout is reachable through two names on this host (`webeverything`,
    // the real dir, and `web-everything`, a symlink CONSTELLATION_REPOS also lists). If `primaryCheckout` probes
    // the symlink name first, baking THAT string in makes gh-throttle.mjs's own
    // `__ORIG_URL === pathToFileURL(process.argv[1])` entry check silently false (Node's loader reports
    // __ORIG_URL through the REAL path) — main() never runs, the CLI exits 0 having printed nothing, and
    // every gh call routed through it looks like a no-op success.
    const exists = (p) => p === '/w/web-everything/scripts/lib/gh-throttle.mjs';
    const realpath = (p) => (p === '/w/web-everything/scripts/lib/gh-throttle.mjs' ? '/w/webeverything/scripts/lib/gh-throttle.mjs' : p);
    const path = defaultGhThrottleCliPath({ root: '/w/.lanes/web-everything/lane-5', exists, realpath });
    expect(path).toBe('/w/webeverything/scripts/lib/gh-throttle.mjs');
  });

  it('decouple-primary-checkout: the CONTROL CLONE wins over the primary checkout when it is provisioned', () => {
    // Both exist — the old code picked the primary (the operator's own, possibly months-stale working copy).
    const exists = (p) => p === '/w/webeverything' || p === '/w/webeverything/scripts/lib/gh-throttle.mjs'
      || p === '/h/workspace/wev-control/scripts/lib/gh-throttle.mjs';
    const path = defaultGhThrottleCliPath({ root: '/w/.lanes/web-everything/lane-22', exists, realpath: (p) => p, env: {}, home: '/h' });
    expect(path).toBe('/h/workspace/wev-control/scripts/lib/gh-throttle.mjs');
    expect(path).not.toContain('/w/webeverything');
  });

  it('decouple-primary-checkout: WE_CONTROL_CLONE moves the control clone', () => {
    const exists = (p) => p === '/w/webeverything/scripts/lib/gh-throttle.mjs' || p === '/srv/ctl/scripts/lib/gh-throttle.mjs';
    const path = defaultGhThrottleCliPath({ root: '/w/.lanes/web-everything/lane-5', exists, realpath: (p) => p, env: { WE_CONTROL_CLONE: '/srv/ctl' } });
    expect(path).toBe('/srv/ctl/scripts/lib/gh-throttle.mjs');
  });

  it('decouple-primary-checkout: an unprovisioned control clone falls back to the primary (one-release compat)', () => {
    const exists = (p) => p === '/w/webeverything' || p === '/w/webeverything/scripts/lib/gh-throttle.mjs';
    const path = defaultGhThrottleCliPath({ root: '/w/.lanes/web-everything/lane-22', exists, realpath: (p) => p, env: {}, home: '/h' });
    expect(path).toBe('/w/webeverything/scripts/lib/gh-throttle.mjs');
  });

  it('falls back to this module\'s own sibling path when no primary checkout can be found on disk at all', () => {
    const path = defaultGhThrottleCliPath({ root: '/nowhere', exists: () => false });
    expect(path).toMatch(/\/scripts\/lib\/gh-throttle\.mjs$/);
    expect(path).not.toBe('/nowhere/scripts/lib/gh-throttle.mjs');
  });
});

describe('resolveRealGhBinary — pure, given exists', () => {
  it('finds the first PATH entry (other than the shim dir itself) with a `gh` file', () => {
    const exists = (p) => p === '/opt/homebrew/bin/gh';
    expect(resolveRealGhBinary({ pathEnv: '/shim:/usr/bin:/opt/homebrew/bin', shimDir: '/shim', exists })).toBe('/opt/homebrew/bin/gh');
  });

  it('NEVER resolves to the shim dir itself, even if a stale `gh` sits there', () => {
    const exists = (p) => p === '/shim/gh' || p === '/opt/homebrew/bin/gh';
    expect(resolveRealGhBinary({ pathEnv: '/shim:/opt/homebrew/bin', shimDir: '/shim', exists })).toBe('/opt/homebrew/bin/gh');
  });

  it('skips EVERY generated shim dir (another checkout\'s, or the legacy shared one), never baking a shim in as the real gh (#4044)', () => {
    const exists = (p) => p.endsWith('/gh');
    expect(resolveRealGhBinary({
      pathEnv: '/h/.claude/github-app-token/gh-shim.d/abc:/h/.claude/github-app-token/gh-shim:/opt/homebrew/bin',
      shimDir: '/h/.claude/github-app-token/gh-shim.d/mine', shimRoot: '/h/.claude/github-app-token', exists,
    })).toBe('/opt/homebrew/bin/gh');
  });

  it('returns null when no PATH entry has a real gh — the caller\'s signal to skip shimming entirely', () => {
    expect(resolveRealGhBinary({ pathEnv: '/usr/bin:/bin', shimDir: '/shim', exists: () => false })).toBeNull();
  });

  it('handles an empty PATH without throwing', () => {
    expect(resolveRealGhBinary({ pathEnv: '', shimDir: '/shim', exists: () => false })).toBeNull();
  });
});

describe('ghShimPathOverride — pure', () => {
  it('prepends the shim dir ahead of whatever PATH already held', () => {
    expect(ghShimPathOverride({ dir: '/shim', currentPath: '/usr/bin:/bin' })).toBe('/shim:/usr/bin:/bin');
  });
});

describe('looksLikeAppTokenAuthFailure — pure, distinguishes a rejected credential from every other gh failure', () => {
  it('recognizes the exact live-caught signature (review-2582)', () => {
    expect(looksLikeAppTokenAuthFailure('HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login -h github.com')).toBe(true);
  });

  it('recognizes "Bad credentials" case-insensitively even without the HTTP 401 line', () => {
    expect(looksLikeAppTokenAuthFailure('bad credentials')).toBe(true);
  });

  it('does NOT match an unrelated failure — a missing PR, a bad flag, a network error', () => {
    expect(looksLikeAppTokenAuthFailure('HTTP 404: Not Found')).toBe(false);
    expect(looksLikeAppTokenAuthFailure('unknown flag --bogus')).toBe(false);
    expect(looksLikeAppTokenAuthFailure('dial tcp: connection refused')).toBe(false);
  });

  it('handles empty/undefined input without throwing', () => {
    expect(looksLikeAppTokenAuthFailure('')).toBe(false);
    expect(looksLikeAppTokenAuthFailure(undefined)).toBe(false);
  });
});

describe('renderGhShimScript — pure text, and REALLY RUN against a fake real gh', () => {
  it('bakes the real gh path and cache path in as literal, unambiguous JSON string constants', () => {
    const src = renderGhShimScript({ realGhPath: '/opt/homebrew/bin/gh', cachePath: '/home/op/.claude/github-app-token/web-everything.json' });
    expect(src).toContain(`const REAL_GH = ${JSON.stringify('/opt/homebrew/bin/gh')};`);
    expect(src).toContain(`const CACHE_PATH = ${JSON.stringify('/home/op/.claude/github-app-token/web-everything.json')};`);
    expect(src).toMatch(/^#!\/usr\/bin\/env node/);
  });

  it('every spawnSync target in the rendered shim is an absolute path or process.execPath — never a PATH lookup (PR #2851 review)', () => {
    const src = renderGhShimScript({ realGhPath: '/opt/homebrew/bin/gh', cachePath: '/home/op/.claude/github-app-token/web-everything.json' });
    const targets = [...src.matchAll(/spawnSync\(\s*([^,)]+)[,)]/g)].map((m) => m[1].trim());
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect([t, t === 'REAL_GH' || t === 'process.execPath' || /^['"]\//.test(t)]).toEqual([t, true]);
  });

  // THE LIVE PROOF (mirrors dispatch-spawn-live.test.mjs's own reasoning: a textual assertion on the rendered
  // source could not catch a real runtime bug — a typo in the freshness check, a broken argv passthrough, a
  // wrong exit code). This actually renders, writes, chmods and EXECUTES the shim as a real child process.
  describe('live', () => {
    function setup() {
      const dir = mkdtempSync(join(tmpdir(), 'we-gh-shim-live-'));
      const realGh = join(dir, 'real-gh');
      // The fake "real gh": echoes its own argv and whatever GH_TOKEN it saw, so the test can assert both.
      writeFileSync(realGh, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), ghToken: process.env.GH_TOKEN || null }));\n', 'utf8');
      chmodSync(realGh, 0o755);
      const cachePath = join(dir, 'cache.json');
      const shimPath = join(dir, 'gh');
      writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath }), 'utf8');
      chmodSync(shimPath, 0o755);
      return { dir, realGh, cachePath, shimPath };
    }

    it('a FRESH cached token is applied as GH_TOKEN for the real gh call', () => {
      const { dir, cachePath, shimPath } = setup();
      try {
        writeFileSync(cachePath, JSON.stringify({ v: 2, token: 'ghs_live_fresh', expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }), 'utf8');
        const out = JSON.parse(execFileSync(shimPath, ['pr', 'view', '181'], { encoding: 'utf8' }));
        expect(out.ghToken).toBe('ghs_live_fresh');
        expect(out.argv).toEqual(['pr', 'view', '181']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a token within the refresh buffer of expiry is NOT applied — falls through to whatever auth was already in effect', () => {
      const { dir, cachePath, shimPath } = setup();
      try {
        writeFileSync(cachePath, JSON.stringify({ v: 2, token: 'ghs_live_stale', expiresAt: new Date(Date.now() + 60 * 1000).toISOString() }), 'utf8');
        const out = JSON.parse(execFileSync(shimPath, ['pr', 'view', '181'], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: undefined } }));
        expect(out.ghToken).toBeFalsy();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // #4044 live bug (2026-09-25 08:14 ET): the shared shim had baked in a gh-throttle.mjs path from a checkout
    // that was gone; every gh call on the machine died with `node:internal/modules/cjs/loader:1227` and the
    // daemon rebuild's live smoke rejected main on it. A missing throttle CLI must degrade to the real gh.
    it('a baked GH_THROTTLE_CLI that no longer exists (its checkout was removed) falls back to the real gh — never a Cannot-find-module crash (#4044)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'we-gh-shim-live-'));
      try {
        const realGh = join(dir, 'real-gh');
        writeFileSync(realGh, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), ghToken: process.env.GH_TOKEN || null }));\n', 'utf8');
        chmodSync(realGh, 0o755);
        const cachePath = join(dir, 'cache.json');
        writeFileSync(cachePath, JSON.stringify({ v: 2, token: 'ghs_live_fresh', expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }), 'utf8');
        const shimPath = join(dir, 'gh');
        const goneCli = join(dir, 'lane-that-was-deleted', 'scripts', 'lib', 'gh-throttle.mjs');
        writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath, ghThrottleCliPath: goneCli }), 'utf8');
        chmodSync(shimPath, 0o755);
        const r = spawnSync(shimPath, ['api', 'repos/web-everything/y'], { encoding: 'utf8' });
        expect(r.stderr).not.toMatch(/Cannot find module|cjs\/loader/);
        expect(r.status).toBe(0);
        const out = JSON.parse(r.stdout);
        expect(out.argv).toEqual(['api', 'repos/web-everything/y']);
        expect(out.ghToken).toBe('ghs_live_fresh'); // still on the App token — only the pacing hop is skipped
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // #4200-ish (gh-shim-stable-path) — the missing-CLI fallback now warns on stderr instead of degrading
    // silently, so a fallback that WOULD have gone unnoticed shows up in the dispatched session's own output.
    it('a missing GH_THROTTLE_CLI degrades to direct gh AND prints a visible stderr warning naming the missing path', () => {
      const dir = mkdtempSync(join(tmpdir(), 'we-gh-shim-live-'));
      try {
        const realGh = join(dir, 'real-gh');
        writeFileSync(realGh, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true }));\n');
        chmodSync(realGh, 0o755);
        const cachePath = join(dir, 'cache.json');
        const shimPath = join(dir, 'gh');
        const goneCli = join(dir, 'lane-that-was-deleted', 'scripts', 'lib', 'gh-throttle.mjs');
        writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath, ghThrottleCliPath: goneCli }), 'utf8');
        chmodSync(shimPath, 0o755);
        const r = spawnSync(shimPath, ['api', 'repos/web-everything/y'], { encoding: 'utf8' });
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ ok: true });
        expect(r.stderr).toContain('gh-shim:');
        expect(r.stderr).toContain(goneCli);
        expect(r.stderr).toContain('falling back to direct, unthrottled gh');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // #4200-ish — GH_THROTTLE_CLI itself can exist while one of ITS OWN sibling imports has been stranded by a
    // lane reset elsewhere (the entry file survives; a module it imports does not). The OLD detection only
    // matched "Cannot find module" text that also contained GH_THROTTLE_CLI's own path, which this case does
    // NOT produce (the missing path is the SIBLING's, not the entry file's) — so it used to crash the whole
    // gh call instead of degrading. Broadened detection must catch this too.
    it('GH_THROTTLE_CLI present but with a stranded sibling import still degrades to direct gh, never crashes', () => {
      const dir = mkdtempSync(join(tmpdir(), 'we-gh-shim-live-'));
      try {
        const realGh = join(dir, 'real-gh');
        writeFileSync(realGh, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, via: "real-gh" }));\n');
        chmodSync(realGh, 0o755);
        const brokenCliDir = join(dir, 'broken-throttle-checkout');
        mkdirSync(brokenCliDir, { recursive: true });
        const brokenCli = join(brokenCliDir, 'gh-throttle.mjs');
        // The entry file itself exists and is valid — it just imports a sibling that isn't there, exactly the
        // shape a partial lane reset leaves behind.
        writeFileSync(brokenCli, "import './a-sibling-that-was-stranded-by-a-lane-reset.mjs';\n", 'utf8');
        const cachePath = join(dir, 'cache.json');
        const shimPath = join(dir, 'gh');
        writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath, ghThrottleCliPath: brokenCli }), 'utf8');
        chmodSync(shimPath, 0o755);
        const r = spawnSync(shimPath, ['api', 'repos/web-everything/y'], { encoding: 'utf8' });
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ ok: true, via: 'real-gh' });
        expect(r.stderr).toContain('gh-shim:');
        expect(r.stderr).toContain('falling back to direct, unthrottled gh');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // PR #2772 review:changes — the throttle CLI relays the REAL gh's stderr byte-for-byte, so a genuine gh
    // failure (a Node-based extension, a broken Node git hook) whose OWN stderr says "Cannot find module" must
    // never be mistaken for the throttle CLI failing to load: that would re-run the SAME, possibly mutating,
    // command a second time via the direct fallback. The throttle CLI here loads fine and runs gh exactly once.
    it('does not replay a real gh failure whose own relayed stderr contains "Cannot find module" — the mutating call runs exactly once', () => {
      // realpath'd: macOS's tmpdir is a symlink (/var → /private/var), which would make the relay CLI's own
      // entry-point guard below silently false — the same trap defaultGhThrottleCliPath realpaths against.
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'we-gh-shim-live-')));
      try {
        const counter = join(dir, 'invocations');
        const realGh = join(dir, 'real-gh');
        // A mutating "real gh": records the invocation, then fails for a reason UNRELATED to the throttle CLI.
        writeFileSync(
          realGh,
          '#!/usr/bin/env node\n'
            + `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x');\n`
            + "process.stderr.write(\"Error: Cannot find module '/some/unrelated/hook.js'\\n\");\n"
            + 'process.exitCode = 1;\n',
          'utf8',
        );
        chmodSync(realGh, 0o755);
        // A healthy throttle CLI that transparently relays the real gh (the same contract gh-throttle.mjs's own
        // runGhCliPassthrough keeps), guarded like the real one so importing it has no side effect.
        const relayCli = join(dir, 'healthy-throttle', 'gh-throttle.mjs');
        mkdirSync(join(dir, 'healthy-throttle'), { recursive: true });
        writeFileSync(
          relayCli,
          "import { spawnSync } from 'node:child_process';\n"
            + "import { pathToFileURL } from 'node:url';\n"
            + "if (__ORIG_URL === pathToFileURL(process.argv[1] || '').href) {\n"
            + "  const r = spawnSync(process.env.WE_GH_THROTTLE_GH_BIN, process.argv.slice(2), { stdio: ['inherit', 'pipe', 'pipe'] });\n"
            + '  process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode = r.status;\n'
            + '}\n',
          'utf8',
        );
        const cachePath = join(dir, 'cache.json');
        const shimPath = join(dir, 'gh');
        writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath, ghThrottleCliPath: relayCli }), 'utf8');
        chmodSync(shimPath, 0o755);
        const r = spawnSync(shimPath, ['pr', 'comment', '1', '--body', 'x'], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: undefined } });
        expect(readFileSync(counter, 'utf8')).toBe('x'); // exactly one real invocation — never a silent replay
        expect(r.status).toBe(1); // the genuine failure is preserved, not masked by a fallback's result
        expect(r.stderr).toContain("Cannot find module '/some/unrelated/hook.js'");
        expect(r.stderr).not.toContain('gh-shim:');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a missing cache file is treated as absent, never thrown on — the real gh still runs', () => {
      const { dir, shimPath } = setup(); // cache.json is never written
      try {
        // GH_TOKEN cleared: a host running under App auth would otherwise leak its own token into the fake.
        const out = JSON.parse(execFileSync(shimPath, ['--version'], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: undefined } }));
        expect(out.ghToken).toBeFalsy();
        expect(out.argv).toEqual(['--version']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a token that IS fresh by expiresAt but GitHub rejects (HTTP 401) falls back to personal auth instead of failing the session, and invalidates the shared cache (#xkse05k, live-caught review-2582)', () => {
      const { dir, cachePath, shimPath } = setup();
      const realGh = join(dir, 'real-gh');
      // Rejects the App token specifically (exactly what GitHub did to review-2582's "fresh" cached token);
      // succeeds when called with no GH_TOKEN at all (personal auth, proven healthy in the live incident).
      writeFileSync(
        realGh,
        '#!/usr/bin/env node\n'
          + 'if (process.env.GH_TOKEN) { process.stderr.write("HTTP 401: Bad credentials (https://api.github.com/graphql)\\n"); process.exit(1); }\n'
          + 'console.log(JSON.stringify({ ghToken: process.env.GH_TOKEN || null, ok: true }));\n',
        'utf8',
      );
      chmodSync(realGh, 0o755);
      writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath }), 'utf8');
      chmodSync(shimPath, 0o755);
      try {
        writeFileSync(cachePath, JSON.stringify({ v: 2, token: 'ghs_rejected_but_fresh', expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString() }), 'utf8');
        const out = JSON.parse(execFileSync(shimPath, ['pr', 'view', '2582'], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: undefined } }));
        expect(out.ok).toBe(true);
        expect(out.ghToken).toBeFalsy(); // the retry ran with no token override — personal auth, not the rejected one
        expect(existsSync(cachePath)).toBe(false); // invalidated so the fleet's next refresh mints a replacement
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a large (>100KB) gh pr view payload is NOT truncated — the classic write-then-exit race (#x8mpubm follow-up, live-caught review-2578/2601: "Unterminated string in JSON")', () => {
      const { dir, cachePath, shimPath } = setup();
      const realGh = join(dir, 'real-gh');
      // A fake `gh` that prints a large, valid JSON payload — standing in for a real `gh pr view` with a big
      // body/comments/files list. Padded well past the ~64KB pipe-buffer size that triggers the async-write
      // race: `stdio: ['inherit','pipe','pipe']` captures this into a Buffer, the shim re-emits it via
      // `process.stdout.write`, and a `process.exit()` called immediately after (the pre-fix code) tears the
      // process down before that write drains, truncating the JSON mid-string — exactly the live symptom.
      const bigBody = 'x'.repeat(150 * 1024);
      writeFileSync(
        realGh,
        '#!/usr/bin/env node\n'
          + `const body = ${JSON.stringify(bigBody)};\n`
          + 'process.stdout.write(JSON.stringify({ number: 2578, body, ok: true }));\n',
        'utf8',
      );
      chmodSync(realGh, 0o755);
      writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath }), 'utf8');
      chmodSync(shimPath, 0o755);
      try {
        writeFileSync(cachePath, JSON.stringify({ v: 2, token: 'ghs_live_fresh', expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString() }), 'utf8');
        const raw = execFileSync(shimPath, ['pr', 'view', '2578', '--json', 'number,body'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        expect(raw.length).toBeGreaterThan(150 * 1024); // never silently shorter than what `gh` actually printed
        const parsed = JSON.parse(raw); // throws "Unterminated string in JSON" on the pre-fix truncation bug
        expect(parsed.ok).toBe(true);
        expect(parsed.body).toHaveLength(150 * 1024);
        expect(parsed.body).toBe(bigBody);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a REAL gh failure unrelated to auth (e.g. a genuinely missing PR) is passed through untouched — never retried, cache left alone', () => {
      const { dir, cachePath, shimPath } = setup();
      const realGh = join(dir, 'real-gh');
      writeFileSync(
        realGh,
        '#!/usr/bin/env node\nprocess.stderr.write("HTTP 404: Not Found (https://api.github.com/graphql)\\n"); process.exit(1);\n',
      );
      chmodSync(realGh, 0o755);
      writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath }), 'utf8');
      chmodSync(shimPath, 0o755);
      try {
        writeFileSync(cachePath, JSON.stringify({ v: 2, token: 'ghs_still_good', expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString() }), 'utf8');
        expect(() => execFileSync(shimPath, ['pr', 'view', '9999'], { encoding: 'utf8' })).toThrow(/status 1|Command failed/);
        expect(existsSync(cachePath)).toBe(true); // never touched — this wasn't a credential rejection
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a rejected token with NO working fallback either still exits cleanly with the fallback\'s own code (no crash, no double-throw)', () => {
      const { dir, cachePath, shimPath } = setup();
      const realGh = join(dir, 'real-gh');
      // Fails every time, auth-shaped or not — proves the retry's OWN outcome (not a swallowed success) is
      // what the shim reports, and that trying twice never crashes.
      writeFileSync(realGh, '#!/usr/bin/env node\nprocess.stderr.write("HTTP 401: Bad credentials (https://api.github.com/graphql)\\n"); process.exit(1);\n');
      chmodSync(realGh, 0o755);
      writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath }), 'utf8');
      chmodSync(shimPath, 0o755);
      try {
        writeFileSync(cachePath, JSON.stringify({ v: 2, token: 'ghs_rejected', expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString() }), 'utf8');
        expect(() => execFileSync(shimPath, ['pr', 'view', '2582'], { encoding: 'utf8' })).toThrow(/status 1|Command failed/);
        expect(existsSync(cachePath)).toBe(false); // still invalidated — the rejection was real either way
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // PR #2600 review:changes — the App-token call captures output (so a 401 can be inspected), which put it
    // behind spawnSync's default 1MB maxBuffer (ENOBUFS → shim exit 1 on a call that SUCCEEDED), and wrote the
    // captured bytes with process.stdout.write + an immediate process.exit, which drops everything past the
    // first pipe chunk (~8KB) when stdout is a pipe. Both are exercised here through a REAL pipe.
    const BIG = 3 * 1024 * 1024; // well past both the 1MB buffer default and the ~8KB pipe chunk
    function writeBigFakeGh(realGh, { rejectToken = false } = {}) {
      writeFileSync(
        realGh,
        '#!/usr/bin/env node\n'
          + (rejectToken ? 'if (process.env.GH_TOKEN) { process.stderr.write("HTTP 401: Bad credentials\\n"); process.exit(1); }\n' : '')
          + `process.stdout.write("x".repeat(${BIG}));\n`
          + `process.stderr.write("e".repeat(${BIG}));\n`,
        'utf8',
      );
      chmodSync(realGh, 0o755);
    }

    it('a SUCCESSFUL tokened call with multi-MB output passes every byte through a pipe — no ENOBUFS, no truncation', () => {
      const { dir, realGh, cachePath, shimPath } = setup();
      writeBigFakeGh(realGh);
      try {
        writeFileSync(cachePath, JSON.stringify({ v: 2, token: 'ghs_fresh', expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString() }), 'utf8');
        const out = spawnSync(shimPath, ['api', 'big'], { maxBuffer: 64 << 20 });
        expect(out.status).toBe(0);
        expect(out.stdout.length).toBe(BIG);
        expect(out.stderr.length).toBe(BIG);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Regression check only: the retry runs with inherited stdio, which never had either bug.
    it('the 401 fallback retry (inherited stdio) passes multi-MB output through intact', () => {
      const { dir, realGh, cachePath, shimPath } = setup();
      writeBigFakeGh(realGh, { rejectToken: true });
      try {
        writeFileSync(cachePath, JSON.stringify({ v: 2, token: 'ghs_rejected', expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString() }), 'utf8');
        const out = spawnSync(shimPath, ['api', 'big'], { maxBuffer: 64 << 20, env: { ...process.env, GH_TOKEN: undefined } });
        expect(out.status).toBe(0);
        expect(out.stdout.length).toBe(BIG);
        expect(existsSync(cachePath)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exits with the REAL gh\'s own exit code, transparently', () => {
      const dir = mkdtempSync(join(tmpdir(), 'we-gh-shim-live-'));
      const realGh = join(dir, 'real-gh');
      writeFileSync(realGh, '#!/usr/bin/env node\nprocess.exit(7);\n', 'utf8');
      chmodSync(realGh, 0o755);
      const shimPath = join(dir, 'gh');
      writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath: join(dir, 'cache.json') }), 'utf8');
      chmodSync(shimPath, 0o755);
      try {
        expect(() => execFileSync(shimPath, [], { encoding: 'utf8' })).toThrow(/status 7|Command failed/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// #4309 — every agent-session gh call used to log `caller: "unknown"`: the throttle CLI's own argv[1] is always
// gh-throttle.mjs, and the shim never said who called it. The rendered shim now sets WE_GH_THROTTLE_CALLER.
describe('shimCallerScriptFromCommand — pure, the calling script from a `ps -o command=` line (#4309)', () => {
  it('names an interpreter-run script, skipping flags and flag values', () => {
    expect(shimCallerScriptFromCommand('node /w/scripts/conveyor/ci-heal-mark.mjs 2821 --repo=x')).toBe('ci-heal-mark.mjs');
    expect(shimCallerScriptFromCommand('/opt/homebrew/bin/node --import /w/loader.mjs /w/review-daemon.mjs')).toBe('review-daemon.mjs');
    expect(shimCallerScriptFromCommand('python3 -u /w/tool.py')).toBe('tool.py');
    expect(shimCallerScriptFromCommand('/w/bin/sync.sh --fast')).toBe('sync.sh');
  });
  it('never mistakes a shell -c line (an agent Bash tool call), node -e, or a bare binary for a script', () => {
    expect(shimCallerScriptFromCommand("/bin/zsh -c -l source /Users/o/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'gh pr view 1'")).toBeNull();
    expect(shimCallerScriptFromCommand('node -e "require(1)"')).toBeNull();
    expect(shimCallerScriptFromCommand('/usr/local/bin/claude --bg')).toBeNull();
    expect(shimCallerScriptFromCommand('')).toBeNull();
  });
});

describe('renderGhShimScript — sets WE_GH_THROTTLE_CALLER on the throttle CLI (#4309, live)', () => {
  function setup() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'we-gh-shim-caller-')));
    // The fake "real gh" reports the caller the throttle hop would log.
    const realGh = join(dir, 'real-gh');
    writeFileSync(realGh, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ caller: process.env.WE_GH_THROTTLE_CALLER || null }));\n');
    chmodSync(realGh, 0o755);
    // A relay standing in for gh-throttle.mjs's CLI (same contract: exec WE_GH_THROTTLE_GH_BIN, inherit env).
    const relayCli = join(dir, 'throttle', 'gh-throttle.mjs');
    mkdirSync(join(dir, 'throttle'), { recursive: true });
    writeFileSync(relayCli, "import { spawnSync } from 'node:child_process';\nimport { pathToFileURL } from 'node:url';\n"
      + "if (__ORIG_URL === pathToFileURL(process.argv[1] || '').href) {\n"
      + "  const r = spawnSync(process.env.WE_GH_THROTTLE_GH_BIN, process.argv.slice(2), { stdio: ['inherit', 'pipe', 'pipe'] });\n"
      + '  process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode = r.status;\n}\n');
    const shimPath = join(dir, 'gh');
    writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath: join(dir, 'cache.json'), ghThrottleCliPath: relayCli }));
    chmodSync(shimPath, 0o755);
    const env = { ...process.env, GH_TOKEN: undefined, GH_CALLER: undefined, CLAUDE_CODE_SESSION_ID: undefined };
    return { dir, shimPath, env };
  }
  const callerOf = (r) => JSON.parse(r.stdout).caller;
  // Each case starts 4-5 real processes (caller, shim, `ps`, relay, fake gh): ~1s idle, far more under a loaded
  // full-suite run — so these get an explicit budget instead of vitest's 5s default.
  const SPAWN_TIMEOUT_MS = 30_000;

  it('GH_CALLER wins', () => {
    const { dir, shimPath, env } = setup();
    try {
      expect(callerOf(spawnSync(shimPath, ['pr', 'view', '1'], { encoding: 'utf8', env: { ...env, GH_CALLER: 'parked-pr-conflict-watch-we' } }))).toBe('parked-pr-conflict-watch-we');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, SPAWN_TIMEOUT_MS);

  it('else the parent process\'s script (a node script shelling a bare gh)', () => {
    const { dir, shimPath, env } = setup();
    try {
      const script = join(dir, 'ci-heal-mark.mjs');
      writeFileSync(script, `import { spawnSync } from 'node:child_process';\nconst r = spawnSync(${JSON.stringify(shimPath)}, ['pr', 'comment', '1'], { encoding: 'utf8' });\nprocess.stdout.write(r.stdout);\n`);
      const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...env, CLAUDE_CODE_SESSION_ID: 'must-not-win' } });
      expect(callerOf(r)).toBe('ci-heal-mark.mjs');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, SPAWN_TIMEOUT_MS);

  it('else the Claude session id (a shell -c parent, the agent Bash tool shape)', () => {
    const { dir, shimPath, env } = setup();
    try {
      // `; true` keeps sh from exec-replacing itself, so the shim's parent really is the `sh -c` process.
      const r = spawnSync('/bin/sh', ['-c', `${JSON.stringify(shimPath)} pr view 1; true`], { encoding: 'utf8', env: { ...env, CLAUDE_CODE_SESSION_ID: '0123456789abcdef' } });
      expect(callerOf(r)).toBe('session:01234567');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, SPAWN_TIMEOUT_MS);

  it('else the parent\'s command name — never left blank', () => {
    const { dir, shimPath, env } = setup();
    try {
      const r = spawnSync('/bin/sh', ['-c', `${JSON.stringify(shimPath)} pr view 1; true`], { encoding: 'utf8', env });
      expect(callerOf(r)).toBe('sh');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, SPAWN_TIMEOUT_MS);
});

describe('ensureGhShim — the one real write, best-effort, never throws', () => {
  it('writes an executable file at dir/gh with the rendered content, via a real tmpdir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-gh-shim-ensure-'));
    try {
      const result = ensureGhShim({ dir, realGhPath: '/opt/homebrew/bin/gh', cachePath: '/x/cache.json' });
      expect(result).toEqual({ ok: true, path: join(dir, 'gh') });
      expect(existsSync(join(dir, 'gh'))).toBe(true);
      const content = readFileSync(join(dir, 'gh'), 'utf8');
      expect(content).toContain('/opt/homebrew/bin/gh');
      expect(content).toContain('/x/cache.json');
      // Executable — the whole point of a PATH shim.
      expect(statSync(join(dir, 'gh')).mode & 0o111).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses with {ok:false} when no real gh path is given, writing nothing', () => {
    const mkdir = mock();
    const writeFile = mock();
    expect(ensureGhShim({ dir: '/x', realGhPath: null, mkdir, writeFile })).toEqual({ ok: false, reason: 'no-real-gh' });
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('the real write is atomic — temp file then rename onto dir/gh, never an in-place truncate a concurrent gh could exec half-written (#4044)', () => {
    const writeFile = mock();
    const chmod = mock();
    const rename = mock();
    const result = ensureGhShim({ dir: '/shim', realGhPath: '/bin/gh', cachePath: '/x/c.json', mkdir: mock(), writeFile, chmod, rename });
    expect(result).toEqual({ ok: true, path: '/shim/gh' });
    const tmp = writeFile.mock.calls[0][0];
    expect(tmp).toMatch(/^\/shim\/gh\.tmp-/);
    expect(chmod).toHaveBeenCalledWith(tmp, 0o755);
    expect(rename).toHaveBeenCalledWith(tmp, '/shim/gh');
  });

  it('a failing write is swallowed — {ok:false}, never a thrown error', () => {
    const writeFile = mock(() => { throw new Error('disk full'); });
    const result = ensureGhShim({ dir: '/x', realGhPath: '/bin/gh', mkdir: mock(), writeFile, chmod: mock() });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('write-failed');
  });
});

describe('ensureSettingsFileEnv — the durable, per-checkout delivery path (#x8mpubm follow-up)', () => {
  it('creates .claude/settings.local.json with the given env, via a real tmpdir', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'we-settings-file-'));
    try {
      const result = ensureSettingsFileEnv({ cwd, env: { PATH: '/shim:/usr/bin' } });
      const path = join(cwd, '.claude', 'settings.local.json');
      expect(result).toEqual({ ok: true, path });
      const written = JSON.parse(readFileSync(path, 'utf8'));
      expect(written.env.PATH).toBe('/shim:/usr/bin');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('is ADDITIVE — preserves an existing file\'s other top-level keys and other env entries', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'we-settings-file-'));
    try {
      mkdirSync(join(cwd, '.claude'), { recursive: true });
      writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, env: { OTHER: 'kept' } }), 'utf8');
      ensureSettingsFileEnv({ cwd, env: { PATH: '/shim:/usr/bin' } });
      const written = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8'));
      expect(written.permissions).toEqual({ allow: ['Bash(ls:*)'] });
      expect(written.env).toEqual({ OTHER: 'kept', PATH: '/shim:/usr/bin' });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a corrupt existing file is treated as empty, never thrown on', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'we-settings-file-'));
    try {
      mkdirSync(join(cwd, '.claude'), { recursive: true });
      writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{ not json', 'utf8');
      const result = ensureSettingsFileEnv({ cwd, env: { PATH: '/shim:/usr/bin' } });
      expect(result.ok).toBe(true);
      const written = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8'));
      expect(written.env.PATH).toBe('/shim:/usr/bin');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns {ok:false} without throwing when no cwd is given, or when the write fails', () => {
    expect(ensureSettingsFileEnv({ cwd: null, env: {} })).toEqual({ ok: false, reason: 'no-cwd' });
    const result = ensureSettingsFileEnv({
      cwd: '/x', env: { PATH: 'x' }, mkdir: mock(), writeFile: () => { throw new Error('read-only fs'); },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('write-failed');
  });
});

describe('ensureSettingsFilePermissions — the permission counterpart to ensureSettingsFileEnv (#xrv69j6)', () => {
  it('creates .claude/settings.local.json with the given additionalDirectories + allow rules, via a real tmpdir', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'we-settings-perm-'));
    try {
      const result = ensureSettingsFilePermissions({
        cwd, additionalDirectories: ['/lanes/lane-9'], allow: ['Edit(/lanes/lane-9/**)', 'Write(/lanes/lane-9/**)'],
      });
      const path = join(cwd, '.claude', 'settings.local.json');
      expect(result).toEqual({ ok: true, path });
      const written = JSON.parse(readFileSync(path, 'utf8'));
      expect(written.permissions.additionalDirectories).toEqual(['/lanes/lane-9']);
      expect(written.permissions.allow).toEqual(['Edit(/lanes/lane-9/**)', 'Write(/lanes/lane-9/**)']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('is ADDITIVE and DEDUPES — preserves an existing file\'s other keys/env and never repeats an entry', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'we-settings-perm-'));
    try {
      mkdirSync(join(cwd, '.claude'), { recursive: true });
      writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({
        env: { OTHER: 'kept' },
        permissions: { additionalDirectories: ['/lanes/lane-9'], allow: ['Edit(/lanes/lane-9/**)'] },
      }), 'utf8');
      ensureSettingsFilePermissions({
        cwd, additionalDirectories: ['/lanes/lane-9', '/lanes/lane-12'], allow: ['Edit(/lanes/lane-9/**)', 'Edit(/lanes/lane-12/**)'],
      });
      const written = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8'));
      expect(written.env).toEqual({ OTHER: 'kept' });
      expect(written.permissions.additionalDirectories).toEqual(['/lanes/lane-9', '/lanes/lane-12']);
      expect(written.permissions.allow).toEqual(['Edit(/lanes/lane-9/**)', 'Edit(/lanes/lane-12/**)']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a corrupt existing file is treated as empty, never thrown on', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'we-settings-perm-'));
    try {
      mkdirSync(join(cwd, '.claude'), { recursive: true });
      writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{ not json', 'utf8');
      const result = ensureSettingsFilePermissions({ cwd, additionalDirectories: ['/lanes/lane-9'] });
      expect(result.ok).toBe(true);
      const written = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8'));
      expect(written.permissions.additionalDirectories).toEqual(['/lanes/lane-9']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('is a no-op (never writes) when nothing is given to grant', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'we-settings-perm-'));
    try {
      const result = ensureSettingsFilePermissions({ cwd, additionalDirectories: [], allow: [] });
      expect(result).toEqual({ ok: true, changed: false });
      expect(existsSync(join(cwd, '.claude', 'settings.local.json'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns {ok:false} without throwing when no cwd is given, or when the write fails', () => {
    expect(ensureSettingsFilePermissions({ cwd: null, additionalDirectories: ['/x'] })).toEqual({ ok: false, reason: 'no-cwd' });
    const result = ensureSettingsFilePermissions({
      cwd: '/x', additionalDirectories: ['/x'], mkdir: mock(), writeFile: () => { throw new Error('read-only fs'); },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('write-failed');
  });
});

describe('sanitizeSpawnEnv — pure, never lets a daemon\'s own App token leak into a spawned claude front-end (#x8mpubm follow-up)', () => {
  it('removes GH_TOKEN and GITHUB_TOKEN, keeps everything else', () => {
    const out = sanitizeSpawnEnv({ GH_TOKEN: 'ghs_x', GITHUB_TOKEN: 'y', PATH: '/bin', HOME: '/Users/op' });
    expect(out).toEqual({ PATH: '/bin', HOME: '/Users/op' });
  });

  it('is a no-op (aside from copying) when neither var is present', () => {
    expect(sanitizeSpawnEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });

  it('never mutates the input object', () => {
    const input = { GH_TOKEN: 'ghs_x', PATH: '/bin' };
    sanitizeSpawnEnv(input);
    expect(input.GH_TOKEN).toBe('ghs_x'); // untouched
  });
});

describe('buildGhShimSettingsEnv — the composed, OPT-IN-GATED entry point a dispatcher actually calls', () => {
  it('returns null and touches NO fs at all when App auth is not configured — the safe default for every unconfigured host (and every test)', () => {
    const exists = mock();
    const writeFile = mock();
    const mkdir = mock();
    const result = buildGhShimSettingsEnv({ env: {}, exists, writeFile, mkdir });
    expect(result).toBeNull();
    expect(exists).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('returns null when configured but no real gh binary is found on PATH', () => {
    const result = buildGhShimSettingsEnv({ env: CONFIGURED_ENV, pathEnv: '/usr/bin', exists: () => false });
    expect(result).toBeNull();
  });

  it('configured + a real gh found: writes the shim and returns the PATH override', () => {
    const writeFile = mock();
    const chmod = mock();
    const mkdir = mock();
    const result = buildGhShimSettingsEnv({
      env: CONFIGURED_ENV, pathEnv: '/opt/homebrew/bin:/usr/bin', dir: '/shim', cachePath: '/home/op/cache.json',
      exists: (p) => p === '/opt/homebrew/bin/gh', writeFile, chmod, mkdir,
    });
    expect(result).toEqual({ PATH: '/shim:/opt/homebrew/bin:/usr/bin' });
    expect(mkdir).toHaveBeenCalledWith('/shim', { recursive: true });
    expect(writeFile).toHaveBeenCalledWith('/shim/gh', expect.stringContaining('/opt/homebrew/bin/gh'), 'utf8');
    expect(chmod).toHaveBeenCalledWith('/shim/gh', 0o755);
  });

  it('returns null (never throws) when the shim write itself fails', () => {
    const result = buildGhShimSettingsEnv({
      env: CONFIGURED_ENV, pathEnv: '/opt/homebrew/bin', dir: '/shim',
      exists: () => true, writeFile: () => { throw new Error('read-only fs'); }, mkdir: mock(), chmod: mock(),
    });
    expect(result).toBeNull();
  });

  describe('with `cwd` (#x8mpubm follow-up) — the durable settings.local.json path a spare-pool claim cannot skip', () => {
    it('ALSO writes the PATH override into <cwd>/.claude/settings.local.json, via a real tmpdir round trip', () => {
      const shimDir = mkdtempSync(join(tmpdir(), 'we-gh-shim-dir-'));
      const cwd = mkdtempSync(join(tmpdir(), 'we-gh-shim-cwd-'));
      try {
        const result = buildGhShimSettingsEnv({
          env: CONFIGURED_ENV, pathEnv: '/opt/homebrew/bin:/usr/bin', dir: shimDir, cachePath: join(shimDir, 'cache.json'),
          exists: (p) => p === '/opt/homebrew/bin/gh', cwd,
        });
        expect(result).toEqual({ PATH: `${shimDir}:/opt/homebrew/bin:/usr/bin` });
        const written = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8'));
        expect(written.env.PATH).toBe(result.PATH); // the SAME override reaches both delivery paths
      } finally {
        rmSync(shimDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it('omitting `cwd` (the pre-existing contract) never touches any settings file — back-compat for every caller that does not pass it', () => {
      const writeFile = mock();
      buildGhShimSettingsEnv({
        env: CONFIGURED_ENV, pathEnv: '/opt/homebrew/bin', dir: '/shim',
        exists: () => true, writeFile, mkdir: mock(), chmod: mock(),
      });
      // Only the shim's own single write — never a second call for a settings file nobody asked for.
      expect(writeFile).toHaveBeenCalledTimes(1);
    });

    it('a failed settings-file write never changes the returned PATH override — purely additional insurance', () => {
      const result = buildGhShimSettingsEnv({
        env: CONFIGURED_ENV, pathEnv: '/opt/homebrew/bin', dir: '/shim', cwd: '/read-only-checkout',
        exists: () => true, writeFile: (path) => { if (String(path).includes('settings.local.json')) throw new Error('read-only fs'); }, mkdir: mock(), chmod: mock(),
      });
      expect(result).toEqual({ PATH: '/shim:/opt/homebrew/bin' });
    });
  });
});

// #4653: the generated artifact and its ledger survive loss of the generating checkout.
describe('disposable checkout fallback metering', () => {
  it.each(['entry', 'import', 'healthy', 'failure', 'unknown', 'nested', 'debug'])('observes %s through the adopted PATH without replay', (mode) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'we-shim-meter-')));
    try {
      const checkout = join(dir, 'checkout');
      const bin = join(dir, 'bin');
      const ledger = join(dir, 'ledger');
      mkdirSync(checkout);
      const cli = join(checkout, 'throttle.mjs');
      const dependency = join(checkout, 'dependency.mjs');
      writeFileSync(dependency, 'export {};');
      writeFileSync(cli, `import './dependency.mjs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
if (__ORIG_URL === pathToFileURL(process.argv[1] || '').href) {
  const r = spawnSync(process.env.WE_GH_THROTTLE_GH_BIN, process.argv.slice(2), { stdio: 'inherit' });
  process.exitCode = r.status;
}`);
      const realGh = join(dir, 'real-gh');
      const count = join(dir, 'executions');
      const secret = 'ghs_disposable_fixture_secret';
      const trace = '* Request at now\n* Request to https://api.github.com/graphql\n> Authorization: Bearer ' + secret
        + '\n\nprivate request body\n< HTTP/2.0 200 OK\n< X-Ratelimit-Used: 9\n< X-Ratelimit-Remaining: 91\n< X-Ratelimit-Limit: 100\n< X-Ratelimit-Reset: 123\n< X-Ratelimit-Resource: graphql\n< Set-Cookie: private-cookie\n\n'
        + JSON.stringify({ data: { rateLimit: { cost: 3 }, private: 'private-response' } }) + '\n\n* Request took 1ms\n';
      writeFileSync(realGh, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(count)}, 'call\\n');
if (process.env.GH_TOKEN !== ${JSON.stringify(secret)}) process.exit(9);
process.stdout.write('payload\\u0000bytes\\n');
if (process.env.GH_DEBUG === 'api') process.stderr.write(${JSON.stringify(trace)});
process.stderr.write(${JSON.stringify(mode === 'failure' ? 'Cannot find module unrelated-extension\n' : 'warning\n')});
process.exitCode = ${mode === 'failure' ? 7 : 0};
`);
      chmodSync(realGh, 0o755);
      const cachePath = join(dir, 'cache.json');
      writeFileSync(cachePath, JSON.stringify({ v: 2, token: secret, installationId: '12345', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
      expect(ensureGhShim({ dir: bin, realGhPath: realGh, cachePath, ghThrottleCliPath: cli }).ok).toBe(true);
      if (mode === 'import') rmSync(dependency);
      else if (!['healthy', 'failure'].includes(mode)) rmSync(checkout, { recursive: true });
      const env = {
        ...process.env, PATH: ghShimPathOverride({ dir: bin }), GH_CALLER: 'disposable-probe',
        WE_GH_THROTTLE_LOCK_ROOT: ledger, GH_DEBUG: mode === 'debug' ? 'api' : '',
        WE_GH_THROTTLE_COST_HEADERS: mode === 'unknown' ? '0' : '1',
        WE_GH_THROTTLE_OUTER_INV: mode === 'nested' ? 'outer-probe' : '',
      };
      // A new shell resolves a bare gh through the actual generated PATH, after checkout deletion.
      const result = spawnSync('/bin/sh', ['-c', 'command -v gh; gh api graphql'], { env, encoding: 'utf8', cwd: dir });
      expect(result.stdout).toBe(`${join(bin, 'gh')}\npayload\u0000bytes\n`);
      expect(result.status).toBe(mode === 'failure' ? 7 : 0);
      expect(readFileSync(count, 'utf8')).toBe('call\n');
      if (['healthy', 'failure'].includes(mode)) {
        expect(existsSync(join(ledger, 'calls.jsonl'))).toBe(false);
        expect(result.stderr).toBe(mode === 'failure' ? 'Cannot find module unrelated-extension\n' : 'warning\n');
      } else {
        const raw = readFileSync(join(ledger, 'calls.jsonl'), 'utf8');
        const rows = raw.trim().split('\n').map(JSON.parse);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          transport: 'shim-fallback', fallbackReason: mode === 'import' ? 'missing-import' : 'missing-entry',
          caller: 'disposable-probe', id: 'app', installationId: '12345', authSource: 'app-cache', resource: 'graphql',
          cost: mode === 'unknown' ? null : 3, costSource: mode === 'unknown' ? 'unknown' : 'response',
        });
        if (mode === 'nested') {
          expect(rows[0].outer).toBe('outer-probe');
          const outer = { ...rows[0], inv: 'outer-probe' };
          delete outer.outer;
          const spend = attributeSpend([rows[0], outer]);
          expect(spend.invocations).toHaveLength(1);
          expect(spend.invocations[0].responses).toHaveLength(1);
          expect(spend.invocations[0].attributedByRes.graphql).toBe(3);
        }
        if (mode !== 'unknown') expect(rows[0].rl).toEqual([{ used: 9, rem: 91, limit: 100, reset: 123, res: 'graphql', cost: 3 }]);
        for (const privateValue of [secret, 'private-cookie', 'private-response', 'private request body', 'Authorization']) {
          expect(raw).not.toContain(privateValue);
          if (mode !== 'debug') expect(result.stderr).not.toContain(privateValue);
        }
        if (mode === 'debug') expect(result.stderr).toContain(trace);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
