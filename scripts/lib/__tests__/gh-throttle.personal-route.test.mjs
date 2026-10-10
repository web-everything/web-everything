/**
 * @file scripts/lib/__tests__/gh-throttle.personal-route.test.mjs
 * @description we:backlog/xhcgdce — the whole fleet's `gh` calls share ONE GitHub App installation's 5,000
 *   point/hour GraphQL budget, exhausted fleet-wide 3+ times in one day. This proves the short-term fix: a
 *   classified READ can be routed onto the operator's own personal GitHub identity (a separate 5,000/hr
 *   allowance) while every WRITE stays on the App, unconditionally — including the "soak break" this card's
 *   Done-when names: a read burst that already exhausted the App's own bucket no longer blocks reads once the
 *   split is enabled, because the personal identity's budget bucket is a genuinely separate one
 *   (`readBudgetBlock`/`writeBudgetBlock` already key on `ghAuthIdentity` — #gh-graphql-budget).
 *
 *   OFF BY DEFAULT (`resolvePersonalRouteEnabled`) — every scenario below sets `throttle.personalRoute: true`
 *   explicitly except the very first, which proves the opposite: with NO flag and NO env var, behavior is
 *   byte-identical to every `gh-throttle.mjs` test written before this card (see that file's own env
 *   assertions) — the regression pin for the rest of the suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyGhRead, personalGhToken, resetPersonalGhTokenCacheForTest, looksLikeGhAuthFailure,
  resolvePersonalRouteEnabled, runGhCliPassthrough, ghAuthIdentity, writeBudgetBlock, readBudgetBlock,
  ghThrottleLogPath, looksLikePersonalAccessDenial, runGhSync, execFileSyncThrottled,
} from '../gh-throttle.mjs';
import { expectSecretAbsent, snapshotEnv } from './helpers/secret-absence.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'gh-personal-route-'));
// #4309's cost-header capture defaults ON and always sets an explicit `env` key (to add `GH_DEBUG=api`) — kept
// OFF here (`WE_GH_THROTTLE_COST_HEADERS: '0'`) so a bare `spawn.mock.calls[…][2].env` assertion below tests
// THIS card's own env-override behavior, not that unrelated feature's.
const APP_ENV = { GH_TOKEN: 'ghs_appToken', HOME: '/h', WE_GH_THROTTLE_COST_HEADERS: '0' };
const PERSONAL_TOKEN = 'gho_personalToken';
const personalIdentity = ghAuthIdentity({ GH_TOKEN: PERSONAL_TOKEN });

describe('classifyGhRead — the conservative read allowlist', () => {
  it('allows pr list/view/checks, run list/view, search, and a plain/explicit-GET api call', () => {
    expect(classifyGhRead(['pr', 'list'])).toBe(true);
    expect(classifyGhRead(['pr', 'view', '1'])).toBe(true);
    expect(classifyGhRead(['pr', 'checks', '1'])).toBe(true);
    expect(classifyGhRead(['run', 'list'])).toBe(true);
    expect(classifyGhRead(['run', 'view', '1'])).toBe(true);
    expect(classifyGhRead(['search', 'issues', 'foo'])).toBe(true);
    expect(classifyGhRead(['api', 'repos/o/n'])).toBe(true);
    expect(classifyGhRead(['api', '--method', 'GET', 'repos/o/n'])).toBe(true);
    expect(classifyGhRead(['api', '-X', 'GET', 'repos/o/n'])).toBe(true);
  });

  it('defaults UNKNOWN/ambiguous to write/App — never a false positive', () => {
    expect(classifyGhRead(['pr', 'comment', '1'])).toBe(false);
    expect(classifyGhRead(['pr', 'merge', '1'])).toBe(false);
    expect(classifyGhRead(['issue', 'view', '1'])).toBe(false); // conservative: not on the literal allowlist
    expect(classifyGhRead(['label', 'list'])).toBe(false); // conservative: not on the literal allowlist
    expect(classifyGhRead(['gist', 'list'])).toBe(false); // wholly unrecognized
  });

  it('recognizes every spelling of a mutating method (review-2026-09-28 finding: -X/--method= were missed)', () => {
    expect(classifyGhRead(['api', '-X', 'DELETE', 'repos/o/n/labels/x'])).toBe(false);
    expect(classifyGhRead(['api', '-X', 'POST', 'repos/o/n/dispatches'])).toBe(false);
    expect(classifyGhRead(['api', '--method=DELETE', 'repos/o/n/labels/x'])).toBe(false);
    expect(classifyGhRead(['api', '-XDELETE', 'repos/o/n/labels/x'])).toBe(false);
  });

  // PR #2885 review: gh (pflag) accepts `=`-joined AND attached spellings of every payload/method flag, and a
  // repeated `--method` resolves to the LAST one. Any spelling the classifier misses routes a real mutation onto
  // the operator's personal token, so every one is enumerated here, table-driven.
  it.each([
    ['--input=FILE', ['api', 'repos/o/n/dispatches', '--input=body.json']],
    ['--input FILE', ['api', 'repos/o/n/dispatches', '--input', 'body.json']],
    ['-fkey=v (attached)', ['api', 'repos/o/n/issues/1/comments', '-fbody=hi']],
    ['-Fkey=v (attached)', ['api', 'repos/o/n/issues', '-Ftitle=x']],
    ['-f key=v', ['api', 'repos/o/n/issues', '-f', 'title=x']],
    ['-F key=v', ['api', 'repos/o/n/issues', '-F', 'title=x']],
    ['--field key=v', ['api', 'repos/o/n/issues', '--field', 'title=x']],
    ['--field=key=v', ['api', 'repos/o/n/issues', '--field=title=x']],
    ['--raw-field key=v', ['api', 'repos/o/n/issues', '--raw-field', 'title=x']],
    ['--raw-field=key=v', ['api', 'repos/o/n/issues', '--raw-field=title=x']],
    ['clustered bool + -f (-if)', ['api', 'repos/o/n/issues', '-if', 'title=x']],
    ['clustered bool + attached -F (-iFtitle=x)', ['api', 'repos/o/n/issues', '-iFtitle=x']],
    ['repeated --method, last is POST', ['api', '--method', 'GET', 'repos/o/n/issues', '--method', 'POST']],
    ['--method=GET then -XPOST', ['api', '--method=GET', '-XPOST', 'repos/o/n/issues']],
    ['clustered bool + -X (-iXPOST)', ['api', '-iXPOST', 'repos/o/n/issues']],
    ['clustered bool + -X value (-iX POST)', ['api', '-iX', 'POST', 'repos/o/n/issues']],
    ['lowercase method', ['api', '--method', 'delete', 'repos/o/n/labels/x']],
    // pflag reads a `--` right after a value-taking long flag as that flag's VALUE, so later flags still apply.
    ['--preview -- then -XPOST', ['api', '--preview', '--', '-XPOST', 'repos/o/n/issues']],
    ['--jq -- then -XPOST', ['api', '--jq', '--', '-XPOST', 'repos/o/n/issues']],
    ['--template -- then -f', ['api', '--template', '--', 'repos/o/n/issues', '-f', 'title=x']],
    ['--header -- then --input', ['api', '--header', '--', '--input', 'b.json', 'repos/o/n/dispatches']],
    ['global -R, --preview -- then --method=DELETE', ['-R', 'o/n', 'api', '--preview', '--', '--method=DELETE', 'r']],
  ])('every payload/method spelling resolves to write/App: %s', (_label, argv) => {
    expect(classifyGhRead(argv)).toBe(false);
  });

  it('a GET with a payload flag stays conservative (write/App) — a documented MVP gap, never a false positive', () => {
    expect(classifyGhRead(['api', '--method', 'GET', 'repos/o/n/pulls/1/files', '-F', 'per_page=100'])).toBe(false);
    expect(classifyGhRead(['api', 'graphql', '-f', 'query=query{viewer{login}}'])).toBe(false);
  });

  it('strips leading global flags so a subcommand is not missed (review-2026-09-28 finding)', () => {
    expect(classifyGhRead(['-R', 'o/n', 'pr', 'list'])).toBe(true);
    expect(classifyGhRead(['--repo', 'o/n', 'pr', 'view', '1'])).toBe(true);
    expect(classifyGhRead(['--hostname', 'ghe.example.com', 'pr', 'list'])).toBe(true);
  });
});

describe("personalGhToken — the operator's own gh CLI login, never the App/logged token", () => {
  beforeEach(() => resetPersonalGhTokenCacheForTest());
  afterEach(() => vi.unstubAllEnvs());

  it('strips GH_TOKEN/GITHUB_TOKEN before shelling the real binary, and returns only what it reads back', () => {
    // Seed sentinels so the toBeUndefined assertions below are real (the test otherwise never sets these keys).
    vi.stubEnv('GH_TOKEN', 'sentinel-gh-token');
    vi.stubEnv('GITHUB_TOKEN', 'sentinel-github-token');
    const exec = vi.fn((bin, args, opts) => {
      expect(opts.env.GH_TOKEN).toBeUndefined();
      expect(opts.env.GITHUB_TOKEN).toBeUndefined();
      expect(args).toEqual(['auth', 'token']);
      return 'gho_personalSecret123\n';
    });
    expect(personalGhToken({ bin: '/real/gh', exec })).toBe('gho_personalSecret123');
    expect(exec).toHaveBeenCalledWith('/real/gh', ['auth', 'token'], expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }));
  });

  it('caches for the process — one shell-out even across repeated calls', () => {
    const exec = vi.fn(() => 'tok\n');
    personalGhToken({ exec });
    personalGhToken({ exec });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('any failure (missing gh, not logged in, empty output) resolves to null, never throws', () => {
    expect(personalGhToken({ exec: () => { throw new Error('not logged in'); } })).toBe(null);
    resetPersonalGhTokenCacheForTest();
    expect(personalGhToken({ exec: () => '' })).toBe(null);
    resetPersonalGhTokenCacheForTest();
    expect(personalGhToken({ exec: () => '   \n' })).toBe(null);
  });
});

describe('looksLikeGhAuthFailure / resolvePersonalRouteEnabled — pure classifiers', () => {
  it('looksLikeGhAuthFailure matches HTTP 401 / Bad credentials, never a rate limit', () => {
    expect(looksLikeGhAuthFailure('HTTP 401: Bad credentials')).toBe(true);
    expect(looksLikeGhAuthFailure('gh: Bad credentials (HTTP 401)')).toBe(true);
    expect(looksLikeGhAuthFailure('API rate limit exceeded')).toBe(false);
    expect(looksLikeGhAuthFailure('')).toBe(false);
    expect(looksLikeGhAuthFailure(null)).toBe(false);
  });

  it('resolvePersonalRouteEnabled defaults OFF and only turns on for recognized truthy spellings', () => {
    expect(resolvePersonalRouteEnabled({})).toBe(false);
    expect(resolvePersonalRouteEnabled({ WE_GH_THROTTLE_PERSONAL_ROUTE: '0' })).toBe(false);
    expect(resolvePersonalRouteEnabled({ WE_GH_THROTTLE_PERSONAL_ROUTE: 'false' })).toBe(false);
    expect(resolvePersonalRouteEnabled({ WE_GH_THROTTLE_PERSONAL_ROUTE: '1', WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS: 'reads' })).toBe(true);
    expect(resolvePersonalRouteEnabled({ WE_GH_THROTTLE_PERSONAL_ROUTE: 'true', WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS: 'reads' })).toBe(true);
  });

  // Operator ruling 2026-10-09 ~21:20 ET: daemons use the App by default. BEFORE this change the env flag alone
  // sent reads to the operator's personal bucket (drain broke at 13:21Z on "rate limit exceeded for user ID 760299").
  it('github.auth=app (the default) keeps the route OFF even when a plist still sets the env flag', () => {
    const appPolicy = { auth: 'app', personalExceptions: {} };
    expect(resolvePersonalRouteEnabled({ WE_GH_THROTTLE_PERSONAL_ROUTE: '1' }, { policy: appPolicy })).toBe(false);
    expect(resolvePersonalRouteEnabled({ WE_GH_THROTTLE_PERSONAL_ROUTE: '1' }, { policy: { auth: 'app', personalExceptions: { reads: 'x' } } })).toBe(true);
    expect(resolvePersonalRouteEnabled({ WE_GH_THROTTLE_PERSONAL_ROUTE: '1' }, { policy: { auth: 'personal', personalExceptions: {} } })).toBe(true);
    // The live settings file ships `auth: app` with no `reads` exception.
    expect(resolvePersonalRouteEnabled({ WE_GH_THROTTLE_PERSONAL_ROUTE: '1' })).toBe(false);
  });
});

describe('runGhCliPassthrough — the gh read/App-write identity split (we:backlog/xhcgdce)', () => {
  it('OFF BY DEFAULT — byte-identical to before this card, even for a classified read with a token available', () => {
    const lockRoot = tmp();
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) }));
    runGhCliPassthrough(['pr', 'list'], { throttle: { lockRoot, env: APP_ENV, personalToken: PERSONAL_TOKEN }, spawn });
    expect(spawn.mock.calls[0][2].env).toBeUndefined(); // no personalRoute flag/env var → no override at all
  });

  it('THE SOAK-BREAK PROOF — a read is no longer blocked by the App bucket\'s own exhaustion once enabled', () => {
    const lockRoot = tmp();
    // The App identity's graphql bucket is already exhausted — the exact incident this card fixes.
    writeBudgetBlock(lockRoot, 'app', 'graphql', { untilMs: Date.now() + 3600_000, nowMs: Date.now() });
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) }));

    // BEFORE (the split not enabled): the same read stays blocked, fails fast, unchanged from today.
    const before = runGhCliPassthrough(['pr', 'list'], { throttle: { lockRoot, env: APP_ENV }, spawn });
    expect(before.status).toBe(1);
    expect(spawn).not.toHaveBeenCalled();

    // AFTER: personalRoute enabled + a personal token available → the read spends the PERSONAL identity's own
    // bucket (untouched by the App's block) and actually reaches gh.
    const after = runGhCliPassthrough(['pr', 'list'], {
      throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: PERSONAL_TOKEN }, spawn,
    });
    expect(after.status).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][2].env.GH_TOKEN).toBe(PERSONAL_TOKEN);
    expect(readBudgetBlock(lockRoot, personalIdentity, 'graphql')).toBe(null);
  });

  it('a write is NEVER routed to the personal token, even enabled with a token available', () => {
    const lockRoot = tmp();
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    runGhCliPassthrough(['pr', 'comment', '1', '--body', 'x'], {
      throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: PERSONAL_TOKEN }, spawn,
    });
    expect(spawn.mock.calls[0][2].env).toBeUndefined(); // unchanged App env — no override at all
  });

  it('an unrecognized/ambiguous shape defaults to write/App even though it mutates nothing the classifier knows', () => {
    const lockRoot = tmp();
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    runGhCliPassthrough(['gist', 'list'], {
      throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: PERSONAL_TOKEN }, spawn,
    });
    expect(spawn.mock.calls[0][2].env).toBeUndefined();
  });

  it('a missing personal token falls back to the App transparently, no override', () => {
    const lockRoot = tmp();
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    runGhCliPassthrough(['pr', 'list'], { throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: null }, spawn });
    expect(spawn.mock.calls[0][2].env).toBeUndefined();
  });

  it("a caller's own explicit non-App/non-default token is left completely alone (never hijacked)", () => {
    const lockRoot = tmp();
    const callerEnv = { GH_TOKEN: 'gho_someOtherCallersOwnToken', WE_GH_THROTTLE_COST_HEADERS: '0' };
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    runGhCliPassthrough(['pr', 'list'], { throttle: { lockRoot, env: callerEnv, personalRoute: true, personalToken: PERSONAL_TOKEN }, spawn });
    expect(spawn.mock.calls[0][2].env).toBeUndefined();
  });

  it('a REJECTED personal token falls back to the App identity ONCE, transparently', () => {
    const lockRoot = tmp();
    let call = 0;
    const spawn = vi.fn((bin, argv, opts) => {
      call += 1;
      if (call === 1) {
        expect(opts.env.GH_TOKEN).toBe(PERSONAL_TOKEN);
        return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('HTTP 401: Bad credentials') };
      }
      expect(opts.env).toBeUndefined(); // second attempt reverted to the plain, unmodified App env
      return { status: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) };
    });
    const r = runGhCliPassthrough(['pr', 'list'], {
      throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: PERSONAL_TOKEN, sleep: () => {} }, spawn,
    });
    expect(r.status).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('a rejected personal token does not retry against an App bucket already known exhausted', () => {
    const lockRoot = tmp();
    writeBudgetBlock(lockRoot, 'app', 'graphql', { untilMs: Date.now() + 3600_000, nowMs: Date.now() });
    const spawn = vi.fn(() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('HTTP 401: Bad credentials') }));
    const r = runGhCliPassthrough(['pr', 'list'], {
      throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: PERSONAL_TOKEN, sleep: () => {} }, spawn,
    });
    expect(spawn).toHaveBeenCalledTimes(1); // the rejected personal-token attempt only — no doomed App retry
    expect(r.stderr.toString()).toMatch(/shared backoff until/);
  });

  // PR #2885 review — a routed identity's failure-mode matrix: missing and rejected are covered above; these are
  // the two budget modes. Each falls back to the App bucket (checking the App's own block first), never fails
  // fast while the App may still have budget.
  it("the PERSONAL bucket already blocked → the read falls back to the App bucket, not fail-fast", () => {
    const lockRoot = tmp();
    writeBudgetBlock(lockRoot, personalIdentity, 'graphql', { untilMs: Date.now() + 3600_000, nowMs: Date.now() });
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) }));
    const r = runGhCliPassthrough(['pr', 'list'], {
      throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: PERSONAL_TOKEN }, spawn,
    });
    expect(r.status).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][2].env).toBeUndefined(); // plain, unmodified App env
  });

  it('BOTH buckets blocked → fails fast with the App block, no gh call at all', () => {
    const lockRoot = tmp();
    writeBudgetBlock(lockRoot, personalIdentity, 'graphql', { untilMs: Date.now() + 3600_000, nowMs: Date.now() });
    writeBudgetBlock(lockRoot, 'app', 'graphql', { untilMs: Date.now() + 3600_000, nowMs: Date.now() });
    const spawn = vi.fn();
    const r = runGhCliPassthrough(['pr', 'list'], {
      throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: PERSONAL_TOKEN }, spawn,
    });
    expect(r.status).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(r.stderr.toString()).toMatch(/shared backoff until/);
  });

  it('the PERSONAL bucket exhausted MID-CALL → records the personal block (probe under the personal token), then retries once on the App', () => {
    const lockRoot = tmp();
    const seen = [];
    const spawn = vi.fn((bin, argv, opts) => {
      seen.push({ argv, token: opts.env ? opts.env.GH_TOKEN : undefined });
      if (seen.length === 1) return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('GraphQL: API rate limit exceeded for user ID 1.') };
      if (argv[0] === 'api') return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; // the budget probe
      return { status: 0, stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) };
    });
    const r = runGhCliPassthrough(['pr', 'list'], {
      throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: PERSONAL_TOKEN, sleep: () => {} }, spawn,
    });
    expect(r.status).toBe(0);
    expect(seen[0].token).toBe(PERSONAL_TOKEN);
    const probe = seen.find((c) => c.argv[0] === 'api');
    expect(probe && probe.token).toBe(PERSONAL_TOKEN); // the probe measured the PERSONAL identity's budget
    expect(seen[seen.length - 1].token).toBeUndefined(); // the final retry ran on the plain App env
    expect(readBudgetBlock(lockRoot, personalIdentity, 'graphql')).not.toBe(null);
    expect(readBudgetBlock(lockRoot, 'app', 'graphql')).toBe(null);
  });

  it('cost-header capture keeps inheriting process.env when throttle.env is partial (unrouted call)', () => {
    const lockRoot = tmp();
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) }));
    runGhCliPassthrough(['pr', 'comment', '1', '--body', 'x'], { throttle: { lockRoot, env: { GH_TOKEN: 'ghs_x' } }, spawn });
    const childEnv = spawn.mock.calls[0][2].env;
    expect(childEnv.GH_DEBUG).toBe('api');
    expect(childEnv.PATH).toBe(process.env.PATH);
  });

  it('a routed read with a partial throttle.env still inherits process.env (PATH) in both capture modes', () => {
    for (const costHeaders of ['0', '1']) {
      const lockRoot = tmp();
      const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) }));
      runGhCliPassthrough(['pr', 'list'], {
        throttle: { lockRoot, env: { GH_TOKEN: 'ghs_x', WE_GH_THROTTLE_COST_HEADERS: costHeaders }, personalRoute: true, personalToken: PERSONAL_TOKEN }, spawn,
      });
      const childEnv = spawn.mock.calls[0][2].env;
      expect(childEnv.GH_TOKEN).toBe(PERSONAL_TOKEN);
      expect(childEnv.GITHUB_TOKEN).toBeUndefined();
      expect(childEnv.PATH).toBe(process.env.PATH);
    }
  });

  it('records the resolved identity on the sidecar log line (the health smell)', () => {
    const lockRoot = tmp();
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) }));
    runGhCliPassthrough(['pr', 'list'], { throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: PERSONAL_TOKEN }, spawn });
    const lines = readFileSync(ghThrottleLogPath(lockRoot), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].id).toBe(personalIdentity);
  });

  // PR #2885 review — a routed read the personal identity cannot serve (404, or a 403 that is not a rate limit)
  // takes the same once-only App fallback as a rejected token: the personal identity is only a bonus bucket.
  it.each([
    ['404', 'GraphQL: Could not resolve to a Repository (HTTP 404)'],
    ['non-rate-limit 403', 'HTTP 403: Resource protected by organization SAML enforcement'],
  ])('personal %s falls back once to the App', (_label, stderr) => {
    const lockRoot = tmp();
    const spawn = vi.fn((bin, argv, opts) => (opts.env
      ? { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) }
      : { status: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) }));
    const r = runGhCliPassthrough(['pr', 'list'], {
      throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: PERSONAL_TOKEN, sleep: () => {} }, spawn,
    });
    expect(r.status).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][2].env.GH_TOKEN).toBe(PERSONAL_TOKEN);
    expect(spawn.mock.calls[1][2].env).toBeUndefined();
  });

  it('a 404 fallback does not retry against an App bucket already known exhausted', () => {
    const lockRoot = tmp();
    writeBudgetBlock(lockRoot, 'app', 'graphql', { untilMs: Date.now() + 3600_000, nowMs: Date.now() });
    const spawn = vi.fn(() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('HTTP 404: Not Found') }));
    const r = runGhCliPassthrough(['pr', 'list'], {
      throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: PERSONAL_TOKEN, sleep: () => {} }, spawn,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(r.stderr.toString()).toMatch(/shared backoff until/);
  });

  it('looksLikePersonalAccessDenial: 404 and plain 403 yes; rate-limit 403, 500, empty no', () => {
    expect(looksLikePersonalAccessDenial('HTTP 404: Not Found')).toBe(true);
    expect(looksLikePersonalAccessDenial('HTTP 403: Forbidden')).toBe(true);
    expect(looksLikePersonalAccessDenial('HTTP 403: API rate limit exceeded for user ID 1.')).toBe(false);
    expect(looksLikePersonalAccessDenial('HTTP 500: Server Error')).toBe(false);
    expect(looksLikePersonalAccessDenial('')).toBe(false);
  });

  // Maps the routing block's "the token is never logged" claim to a test.
  it('the personal token is absent from the sidecar log, relayed stderr and process.env after a routed read', () => {
    const lockRoot = tmp();
    const envBefore = snapshotEnv();
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) }));
    const r = runGhCliPassthrough(['pr', 'list'], { throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: PERSONAL_TOKEN }, spawn });
    expect(spawn.mock.calls[0][2].env.GH_TOKEN).toBe(PERSONAL_TOKEN); // the routed path really ran
    expectSecretAbsent(PERSONAL_TOKEN, { logPath: ghThrottleLogPath(lockRoot), sinks: [r.stdout, r.stderr], envBefore });
  });

  // Pin: routing is NOT restricted to a target repo today — tolerated (opt-in is the only guard); a future
  // restriction must flip this test deliberately.
  it('personal route is unrestricted by target repo today (tolerated, see follow-up)', () => {
    const lockRoot = tmp();
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) }));
    runGhCliPassthrough(['-R', 'other/repo', 'pr', 'list'], { throttle: { lockRoot, env: APP_ENV, personalRoute: true, personalToken: PERSONAL_TOKEN }, spawn });
    expect(spawn.mock.calls[0][2].env.GH_TOKEN).toBe(PERSONAL_TOKEN);
  });
});


describe.each([
  ['runGhSync', (args, opts) => runGhSync(args, opts)],
  ['execFileSyncThrottled', (args, opts) => execFileSyncThrottled('gh', args, opts)],
])('%s — imported read routing', (_name, run) => {
  function fixture(overrides = {}, childEnv = APP_ENV) {
    const lockRoot = tmp();
    const exec = vi.fn(() => 'ok');
    const env = { ...APP_ENV, WE_GH_THROTTLE_PERSONAL_ROUTE: '1', WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS: 'reads' };
    const opts = { env: childEnv, encoding: 'utf8', throttle: { lockRoot, env, exec, personalToken: PERSONAL_TOKEN, ...overrides } };
    const logs = () => readFileSync(ghThrottleLogPath(lockRoot), 'utf8').trim().split('\n').map(JSON.parse);
    return { lockRoot, exec, opts, logs };
  }

  it.each([
    ['pr', 'list'], ['pr', 'view', '1'], ['pr', 'checks', '1'],
  ])('routes %s %s to the personal bucket even when the App is blocked', (...args) => {
    const { lockRoot, exec, opts, logs } = fixture();
    const envBefore = snapshotEnv();
    writeBudgetBlock(lockRoot, 'app', 'graphql', { untilMs: Date.now() + 3600_000 });
    expect(run(args, opts)).toBe('ok');
    const child = exec.mock.calls[0][1];
    expect(child.env.GH_TOKEN === PERSONAL_TOKEN).toBe(true);
    expect(child.env.GITHUB_TOKEN).toBeUndefined();
    expect(logs()).toContainEqual(expect.objectContaining({ outcome: 'call', id: personalIdentity, auth: { kind: 'personal-token' } }));
    expect(opts.env === APP_ENV).toBe(true);
    expectSecretAbsent(PERSONAL_TOKEN, { logPath: ghThrottleLogPath(lockRoot), envBefore });
  });

  it.each([
    ['pr', 'edit', '1', '--title', 'test'], ['pr', 'comment', '1', '--body', 'test'],
    ['pr', 'merge', '1'], ['api', '-X', 'POST', 'repos/o/r/issues'],
  ])('keeps %s %s on the bot and records its identity', (...args) => {
    const { exec, opts, logs, lockRoot } = fixture();
    run(args, opts);
    expect(exec.mock.calls[0][1].env === APP_ENV).toBe(true);
    expect(logs()).toContainEqual(expect.objectContaining({ outcome: 'call', id: 'app', auth: { kind: 'installation', installationId: null, source: 'unknown' } }));
    expectSecretAbsent(APP_ENV.GH_TOKEN, { logPath: ghThrottleLogPath(lockRoot) });
  });

  it.each(['0', undefined])('switch %s preserves the original execution options', (value) => {
    const env = { ...APP_ENV, WE_GH_THROTTLE_PERSONAL_ROUTE: value, WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS: 'reads' };
    const { exec, opts } = fixture({ env });
    run(['pr', 'list'], opts);
    expect(exec.mock.calls[0][1]).toEqual({ env: APP_ENV, encoding: 'utf8' });
  });

  it('missing personal token preserves the original execution options', () => {
    const { exec, opts } = fixture({ personalToken: null });
    run(['pr', 'list'], opts);
    expect(exec.mock.calls[0][1]).toEqual({ env: APP_ENV, encoding: 'utf8' });
  });

  it('does not replace an explicit caller credential even when throttle.env is App-authenticated', () => {
    const childEnv = { GH_TOKEN: 'gho_explicitCaller' };
    const { exec, opts, logs } = fixture({}, childEnv);
    run(['pr', 'list'], opts);
    expect(exec.mock.calls[0][1].env === childEnv).toBe(true);
    expect(logs()[0].id).toBe(ghAuthIdentity(childEnv));
  });

  it('routes an inherited default login and records it separately from default', () => {
    const { exec, opts, logs } = fixture({}, {});
    delete opts.env;
    opts.throttle.env = { WE_GH_THROTTLE_PERSONAL_ROUTE: '1', WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS: 'reads' };
    run(['pr', 'list'], opts);
    expect(exec.mock.calls[0][1].env.GH_TOKEN === PERSONAL_TOKEN).toBe(true);
    expect(logs()[0].id).toBe(personalIdentity);
  });

  describe('inherited process.env credential (no execOpts.env)', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    it('preserves inherited explicit credentials with configuration-only throttle.env', () => {
      vi.stubEnv('GH_TOKEN', 'gho_explicitInherited');
      const { exec, opts, logs } = fixture({}, {});
      delete opts.env;
      opts.throttle.env = { WE_GH_THROTTLE_PERSONAL_ROUTE: '1', WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS: 'reads' };
      run(['pr', 'list'], opts);
      expect(exec.mock.calls[0][1]).toEqual({ encoding: 'utf8' });
      expect(logs()[0].id).toBe(ghAuthIdentity({ GH_TOKEN: 'gho_explicitInherited' }));
    });

    it('still routes an inherited App credential with configuration-only throttle.env', () => {
      vi.stubEnv('GH_TOKEN', 'ghs_inheritedApp');
      const { exec, opts, logs } = fixture({}, {});
      delete opts.env;
      opts.throttle.env = { WE_GH_THROTTLE_PERSONAL_ROUTE: '1', WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS: 'reads' };
      run(['pr', 'list'], opts);
      expect(exec.mock.calls[0][1].env.GH_TOKEN === PERSONAL_TOKEN).toBe(true);
      expect(logs()[0].id).toBe(personalIdentity);
    });
  });

  it('keeps a narrowed caller env narrowed: only GH_TOKEN is swapped, process.env does not leak in', () => {
    vi.stubEnv('WE_SENTINEL_SECRET', 'sentinel-value');
    try {
      const childEnv = { PATH: '/usr/bin', GH_TOKEN: 'ghs_appToken', GITHUB_TOKEN: 'ghs_appToken' };
      const { exec, opts } = fixture({}, childEnv);
      run(['pr', 'list'], opts);
      expect(exec.mock.calls[0][1].env).toEqual({ PATH: '/usr/bin', GH_TOKEN: PERSONAL_TOKEN });
      expect(opts.env).toEqual({ PATH: '/usr/bin', GH_TOKEN: 'ghs_appToken', GITHUB_TOKEN: 'ghs_appToken' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses the same route in the captured spawn path', () => {
    const { opts, logs } = fixture();
    delete opts.throttle.exec;
    opts.throttle.env.WE_GH_THROTTLE_COST_HEADERS = '1';
    const spawn = vi.fn(() => ({ status: 0, stdout: 'ok', stderr: '' }));
    opts.throttle.spawn = spawn;
    expect(run(['pr', 'list'], opts)).toBe('ok');
    expect(spawn.mock.calls[0][2].env.GH_TOKEN === PERSONAL_TOKEN).toBe(true);
    expect(logs()[0].id).toBe(personalIdentity);
  });

  it('passes the selected credential to a real child and resolves the stored login without logging it', () => {
    const { lockRoot, opts, logs } = fixture();
    const bin = join(lockRoot, 'gh');
    // Offline executable fixture: auth token is captured privately; normal calls emit only a bucket label.
    writeFileSync(bin, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'auth') {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) process.exitCode = 2;
  else process.stdout.write(${JSON.stringify(PERSONAL_TOKEN)});
} else {
  process.stdout.write(process.env.GH_TOKEN === ${JSON.stringify(PERSONAL_TOKEN)} ? 'personal' : 'bot');
}
`);
    chmodSync(bin, 0o755);
    resetPersonalGhTokenCacheForTest();
    delete opts.throttle.exec;
    delete opts.throttle.personalToken;
    opts.throttle.bin = bin;
    try {
      expect(run(['pr', 'list'], opts)).toBe('personal');
      expect(run(['pr', 'edit', '1', '--title', 'test'], opts)).toBe('bot');
      expect(logs().filter(row => row.outcome === 'call').map(row => row.id)).toEqual([personalIdentity, 'app']);
      expectSecretAbsent(PERSONAL_TOKEN, { logPath: ghThrottleLogPath(lockRoot) });
    } finally {
      resetPersonalGhTokenCacheForTest();
    }
  });

  it('falls back to the bot when the personal bucket is already blocked', () => {
    const { lockRoot, exec, opts, logs } = fixture();
    writeBudgetBlock(lockRoot, personalIdentity, 'graphql', { untilMs: Date.now() + 3600_000 });
    run(['pr', 'list'], opts);
    expect(exec.mock.calls[0][1].env === APP_ENV).toBe(true);
    expect(logs().map(row => row.id)).toEqual([personalIdentity, 'app']);
  });

  it.each(['HTTP 401: Bad credentials', 'HTTP 404: Not Found', 'HTTP 403: SSO required'])('falls back once after %s', (stderr) => {
    const { exec, opts, logs } = fixture();
    exec.mockImplementationOnce(() => { throw Object.assign(new Error('gh failed'), { stderr }); });
    expect(run(['pr', 'list'], opts)).toBe('ok');
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1][1].env === APP_ENV).toBe(true);
    expect(logs().filter(row => row.outcome === 'call').map(row => row.id)).toEqual([personalIdentity, 'app']);
  });

  it('does not retry a rejected personal token against a blocked bot', () => {
    const { lockRoot, exec, opts, logs } = fixture();
    writeBudgetBlock(lockRoot, 'app', 'graphql', { untilMs: Date.now() + 3600_000 });
    exec.mockImplementation(() => { throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 401: Bad credentials' }); });
    expect(() => run(['pr', 'list'], opts)).toThrow(/shared backoff/);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(logs().at(-1)).toMatchObject({ outcome: 'budget_blocked', id: 'app' });
  });

  it('probes an exhausted personal bucket with that credential, then falls back to the bot', () => {
    const { lockRoot, exec, opts, logs } = fixture();
    exec.mockImplementationOnce(() => { throw Object.assign(new Error('gh failed'), { stderr: 'GraphQL: API rate limit already exceeded' }); });
    exec.mockImplementationOnce(() => JSON.stringify({ resources: { graphql: { remaining: 0, reset: Math.floor(Date.now() / 1000) + 3600 } } }));
    expect(run(['pr', 'list'], opts)).toBe('ok');
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls[1][1].env.GH_TOKEN === PERSONAL_TOKEN).toBe(true);
    expect(exec.mock.calls[2][1].env === APP_ENV).toBe(true);
    expect(readBudgetBlock(lockRoot, personalIdentity, 'graphql')).not.toBeNull();
    expect(logs().filter(row => row.outcome === 'call').map(row => row.id)).toEqual([personalIdentity, 'app']);
  });
});
