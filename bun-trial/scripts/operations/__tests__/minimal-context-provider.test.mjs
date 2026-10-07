/**
 * @file minimal-context-provider.test.mjs — coverage for the shared primitives extracted out of
 * `we:scripts/operations/deliver-item-wrapper.mjs` (#3627, PR #2107) for #xu2pp2m: the `CLAUDE_RESTRICTED_
 * PROVIDER` argv shape, hooks-settings generation, lane acquire/release, and the gate-running pattern. Every
 * behavior asserted here is byte-identical to what `deliver-item-wrapper.test.mjs` already proved for the
 * pre-extraction code — this suite exists so the SHARED module has its own direct coverage too, independent of
 * `deliver-item-wrapper.mjs`'s own (unchanged) 106 tests.
 */

// Mirrors `deliver-item-wrapper.test.mjs`'s own `mock.module('node:fs', ...)` convention: `node:fs`'s real module
// namespace is not spy-able in place (`vi.spyOn` on the live module object throws "Cannot redefine property"),
// so the whole module is replaced with a fresh, mockable object instead — `mkdirSync`/`writeFileSync` become
// `mock()`s while every other export (`readFileSync`, etc.) stays real.
import { describe, it, test, expect, mock } from 'bun:test';
const __ORIG_URL = new URL('../../../../scripts/operations/__tests__/minimal-context-provider.test.mjs', import.meta.url).href;
const __ORIG_FILE = new URL(__ORIG_URL).pathname;
const __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\/$/, '');
const __actual0 = { ...(await import('node:fs')) };
mock.module('node:fs', () => {
  const actual = __actual0;
  const mocked = { ...actual, mkdirSync: mock(), writeFileSync: mock() };
  return { ...mocked, default: mocked };
});

import { mkdirSync, writeFileSync } from 'node:fs';

import {
  REPO_ROOT, RESTRICTED_PROVIDER_TOOLS, buildRestrictedProviderArgv, createHooksSettingsWriter,
  persistSpawnFailure, acquireLane, resetStaleVerifyMarker, releaseLane, releaseAllPools, resolveLanePath,
  runVerifyOperation, resolveRunCwd, laneHasCommitAhead,
} from '../../../../scripts/operations/minimal-context-provider.mjs';

// build-orphan-adopt (#4131/#4382) — HALF of the resumability check `deliver-item-wrapper.mjs
// #runAgentToCompletion`'s `resume` branch uses, and `scripts/conveyor/build-dispatch-orphan-adopt.mjs`'s own
// `checkResumable` reuses the SAME function rather than re-deriving it.
describe('laneHasCommitAhead', () => {
  it('true when the lane has at least one commit ahead of its base', () => {
    const run = mock(() => '3\n');
    expect(laneHasCommitAhead({ lane: '/fake/lane-9', run })).toBe(true);
    // PR #2921 review — `origin/main`, never local `main`: a pool lane's working branch IS its local `main`.
    expect(run).toHaveBeenCalledWith('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: '/fake/lane-9' });
  });

  it('false when the lane has zero commits ahead', () => {
    const run = mock(() => '0\n');
    expect(laneHasCommitAhead({ lane: '/fake/lane-9', run })).toBe(false);
  });

  it('respects a non-default base', () => {
    const run = mock(() => '1\n');
    laneHasCommitAhead({ lane: '/fake/lane-9', base: 'lane/daemon-poc', run });
    expect(run).toHaveBeenCalledWith('git', ['rev-list', '--count', 'lane/daemon-poc..HEAD'], { cwd: '/fake/lane-9' });
  });

  it('fails closed (false) when git throws — an unreadable lane is never resumable', () => {
    const run = mock(() => { throw new Error('not a git repository'); });
    expect(laneHasCommitAhead({ lane: '/fake/gone', run })).toBe(false);
  });

  it('fails closed (false) on unparseable output', () => {
    const run = mock(() => 'not-a-number\n');
    expect(laneHasCommitAhead({ lane: '/fake/lane-9', run })).toBe(false);
  });
});

describe('REPO_ROOT', () => {
  // NOTE, mirroring `deliver-item-wrapper.test.mjs`'s own pre-existing comment on this exact point: this file's
  // `__ORIG_URL`-derived `REPO_ROOT` does not resolve reliably inside vitest's SSR transform, so no test
  // here calls a REPO_ROOT-relative real fs write directly — every such seam (`createHooksSettingsWriter`,
  // `persistSpawnFailure`) is asserted at the injectable-seam / source level instead, the SAME convention the
  // pre-existing suite already established.
  it('is a non-empty string (script-location-resolved, never cwd-derived)', () => {
    expect(typeof REPO_ROOT).toBe('string');
    expect(REPO_ROOT.length).toBeGreaterThan(0);
  });
});

// #xu2pp2m — bug found live (driver run against real PR #2108 from an isolated scratch clone): `run()` used
// to hardcode every subprocess's `cwd` to `REPO_ROOT` (THIS file's own script-location-derived checkout),
// never the checkout the wrapper is actually being invoked FROM — which silently breaks `lane-pool.mjs
// acquire` whenever `REPO_ROOT` happens to be a throwaway scratch clone with no sibling `.lanes` pool of its
// own. `resolveRunCwd` is the fix: `run()`'s cwd now resolves from `process.cwd()`'s own git toplevel first,
// falling back to `REPO_ROOT` only when `process.cwd()` is not inside a git checkout at all.
describe('resolveRunCwd', () => {
  it('prefers the git toplevel of the given processCwd — the ACTUAL working checkout the wrapper is being '
    + 'run from — over REPO_ROOT (this file\'s own script-location-derived checkout)', () => {
    const gitToplevel = mock(() => '/some/other/checkout/entirely');
    const cwd = resolveRunCwd('/some/other/checkout/entirely/scripts', gitToplevel);
    expect(gitToplevel).toHaveBeenCalledWith('/some/other/checkout/entirely/scripts');
    expect(cwd).toBe('/some/other/checkout/entirely');
    expect(cwd).not.toBe(REPO_ROOT);
  });

  it('falls back to REPO_ROOT when processCwd is not inside any git checkout (gitToplevel resolves null) — '
    + 'never leaves run() with no valid cwd at all', () => {
    const gitToplevel = mock(() => null);
    const cwd = resolveRunCwd('/tmp/not-a-checkout', gitToplevel);
    expect(cwd).toBe(REPO_ROOT);
  });

  it('defaults processCwd to process.cwd() and gitToplevel to a real git call when not injected (production '
    + 'shape — the injected form above is what every test exercises)', () => {
    expect(typeof resolveRunCwd()).toBe('string');
    expect(resolveRunCwd().length).toBeGreaterThan(0);
  });
});

describe('buildRestrictedProviderArgv', () => {
  it('fresh spawn: --restricted, an explicit --tools allowlist, --strict-mcp-config, --disable-slash-commands, '
    + 'the given --settings file, and -p/--session-id', () => {
    const argv = buildRestrictedProviderArgv({
      sessionId: 'session-1', prompt: 'do the thing', settingsFile: '/repo/.operations/hooks.json',
    });
    expect(argv).toEqual([
      '--restricted', '--tools', RESTRICTED_PROVIDER_TOOLS, '--strict-mcp-config',
      '--disable-slash-commands', '--settings', '/repo/.operations/hooks.json',
      '--model', 'sonnet', '--effort', 'medium', '-p', '--session-id', 'session-1', 'do the thing',
    ]);
  });

  it('resume: --resume <id>, no -p/--session-id', () => {
    const argv = buildRestrictedProviderArgv({
      sessionId: 'ignored', resumeSessionId: 'resume-1', prompt: 'fix it', settingsFile: '/repo/.operations/hooks.json',
    });
    expect(argv).toContain('--resume');
    expect(argv).toContain('resume-1');
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('--session-id');
  });

  it('never emits --bare or --safe-mode', () => {
    const argv = buildRestrictedProviderArgv({ sessionId: 's', prompt: 'p', settingsFile: '/x.json' });
    expect(argv).not.toContain('--bare');
    expect(argv).not.toContain('--safe-mode');
  });

  it('`tools` is overridable — a future caller can narrow/widen the allowlist without a second argv builder', () => {
    const argv = buildRestrictedProviderArgv({ sessionId: 's', prompt: 'p', settingsFile: '/x.json', tools: 'Bash' });
    expect(argv).toEqual([
      '--restricted', '--tools', 'Bash', '--strict-mcp-config', '--disable-slash-commands', '--settings', '/x.json',
      '--model', 'sonnet', '--effort', 'medium', '-p', '--session-id', 's', 'p',
    ]);
  });
});

describe('createHooksSettingsWriter', () => {
  it('returns a function whose source literally writes with mkdirSync/writeFileSync and never guards on '
    + 'existsSync — mirrors the #3627 bug-8 correctness fix (a stale on-disk file must never survive a schema '
    + 'change just because the path "already exists")', () => {
    const writer = createHooksSettingsWriter('some-file.json', { hooks: {} });
    const source = writer.toString();
    expect(source).toContain('mkdirSync');
    expect(source).toContain('writeFileSync');
    expect(source).not.toContain('existsSync');
  });

  it('two different (fileName, settings) pairs produce two independently-callable, distinct writer functions '
    + '(same generated shape, closed over different content — never a shared mutable writer)', () => {
    const a = createHooksSettingsWriter('a.json', { who: 'a' });
    const b = createHooksSettingsWriter('b.json', { who: 'b' });
    expect(typeof a).toBe('function');
    expect(typeof b).toBe('function');
    expect(a).not.toBe(b);
    expect(a.toString()).toBe(b.toString()); // same generated source shape
  });

  it('the generated writer calls mkdirSync(<...>.operations, {recursive:true}) then writeFileSync with the '
    + 'pretty-printed settings JSON at a path ending in `.operations/<fileName>` — spied at the mocked '
    + '`node:fs` boundary rather than a real REPO_ROOT-relative write (REPO_ROOT does not resolve reliably '
    + 'under vitest\'s SSR transform — the same limitation `deliver-item-wrapper.test.mjs` already documents)', () => {
    mkdirSync.mockReset();
    writeFileSync.mockReset();
    const writer = createHooksSettingsWriter('probe-hooks.json', { hello: 'world' });
    const path = writer();
    expect(mkdirSync).toHaveBeenCalledTimes(1);
    expect(mkdirSync.mock.calls[0][0]).toMatch(/\.operations$/);
    expect(mkdirSync.mock.calls[0][1]).toEqual({ recursive: true });
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = writeFileSync.mock.calls[0];
    expect(writtenPath).toMatch(/\.operations\/probe-hooks\.json$/);
    expect(writtenPath).toBe(path);
    expect(writtenContent).toBe(`${JSON.stringify({ hello: 'world' }, null, 2)}\n`);
  });
});

describe('persistSpawnFailure', () => {
  it('never throws even when the underlying write fails (best-effort — never mask the real spawn error)', () => {
    mkdirSync.mockReset();
    writeFileSync.mockReset();
    mkdirSync.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => persistSpawnFailure('probe-dir', 's', new Error('boom'))).not.toThrow();
    expect(persistSpawnFailure('probe-dir', 's', new Error('boom'))).toBe(null);
  });

  it('writes a JSON capture under `.operations/<dirName>/` named by sessionSlug + timestamp, and returns the '
    + 'path — spied at the mocked `node:fs` boundary (same REPO_ROOT-under-vitest limitation noted above)', () => {
    mkdirSync.mockReset();
    writeFileSync.mockReset();
    const path = persistSpawnFailure('probe-spawn-failures', 'sess-1', Object.assign(new Error('boom'), { stdout: 'out', stderr: 'err', status: 1, signal: null }));
    expect(path).toMatch(/\.operations\/probe-spawn-failures\/sess-1-\d+\.json$/);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = writeFileSync.mock.calls[0];
    expect(writtenPath).toBe(path);
    const parsed = JSON.parse(writtenContent);
    expect(parsed.sessionSlug).toBe('sess-1');
    expect(parsed.message).toBe('boom');
    expect(parsed.stdout).toBe('out');
    expect(parsed.stderr).toBe('err');
  });

  it('a resume tags the filename with -resume so it never clobbers the fresh spawn\'s own capture', () => {
    mkdirSync.mockReset();
    writeFileSync.mockReset();
    const path = persistSpawnFailure('probe-spawn-failures', 'sess-2', new Error('boom'), { resumeSessionId: 'r' });
    expect(path).toMatch(/sess-2-resume-\d+\.json$/);
  });
});

describe('acquireLane', () => {
  it('defaults `purpose` to `conveyor-delivery` — every pre-extraction call site (deliver-item-wrapper.mjs\'s '
    + 'own `deliverItem`) is unaffected by the generalization', () => {
    const run = mock(() => '');
    acquireLane({ lane: 3, sessionSlug: 's', scope: 'we:x', item: '1', claudeSessionId: 'id-1' }, { run });
    const [, args] = run.mock.calls[0];
    expect(args).toContain('--purpose=conveyor-delivery');
  });

  it('an explicit `purpose` overrides the default — a review dispatch acquires for `review-loop`, never '
    + '`conveyor-delivery`', () => {
    const run = mock(() => '');
    acquireLane({ lane: 1, sessionSlug: 'review-42', scope: '', item: '', claudeSessionId: 'id-2', purpose: 'review-loop' }, { run });
    const [, args] = run.mock.calls[0];
    expect(args).toContain('--purpose=review-loop');
    expect(args).not.toContain('--purpose=conveyor-delivery');
  });

  it('stamps CLAUDE_CODE_SESSION_ID=<claudeSessionId> on the acquire subprocess\'s own env', () => {
    const run = mock(() => '');
    acquireLane({ lane: 1, sessionSlug: 's', scope: '', item: '', claudeSessionId: 'id-3' }, { run });
    const [, , opts] = run.mock.calls[0];
    expect(opts.env.CLAUDE_CODE_SESSION_ID).toBe('id-3');
  });

  it('best-effort: a resolveLanePath/reset failure AFTER a successful acquire never throws — only the acquire '
    + 'call itself (call 1) is un-guarded, mirroring `deliver-item-wrapper.test.mjs`\'s own acquireLane suite', () => {
    // `run` succeeds (returns '') for every call, including the acquire itself; the post-acquire
    // `lane-pool.mjs status` lookup then fails to parse '' as JSON, which the best-effort try/catch swallows —
    // exactly 2 calls (acquire, then the failing status lookup), never a 3rd `verify-lane.mjs reset` call.
    const run = mock(() => '');
    expect(() => acquireLane({ lane: 1, sessionSlug: 's', scope: '', item: '', claudeSessionId: 'id-4' }, { run })).not.toThrow();
    expect(run).toHaveBeenCalledTimes(2);
  });

  describe('the UNNUMBERED shape (`lane` omitted) — review-agent-brief.md step 1\'s own real acquire', () => {
    it('omits --lane/--scope/--item entirely and reads the acquired path off the acquire call\'s OWN stdout '
      + '(verified against the real CLI: lane-pool.mjs acquire prints ONLY the path to stdout, every '
      + 'informational line goes to stderr)', () => {
      const run = mock(() => '/pool/lane-9\n');
      const path = acquireLane({ sessionSlug: 'review-42', claudeSessionId: 'id-6', purpose: 'review-loop' }, { run });
      expect(path).toBe('/pool/lane-9');
      const [, args] = run.mock.calls[0];
      expect(args).toEqual(['scripts/lane-pool.mjs', 'acquire', '--purpose=review-loop', '--session=review-42', '--adopt']);
    });

    it('adds --wait-ms=<n> when given', () => {
      const run = mock(() => '/pool/lane-9');
      acquireLane({ sessionSlug: 'review-42', claudeSessionId: 'id-7', purpose: 'review-loop', waitMs: 30000 }, { run });
      const [, args] = run.mock.calls[0];
      expect(args).toEqual(['scripts/lane-pool.mjs', 'acquire', '--purpose=review-loop', '--session=review-42', '--wait-ms=30000', '--adopt']);
    });

    it('best-effort: a marker-reset failure never throws, and the resolved path still comes back', () => {
      const run = mock((cmd, args) => {
        if (args[1] === 'acquire') return '/pool/lane-9';
        throw new Error('reset refused');
      });
      let path;
      expect(() => { path = acquireLane({ sessionSlug: 's', claudeSessionId: 'id-8', purpose: 'review-loop' }, { run }); }).not.toThrow();
      expect(path).toBe('/pool/lane-9');
    });

    // #xu2pp2m fixer — `--base=<ref>` reconstitutes a bounced PR's own lane/* ref instead of resetting to
    // origin/main (the real, verified lane-pool.mjs acquire flag, #2386).
    it('adds --base=<ref> when given, after --wait-ms and before --adopt', () => {
      const run = mock(() => '/pool/lane-9');
      acquireLane({ sessionSlug: 'fix-2108', claudeSessionId: 'id-9', purpose: 'conveyor-fix', waitMs: 30000, base: 'lane/2108-foo' }, { run });
      const [, args] = run.mock.calls[0];
      expect(args).toEqual([
        'scripts/lane-pool.mjs', 'acquire', '--purpose=conveyor-fix', '--session=fix-2108',
        '--wait-ms=30000', '--base=lane/2108-foo', '--adopt',
      ]);
    });

    it('omits --base entirely when not given — every existing caller (review dispatch) is byte-for-byte unchanged', () => {
      const run = mock(() => '/pool/lane-9');
      acquireLane({ sessionSlug: 'review-42', claudeSessionId: 'id-10', purpose: 'review-loop' }, { run });
      const [, args] = run.mock.calls[0];
      expect(args.some((a) => a.startsWith('--base='))).toBe(false);
    });

    // build-path-codex-isolation-locus — the new `repo`/`item` support this fix adds, so
    // `deliver-item-wrapper.mjs#acquireImplLane` can draw a non-`we` locus item's implementation lane from
    // ITS OWN pool (`--repo=<checkoutPath>`) rather than whatever `resolveRunCwd()` would derive (always WE,
    // for the mechanical build dispatcher's own process).
    it('adds --repo=<checkoutPath> when given, so the acquire draws from a DIFFERENT repo\'s pool than the '
      + 'calling process\'s own cwd would derive', () => {
      const run = mock(() => '/other-pool/lane-4');
      acquireLane({
        sessionSlug: 'conveyor-3604', claudeSessionId: 'id-11', purpose: 'conveyor-delivery-impl',
        repo: '/home/x/workspace/plateau-app',
      }, { run });
      const [, args] = run.mock.calls[0];
      expect(args).toContain('--repo=/home/x/workspace/plateau-app');
    });

    it('omits --repo entirely when not given — every existing caller (review dispatch, and every WE-locus '
      + 'delivery) is byte-for-byte unchanged', () => {
      const run = mock(() => '/pool/lane-9');
      acquireLane({ sessionSlug: 'review-42', claudeSessionId: 'id-12', purpose: 'review-loop' }, { run });
      const [, args] = run.mock.calls[0];
      expect(args.some((a) => a.startsWith('--repo='))).toBe(false);
    });

    it('adds --item=<num> when given — so the drain\'s existing by-item release sweep '
      + '(`lane-pool.mjs release --all-pools --item=<num>`) finds this lane too', () => {
      const run = mock(() => '/other-pool/lane-4');
      acquireLane({
        sessionSlug: 'conveyor-3604', claudeSessionId: 'id-13', purpose: 'conveyor-delivery-impl', item: '3604',
      }, { run });
      const [, args] = run.mock.calls[0];
      expect(args).toContain('--item=3604');
    });

    it('omits --item entirely when not given — review dispatch never passes one, and its own pinned argv '
      + '(above) is unaffected', () => {
      const run = mock(() => '/pool/lane-9');
      acquireLane({ sessionSlug: 'review-42', claudeSessionId: 'id-14', purpose: 'review-loop' }, { run });
      const [, args] = run.mock.calls[0];
      expect(args.some((a) => a.startsWith('--item='))).toBe(false);
    });
  });
});

describe('resetStaleVerifyMarker', () => {
  it('calls verify-lane.mjs reset --repo=<lanePath> --json with CLAUDE_CODE_SESSION_ID set', () => {
    const run = mock(() => JSON.stringify({ status: 'reset' }));
    resetStaleVerifyMarker('/pool/lane-4', { run, claudeSessionId: 'id-5' });
    const [cmd, args, opts] = run.mock.calls[0];
    expect(cmd).toBe('node');
    expect(args).toEqual(['scripts/verify-lane.mjs', 'reset', '--repo=/pool/lane-4', '--json']);
    expect(opts.env.CLAUDE_CODE_SESSION_ID).toBe('id-5');
  });

  it('never throws on a refusal', () => {
    const run = mock(() => { throw new Error('refused'); });
    expect(() => resetStaleVerifyMarker('/pool/lane-4', { run, claudeSessionId: 'x' })).not.toThrow();
  });
});

describe('releaseLane', () => {
  it('calls lane-pool.mjs release --lane=<N> --session=<slug>', () => {
    const run = mock(() => '');
    releaseLane({ lane: 3, sessionSlug: 'review-42' }, { run });
    expect(run).toHaveBeenCalledWith('node', ['scripts/lane-pool.mjs', 'release', '--lane=3', '--session=review-42'], {});
  });

  it('bestEffort=true swallows a release failure rather than throwing', () => {
    const run = mock(() => { throw new Error('boom'); });
    expect(() => releaseLane({ lane: 3, sessionSlug: 's', bestEffort: true }, { run })).not.toThrow();
  });

  it('bestEffort=false (the default) propagates a release failure', () => {
    const run = mock(() => { throw new Error('boom'); });
    expect(() => releaseLane({ lane: 3, sessionSlug: 's' }, { run })).toThrow('boom');
  });
});

describe('releaseAllPools', () => {
  it('calls lane-pool.mjs release --all-pools --session=<slug> — the review-agent-brief\'s own step-4 shape', () => {
    const run = mock(() => '');
    releaseAllPools('review-42', { run });
    expect(run).toHaveBeenCalledWith('node', ['scripts/lane-pool.mjs', 'release', '--all-pools', '--session=review-42']);
  });

  it('never throws (best-effort)', () => {
    const run = mock(() => { throw new Error('boom'); });
    expect(() => releaseAllPools('s', { run })).not.toThrow();
  });
});

describe('resolveLanePath', () => {
  it('returns the matching lane\'s real path from lane-pool.mjs status --json', () => {
    const run = mock(() => JSON.stringify({ lanes: [{ lane: 4, path: '/pool/lane-4', exists: true }] }));
    expect(resolveLanePath(4, { run })).toBe('/pool/lane-4');
    expect(run).toHaveBeenCalledWith('node', ['scripts/lane-pool.mjs', 'status', '--json']);
  });

  it('throws a named error when no matching entry is reported', () => {
    const run = mock(() => JSON.stringify({ lanes: [{ lane: 1, path: '/pool/lane-1', exists: true }] }));
    expect(() => resolveLanePath(2, { run })).toThrow(/no entry\/path for lane-2/);
  });
});

describe('runVerifyOperation', () => {
  it('reports `pass` for a green verdict', () => {
    const run = mock(() => JSON.stringify({ verdict: { ok: true, failed: 0, unrun: 0 } }));
    const result = runVerifyOperation('/pool/lane-1', { run });
    expect(result.outcome).toBe('pass');
  });

  it('reports `fail` when the verdict carries a real failure', () => {
    const run = mock(() => JSON.stringify({ verdict: { ok: false, failed: 1, unrun: 0, blocking: [] } }));
    const result = runVerifyOperation('/pool/lane-1', { run });
    expect(result.outcome).toBe('fail');
  });

  it('reports `unrun` (never `fail`) when nothing failed but the gate did not run', () => {
    const run = mock(() => JSON.stringify({ verdict: { ok: false, failed: 0, unrun: 1, blocking: [] } }));
    const result = runVerifyOperation('/pool/lane-1', { run });
    expect(result.outcome).toBe('unrun');
  });

  it('reports `unrun` when the operation itself throws (a refusal/crash)', () => {
    const run = mock(() => { throw new Error('refused'); });
    const result = runVerifyOperation('/pool/lane-1', { run });
    expect(result.outcome).toBe('unrun');
  });

  it('reports `unrun` when the output does not parse', () => {
    const run = mock(() => 'not json');
    const result = runVerifyOperation('/pool/lane-1', { run });
    expect(result.outcome).toBe('unrun');
  });
});
