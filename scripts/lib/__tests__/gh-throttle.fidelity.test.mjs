/**
 * @file scripts/lib/__tests__/gh-throttle.fidelity.test.mjs
 * @description REAL, side-by-side pass-through fidelity proof for #3621's `gh`-throttle wrapper — against the
 *   ACTUAL `gh` binary, not a mock. Two things get proven for real, both directions the wrapper is offered in:
 *
 *   1. The IMPORTABLE `runGhSync` seam: its return value on success is byte-identical to a raw
 *      `execFileSync('gh', args, opts)` call, for several safe, read-only commands.
 *   2. The STANDALONE CLI passthrough (`node scripts/lib/gh-throttle.mjs <args>`): its stdout, stderr, and
 *      exit code are byte-identical to running the real `gh <args>` directly.
 *
 * SKIPS CLEANLY (never fails red) when `gh` is not on PATH or not authenticated — this proves fidelity when the
 * real tool is available; it is not a substitute for the mocked semaphore/backoff unit proof in
 * `gh-throttle.test.mjs`, which needs neither.
 *
 * #4309 — the passthrough now turns `GH_DEBUG=api` on to read GitHub's free `X-Ratelimit-*` headers, and strips
 * its own trace before relaying stderr. That strip is proven here against GOLDEN FIXTURES captured from the
 * pinned real binary (`/opt/homebrew/bin/gh`, gh 2.95.0, 2026-09-28 — never the shim on PATH), in
 * `fixtures/gh-debug/`: a success, a 404 (with its plain, no-debug stderr as the oracle), a paginated `pr list`,
 * a REST call, and a repo-resolving call that also prints `[git …]` lines. The rate-limit, multi-request,
 * signal-kill and buffer-overflow shapes are DERIVED from those real traces (a live rate-limit or `pr create`
 * would spend or mutate the real account) — each derivation is spelled out at its test. Only credential-bearing
 * lines were redacted from the captures (`Authorization`, `X-Github-Request-Id`).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runGhSync, runGhCliPassthrough, stripGhDebug, rateLimitRecords, ghThrottleLogPath } from '../gh-throttle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, '..', 'gh-throttle.mjs');

function ghAvailable() {
  // This probe's whole intent is "is gh logged in?" — under the hermetic harness (xcu4cqf) the fake gh answers it
  // with the declared `unauthenticated` fixture (the real-binary half then skips), recording no live access.
  const prior = process.env.WE_HERMETIC_GH;
  process.env.WE_HERMETIC_GH = 'unauthenticated';
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    if (prior === undefined) delete process.env.WE_HERMETIC_GH; else process.env.WE_HERMETIC_GH = prior;
  }
}

const available = ghAvailable();
const d = available ? describe : describe.skip;

d('real side-by-side pass-through fidelity against the actual gh binary', () => {
  let repoSlug;
  let realPrNum;

  beforeAll(() => {
    repoSlug = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { encoding: 'utf8' }).trim();
    // A real, already-merged PR on this repo — safe, read-only, and stable (won't change again).
    const merged = JSON.parse(execFileSync('gh', ['pr', 'list', '--repo', repoSlug, '--state', 'merged', '--limit', '1', '--json', 'number'], { encoding: 'utf8' }));
    realPrNum = merged[0].number;
  });

  it('runGhSync: `gh api rate_limit` — identical stdout to a raw execFileSync call', () => {
    const raw = execFileSync('gh', ['api', 'rate_limit'], { encoding: 'utf8' });
    const throttled = runGhSync(['api', 'rate_limit'], { encoding: 'utf8' });
    // The two calls happen microseconds apart; `resources.core.used` can legitimately tick between them, so
    // compare STRUCTURE (parses, same top-level shape) rather than asserting byte-identical JSON text — the
    // CLI-passthrough test below is the one that proves true byte-for-byte identity, on a command with no
    // between-call-mutable field.
    const rawParsed = JSON.parse(raw);
    const throttledParsed = JSON.parse(throttled);
    expect(Object.keys(throttledParsed).sort()).toEqual(Object.keys(rawParsed).sort());
    expect(throttledParsed.resources.core.limit).toBe(rawParsed.resources.core.limit);
  });

  it('runGhSync: `gh pr view <n> --json number,state,title` — byte-identical stdout (immutable, merged PR)', () => {
    const args = ['pr', 'view', String(realPrNum), '--repo', repoSlug, '--json', 'number,state,title'];
    const raw = execFileSync('gh', args, { encoding: 'utf8' });
    const throttled = runGhSync(args, { encoding: 'utf8' });
    expect(throttled).toBe(raw); // an already-merged PR's number/state/title cannot change between the two calls
  });

  it('runGhSync: a real failure (unknown PR number) throws the SAME shape as a raw execFileSync throw', () => {
    const args = ['pr', 'view', '999999999', '--repo', repoSlug, '--json', 'number'];
    let rawErr = null, throttledErr = null;
    try { execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { rawErr = e; }
    try { runGhSync(args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { throttledErr = e; }
    expect(rawErr).not.toBeNull();
    expect(throttledErr).not.toBeNull();
    expect(throttledErr.status).toBe(rawErr.status);
    expect(String(throttledErr.stderr)).toBe(String(rawErr.stderr));
  });

  it('CLI passthrough: `node gh-throttle.mjs api rate_limit` — same shape as raw gh, exit 0', () => {
    const raw = execFileSync('gh', ['api', 'rate_limit'], { encoding: 'utf8' });
    const viaWrapper = execFileSync('node', [WRAPPER, 'api', 'rate_limit'], { encoding: 'utf8' });
    expect(JSON.parse(viaWrapper).resources.core.limit).toBe(JSON.parse(raw).resources.core.limit);
  });

  it('CLI passthrough: byte-identical stdout on an immutable read (merged PR), matching exit code', () => {
    const args = ['pr', 'view', String(realPrNum), '--repo', repoSlug, '--json', 'number,state,title'];
    const raw = execFileSync('gh', args, { encoding: 'utf8' });
    const viaWrapper = execFileSync('node', [WRAPPER, ...args], { encoding: 'utf8' });
    expect(viaWrapper).toBe(raw);
  });

  it('CLI passthrough: relays a real failure’s stderr text and NON-ZERO exit code identically', () => {
    const args = ['pr', 'view', '999999999', '--repo', repoSlug, '--json', 'number'];
    let rawErr = null, wrapperErr = null;
    try { execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { rawErr = e; }
    try { execFileSync('node', [WRAPPER, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { wrapperErr = e; }
    expect(rawErr).not.toBeNull();
    expect(wrapperErr).not.toBeNull();
    expect(wrapperErr.status).toBe(rawErr.status);
    expect(String(wrapperErr.stderr).trim()).toBe(String(rawErr.stderr).trim());
  });
});

// ── #4309 — stripGhDebug over golden fixtures from the real binary ───────────────────────────────────────────
const FIX = join(HERE, 'fixtures', 'gh-debug');
const fx = (name) => readFileSync(join(FIX, name), 'utf8');

describe('stripGhDebug — golden fixtures from the pinned real gh binary (#4309)', () => {
  it('a 404: the stripped stderr is byte-identical to the SAME call run without GH_DEBUG (the oracle)', () => {
    const { stderr, responses } = stripGhDebug(fx('pr-view-404.debug.stderr'));
    expect(stderr).toBe(fx('pr-view-404.plain.stderr'));
    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe(200); // GraphQL NOT_FOUND is an HTTP 200 with an `errors` body
    expect(rateLimitRecords(responses)).toEqual([{ used: 37, rem: 4963, limit: 5000, reset: 1790615715, res: 'graphql', shape: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
  });

  it('a success: nothing of the trace survives, one GraphQL response captured', () => {
    const { stderr, responses } = stripGhDebug(fx('pr-view-success.debug.stderr'));
    expect(stderr).toBe('');
    expect(rateLimitRecords(responses)).toEqual([{ used: 36, rem: 4964, limit: 5000, reset: 1790615715, res: 'graphql', shape: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
  });

  it('a paginated `pr list`: two request blocks, both stripped, one rl record per HTTP response', () => {
    const { stderr, responses } = stripGhDebug(fx('pr-list-paginated.debug.stderr'));
    expect(stderr).toBe('');
    expect(responses).toHaveLength(2);
    expect(rateLimitRecords(responses).every((r) => r.res === 'graphql')).toBe(true);
  });

  it('a REST call records `res: core`; a repo-resolving call\'s `[git …]` debug lines are stripped too', () => {
    expect(rateLimitRecords(stripGhDebug(fx('api-rate-limit-rest.debug.stderr')).responses)[0].res).toBe('core');
    const local = fx('pr-view-git-resolve.debug.stderr');
    expect(local).toMatch(/^\[git remote -v\]$/m);
    expect(stripGhDebug(local).stderr).toBe('');
  });

  it('a multi-request command (DERIVED: blocks back to back, as `pr create` prints them) with a real warning between', () => {
    const text = fx('pr-view-success.debug.stderr') + 'Warning: 1 uncommitted change\n' + fx('api-rate-limit-rest.debug.stderr') + fx('pr-view-404.debug.stderr');
    const { stderr, responses } = stripGhDebug(text);
    expect(stderr).toBe('Warning: 1 uncommitted change\n' + fx('pr-view-404.plain.stderr'));
    expect(rateLimitRecords(responses).map((r) => r.res)).toEqual(['graphql', 'core', 'graphql']);
  });

  it('a rate-limit error (DERIVED from the real 404 trace: remaining 0, GitHub\'s exhaustion message) keeps the error, reads the headers', () => {
    const text = fx('pr-view-404.debug.stderr')
      .replace('X-Ratelimit-Remaining: 4963', 'X-Ratelimit-Remaining: 0')
      .replace(/^GraphQL: .*$/m, 'GraphQL: API rate limit already exceeded for installation ID 1234. (rateLimit)');
    const { stderr, responses } = stripGhDebug(text);
    expect(stderr).toBe('GraphQL: API rate limit already exceeded for installation ID 1234. (rateLimit)\n');
    expect(rateLimitRecords(responses)[0].rem).toBe(0);
  });

  it('an UNCLOSED block (DERIVED: gh killed / its output cut mid-body) fails closed: the whole tail is dropped (#4428)', () => {
    const full = fx('pr-view-success.debug.stderr');
    const cut = full.slice(0, full.indexOf('"repository"')); // headers complete, body cut mid-way
    const { stderr, responses } = stripGhDebug(cut);
    expect(stderr).toBe('');
    expect(responses).toHaveLength(1);
    // cut before any response: the request side (incl. body) is dropped too, so is anything after it
    const reqOnly = full.slice(0, full.indexOf('GraphQL query:')) + 'error connecting to api.github.com\n';
    expect(stripGhDebug(reqOnly).stderr).toBe('');
  });

  it('text with no trace at all (a spawn error, a caller\'s plain stderr) passes through unchanged', () => {
    expect(stripGhDebug('')).toEqual({ stderr: '', responses: [] });
    expect(stripGhDebug('gh: pull request #9 already exists\n').stderr).toBe('gh: pull request #9 already exists\n');
  });
});

// ── #4309 — the passthrough's capture, with an INJECTED spawn replaying the real traces ─────────────────────────
describe('runGhCliPassthrough — cost-header capture (#4309)', () => {
  const readLog = (lockRoot) => readFileSync(ghThrottleLogPath(lockRoot), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  afterEach(() => { vi.unstubAllEnvs(); });

  it('turns GH_DEBUG=api on, relays the SAME stderr a no-debug call would, and logs rl/id/inv/resource', () => {
    const spawn = vi.fn(() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(fx('pr-view-404.debug.stderr')), error: null }));
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-cost-'));
    const r = runGhCliPassthrough(['pr', 'view', '999999999'], { throttle: { lockRoot, cap: 2, sleep: () => {}, env: { GH_TOKEN: 'ghs_x' } }, spawn });
    expect(spawn.mock.calls[0][2].env.GH_DEBUG).toBe('api');
    expect(r.status).toBe(1);
    expect(r.stderr.toString('utf8')).toBe(fx('pr-view-404.plain.stderr'));
    const [line] = readLog(lockRoot);
    expect(line).toMatchObject({ outcome: 'call', resource: 'graphql', id: 'app', rl: [{ used: 37, rem: 4963, limit: 5000, reset: 1790615715, res: 'graphql' }] });
    expect(line.inv).toMatch(/^[0-9a-f-]{12}$/);
    expect(line.outer).toBeUndefined();
  });

  it('a caller-set GH_DEBUG is never overridden and its trace is relayed UNTOUCHED (no strip, no rl)', () => {
    vi.stubEnv('GH_DEBUG', 'api');
    const raw = Buffer.from(fx('pr-view-404.debug.stderr'));
    const spawn = vi.fn(() => ({ status: 1, stdout: Buffer.alloc(0), stderr: raw, error: null }));
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-cost-'));
    const r = runGhCliPassthrough(['pr', 'view', '999999999'], { throttle: { lockRoot, cap: 2, sleep: () => {} }, spawn });
    expect(spawn.mock.calls[0][2].env).toBeUndefined();
    expect(r.stderr).toBe(raw);
    expect(readLog(lockRoot)[0].rl).toBeUndefined();
  });

  it('kill switch WE_GH_THROTTLE_COST_HEADERS=0: no GH_DEBUG, no strip, no rl', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok'), stderr: Buffer.from('warn\n'), error: null }));
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-cost-'));
    runGhCliPassthrough(['pr', 'view', '1'], { throttle: { lockRoot, cap: 2, sleep: () => {}, env: { WE_GH_THROTTLE_COST_HEADERS: '0' } }, spawn });
    expect(spawn.mock.calls[0][2].env).toBeUndefined();
    expect(readLog(lockRoot)[0].rl).toBeUndefined();
  });

  it('classifies on the STRIPPED text: a response BODY that mentions "API rate limit exceeded" never triggers a retry', () => {
    // `replace` hits the FIRST occurrence only — the JSON response BODY's `message`, not gh's final error line.
    const trace = fx('pr-view-404.debug.stderr').replace('Could not resolve to a PullRequest', 'API rate limit exceeded');
    expect(trace).toMatch(/"message": "API rate limit exceeded/);
    const spawn = vi.fn(() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(trace), error: null }));
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-cost-'));
    const r = runGhCliPassthrough(['pr', 'view', '999999999'], { throttle: { lockRoot, cap: 2, sleep: () => {}, maxAttempts: 3 }, spawn });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(r.stderr.toString()).toBe(fx('pr-view-404.plain.stderr'));
  });

  it('a nested call (runGhSync → shim → this CLI) records `outer: <inv>` from WE_GH_THROTTLE_OUTER_INV', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('{}'), stderr: Buffer.from(fx('pr-view-success.debug.stderr')), error: null }));
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-cost-'));
    const r = runGhCliPassthrough(['pr', 'view', '2828'], { throttle: { lockRoot, cap: 2, sleep: () => {}, env: { WE_GH_THROTTLE_OUTER_INV: 'outer-abc' } }, spawn });
    expect(r.stderr.length).toBe(0);
    expect(readLog(lockRoot)[0].outer).toBe('outer-abc');
  });

  it('runGhSync logs id/inv/resource too, and an injected exec still sees its opts UNCHANGED', () => {
    const exec = vi.fn(() => 'ok');
    const lockRoot = mkdtempSync(join(tmpdir(), 'gh-cost-'));
    runGhSync(['pr', 'list'], { encoding: 'utf8', throttle: { lockRoot, cap: 2, sleep: () => {}, exec } });
    expect(exec).toHaveBeenCalledWith(['pr', 'list'], { encoding: 'utf8' });
    expect(readLog(lockRoot)[0]).toMatchObject({ resource: 'graphql', id: expect.any(String), inv: expect.any(String) });
    expect(readLog(lockRoot)[0].rl).toBeUndefined(); // an injected exec is never captured (#4375 captures the REAL exec)
  });
});

// ── PR #2851 review — the debug trace must never overflow a capture sized for the plain payload ───────────────
describe('runGhCliPassthrough — debug capture preserves successful large-payload commands (PR #2851 review)', () => {
  // A REAL subprocess standing in for gh: prints `size` bytes of stdout, and — only when GH_DEBUG=api — a trace
  // that echoes the response body pretty-printed (3× the payload), exactly the shape gh's `api` debug prints.
  const fakeGh = (dir) => {
    const bin = join(dir, 'fake-gh');
    writeFileSync(bin, [
      '#!/usr/bin/env node',
      'const size = Number(process.env.FAKE_SIZE);',
      'const body = "x".repeat(size);',
      'if (process.env.GH_DEBUG === "api") {',
      '  process.stderr.write("* Request at 2026-09-28\\n* Request to https://api.github.com/graphql\\n< HTTP/2.0 200 OK\\n");',
      '  process.stderr.write("< X-Ratelimit-Used: 7\\n< X-Ratelimit-Resource: graphql\\n< X-Ratelimit-Reset: 1790615715\\n\\n");',
      '  process.stderr.write(body.replace(/x{80}/g, (m) => "  " + m + "\\n").repeat(3) + "\\n* Request took 1ms\\n");',
      '}',
      'process.stdout.write(body);',
    ].join('\n'), 'utf8');
    chmodSync(bin, 0o755);
    return bin;
  };
  const run = (size) => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-cap-buf-'));
    const bin = fakeGh(dir);
    process.env.FAKE_SIZE = String(size);
    try {
      return runGhCliPassthrough(['api', 'graphql'], { bin, throttle: { lockRoot: join(dir, 'locks'), cap: 2, sleep: () => {}, maxBuffer: 64 * 1024 } });
    } finally { delete process.env.FAKE_SIZE; }
  };

  it('a payload that fits the allowance succeeds even though its debug trace alone would not', () => {
    const r = run(40 * 1024);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(40 * 1024);
    expect(r.stderr.toString('utf8')).toBe('');
  });

  it('a payload that does NOT fit the allowance still fails the same way it did before capture existed', () => {
    expect(() => run(80 * 1024)).toThrow(/ENOBUFS|maxBuffer/);
  });

  it('an over-cap payload under capture is still LOGGED (it ran and spent points) before the overflow is raised', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-cap-log-'));
    const bin = fakeGh(dir);
    process.env.FAKE_SIZE = String(80 * 1024);
    try {
      expect(() => runGhCliPassthrough(['api', 'graphql'], { bin, throttle: { lockRoot: join(dir, 'locks'), cap: 2, sleep: () => {}, maxBuffer: 64 * 1024 } })).toThrow(/ENOBUFS/);
    } finally { delete process.env.FAKE_SIZE; }
    const [line] = readFileSync(ghThrottleLogPath(join(dir, 'locks')), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(line).toMatchObject({ outcome: 'call', ok: false, rl: [{ used: 7, res: 'graphql' }] });
  });
});

// ── #4375 — runGhSync captures cost headers on EVERY real call, success or failure ───────────────────────────
describe('runGhSync — cost-header capture on the real exec (#4375)', () => {
  const readLog = (lockRoot) => readFileSync(ghThrottleLogPath(lockRoot), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const tuning = (dir, extra = {}) => ({ lockRoot: join(dir, 'locks'), cap: 2, sleep: () => {}, bin: join(dir, 'fake-gh'), ...extra });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  // A REAL subprocess standing in for gh: replays the golden fixtures — the DEBUG trace when GH_DEBUG=api, the plain
  // stderr otherwise — plus an optional real warning, an exit code, and stdin echoed to stdout.
  const fakeGh = () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-sync-cap-'));
    const bin = join(dir, 'fake-gh');
    writeFileSync(bin, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const e = process.env;',
      'const debug = e.GH_DEBUG === "api";',
      'if (debug && e.FAKE_TRACE) process.stderr.write(fs.readFileSync(e.FAKE_TRACE));',
      'if (e.FAKE_WARN) process.stderr.write(e.FAKE_WARN);',
      'if (!debug && e.FAKE_PLAIN) process.stderr.write(fs.readFileSync(e.FAKE_PLAIN));',
      'process.stdout.write(e.FAKE_ECHO_STDIN ? fs.readFileSync(0) : "{\\"number\\":2828}\\n");',
      'process.exitCode = Number(e.FAKE_EXIT || 0);',
    ].join('\n'), 'utf8');
    chmodSync(bin, 0o755);
    return { dir, bin };
  };
  const envFor = (fake) => {
    const env = { ...process.env, GH_TOKEN: 'ghs_x', ...fake };
    delete env.GH_DEBUG;
    delete env.WE_GH_THROTTLE_COST_HEADERS;
    return env;
  };
  const SUCCESS = { FAKE_TRACE: join(FIX, 'pr-view-success.debug.stderr') };
  const NOT_FOUND = { FAKE_TRACE: join(FIX, 'pr-view-404.debug.stderr'), FAKE_PLAIN: join(FIX, 'pr-view-404.plain.stderr'), FAKE_EXIT: '1' };
  const catchErr = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('expected a throw'); };
  const errShape = (e) => ({ message: e.message, status: e.status, signal: e.signal, stdout: String(e.stdout), stderr: String(e.stderr), output: (e.output || []).map((o) => (o == null ? o : String(o))) });

  it('a SUCCESS logs rl/id/inv and returns byte-identical stdout to a raw execFileSync (buffer and utf8)', () => {
    const { dir, bin } = fakeGh();
    const env = envFor({ ...SUCCESS, FAKE_WARN: 'Warning: 1 uncommitted change\n' });
    const stdio = ['ignore', 'pipe', 'pipe'];
    for (const encoding of [undefined, 'utf8']) {
      const raw = execFileSync(bin, ['pr', 'view', '2828'], { env, stdio, encoding });
      const got = runGhSync(['pr', 'view', '2828'], { env, stdio, encoding, throttle: tuning(dir) });
      expect(Buffer.isBuffer(got)).toBe(Buffer.isBuffer(raw));
      expect(String(got)).toBe(String(raw));
    }
    const lines = readLog(join(dir, 'locks'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ outcome: 'call', ok: true, resource: 'graphql', id: 'app', rl: [{ used: 36, rem: 4964, limit: 5000, reset: 1790615715, res: 'graphql' }] });
    expect(lines[0].inv).toMatch(/^[0-9a-f-]{12}$/);
  });

  it('a FAILURE throws the SAME error shape (message, status, stdout, stderr, output) as a raw execFileSync, and logs rl', () => {
    const { dir, bin } = fakeGh();
    const env = envFor(NOT_FOUND);
    const opts = { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    const raw = catchErr(() => execFileSync(bin, ['pr', 'view', '999999999'], opts));
    const got = catchErr(() => runGhSync(['pr', 'view', '999999999'], { ...opts, throttle: tuning(dir) }));
    expect(errShape(got)).toEqual(errShape(raw));
    expect(got.stderr).toBe(fx('pr-view-404.plain.stderr'));
    expect(readLog(join(dir, 'locks'))[0]).toMatchObject({ ok: false, rl: [{ used: 37, res: 'graphql' }] });
  });

  it('with NO stdio option, relays the SAME (stripped) stderr to this process as execFileSync would', () => {
    const { dir, bin } = fakeGh();
    const env = envFor({ ...SUCCESS, FAKE_WARN: 'Warning: real\n' });
    const writes = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
    execFileSync(bin, ['pr', 'view', '2828'], { env });
    const rawWrites = writes.splice(0);
    runGhSync(['pr', 'view', '2828'], { env, throttle: tuning(dir) });
    expect(writes).toEqual(rawWrites);
    expect(writes.join('')).toBe('Warning: real\n');
    expect(readLog(join(dir, 'locks'))[0].rl).toHaveLength(1);
  });

  it('stdin: an `input` body reaches gh on EVERY attempt, exactly as execFileSync passes it', () => {
    const { dir, bin } = fakeGh();
    const env = envFor({ ...SUCCESS, FAKE_ECHO_STDIN: '1' });
    const got = runGhSync(['api', 'graphql', '--input', '-'], { env, input: '{"query":"{ viewer { login } }"}', encoding: 'utf8', throttle: tuning(dir) });
    expect(got).toBe('{"query":"{ viewer { login } }"}');
    const spawn = vi.fn(() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('HTTP 403: You have exceeded a secondary rate limit\n'), output: [], error: null }));
    catchErr(() => runGhSync(['api', 'graphql'], { input: 'BODY', stdio: ['pipe', 'pipe', 'pipe'], throttle: tuning(dir, { spawn, maxAttempts: 2 }) }));
    expect(spawn).toHaveBeenCalledTimes(2);
    for (const call of spawn.mock.calls) expect(call[2]).toMatchObject({ input: 'BODY', stdio: ['pipe', 'pipe', 'pipe'], env: expect.objectContaining({ GH_DEBUG: 'api' }) });
  });

  it('classifies on the STRIPPED stderr (a body saying "API rate limit exceeded" is not retried), reads backoff headers from the trace', () => {
    const trace = fx('pr-view-404.debug.stderr').replace('Could not resolve to a PullRequest', 'API rate limit exceeded');
    const spawn = vi.fn(() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(trace), output: [], error: null }));
    const dir = mkdtempSync(join(tmpdir(), 'gh-sync-cap-'));
    const err = catchErr(() => runGhSync(['pr', 'view', '9'], { stdio: 'pipe', throttle: tuning(dir, { spawn, maxAttempts: 3 }) }));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(String(err.stderr)).toBe(fx('pr-view-404.plain.stderr'));
    // a REAL secondary limit: the stripped error line classifies, the trace's Retry-After calibrates the wait
    const secondary = fx('pr-view-404.debug.stderr').replace('< X-Ratelimit-Limit', '< Retry-After: 7\n< X-Ratelimit-Limit')
      .replace(/^GraphQL: .*$/m, 'HTTP 403: You have exceeded a secondary rate limit');
    const sleeps = [];
    const spawn2 = vi.fn()
      .mockReturnValueOnce({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(secondary), output: [], error: null })
      .mockReturnValueOnce({ status: 0, stdout: Buffer.from('ok'), stderr: Buffer.from(fx('pr-view-success.debug.stderr')), output: [], error: null });
    expect(String(runGhSync(['pr', 'view', '9'], { stdio: 'pipe', throttle: tuning(dir, { spawn: spawn2, maxAttempts: 3, sleep: (ms) => sleeps.push(ms) }) }))).toBe('ok');
    expect(sleeps[0]).toBeGreaterThanOrEqual(7000);
  });

  it('no capture — and the raw exec path unchanged — for a caller GH_DEBUG, a non-piped stderr, or the kill switch', () => {
    const { dir } = fakeGh();
    const spawn = vi.fn();
    // caller's own GH_DEBUG: the trace is the caller's, relayed untouched
    const callerDebug = catchErr(() => runGhSync(['pr', 'view', '9'], { env: { ...envFor(NOT_FOUND), GH_DEBUG: 'api' }, encoding: 'utf8', stdio: 'pipe', throttle: tuning(dir, { spawn }) }));
    expect(callerDebug.stderr).toBe(fx('pr-view-404.debug.stderr'));
    // stderr not piped
    runGhSync(['pr', 'view', '2828'], { env: envFor(SUCCESS), stdio: ['ignore', 'pipe', 'ignore'], throttle: tuning(dir, { spawn }) });
    // kill switch
    runGhSync(['pr', 'view', '2828'], { env: envFor(SUCCESS), stdio: 'pipe', throttle: tuning(dir, { spawn, env: { WE_GH_THROTTLE_COST_HEADERS: '0' } }) });
    expect(spawn).not.toHaveBeenCalled();
    expect(readLog(join(dir, 'locks')).map((l) => l.rl)).toEqual([undefined, undefined, undefined]);
  });

  it('calibrateHeaders callers are captured (rl logged) but keep their trace in stderr, as before', () => {
    const { dir } = fakeGh();
    const err = catchErr(() => runGhSync(['pr', 'create'], { env: envFor(NOT_FOUND), encoding: 'utf8', stdio: 'pipe', throttle: tuning(dir, { calibrateHeaders: true }) }));
    expect(err.stderr).toBe(fx('pr-view-404.debug.stderr'));
    expect(readLog(join(dir, 'locks'))[0].rl).toEqual([{ used: 37, rem: 4963, limit: 5000, reset: 1790615715, res: 'graphql', shape: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
  });

  it('stdout over the caller\'s maxBuffer still raises ENOBUFS (the trace headroom never loosens the cap), and is logged', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.alloc(2048), stderr: Buffer.from(fx('pr-view-success.debug.stderr')), output: [], error: null }));
    const dir = mkdtempSync(join(tmpdir(), 'gh-sync-cap-'));
    const err = catchErr(() => runGhSync(['api', 'graphql'], { maxBuffer: 1024, stdio: 'pipe', throttle: tuning(dir, { spawn }) }));
    expect(err.code).toBe('ENOBUFS');
    expect(spawn.mock.calls[0][2].maxBuffer).toBe(1024 * 8);
    expect(readLog(join(dir, 'locks'))[0]).toMatchObject({ ok: false, rl: [{ used: 36 }] });
  });
});
