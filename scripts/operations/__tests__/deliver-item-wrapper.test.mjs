/**
 * @file deliver-item-wrapper.test.mjs — argv-contract coverage for the #3627 minimal-delivery wrapper
 * PROTOTYPE (`we:scripts/operations/deliver-item-wrapper.mjs`). The file is still NOT wired into
 * `dispatch-lane.mjs` and NOT imported by production code — this test exists so the one thing that is a real,
 * load-bearing contract (the `claude` argv `CLAUDE_RESTRICTED_PROVIDER` constructs) cannot silently drift.
 *
 * Mirrors the reasoning `we:scripts/operations/dispatch-lane-io.mjs#buildAgentArgv` is tested for: "the argv
 * IS the contract with the CLI and a test that asserts it is the only thing standing between a flag rename
 * and a silent non-dispatch." `buildRestrictedProviderArgv` is the pure seam extracted from
 * `CLAUDE_RESTRICTED_PROVIDER.spawn` for exactly this reason.
 *
 * This provider replaces an earlier `--bare`-based draft; see the file's own docblock for the real (not
 * assumed) verification trail behind the swap — a `--safe-mode` swap was tried FIRST and independently
 * REJECTED after a real smoke test showed a `--settings=<hooks file>` layered on top of it never fires.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ================================================================================================
// #3627 bug 13/14 — `deliverItem` itself has NO injection points for its own internal calls (acquireLane,
// claimItem, runAgentToCompletion, runGateWithOneRetry, runConverge, openPr, … all use this file's own
// module-level `run`/`readFileSync`, not a param `deliverItem` threads through). The ONLY way to drive
// `deliverItem`'s real, unmodified success path in a test is to mock its cross-module dependencies at their
// own boundary: `node:child_process#execFileSync` (every `run` call bottoms out here), `node:fs#readFileSync`
// (only for the one real file it reads — the v2 brief template; every other fs call in the success path
// writes to a REAL temp lane dir, so `writeFileSync`/`mkdirSync`/etc are left real via the `actual` spread),
// and `findItem`/`tryReadDeliveryReport` (genuinely separate modules, cleanly mockable via `vi.mock`).
// `findItem` wraps the REAL implementation by default (`vi.fn(actual.findItem)`) so every OTHER describe
// block below that relies on real `findItem` behavior (via `resolveItemSpecPathBasename`/`fillMinimalBrief`)
// is unaffected — only the `deliverItem` describe block at the bottom overrides it per-test.
// ================================================================================================
vi.mock('../dispatch-lane-io.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, findItem: vi.fn(actual.findItem) };
});
vi.mock('../delivery-report-store.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, tryReadDeliveryReport: vi.fn() };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const mocked = { ...actual, execFileSync: vi.fn() };
  return { ...mocked, default: mocked };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  const readFileSync = vi.fn((path, ...rest) => {
    if (String(path).includes('delivery-agent-brief-v2.md')) return 'Build item {{ITEM_SPEC_PATH_BASENAME}}.';
    return actual.readFileSync(path, ...rest);
  });
  const mocked = { ...actual, readFileSync };
  return { ...mocked, default: mocked };
});
// #4349 finding #7 — a way to inject a throw AFTER the root span's own `ok()` close, i.e. after a terminal
// branch already called `settleTerminal` and is on its way out through `finish()`. Everything else about
// telemetry stays real; only the root `dispatch` span's `ok()` is wrapped, and only fires once per flag set.
const telemetryFaults = vi.hoisted(() => ({ throwOnNextRootOk: false, failures: [] }));
vi.mock('../telemetry-store.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    recorderFor: (...args) => {
      const rec = actual.recorderFor(...args);
      return {
        ...rec,
        startSpan: (name, opts) => {
          const span = rec.startSpan(name, opts);
          if (name !== 'dispatch') return span;
          return {
            ...span,
            fail: (error, attrs) => {
              telemetryFaults.failures.push({ error, attrs });
              return span.fail(error, attrs);
            },
            ok: (extra) => {
              if (telemetryFaults.throwOnNextRootOk) {
                telemetryFaults.throwOnNextRootOk = false;
                throw new Error('injected: telemetry root.ok threw after settle');
              }
              return span.ok(extra);
            },
          };
        },
      };
    },
  };
});

import { execFileSync } from 'node:child_process';
import { SPAWN_TIMEOUT_MS, findItem } from '../dispatch-lane-io.mjs';
import { tryReadDeliveryReport } from '../delivery-report-store.mjs';
import { CODEX_DELIVERY_MODEL } from '../codex-delivery-provider.mjs';
import { parseDelegationMarker } from '../../lib/delegation-marker.mjs';
import {
  DELIVERY_AGENT_PROVIDERS, DELIVERY_AGENT_SPAWN_TIMEOUT_MS, buildRestrictedProviderArgv,
  DELIVERY_AGENT_PROVIDER_NAMES, DEFAULT_DELIVERY_AGENT_PROVIDER_NAME, resolveDeliveryAgentProvider,
  resolveItemSpecPathBasename, fillMinimalBrief,
  buildPrBody, writePrBody, openPr, describeOpenPrRefusal, delegationForBuild,
  runConverge, parseConvergeEditResult, buildConvergeEditorArgv, runConvergeEdit,
  convergeRoundTouchedFiles, commitConvergeRound, commitBuildTurn, coAuthorTrailerFor, convergeScratchDir,
  resetConvergeScratchDir,
  prefixOwnPathMentions, sanitizeOwnLocusMentions,
  decideParkMode, computeLaneDiffStats,
  resolveLanePath, runGateWithOneRetry, claimItem, runAgentToCompletion, acquireLane,
  buildDeliveryAgentEnv, DELIVERY_HOOKS_SETTINGS, ensureDeliveryHooksSettingsFile,
  resetStaleVerifyMarker, runVerifyOperation, deliverItem,
  // build-path-codex-isolation-locus
  resolveDeliveryLocus, acquireImplLane, stageDeliveryReportCliIntoLane, DELIVERY_REPORT_CLI_REL_FILES,
  mergeSettleResult, buildReportFromEnvelope, envelopeReportOrNull,
  // #4348-open-pr-retry
  classifyOpenPrFailure,
} from '../deliver-item-wrapper.mjs';
import { runDeliverItemCli } from '../deliver-item-run.mjs';
import { REPO_ROOT } from '../minimal-context-provider.mjs';
import { repoProfile } from '../../lib/repo-profile.mjs';
// #4349 — real (never mocked) run-store + build-dispatch-claim reads, driven through a temp `OPERATION_RUNS_DIR`
// / `WE_COORDINATION_ROOT` in the new describe block below.
import { createFileRunStore, newRunRecord } from '../run-store.mjs';
import { acquireBuildDispatchClaim, listBuildDispatchClaims, listBuildDispatchHolds } from '../../conveyor/build-dispatch-claim.mjs';

// A real UUID, hardcoded for deterministic assertions (mirrors `crypto.randomUUID()`'s own output shape). Tests
// that need "some UUID, any UUID" instead assert against this regex.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('buildRestrictedProviderArgv', () => {
  it('#4348 — addDirs adds one `--add-dir <dir>` pair each, on both branches, before -p/--resume', () => {
    const fresh = buildRestrictedProviderArgv({ sessionId: 'u', prompt: 'p', settingsFile: '/s.json', addDirs: ['/we/lane-7'] });
    expect(fresh.slice(-10)).toEqual(['--add-dir', '/we/lane-7', '--model', 'sonnet', '--effort', 'medium', '-p', '--session-id', 'u', 'p']);
    const resume = buildRestrictedProviderArgv({ prompt: 'p', resumeSessionId: 'u', settingsFile: '/s.json', addDirs: ['/we/lane-7'] });
    expect(resume.slice(-5)).toEqual(['--add-dir', '/we/lane-7', '--resume', 'u', 'p']);
  });

  it('fresh spawn: uses --restricted (never --bare), an explicit --tools allowlist, --strict-mcp-config, '
    + '--disable-slash-commands, the given --settings file, and -p/--session-id', () => {
    const argv = buildRestrictedProviderArgv({
      sessionId: 'session-1', prompt: 'build item #1234', settingsFile: '/repo/.operations/hooks.json',
    });
    expect(argv).toEqual([
      '--restricted', '--tools', 'Bash,Edit,Write,Read,Glob,Grep', '--strict-mcp-config',
      '--disable-slash-commands', '--settings', '/repo/.operations/hooks.json',
      '--model', 'sonnet', '--effort', 'medium', '-p', '--session-id', 'session-1', 'build item #1234',
    ]);
  });

  it('never emits --bare — the flag this provider replaced (it requires ANTHROPIC_API_KEY/apiKeyHelper and '
    + 'cannot use the operator\'s OAuth/subscription auth)', () => {
    const argv = buildRestrictedProviderArgv({
      sessionId: 'session-1', prompt: 'build item #1234', settingsFile: '/repo/.operations/hooks.json',
    });
    expect(argv).not.toContain('--bare');
  });

  it('never emits --safe-mode — independently smoke-tested and rejected: a --settings-supplied hook layered '
    + 'on top of --safe-mode does not fire (confirmed by running a guard-bash.mjs-denied command through it '
    + 'and observing it execute for real, permission_denials: [])', () => {
    const argv = buildRestrictedProviderArgv({
      sessionId: 'session-1', prompt: 'build item #1234', settingsFile: '/repo/.operations/hooks.json',
    });
    expect(argv).not.toContain('--safe-mode');
  });

  it('resume: drops -p/--session-id, adds --resume <id>, retains the session model and keeps the restriction flags from a fresh '
    + 'spawn (--resume was verified, not assumed, to preserve both auth-without-a-key and hooks-firing)', () => {
    const argv = buildRestrictedProviderArgv({
      sessionId: 'session-1', prompt: 'fix the gate failure', resumeSessionId: 'session-1',
      settingsFile: '/repo/.operations/hooks.json',
    });
    expect(argv).toEqual([
      '--restricted', '--tools', 'Bash,Edit,Write,Read,Glob,Grep', '--strict-mcp-config',
      '--disable-slash-commands', '--settings', '/repo/.operations/hooks.json',
      '--resume', 'session-1', 'fix the gate failure',
    ]);
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('--session-id');
  });

  it('--tools is always the explicit allowlist, never "default" — verified: --tools=default does not '
    + 'restore what --restricted removes (a real probe asking for a Bash call under --tools=default came '
    + 'back "no shell tool available")', () => {
    const argv = buildRestrictedProviderArgv({
      sessionId: 's', prompt: 'p', settingsFile: '/f.json',
    });
    const toolsIdx = argv.indexOf('--tools');
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(argv[toolsIdx + 1]).toBe('Bash,Edit,Write,Read,Glob,Grep');
    expect(argv[toolsIdx + 1]).not.toBe('default');
  });

  it('--settings always carries the caller-provided hooks-file path verbatim, not a hardcoded default', () => {
    const argv = buildRestrictedProviderArgv({
      sessionId: 's', prompt: 'p', settingsFile: '/some/other/path/hooks.json',
    });
    const settingsIdx = argv.indexOf('--settings');
    expect(argv[settingsIdx + 1]).toBe('/some/other/path/hooks.json');
  });
});

describe('DELIVERY_AGENT_PROVIDERS registry', () => {
  it('registers the real provider under the renamed key "claude-restricted" (was "claude-bare")', () => {
    expect(DELIVERY_AGENT_PROVIDERS['claude-bare']).toBeUndefined();
    expect(DELIVERY_AGENT_PROVIDERS['claude-restricted']).toBeDefined();
    expect(DELIVERY_AGENT_PROVIDERS['claude-restricted'].name).toBe('claude-restricted');
  });

  // #3580 — the codex key is no longer a throwing placeholder. Its own argv/thread-mapping contract is covered
  // in `__tests__/codex-delivery-provider.test.mjs`; what belongs HERE is only that the registry, the default
  // and the resolver behave, and that `CODEX_PROVIDER.spawn` honours the same PORT contract as the Claude one.
  it('registers a REAL codex provider (no longer a deliberately-throwing seam)', () => {
    expect(DELIVERY_AGENT_PROVIDERS.codex).toBeDefined();
    expect(DELIVERY_AGENT_PROVIDERS.codex.name).toBe('codex');
    expect(typeof DELIVERY_AGENT_PROVIDERS.codex.spawn).toBe('function');
  });

  it('keeps CLAUDE the default — #3580 adds a choice, it does not change the one already made', () => {
    expect(DEFAULT_DELIVERY_AGENT_PROVIDER_NAME).toBe('claude-restricted');
    expect(DELIVERY_AGENT_PROVIDER_NAMES).toEqual(['claude-restricted', 'codex']);
    expect(resolveDeliveryAgentProvider()).toBe(DELIVERY_AGENT_PROVIDERS['claude-restricted']);
  });

  it('resolves each name, and refuses an unknown one BY NAME rather than returning undefined', () => {
    expect(resolveDeliveryAgentProvider('codex')).toBe(DELIVERY_AGENT_PROVIDERS.codex);
    expect(resolveDeliveryAgentProvider(' claude-restricted ')).toBe(DELIVERY_AGENT_PROVIDERS['claude-restricted']);
    expect(() => resolveDeliveryAgentProvider('gemini')).toThrow(/unknown delivery agent provider "gemini"/);
    expect(() => resolveDeliveryAgentProvider('gemini')).toThrow(/claude-restricted\|codex/);
  });
});

// ================================================================================================
// #3580 — CODEX_PROVIDER.spawn. The port contract is `(request, io?) => void, BLOCKING`; these assert that the
// Codex implementation satisfies the SAME contract `CLAUDE_RESTRICTED_PROVIDER.spawn` does (resolved lane cwd,
// real delivery env vars, the 60-minute delivery budget, failure capture) plus the one thing only it has: the
// `sessionSlug → Codex thread id` mapping that stands in for Claude's caller-minted `--session-id`.
//
// The process boundary is MOCKED here (`spawnAgent`), never a real `codex`. The behaviour it is mocked to have
// — blocking, returning a stdout carrying a `thread.started` event, the same id re-announced on resume — was
// measured live against codex-cli 0.153.4 first; see `__tests__/codex-delivery-provider.test.mjs`'s header.
// ================================================================================================
describe('CODEX_PROVIDER.spawn (#3580 — the real second provider)', () => {
  const LANE_PATH = '/tmp/lane-9';
  const THREAD_EVENT = '{"type":"thread.started","thread_id":"01a0-live-thread"}\n{"type":"turn.completed"}\n';

  /** The injectable `io` every test below starts from — no real fs, no real process, no real lane.
   *  #3383 mechanical-dispatcher follow-up — `spawnAgent` now resolves `{stdout, resourceUsage}` (was a bare
   *  stdout string), matching the real async `spawnToCompletion`-based primitive this provider now awaits. */
  const io = (over = {}) => ({
    spawnAgent: vi.fn(() => ({ stdout: THREAD_EVENT, resourceUsage: null })),
    resolveLane: vi.fn(() => LANE_PATH),
    run: vi.fn(),
    persistFailure: vi.fn(),
    resolveReportsDir: vi.fn(() => '/tmp/reports'),
    readThreadId: vi.fn(() => null),
    writeThreadId: vi.fn(),
    denyPaths: ['/tmp/primary/**'],
    // #3383 mechanical-dispatcher Bug 2 fix — real `recordCodexRunScorecard` touches disk (the tracked
    // `run-scorecards.json`); every test here injects a fake so none of them mutate it as a side effect.
    recordScorecard: vi.fn(),
    ...over,
  });

  const REQ = { sessionId: 'claude-uuid', prompt: 'BUILD IT', lane: 9, sessionSlug: 'sess-9', item: '3580', attemptTag: 'b' };

  it('spawns `codex exec` in the RESOLVED lane clone, not wherever the wrapper process happens to sit', async () => {
    const o = io();
    await DELIVERY_AGENT_PROVIDERS.codex.spawn(REQ, o);
    expect(o.resolveLane).toHaveBeenCalledWith(9, { run: o.run });
    const [argv, opts] = o.spawnAgent.mock.calls[0];
    expect(argv.slice(0, 3)).toEqual(['exec', '-C', LANE_PATH]);
    expect(opts.cwd).toBe(LANE_PATH);
  });

  // #3627 bugs 7/9 are provider-INDEPENDENT (they are about where the child is and where its report lands),
  // so the second provider must not silently re-introduce either of them.
  it('stamps the SAME real delivery env vars the Claude provider does, including the reports-dir override', async () => {
    const o = io();
    await DELIVERY_AGENT_PROVIDERS.codex.spawn(REQ, o);
    expect(o.spawnAgent.mock.calls[0][1].env).toMatchObject({
      WE_DISPATCH_KIND: 'delivery',
      DELIVERY_SESSION: 'sess-9',
      DELIVERY_ITEM: '3580',
      LANE: LANE_PATH,
      ATTEMPT_TAG: 'b',
      OPERATION_DELIVERY_REPORTS_DIR: '/tmp/reports',
    });
  });

  // #3383 mechanical-dispatcher fix — the actual #3476 regression test for the Codex provider: this MUST
  // resolve the reports dir WITH the resolved lane path, never bare (see the Claude describe block's own
  // regression test, above, for the full root-cause account — this is the same bug, in the second provider).
  it('resolves the reports dir WITH the resolved lane path — never bare', async () => {
    const o = io();
    await DELIVERY_AGENT_PROVIDERS.codex.spawn(REQ, o);
    expect(o.resolveReportsDir).toHaveBeenCalledWith(LANE_PATH);
  });

  it('blocks on the DELIVERY budget, never dispatch-lane-io\'s 60s fire-and-forget one (#3627 bug 6)', async () => {
    const o = io();
    await DELIVERY_AGENT_PROVIDERS.codex.spawn(REQ, o);
    expect(o.spawnAgent.mock.calls[0][1].timeout).toBe(DELIVERY_AGENT_SPAWN_TIMEOUT_MS);
    expect(DELIVERY_AGENT_SPAWN_TIMEOUT_MS).not.toBe(SPAWN_TIMEOUT_MS);
  });

  // #3383 mechanical-dispatcher Bug 2 fix — THE regression test: a real build dispatch must score + record
  // its own run, stamped `dispatchKind: 'build'`.
  it('scores + records this run via recordScorecard, stamped as the build kind/role', async () => {
    const o = io();
    await DELIVERY_AGENT_PROVIDERS.codex.spawn(REQ, o);
    expect(o.recordScorecard).toHaveBeenCalledWith(expect.objectContaining({
      stdout: THREAD_EVENT, dispatchKind: 'build', role: 'delivery', provider: 'codex', item: '3580', handle: 'sess-9',
    }));
  });

  it('records the thread id Codex minted, keyed by sessionSlug, on a FRESH spawn', async () => {
    const o = io();
    await DELIVERY_AGENT_PROVIDERS.codex.spawn(REQ, o);
    expect(o.writeThreadId).toHaveBeenCalledWith('sess-9', '01a0-live-thread');
  });

  it('resumes on the RECORDED Codex thread id — never on the Claude UUID the port hands it', async () => {
    const o = io({ readThreadId: vi.fn(() => 'recorded-tid') });
    await DELIVERY_AGENT_PROVIDERS.codex.spawn({ ...REQ, resumeSessionId: 'claude-uuid' }, o);
    expect(o.readThreadId).toHaveBeenCalledWith('sess-9');
    const argv = o.spawnAgent.mock.calls[0][0];
    expect(argv.slice(0, 3)).toEqual(['exec', 'resume', 'recorded-tid']);
    expect(argv).not.toContain('claude-uuid');
    // A resume re-announces the same id, so re-recording it would be noise.
    expect(o.writeThreadId).not.toHaveBeenCalled();
  });

  // A silent downgrade to a fresh session would lose exactly the build context the gate-failure resume exists
  // to carry — the agent would be handed "your gate failed" with no memory of what it built.
  it('REFUSES to resume when no thread id was recorded, instead of silently starting a new session', async () => {
    const o = io({ readThreadId: vi.fn(() => null) });
    await expect(DELIVERY_AGENT_PROVIDERS.codex.spawn({ ...REQ, resumeSessionId: 'claude-uuid' }, o))
      .rejects.toThrow(/cannot resume session sess-9/);
    expect(o.spawnAgent).not.toHaveBeenCalled();
  });

  it('captures the child\'s output on a spawn failure and rethrows untouched (same as the Claude provider)', async () => {
    const boom = new Error('spawnSync codex ETIMEDOUT');
    const o = io({ spawnAgent: vi.fn(() => { throw boom; }) });
    await expect(DELIVERY_AGENT_PROVIDERS.codex.spawn(REQ, o)).rejects.toThrow(boom);
    expect(o.persistFailure).toHaveBeenCalledWith('sess-9', boom, { resumeSessionId: null });
  });

  it('refuses a deny map that would cover the agent\'s own lane, before any spawn happens', async () => {
    const o = io({ denyPaths: ['/tmp/**'] }); // LANE_PATH is /tmp/lane-9 — covered.
    await expect(DELIVERY_AGENT_PROVIDERS.codex.spawn(REQ, o)).rejects.toThrow(/covers the agent's own lane/);
    expect(o.spawnAgent).not.toHaveBeenCalled();
  });

  it('tolerates a stream with no thread.started rather than failing a build that already succeeded', async () => {
    const o = io({ spawnAgent: vi.fn(() => ({ stdout: '{"type":"turn.completed"}', resourceUsage: null })) });
    await DELIVERY_AGENT_PROVIDERS.codex.spawn(REQ, o); // a throw here fails the test naturally.
    expect(o.writeThreadId).not.toHaveBeenCalled();
  });

  // ==============================================================================================
  // build-path-codex-isolation-locus — the live #3604 fix: a non-`we` locus item's Codex spawn must run
  // with cwd = its OWN implementation lane (`lanePathOverride`, from `acquireImplLane`), never the WE lane
  // `lane`/`resolveLane` would resolve to. Before this fix, `deliverItem` never passed anything for
  // `lanePathOverride`, this provider only ever knew `lane` (a WE-pool number), and Codex reported `blocked`
  // ("IMPL_LANE unset") when dispatched for a plateau-app-scoped card.
  // ==============================================================================================
  describe('CODEX_PROVIDER.spawn lanePathOverride (build-path-codex-isolation-locus fix)', () => {
    const IMPL_LANE_PATH = '/tmp/.lanes/plateau-app/lane-4';

    it('spawns with cwd = the OVERRIDE (the WE lane is still resolved, for $LANE — #4348)', async () => {
      const o = io({ stageDeliveryReportCli: vi.fn() });
      await DELIVERY_AGENT_PROVIDERS.codex.spawn({ ...REQ, lanePathOverride: IMPL_LANE_PATH }, o);
      expect(o.resolveLane).toHaveBeenCalledWith(9, { run: o.run });
      const [argv, opts] = o.spawnAgent.mock.calls[0];
      expect(argv.slice(0, 3)).toEqual(['exec', '-C', IMPL_LANE_PATH]);
      expect(opts.cwd).toBe(IMPL_LANE_PATH);
    });

    it('stamps IMPL_LANE (never present for an ordinary we-locus spawn) alongside LANE = the WE lane', async () => {
      const o = io({ stageDeliveryReportCli: vi.fn() });
      await DELIVERY_AGENT_PROVIDERS.codex.spawn({ ...REQ, lanePathOverride: IMPL_LANE_PATH }, o);
      expect(o.spawnAgent.mock.calls[0][1].env).toMatchObject({
        LANE: LANE_PATH, IMPL_LANE: IMPL_LANE_PATH,
      });
      // the ordinary (no override) spawn from the describe block above never sets IMPL_LANE at all —
      // asserted there via `.toMatchObject` with no `IMPL_LANE` key; re-asserted here for contrast.
      const plain = io();
      await DELIVERY_AGENT_PROVIDERS.codex.spawn(REQ, plain);
      expect(plain.spawnAgent.mock.calls[0][1].env.IMPL_LANE).toBeUndefined();
    });

    it('stages delivery-report-cli.mjs\'s closure into the foreign lane BEFORE spawning — required because a '
      + 'frontierui/plateau-app clone never carried this WE-only CLI to begin with', async () => {
      const stageDeliveryReportCli = vi.fn();
      const o = io({ stageDeliveryReportCli });
      await DELIVERY_AGENT_PROVIDERS.codex.spawn({ ...REQ, lanePathOverride: IMPL_LANE_PATH }, o);
      expect(stageDeliveryReportCli).toHaveBeenCalledWith(IMPL_LANE_PATH);
      expect(stageDeliveryReportCli.mock.invocationCallOrder[0])
        .toBeLessThan(o.spawnAgent.mock.invocationCallOrder[0]);
    });

    it('never stages anything for an ordinary we-locus spawn (no lanePathOverride)', async () => {
      const stageDeliveryReportCli = vi.fn();
      const o = io({ stageDeliveryReportCli });
      await DELIVERY_AGENT_PROVIDERS.codex.spawn(REQ, o);
      expect(stageDeliveryReportCli).not.toHaveBeenCalled();
    });

    it('the deny-map seals off the OVERRIDE lane\'s own primary checkout (plateau-app\'s), not WE\'s', async () => {
      const o = io({ stageDeliveryReportCli: vi.fn(), denyPaths: null });
      await DELIVERY_AGENT_PROVIDERS.codex.spawn({
        ...REQ,
        lanePathOverride: `${process.env.HOME}/workspace/.lanes/plateau-app/lane-4`,
      }, o);
      const argv = o.spawnAgent.mock.calls[0][0];
      const permissionsArg = argv.find((a) => typeof a === 'string' && a.startsWith('permissions='));
      expect(permissionsArg).toContain(`${process.env.HOME}/workspace/plateau-app`);
      expect(permissionsArg).not.toContain(`${process.env.HOME}/workspace/webeverything`);
    });
  });
});

// ================================================================================================
// #3627 bug 6 (live #3371 attempt, confirmed 2026-09-09) — `CLAUDE_RESTRICTED_PROVIDER.spawn` passed only
// `env` to `defaultSpawnAgent`, so it silently inherited `dispatch-lane-io.mjs`'s `SPAWN_TIMEOUT_MS` (60s) —
// correct for that file's OTHER, fire-and-forget caller (`defaultClaudeProvider`'s `claude --bg`), but fatal
// here: this spawn is a BLOCKING call for the delivery agent's entire build+gate+converge turn (this file's
// own "BLOCKS — the only 'wait'" comment). Two real attempts died at ~60-64s (`ETIMEDOUT`/SIGKILL) before any
// build work could finish. This suite asserts the fix at the one place a mock generically covering the spawn
// call (as every other test in this file does via a stubbed `provider.spawn`) would silently miss it: the
// actual options object `CLAUDE_RESTRICTED_PROVIDER.spawn` hands to its underlying spawn call — exercised via
// the `spawn`/`ensureSettingsFile` `io` seam this fix added (mirrors this file's existing `{ run: runFn = run }`
// injection pattern, e.g. `runGateWithOneRetry`), so the real code path runs with no real filesystem write and
// no real `claude` process.
// ================================================================================================
describe('CLAUDE_RESTRICTED_PROVIDER.spawn timeout (#3627 bug 6)', () => {
  // #3627 bug 7 — `spawn` now also resolves the real lane path (via the injectable `resolveLane` seam) before
  // it can build `cwd`/`env`, so every fake `io` in this describe block needs a `resolveLane` stub too (never
  // the real `resolveLanePath`, which would shell a real `lane-pool.mjs status --json` this suite's sandboxed
  // environment cannot run).
  const fakeIo = () => ({
    ensureSettingsFile: vi.fn(() => '/fake/.operations/delivery-agent-hooks-settings.json'),
    spawnAgent: vi.fn(),
    resolveLane: vi.fn(() => '/fake/pool/lane-3'),
  });

  it('passes an explicit `timeout` to the underlying spawn call, distinct from and far larger than '
    + 'SPAWN_TIMEOUT_MS (the 60s budget correct only for defaultClaudeProvider\'s fire-and-forget '
    + '`claude --bg` caller)', async () => {
    const io = fakeIo();
    await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
      { sessionId: '55555555-5555-4555-8555-555555555555', prompt: 'build item #3371', lane: 3, sessionSlug: 'conveyor-3371', item: '3371', attemptTag: '' },
      io,
    );

    expect(io.spawnAgent).toHaveBeenCalledTimes(1);
    const [, opts] = io.spawnAgent.mock.calls[0];
    expect(opts.timeout).toBeDefined();
    expect(opts.timeout).not.toBe(SPAWN_TIMEOUT_MS);
    expect(opts.timeout).toBeGreaterThan(SPAWN_TIMEOUT_MS);
    expect(opts.timeout).toBe(DELIVERY_AGENT_SPAWN_TIMEOUT_MS);
  });

  it('DELIVERY_AGENT_SPAWN_TIMEOUT_MS itself is a generous-but-bounded budget (at least 30 real minutes, '
    + 'never Infinity/unlimited — a genuinely wedged agent must still be reclaimed)', () => {
    expect(DELIVERY_AGENT_SPAWN_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(Number.isFinite(DELIVERY_AGENT_SPAWN_TIMEOUT_MS)).toBe(true);
  });

  it('still forwards the WE_DISPATCH_KIND=delivery env stamp alongside the timeout override (#3627 hardening, '
    + 'unaffected by the timeout fix)', async () => {
    const io = fakeIo();
    await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
      { sessionId: '66666666-6666-4666-8666-666666666666', prompt: 'build item #3371', lane: 3, sessionSlug: 'conveyor-3371', item: '3371', attemptTag: '' },
      io,
    );
    const [, opts] = io.spawnAgent.mock.calls[0];
    expect(opts.env.WE_DISPATCH_KIND).toBe('delivery');
  });

  it('the un-overridden `io` defaults name the REAL `ensureDeliveryHooksSettingsFile`/`spawnAgentToCompletion`/'
    + '`resolveLanePath`/`run` — a source-level check (rather than a real fs/process call, which this suite\'s '
    + 'environment cannot make reliably against this file\'s `import.meta.url`-derived REPO_ROOT) that every '
    + 'injected seam is opt-in for tests only, never a second code path production takes', () => {
    const spawnSource = DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn.toString();
    expect(spawnSource).toContain('ensureSettingsFile = ensureDeliveryHooksSettingsFile');
    // The test transform rewrites imported references to a namespaced `__vite_ssr_import_N__.<name>` —
    // assert on the stable suffix, not the whole identifier.
    expect(spawnSource).toMatch(/spawnAgent = [\w.]*\bspawnAgentToCompletion\b/);
    expect(spawnSource).toMatch(/resolveLane = [\w.]*\bresolveLanePath\b/);
    expect(spawnSource).toMatch(/run: runFn = [\w.]*\brun\b/);
  });
});

// ================================================================================================
// #3627 bug 7 (live #3371 attempt, confirmed 2026-09-09) — `CLAUDE_RESTRICTED_PROVIDER.spawn` (and
// `runConvergeEdit`'s own `claude` spawn) never passed a `cwd`, so the spawned agent inherited whatever
// directory the WRAPPER's own node process happened to run from — never the lane clone — and `--restricted`
// confines its file tools to the process's own working directories, so the agent was sandboxed into the wrong
// repo entirely. Separately, the brief's `$LANE`/`$DELIVERY_SESSION`/`$DELIVERY_ITEM` env vars
// (`skills-src/conveyor/delivery-agent-brief-v2.md` uses them directly, e.g. `--session=$DELIVERY_SESSION`)
// were only ever appended as literal TEXT at the end of the prompt, never set as real process env. This suite
// asserts both fixes at the one place a stubbed `provider.spawn` (every OTHER describe block in this file)
// would silently miss them: the real options object handed to the underlying spawn call.
// ================================================================================================
describe('CLAUDE_RESTRICTED_PROVIDER.spawn real cwd + env (#3627 bug 7)', () => {
  const fakeIo = (overrides = {}) => ({
    ensureSettingsFile: vi.fn(() => '/fake/.operations/delivery-agent-hooks-settings.json'),
    spawnAgent: vi.fn(),
    resolveLane: vi.fn(() => '/real/pool/lane-3'),
    ...overrides,
  });

  it('resolves the real lane path via the injected `resolveLane` (mirrors `resolveLanePath`\'s own `run` '
    + 'seam) and passes it as `cwd` to the underlying spawn call — never the wrapper\'s own REPO_ROOT', async () => {
    const io = fakeIo();
    await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
      { sessionId: '77777777-7777-4777-8777-777777777777', prompt: 'build item #3371', lane: 3, sessionSlug: 'conveyor-3371', item: '3371', attemptTag: '' },
      io,
    );
    expect(io.resolveLane).toHaveBeenCalledWith(3, expect.objectContaining({ run: expect.any(Function) }));
    const [, opts] = io.spawnAgent.mock.calls[0];
    expect(opts.cwd).toBe('/real/pool/lane-3');
  });

  it('the spawn\'s `env` carries all four real DELIVERY_SESSION/DELIVERY_ITEM/LANE/ATTEMPT_TAG values — real '
    + 'process env vars, never only the old text-appended `[env: ...]` prompt footer', async () => {
    const io = fakeIo();
    await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
      { sessionId: '88888888-8888-4888-8888-888888888888', prompt: 'build item #3371', lane: 3, sessionSlug: 'conveyor-3371', item: '3371', attemptTag: 'b' },
      io,
    );
    const [, opts] = io.spawnAgent.mock.calls[0];
    expect(opts.env.DELIVERY_SESSION).toBe('conveyor-3371');
    expect(opts.env.DELIVERY_ITEM).toBe('3371');
    expect(opts.env.LANE).toBe('/real/pool/lane-3'); // the RESOLVED path, never the bare lane number
    expect(opts.env.ATTEMPT_TAG).toBe('b');
  });

  it('ATTEMPT_TAG falls back to the empty string, matching the old footer\'s `attemptTag ?? \'\'` behavior', async () => {
    const io = fakeIo();
    await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
      { sessionId: '99999999-9999-4999-8999-999999999999', prompt: 'p', lane: 3, sessionSlug: 's', item: '1' },
      io,
    );
    const [, opts] = io.spawnAgent.mock.calls[0];
    expect(opts.env.ATTEMPT_TAG).toBe('');
  });

  // #3627 bug 9 (live #3371 attempt 4, confirmed 2026-09-09) — `resolveDeliveryReportsDir` is resolved ONCE,
  // in THIS spawn (the wrapper's own process), via the injectable `resolveReportsDir` seam (mirrors
  // `resolveLane`'s own convention), and handed to the spawned agent as `OPERATION_DELIVERY_REPORTS_DIR` — the
  // env override `delivery-report-store.mjs#resolveDeliveryReportsDir` checks FIRST. Without this, the wrapper
  // read reports back from ITS OWN script-location default while the agent (running in a SEPARATE lane clone,
  // its own physical copy of the script) wrote to a DIFFERENT script-location default — the exact false
  // negative ("exited with no done report") that rejected a real, successfully-completed #3371 attempt 4.
  it('resolves the reports dir via the injected `resolveReportsDir` and passes it as '
    + 'OPERATION_DELIVERY_REPORTS_DIR to the underlying spawn call', async () => {
    const io = fakeIo({ resolveReportsDir: vi.fn(() => '/real/repo/.operations/delivery-reports') });
    await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
      { sessionId: '55555555-5555-4555-8555-555555555555', prompt: 'p', lane: 3, sessionSlug: 'conveyor-3371', item: '3371', attemptTag: '' },
      io,
    );
    expect(io.resolveReportsDir).toHaveBeenCalledTimes(1);
    const [, opts] = io.spawnAgent.mock.calls[0];
    expect(opts.env.OPERATION_DELIVERY_REPORTS_DIR).toBe('/real/repo/.operations/delivery-reports');
  });

  // #3383 mechanical-dispatcher fix — THE regression test for the actual #3476 finding: `resolveReportsDir`
  // must be called WITH the resolved lane path, never with no argument at all. Calling it bare silently falls
  // back to the SCRIPT-LOCATION default, which always names the primary checkout regardless of which lane
  // this delivery is for — invisible under Claude's soft, hook-based `--restricted` sandbox (a Bash-shelled
  // write is not gated by `guard-lane.mjs`/`guard-bash.mjs` at all), but a hard `EPERM` under Codex's real
  // OS-level lane jail.
  it('calls `resolveReportsDir` WITH the resolved lane path — never bare — so the reports dir this resolves '
    + 'to is the AGENT\'s own lane, not wherever the wrapper process happens to be running from', async () => {
    const io = fakeIo({ resolveReportsDir: vi.fn(() => '/real/pool/lane-3/.operations/delivery-reports') });
    await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
      { sessionId: '55555555-5555-4555-8555-555555555555', prompt: 'p', lane: 3, sessionSlug: 'conveyor-3371', item: '3371', attemptTag: '' },
      io,
    );
    expect(io.resolveReportsDir).toHaveBeenCalledWith('/real/pool/lane-3'); // io.resolveLane's own fixed return
  });

  it('a resume (resumeAgentWithGateFailure\'s own call shape) gets the SAME OPERATION_DELIVERY_REPORTS_DIR '
    + 'treatment — both call sites go through this one spawn, so both need the agent\'s report to land where '
    + 'the wrapper reads it', async () => {
    const io = fakeIo({ resolveReportsDir: vi.fn(() => '/real/repo/.operations/delivery-reports') });
    await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
      {
        sessionId: '66666666-6666-4666-8666-666666666666', resumeSessionId: '66666666-6666-4666-8666-666666666666',
        prompt: 'fix the gate failure', lane: 3, sessionSlug: 'conveyor-3371', item: '3371', attemptTag: '',
      },
      io,
    );
    const [, opts] = io.spawnAgent.mock.calls[0];
    expect(opts.env.OPERATION_DELIVERY_REPORTS_DIR).toBe('/real/repo/.operations/delivery-reports');
  });

  it('captures the spawned child\'s stdout/stderr and persists them via the injected `persistFailure` seam '
    + 'when the underlying spawn throws — the observability fix, so a future failure does not require hunting '
    + 'down the agent\'s own transcript by UUID', async () => {
    const failure = Object.assign(new Error('spawnSync claude ETIMEDOUT'), {
      stdout: 'partial agent output before the timeout\n',
      stderr: 'some stderr line\n',
      status: null,
      signal: 'SIGKILL',
    });
    const io = fakeIo({ spawnAgent: vi.fn(() => { throw failure; }) });
    const persistFailure = vi.fn();

    await expect(DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
      { sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', prompt: 'p', lane: 3, sessionSlug: 'conveyor-3371', item: '3371', attemptTag: '' },
      { ...io, persistFailure },
    )).rejects.toThrow('spawnSync claude ETIMEDOUT');

    expect(persistFailure).toHaveBeenCalledTimes(1);
    const [sessionSlugArg, errorArg, optsArg] = persistFailure.mock.calls[0];
    expect(sessionSlugArg).toBe('conveyor-3371');
    expect(errorArg).toBe(failure);
    expect(errorArg.stdout).toContain('partial agent output');
    expect(errorArg.stderr).toContain('some stderr line');
    expect(optsArg.resumeSessionId).toBe(null);
  });

  it('still throws the original error after capturing it — the capture is observability, never a swallow', async () => {
    const io = fakeIo({ spawnAgent: vi.fn(() => { throw new Error('boom'); }) });
    await expect(DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
      { sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', prompt: 'p', lane: 3, sessionSlug: 's', item: '1', attemptTag: '' },
      { ...io, persistFailure: vi.fn() },
    )).rejects.toThrow('boom');
  });

  it('a resume\'s captured failure is tagged with the resumeSessionId (so it never clobbers the fresh spawn\'s '
    + 'own capture, which uses the same sessionSlug)', async () => {
    const io = fakeIo({ spawnAgent: vi.fn(() => { throw new Error('resume boom'); }) });
    const persistFailure = vi.fn();
    await expect(DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
      {
        sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', resumeSessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        prompt: 'fix the gate failure', lane: 3, sessionSlug: 'conveyor-3371', item: '3371', attemptTag: '',
      },
      { ...io, persistFailure },
    )).rejects.toThrow('resume boom');
    const [, , optsArg] = persistFailure.mock.calls[0];
    expect(optsArg.resumeSessionId).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  });

  // build-path-codex-isolation-locus — the SAME fix as `CODEX_PROVIDER.spawn lanePathOverride`, above, for
  // the OTHER provider: Claude's `--restricted` mode ALSO confines its file tools to its own spawn cwd (this
  // file's own `CLAUDE_RESTRICTED_PROVIDER.spawn` docblock, bug 7(a): "confines the file tools to the working
  // directories"), so a non-`we` locus item needs the identical cwd redirect here too.
  describe('CLAUDE_RESTRICTED_PROVIDER.spawn lanePathOverride (build-path-codex-isolation-locus fix)', () => {
    const IMPL_LANE_PATH = '/tmp/.lanes/frontierui/lane-2';

    it('cwd is the override, LANE is the (still-resolved) WE lane, IMPL_LANE the override — #4348', async () => {
      const io = fakeIo({ stageDeliveryReportCli: vi.fn() });
      await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
        {
          sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', prompt: 'p', lane: 3, sessionSlug: 'conveyor-2385',
          item: '2385', attemptTag: '', lanePathOverride: IMPL_LANE_PATH,
        },
        io,
      );
      expect(io.resolveLane).toHaveBeenCalled();
      const [, opts] = io.spawnAgent.mock.calls[0];
      expect(opts.cwd).toBe(IMPL_LANE_PATH);
      expect(opts.env.LANE).toBe(io.resolveLane.mock.results[0].value);
      expect(opts.env.LANE).not.toBe(IMPL_LANE_PATH);
      expect(opts.env.IMPL_LANE).toBe(IMPL_LANE_PATH);
    });

    it('stages delivery-report-cli.mjs\'s closure into the foreign lane before spawning', async () => {
      const stageDeliveryReportCli = vi.fn();
      const io = fakeIo({ stageDeliveryReportCli });
      await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
        {
          sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', prompt: 'p', lane: 3, sessionSlug: 's', item: '1',
          attemptTag: '', lanePathOverride: IMPL_LANE_PATH,
        },
        io,
      );
      expect(stageDeliveryReportCli).toHaveBeenCalledWith(IMPL_LANE_PATH);
    });

    it('never stages anything, and never sets IMPL_LANE, for an ordinary we-locus spawn', async () => {
      const stageDeliveryReportCli = vi.fn();
      const io = fakeIo({ stageDeliveryReportCli });
      await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(
        { sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', prompt: 'p', lane: 3, sessionSlug: 's', item: '1', attemptTag: '' },
        io,
      );
      expect(stageDeliveryReportCli).not.toHaveBeenCalled();
      expect(io.spawnAgent.mock.calls[0][1].env.IMPL_LANE).toBeUndefined();
    });
  });
});

// ================================================================================================
// #4348 (live 2026-09-28, #3604/#2720) — a cross-locus build agent was handed ONLY the impl lane: `LANE` was set to
// the spawn cwd (the impl-lane override), so `LANE === IMPL_LANE`, the WE lane holding `backlog/<spec>.md` was
// neither named nor granted, and every plateau-app/frontierui build ended `not-ready (…spec missing…)`. Both
// providers must hand the child `LANE` = WE lane, `IMPL_LANE` = impl lane, cwd = impl lane, AND a sandbox/dir
// grant that reaches the WE lane — and a we-locus spawn must stay byte-identical.
// ================================================================================================
describe('cross-locus delivery reaches BOTH lanes (#4348)', () => {
  const HOME = process.env.HOME;
  // A lane number no real pool uses: the default deny map covers the checkout this suite RUNS from, so a real
  // lane path (e.g. lane-7) here makes these tests fail whenever the suite runs inside that very lane.
  const L7 = `${HOME}/workspace/.lanes/web-everything/lane-4348`;
  const P2 = `${HOME}/workspace/.lanes/plateau-app/lane-2`;
  const REQ = {
    sessionId: '43484348-4348-4348-8348-434843484348', prompt: 'BUILD #2720', lane: 7, sessionSlug: 'conveyor-2720',
    item: '2720', attemptTag: '',
  };
  const codexIo = (over = {}) => ({
    spawnAgent: vi.fn(() => ({ stdout: '{"type":"thread.started","thread_id":"tid-4348"}\n', resourceUsage: null })),
    resolveLane: vi.fn(() => L7),
    run: vi.fn(),
    persistFailure: vi.fn(),
    resolveReportsDir: vi.fn((lanePath) => `${lanePath}/.operations/delivery-reports`),
    readThreadId: vi.fn(() => 'tid-4348'),
    writeThreadId: vi.fn(),
    recordCpu: vi.fn(),
    recordScorecard: vi.fn(),
    stageDeliveryReportCli: vi.fn(),
    ...over,
  });
  const claudeIo = (over = {}) => ({
    ensureSettingsFile: vi.fn(() => '/fake/.operations/delivery-agent-hooks-settings.json'),
    spawnAgent: vi.fn(),
    resolveLane: vi.fn(() => L7),
    run: vi.fn(),
    persistFailure: vi.fn(),
    resolveReportsDir: vi.fn((lanePath) => `${lanePath}/.operations/delivery-reports`),
    recordCpu: vi.fn(),
    stageDeliveryReportCli: vi.fn(),
    ...over,
  });
  const permissionsOf = (argv) => argv.find((a) => typeof a === 'string' && a.startsWith('permissions='));

  it('CODEX_PROVIDER: LANE=WE lane, IMPL_LANE=impl lane, cwd=impl lane, and the WE lane is a writable root', async () => {
    const o = codexIo();
    await DELIVERY_AGENT_PROVIDERS.codex.spawn({ ...REQ, lanePathOverride: P2 }, o);
    const [argv, opts] = o.spawnAgent.mock.calls[0];
    expect(opts.cwd).toBe(P2);
    expect(argv.slice(0, 3)).toEqual(['exec', '-C', P2]);
    expect(opts.env).toMatchObject({ LANE: L7, IMPL_LANE: P2 });
    expect(permissionsOf(argv)).toContain(`"${L7}"="write"`);
    // the gate/report side stays on the impl lane — no behaviour change there.
    expect(opts.env.OPERATION_DELIVERY_REPORTS_DIR).toBe(`${P2}/.operations/delivery-reports`);
  });

  it('CODEX_PROVIDER: the deny map seals BOTH repos\' primary checkouts, and covers neither lane', async () => {
    const o = codexIo();
    await DELIVERY_AGENT_PROVIDERS.codex.spawn({ ...REQ, lanePathOverride: P2 }, o);
    const perms = permissionsOf(o.spawnAgent.mock.calls[0][0]);
    expect(perms).toContain(`"${HOME}/workspace/plateau-app/**"="deny"`);
    // WE's primary is whatever repo-profile resolves for the web-everything pool (REPO_ROOT-derived).
    const weRoot = repoProfile('we').checkoutPath.replace(/\/+$/, '');
    expect(perms).toContain(`"${weRoot}/**"="deny"`);
  });

  it('CODEX_PROVIDER: refuses (before spawning) a deny map that would cover the WE lane', async () => {
    const o = codexIo({ denyPaths: [`${HOME}/workspace/.lanes/web-everything/**`] });
    await expect(DELIVERY_AGENT_PROVIDERS.codex.spawn({ ...REQ, lanePathOverride: P2 }, o))
      .rejects.toThrow(/covers the agent's own lane/);
    expect(o.spawnAgent).not.toHaveBeenCalled();
  });

  it('CODEX_PROVIDER: the gate-failure RESUME keeps the WE-lane grant (`exec resume` takes no --add-dir)', async () => {
    const o = codexIo();
    await DELIVERY_AGENT_PROVIDERS.codex.spawn({ ...REQ, lanePathOverride: P2, resumeSessionId: REQ.sessionId }, o);
    const [argv, opts] = o.spawnAgent.mock.calls[0];
    expect(argv.slice(0, 3)).toEqual(['exec', 'resume', 'tid-4348']);
    expect(permissionsOf(argv)).toContain(`"${L7}"="write"`);
    expect(opts.env).toMatchObject({ LANE: L7, IMPL_LANE: P2 });
  });

  it('CODEX_PROVIDER: the ONLY writable grant added for the heavy queue is the admission lock folder (operator ruling 2026-10-07)', async () => {
    for (const request of [{ ...REQ }, { ...REQ, lanePathOverride: P2 }, { ...REQ, lanePathOverride: P2, resumeSessionId: REQ.sessionId }]) {
      const o = codexIo();
      await DELIVERY_AGENT_PROVIDERS.codex.spawn(request, o);
      const argv = o.spawnAgent.mock.calls[0][0];
      const perms = permissionsOf(argv);
      const writes = [...perms.matchAll(/"([^"]+)"="write"/g)].map((m) => m[1]);
      const lock = writes.filter((w) => w.endsWith('/.lanes/.admission/heavy'));
      expect(lock).toHaveLength(1);
      // nothing broader: no HOME, no workspace root, no .lanes root, no wildcard; the only other write grant is the WE lane.
      for (const w of writes) {
        expect([lock[0], ...(request.lanePathOverride ? [L7] : [])]).toContain(w);
      }
      expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(argv.join(' ')).not.toMatch(/danger-full-access/);
    }
  });

  it('CLAUDE_RESTRICTED_PROVIDER: LANE=WE lane, IMPL_LANE=impl lane, cwd=impl lane, and --add-dir <WE lane>', async () => {
    const o = claudeIo();
    await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn({ ...REQ, lanePathOverride: P2 }, o);
    const [argv, opts] = o.spawnAgent.mock.calls[0];
    expect(opts.cwd).toBe(P2);
    expect(opts.env).toMatchObject({ LANE: L7, IMPL_LANE: P2 });
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe(L7);
    expect(opts.env.OPERATION_DELIVERY_REPORTS_DIR).toBe(`${P2}/.operations/delivery-reports`);
  });

  it('CLAUDE_RESTRICTED_PROVIDER: the resume keeps the --add-dir grant', async () => {
    const o = claudeIo();
    await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn({ ...REQ, lanePathOverride: P2, resumeSessionId: REQ.sessionId }, o);
    const argv = o.spawnAgent.mock.calls[0][0];
    expect(argv).toContain('--resume');
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe(L7);
  });

  it('a we-locus spawn is unchanged: LANE = WE lane, no IMPL_LANE, no --add-dir, no write grant', async () => {
    const c = claudeIo();
    await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(REQ, c);
    const [cArgv, cOpts] = c.spawnAgent.mock.calls[0];
    expect(cOpts.cwd).toBe(L7);
    expect(cOpts.env.LANE).toBe(L7);
    expect(Object.hasOwn(cOpts.env, 'IMPL_LANE')).toBe(false);
    expect(cArgv).toEqual(buildRestrictedProviderArgv({
      sessionId: REQ.sessionId, prompt: REQ.prompt, settingsFile: '/fake/.operations/delivery-agent-hooks-settings.json',
    }));

    const x = codexIo();
    await DELIVERY_AGENT_PROVIDERS.codex.spawn(REQ, x);
    const [xArgv, xOpts] = x.spawnAgent.mock.calls[0];
    expect(xOpts.cwd).toBe(L7);
    expect(xOpts.env.LANE).toBe(L7);
    expect(Object.hasOwn(xOpts.env, 'IMPL_LANE')).toBe(false);
    // the heavy-admission lock folder is the one write grant a we-locus spawn carries (operator ruling 2026-10-07).
    expect([...permissionsOf(xArgv).matchAll(/"([^"]+)"="write"/g)].map((m) => m[1]))
      .toEqual([expect.stringMatching(/\/\.lanes\/\.admission\/heavy$/)]);
    expect(permissionsOf(xArgv)).not.toContain(`${HOME}/workspace/plateau-app`);
  });
});

// `persistDeliverySpawnFailure`'s actual real-fs behavior (what it writes, and that it never throws) is
// exercised end-to-end above via the injectable `persistFailure` seam (`CLAUDE_RESTRICTED_PROVIDER.spawn real
// cwd + env` describe block) — the SAME "assert the seam is invoked correctly, never the real REPO_ROOT-backed
// fs write" convention this suite already established for `ensureSettingsFile`/`spawnAgent`/`resolveLane`
// (their own real defaults are checked at the SOURCE level just below, not by actually calling them: this
// file's `import.meta.url`-derived `REPO_ROOT` does not resolve reliably inside vitest's SSR transform — see
// the pre-existing "un-overridden `io` defaults" test's own comment for why). This block asserts the same
// thing for `persistDeliverySpawnFailure`'s un-overridden default and for the removed stale-file guard.
describe('persistDeliverySpawnFailure / ensureDeliveryHooksSettingsFile un-overridden defaults (#3627 bug 7/8, '
  + 'source-level — see the comment above for why this suite checks these at the source level)', () => {
  it('CLAUDE_RESTRICTED_PROVIDER.spawn\'s un-overridden `persistFailure` default names the REAL '
    + '`persistDeliverySpawnFailure`, not a second, untested code path', () => {
    const spawnSource = DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn.toString();
    expect(spawnSource).toMatch(/persistFailure = [\w.]*\bpersistDeliverySpawnFailure\b/);
  });

  it('ensureDeliveryHooksSettingsFile no longer guards the write behind `if (!existsSync(path))` — the bug 8 '
    + 'correctness fix: a stale pre-fix file (no permissions.allow) must never survive a later call', () => {
    const source = ensureDeliveryHooksSettingsFile.toString();
    expect(source).not.toContain('existsSync');
    expect(source).toContain('writeFileSync');
    expect(source).toContain('mkdirSync');
  });

  it('CLAUDE_RESTRICTED_PROVIDER.spawn\'s un-overridden `resolveReportsDir` default names the REAL '
    + '`resolveDeliveryReportsDir` import (#3627 bug 9) — the same seam that must resolve, in the wrapper\'s '
    + 'own process, to the SAME directory `runAgentToCompletion`\'s `tryReadDeliveryReport` call reads from', () => {
    const spawnSource = DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn.toString();
    expect(spawnSource).toMatch(/resolveReportsDir = [\w.]*\bresolveDeliveryReportsDir\b/);
  });
});

// ================================================================================================
// Gap 1 — fillMinimalBrief was a PLACEHOLDER that left `{{ITEM_SPEC_PATH_BASENAME}}`'s literal token-name
// text in the agent's prompt. It now reuses `dispatch-lane.mjs#fillBrief` for real substitution, resolving the
// item's actual backlog filename through the SAME `findItem` every other launch kind uses.
// ================================================================================================
describe('fillMinimalBrief / resolveItemSpecPathBasename (#3627 gap 1)', () => {
  const fakeLoadItems = () => [
    { num: '1234', slug: 'do-the-thing', scope: ['we:scripts/lib/foo.mjs'] },
  ];

  it('resolveItemSpecPathBasename resolves the REAL backlog filename basename via findItem, not a guess', () => {
    expect(resolveItemSpecPathBasename('1234', fakeLoadItems)).toBe('1234-do-the-thing.md');
  });

  it('resolveItemSpecPathBasename throws a named error when the item cannot be found — never substitutes a placeholder', () => {
    expect(() => resolveItemSpecPathBasename('9999', fakeLoadItems)).toThrow(/could not resolve a backlog filename for item #9999/);
  });

  it('fillMinimalBrief substitutes the REAL filename into the brief — never the literal placeholder-name string the sketch left behind', () => {
    const template = 'Read your spec at backlog/{{ITEM_SPEC_PATH_BASENAME}}. Build exactly that.';
    const prompt = fillMinimalBrief(
      template,
      { item: '1234', sessionSlug: 'conveyor-1234', lane: 7, attemptTag: '' },
      { loadItems: fakeLoadItems },
    );
    expect(prompt).toContain('backlog/1234-do-the-thing.md');
    expect(prompt).not.toContain('{{ITEM_SPEC_PATH_BASENAME}}');
    expect(prompt).not.toContain("item's actual backlog filename for #1234");
  });

  it('fillMinimalBrief still appends the env footer after the real fillBrief substitution', () => {
    const prompt = fillMinimalBrief(
      '{{ITEM_SPEC_PATH_BASENAME}}',
      { item: '1234', sessionSlug: 'conveyor-1234', lane: 7, attemptTag: 'b' },
      { loadItems: fakeLoadItems },
    );
    expect(prompt).toMatch(/\[env: DELIVERY_SESSION=conveyor-1234 DELIVERY_ITEM=1234 LANE=7 ATTEMPT_TAG=b\]$/);
  });

  it('fillMinimalBrief refuses (via the real fillBrief) rather than substituting a value with unsafe characters', () => {
    const unsafeLoadItems = () => [{ num: '1234', slug: 'x`echo pwned`y', scope: [] }];
    expect(() => fillMinimalBrief(
      '{{ITEM_SPEC_PATH_BASENAME}}',
      { item: '1234', sessionSlug: 's', lane: 1, attemptTag: '' },
      { loadItems: unsafeLoadItems },
    )).toThrow(/characters the brief cannot carry safely/);
  });
});

// ================================================================================================
// Gap 2 — openPr read `${lane}/.pr-body.md`, a file nothing ever wrote (ENOENT the moment a real run reached
// PR-open). `buildPrBody`/`writePrBody` now generate and write a real, minimal body first.
// ================================================================================================
describe('buildPrBody / writePrBody (#3627 gap 2)', () => {
  it('pulls the one-line summary from the delivery agent\'s own report reason, and names the item', () => {
    const body = buildPrBody({ item: '1234', report: { reason: 'Implements the missing FooBar validator.', filesTouched: [] } });
    expect(body).toContain('#1234');
    expect(body).toContain('Implements the missing FooBar validator.');
  });

  it('falls back to a generic, still-accurate summary when the report carries no reason (allowed on a `done` outcome)', () => {
    const body = buildPrBody({ item: '5678', report: { outcome: 'done', reason: null, filesTouched: [] } });
    expect(body).toContain('#5678');
    expect(body).toMatch(/Delivers item #5678/);
  });

  it('lists filesTouched when the report carries them', () => {
    const body = buildPrBody({ item: '1234', report: { reason: null, filesTouched: ['scripts/lib/foo.mjs', 'scripts/lib/__tests__/foo.test.mjs'] } });
    expect(body).toContain('scripts/lib/foo.mjs');
    expect(body).toContain('scripts/lib/__tests__/foo.test.mjs');
  });

  it('carries a standard footer identifying the mechanical pipeline', () => {
    const body = buildPrBody({ item: '1234', report: { reason: 'x', filesTouched: [] } });
    expect(body).toMatch(/#3627 minimal delivery-agent pipeline/);
  });

  it('writePrBody writes buildPrBody\'s exact content to `${lane}/.pr-body.md` and returns that path', () => {
    const writeFile = vi.fn();
    const report = { reason: 'Implements the thing.', filesTouched: [] };
    const path = writePrBody({ item: '1234', lane: '/lanes/lane-1', report }, { writeFile });
    expect(path).toBe('/lanes/lane-1/.pr-body.md');
    expect(writeFile).toHaveBeenCalledWith('/lanes/lane-1/.pr-body.md', buildPrBody({ item: '1234', report }));
  });
});

// ================================================================================================
// #3903 main adaptation — a non-Claude build's PR carries the #3690 delegation marker, so the review accept
// records its trial evidence row (#3949) exactly like a hand-delegated `pr-land --delegation=` PR does.
// ================================================================================================
describe('delegation marker on a non-Claude build PR (#3903, #3690)', () => {
  it('a Claude build names no delegation, so its PR body carries no marker', () => {
    expect(delegationForBuild(DELIVERY_AGENT_PROVIDERS['claude-restricted'], 'we:src/foo.ts')).toBeNull();
    const body = buildPrBody({ item: '1234', report: { reason: 'x', filesTouched: [] } });
    expect(parseDelegationMarker(body)).toBeNull();
  });

  it('a Codex build names codex + its real model, and derives taskType from the scope (docs-only → doc-fix)', () => {
    const codex = DELIVERY_AGENT_PROVIDERS.codex;
    expect(delegationForBuild(codex, 'we:docs/a.md,we:README.md')).toEqual({ provider: 'codex', model: CODEX_DELIVERY_MODEL, taskType: 'doc-fix' });
    // a non-doc build has no narrower delegation task type than `other`
    expect(delegationForBuild(codex, 'we:scripts/foo.mjs').taskType).toBe('other');
    expect(delegationForBuild(codex, '').taskType).toBe('other');
  });

  it('buildPrBody stamps a parseable marker when handed a delegation', () => {
    const delegation = delegationForBuild(DELIVERY_AGENT_PROVIDERS.codex, 'we:docs/a.md');
    const body = buildPrBody({ item: '1234', report: { reason: 'x', filesTouched: [] }, delegation });
    expect(parseDelegationMarker(body)).toEqual(delegation);
  });

  it('openPr writes the delegation into the body file it hands to open-pr', () => {
    const writeFile = vi.fn();
    const delegation = { provider: 'codex', model: CODEX_DELIVERY_MODEL, taskType: 'other' };
    const path = writePrBody({ item: '1234', lane: '/lanes/lane-1', report: { reason: 'x' }, delegation }, { writeFile });
    expect(parseDelegationMarker(writeFile.mock.calls[0][1])).toEqual(delegation);
    expect(path).toBe('/lanes/lane-1/.pr-body.md');
  });
});

// ================================================================================================
// Gap 3 — runConverge called `converge-cli.mjs step` exactly once and returned it as if that were the whole
// loop. It now calls `init`, then loops `step` — executing whatever action is printed (`read`/`panel`/
// `edit`/`red-team`/`invite`) — until the action is genuinely `land` or `escalate`.
// ================================================================================================
describe('runConverge (#3627 gap 3 — the real loop)', () => {
  let lane;

  beforeEach(() => {
    lane = mkdtempSync(join(tmpdir(), 'deliver-item-wrapper-converge-'));
    // #4356 — the `init` state-file side effect is simulated inside `fakeRun` itself (below), not here: this
    // block runs BEFORE `runConverge` is even called, and `runConverge` now wipes the lane's scratch dir at
    // its own start (`resetConvergeScratchDir`) before making its first `init` call — a write here would just
    // be wiped before the loop ever got to check for it.
  });

  afterEach(() => {
    rmSync(lane, { recursive: true, force: true });
    rmSync(convergeScratchDir(lane), { recursive: true, force: true });
  });

  /** A scripted fake `run` — routes on argv shape, never on call order, so it stays correct regardless of how
   *  many times any one action's sub-driver calls it internally. `steps` is consumed in order for `step` calls
   *  only (the ONE sequence genuinely order-dependent: each `step` answers "what happens after the observation
   *  I was just fed"). */
  // `gitStatus` answers `git status --porcelain` for #3627 bug 14's per-round commit
  // (`convergeRoundTouchedFiles`) — defaults to '' (nothing touched), which keeps every pre-existing test in
  // this block byte-identical (an `advanced: true` editor reply with an empty status makes `commitConvergeRound`
  // a no-op, so it records a `git status` call but never a `git commit`). A string answers every call the same
  // way; a function `(callIndex) => string` answers per-call, for a test that needs different rounds to see
  // different porcelain output.
  // `onEditorCall` (#4356) — an optional side effect run right before the editor's canned reply is returned,
  // for a test that needs to simulate something the tool-bearing editor turn itself did to the lane/scratch
  // dir (the live #4055 shape: `runConvergeEdit`'s `claude` spawn deleting the wrapper's own bookkeeping).
  function fakeRun({
    init, read = 'diff --git a/x b/x\n+hi\n', panel, redTeamPanel, editor, steps, gitStatus = '', onEditorCall,
  }) {
    let stepIdx = 0;
    let gitStatusCallIdx = 0;
    const calls = [];
    const fn = vi.fn((cmd, args = [], opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === 'node' && args[0] === 'scripts/converge-cli.mjs' && args[1] === 'init') {
        // #4356 — a real `init` call writes the state file for real; this fake reproduces that ONE side
        // effect (nothing else about `init` is faked) so the loop's own existence check has something real
        // to find on its very first `step` call, the same as it would against the genuine CLI. Written here,
        // never in a `beforeEach`, because `runConverge` now wipes the lane's scratch dir itself (via
        // `resetConvergeScratchDir`) before ever making this call — a `beforeEach` write would just be wiped.
        writeFileSync(join(convergeScratchDir(lane), '.converge-state.json'), '{}');
        return init;
      }
      if (cmd === 'bash') return read;
      if (cmd === 'node' && args[0] === 'skills-src/jury/panel-fanout.mjs') {
        const isRedTeam = args.some((a) => String(a).includes('-redteam'));
        return isRedTeam ? redTeamPanel : panel;
      }
      if (cmd === 'claude') {
        if (onEditorCall) onEditorCall();
        return editor;
      }
      if (cmd === 'git' && args[0] === 'status') {
        return typeof gitStatus === 'function' ? gitStatus(gitStatusCallIdx++) : gitStatus;
      }
      if (cmd === 'git' && args[0] === 'add') return ''; // #3383 — commitConvergeRound now stages before committing
      if (cmd === 'git' && args[0] === 'commit') return '';
      if (cmd === 'node' && args[0] === 'scripts/converge-cli.mjs' && args[1] === 'step') {
        if (stepIdx >= steps.length) throw new Error(`fakeRun: no scripted step left for call #${stepIdx + 1}`);
        return steps[stepIdx++];
      }
      throw new Error(`fakeRun: unexpected run(${cmd}, ${JSON.stringify(args)})`);
    });
    fn.calls = calls;
    return fn;
  }

  it('loops through read → panel → edit → red-team → land, calling `step` MORE THAN ONCE (the actual gap)', () => {
    const init = JSON.stringify({
      action: 'read', round: 1, careLevel: 'elevated', jurorsPerLens: 1, roundCap: 5,
      lenses: ['correctness'], seatableLenses: ['correctness'], mandatoryLenses: ['correctness'],
      read: { command: 'git diff', cwd: lane },
    });
    const panelStep = JSON.stringify({
      action: 'panel', round: 1, roundCap: 5,
      panel: [{ lens: 'correctness', jurors: 1, mandatory: true, mandate: 'judge it' }],
    });
    const editStep = JSON.stringify({
      action: 'edit', round: 1, roundCap: 5, edit: { prompt: 'fix the findings' },
    });
    const redTeamStep = JSON.stringify({
      action: 'red-team', round: 2, roundCap: 5,
      redTeam: { jury: [{ lens: 'correctness', prompt: 'try to break it' }] },
    });
    const landStep = JSON.stringify({ action: 'land', round: 2, roundCap: 5, verdict: 'land', dismissed: [] });

    const run = fakeRun({
      init,
      panel: JSON.stringify({ seats: [{ lens: 'correctness', ok: true, findings: [] }] }),
      redTeamPanel: JSON.stringify({ seats: [{ lens: 'correctness', ok: true, findings: [] }] }),
      editor: JSON.stringify({ result: JSON.stringify({ advanced: true, dismissed: [] }) }),
      steps: [panelStep, editStep, redTeamStep, landStep],
    });

    const result = runConverge(
      { lane, item: '1234', goal: 'ship the thing' },
      { run, ensureSettingsFile: () => '/fake/hooks-settings.json' },
    );

    expect(result.action).toBe('land');
    expect(result.verdict).toBe('land');

    const stepCalls = run.calls.filter((c) => c.cmd === 'node' && c.args[1] === 'step');
    expect(stepCalls.length).toBe(4); // proves the loop, not a single call mistaken for the whole thing
    const initCalls = run.calls.filter((c) => c.cmd === 'node' && c.args[1] === 'init');
    expect(initCalls.length).toBe(1);
    expect(run.calls.some((c) => c.cmd === 'claude')).toBe(true); // the editor round actually ran
    expect(run.calls.filter((c) => c.cmd === 'node' && c.args[0] === 'skills-src/jury/panel-fanout.mjs').length).toBe(2); // panel + red-team
  });

  it('stops on `escalate` without ever needing an edit/panel round', () => {
    const init = JSON.stringify({
      action: 'read', round: 1, careLevel: 'elevated', jurorsPerLens: 1, roundCap: 5,
      lenses: ['correctness'], seatableLenses: ['correctness'], mandatoryLenses: ['correctness'],
      read: { command: 'git diff', cwd: lane },
    });
    const escalateStep = JSON.stringify({
      action: 'escalate', round: 1, roundCap: 5, verdict: null,
      reason: 'mandatory-lens-absent', dismissed: [],
    });
    const run = fakeRun({ init, steps: [escalateStep] });

    const result = runConverge({ lane, item: '1234' }, { run, ensureSettingsFile: () => '/fake/hooks.json' });

    expect(result.action).toBe('escalate');
    expect(result.reason).toBe('mandatory-lens-absent');
  });

  it('throws a named error if converge-cli reports an action this loop does not recognize (fails loud, not silently)', () => {
    const init = JSON.stringify({
      action: 'read', round: 1, careLevel: 'elevated', jurorsPerLens: 1, roundCap: 5,
      lenses: [], seatableLenses: [], mandatoryLenses: [],
      read: { command: 'git diff', cwd: lane },
    });
    const weirdStep = JSON.stringify({ action: 'teleport', round: 1, roundCap: 5 });
    const run = fakeRun({ init, steps: [weirdStep] });

    expect(() => runConverge({ lane, item: '1234' }, { run, ensureSettingsFile: () => '/fake/hooks.json' }))
      .toThrow(/action this loop does not know how to run.*teleport/s);
  });

  // ==============================================================================================
  // #3627 bug 14 — an editor round's genuinely ACCEPTED edits (`advanced: true`) were never committed, so
  // `openPr`'s `--sha=HEAD` shipped the PR without them (confirmed live on attempt 6/PR #2109: the backlog-card
  // nuance section and the `.gitignore` line the editor added were both real, accepted, and both missing from
  // the PR). Fixed by committing explicit, real touched paths right after an `advanced: true` edit round,
  // before the loop's next `step` call.
  // ==============================================================================================
  it('commits an accepted round\'s real touched files via explicit paths (`git commit -F <msgfile> -- <paths>`, '
    + 'never `git add -A`) BEFORE the next `step` call reads the lane (#3627 bug 14)', () => {
    const init = JSON.stringify({ action: 'edit', round: 1, roundCap: 5, edit: { prompt: 'fix the findings' } });
    const landStep = JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
    // A real edit (`src/foo.mjs`) alongside this SAME wrapper's own per-round bookkeeping/litter — none of the
    // latter should ever reach the commit.
    const porcelain = ' M src/foo.mjs\n?? .converge-obs-1-0.json\n?? .pr-body.md\n';
    const run = fakeRun({
      init, editor: JSON.stringify({ result: JSON.stringify({ advanced: true, dismissed: [] }) }),
      steps: [landStep], gitStatus: porcelain,
    });

    runConverge({ lane, item: '1234' }, { run, ensureSettingsFile: () => '/fake/hooks.json' });

    const commitCallIdx = run.calls.findIndex((c) => c.cmd === 'git' && c.args[0] === 'commit');
    const addCallIdx = run.calls.findIndex((c) => c.cmd === 'git' && c.args[0] === 'add');
    const stepCallIdx = run.calls.findIndex((c) => c.cmd === 'node' && c.args[1] === 'step');
    expect(commitCallIdx).toBeGreaterThan(-1);
    expect(addCallIdx).toBeGreaterThan(-1);
    expect(stepCallIdx).toBeGreaterThan(-1);
    expect(addCallIdx).toBeLessThan(commitCallIdx);
    expect(commitCallIdx).toBeLessThan(stepCallIdx); // committed before the NEXT step call reads the lane

    const addCall = run.calls[addCallIdx];
    const commitCall = run.calls[commitCallIdx];
    expect(addCall.args.slice(2)).toEqual(commitCall.args.slice(4)); // add's paths equal commit's paths
    // #4356 — the message file now lives in the per-lane scratch dir OUTSIDE the lane, never `${lane}/...`.
    expect(commitCall.args).toEqual(['commit', '-F', `${convergeScratchDir(lane)}/.converge-commit-msg-r1.txt`, '--', 'src/foo.mjs']);
    expect(commitCall.args).not.toContain('-A');
    expect(commitCall.args).not.toContain('.converge-obs-1-0.json'); // this wrapper's own bookkeeping, never committed
    expect(commitCall.args).not.toContain('.pr-body.md'); // known lane-release scratch litter, never committed
  });

  // #xu2pp2m fixer — end-to-end threading through the LOOP (not just the unit test on runConvergeEdit above):
  // the fixer's own dispatch calls `runConverge({...}, {..., dispatchKind: 'fix'})`, and that option must reach
  // the editor sub-spawn's env, not just be silently dropped between `runConverge` and `runConvergeEdit`.
  it('threads an explicit `dispatchKind` option from runConverge down through the loop into the editor spawn\'s env', () => {
    const init = JSON.stringify({ action: 'edit', round: 1, roundCap: 5, edit: { prompt: 'fix the findings' } });
    const landStep = JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
    const run = fakeRun({
      init, editor: JSON.stringify({ result: JSON.stringify({ advanced: false, dismissed: [] }) }),
      steps: [landStep],
    });

    runConverge({ lane, item: '2108' }, { run, ensureSettingsFile: () => '/fake/hooks.json', dispatchKind: 'fix' });

    const editorCall = run.calls.find((c) => c.cmd === 'claude');
    expect(editorCall.opts.env.WE_DISPATCH_KIND).toBe('fix');
  });

  // mechanical-dispatcher follow-up to #3580 — a Codex-selected build `provider` was previously never even
  // threaded down to the converge round at all (not "ignored" — genuinely absent from the call). This proves
  // the END-TO-END path from `runConverge`'s own `provider` option into the round's real `.converge-obs-*.json`
  // record, the same artifact an operator already inspects after a run.
  it('threads a `provider` option from runConverge down into the editor round\'s recorded `.converge-obs-*.json`', () => {
    const init = JSON.stringify({ action: 'edit', round: 1, roundCap: 5, edit: { prompt: 'fix the findings' } });
    const landStep = JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
    const run = fakeRun({
      init, editor: JSON.stringify({ result: JSON.stringify({ advanced: false, dismissed: [] }) }),
      steps: [landStep],
    });

    runConverge(
      { lane, item: '1234' },
      { run, ensureSettingsFile: () => '/fake/hooks.json', provider: { name: 'codex' } },
    );

    // #4356 — obs bookkeeping now lives in the per-lane scratch dir OUTSIDE the lane, never inside it.
    const obs = JSON.parse(readFileSync(join(convergeScratchDir(lane), '.converge-obs-1-0.json'), 'utf8'));
    expect(obs.editResult.requestedProvider).toBe('codex');
    expect(obs.editResult.editorProvider).toBe('claude-restricted'); // the editor itself never changes — no Codex implementation exists yet
  });

  it('creates NO commit for a round the editor did NOT advance (`advanced: false`, dismissed-only) — no empty/'
    + 'spurious commit (#3627 bug 14)', () => {
    const init = JSON.stringify({ action: 'edit', round: 1, roundCap: 5, edit: { prompt: 'fix the findings' } });
    const landStep = JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
    const run = fakeRun({
      init,
      editor: JSON.stringify({ result: JSON.stringify({ advanced: false, dismissed: [{ summary: 'x', reason: 'not real' }] }) }),
      steps: [landStep], gitStatus: ' M src/foo.mjs\n', // even with real untracked changes sitting in the lane
    });

    runConverge({ lane, item: '1234' }, { run, ensureSettingsFile: () => '/fake/hooks.json' });

    expect(run.calls.some((c) => c.cmd === 'git' && c.args[0] === 'status')).toBe(false); // never even checked
    expect(run.calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBe(false);
  });

  it('commits MULTIPLE accepted rounds separately — one commit per round, each before that round\'s own `step` '
    + 'call, each referencing its own round number (#3627 bug 14)', () => {
    const init = JSON.stringify({ action: 'edit', round: 1, roundCap: 5, edit: { prompt: 'fix findings' } });
    const editStep2 = JSON.stringify({ action: 'edit', round: 2, roundCap: 5, edit: { prompt: 'fix more findings' } });
    const landStep = JSON.stringify({ action: 'land', round: 2, roundCap: 5, verdict: 'land', dismissed: [] });
    const run = fakeRun({
      init, editor: JSON.stringify({ result: JSON.stringify({ advanced: true, dismissed: [] }) }),
      steps: [editStep2, landStep], gitStatus: ' M src/foo.mjs\n',
    });

    runConverge({ lane, item: '1234' }, { run, ensureSettingsFile: () => '/fake/hooks.json' });

    const indexed = run.calls.map((c, i) => ({ ...c, i }));
    const commitCalls = indexed.filter((c) => c.cmd === 'git' && c.args[0] === 'commit');
    const stepCalls = indexed.filter((c) => c.cmd === 'node' && c.args[1] === 'step');
    expect(commitCalls.length).toBe(2); // one per accepted round, not one for the whole run
    expect(commitCalls[0].args).toContain(`${convergeScratchDir(lane)}/.converge-commit-msg-r1.txt`);
    expect(commitCalls[1].args).toContain(`${convergeScratchDir(lane)}/.converge-commit-msg-r2.txt`);
    // round 1's commit precedes round 1's own `step` call (which is what hands back round 2's edit action —
    // matches `converge-cli.mjs`'s own `read` action re-reading the lane fresh each round: round 2 must see
    // round 1's commit, not just uncommitted working-tree changes it happens to still be sitting on).
    expect(commitCalls[0].i).toBeLessThan(stepCalls[0].i);
    expect(commitCalls[1].i).toBeGreaterThan(stepCalls[0].i);
    expect(commitCalls[1].i).toBeLessThan(stepCalls[1].i);
  });

  // #3848 (carried from #3801 Fork 1) — the returned verdict also says whether the converge EDITOR actually
  // changed the lane's diff, aggregated across every round of the loop, not just the last one before land/escalate.
  it('(c) records `convergeEditedLane: true` when a round actually committed a real edit', () => {
    const init = JSON.stringify({ action: 'edit', round: 1, roundCap: 5, edit: { prompt: 'fix the findings' } });
    const landStep = JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
    const run = fakeRun({
      init, editor: JSON.stringify({ result: JSON.stringify({ advanced: true, dismissed: [] }) }),
      steps: [landStep], gitStatus: ' M src/foo.mjs\n',
    });

    const result = runConverge({ lane, item: '1234' }, { run, ensureSettingsFile: () => '/fake/hooks.json' });

    expect(result.convergeEditedLane).toBe(true);
  });

  it('(c) records `convergeEditedLane: false` when converge changed nothing — no edit round ever ran', () => {
    const init = JSON.stringify({
      action: 'read', round: 1, careLevel: 'elevated', jurorsPerLens: 1, roundCap: 5,
      lenses: ['correctness'], seatableLenses: ['correctness'], mandatoryLenses: ['correctness'],
      read: { command: 'git diff', cwd: lane },
    });
    const escalateStep = JSON.stringify({
      action: 'escalate', round: 1, roundCap: 5, verdict: null, reason: 'mandatory-lens-absent', dismissed: [],
    });
    const run = fakeRun({ init, steps: [escalateStep] });

    const result = runConverge({ lane, item: '1234' }, { run, ensureSettingsFile: () => '/fake/hooks.json' });

    expect(result.convergeEditedLane).toBe(false);
  });

  it('(c) records `convergeEditedLane: false` when an edit round ran but nothing was accepted (`advanced: false`)', () => {
    const init = JSON.stringify({ action: 'edit', round: 1, roundCap: 5, edit: { prompt: 'fix the findings' } });
    const landStep = JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
    const run = fakeRun({
      init,
      editor: JSON.stringify({ result: JSON.stringify({ advanced: false, dismissed: [{ summary: 'x', reason: 'not real' }] }) }),
      steps: [landStep], gitStatus: ' M src/foo.mjs\n',
    });

    const result = runConverge({ lane, item: '1234' }, { run, ensureSettingsFile: () => '/fake/hooks.json' });

    expect(result.convergeEditedLane).toBe(false);
  });

  // ==============================================================================================
  // #4356 — live #4055/lane-4: three `step` calls against `.converge-state.json` succeeded; the fourth (the
  // first `edit` action's own follow-up `step` call) failed with a raw `Command failed: node
  // scripts/converge-cli.mjs step ...` right after `runConvergeEdit` ran a full Bash+Edit+Write turn with
  // `cwd: lane` — the exact directory the state file used to live in, with no hook protecting that one path.
  // This reproduces the shape (read → panel → red-team → edit, state file removed by the editor turn) and
  // asserts the loop now fails CLEARLY and ATTRIBUTED — naming the missing path, the round, and the action
  // that just ran — instead of letting whatever raw error the next `step` call throws bubble up unexplained.
  // ==============================================================================================
  it('#4356 surfaces a clear, attributed failure (naming the missing state file and the round/action it '
    + 'happened after) when the converge state file vanishes mid-loop, instead of an opaque raw crash', () => {
    // #4356 — computed BEFORE `runConverge` runs (it wipes+recreates this same dir at its own start via
    // `resetConvergeScratchDir`); the state file itself gets created moments later by `fakeRun`'s own `init`
    // handler, the real point in the sequence a real `init` call would have created it.
    const statePath = `${convergeScratchDir(lane)}/.converge-state.json`;

    const init = JSON.stringify({
      action: 'read', round: 1, careLevel: 'elevated', jurorsPerLens: 1, roundCap: 5,
      lenses: ['correctness'], seatableLenses: ['correctness'], mandatoryLenses: ['correctness'],
      read: { command: 'git diff', cwd: lane },
    });
    const panelStep = JSON.stringify({
      action: 'panel', round: 1, roundCap: 5,
      panel: [{ lens: 'correctness', jurors: 1, mandatory: true, mandate: 'judge it' }],
    });
    const redTeamStep = JSON.stringify({
      action: 'red-team', round: 1, roundCap: 5,
      redTeam: { jury: [{ lens: 'correctness', prompt: 'try to break it' }] },
    });
    // The `step` call answering the red-team observation hands back the round's `edit` action — the exact
    // point #4055/lane-4's real failure happened at (three prior `step` calls had already succeeded).
    const editStep = JSON.stringify({ action: 'edit', round: 1, roundCap: 5, edit: { prompt: 'fix the findings' } });

    const run = fakeRun({
      init,
      panel: JSON.stringify({ seats: [{ lens: 'correctness', ok: true, findings: [] }] }),
      redTeamPanel: JSON.stringify({ seats: [{ lens: 'correctness', ok: true, findings: [] }] }),
      editor: JSON.stringify({ result: JSON.stringify({ advanced: false, dismissed: [] }) }),
      steps: [panelStep, redTeamStep, editStep],
      // Simulate the tool-bearing editor turn removing the wrapper's own bookkeeping mid-round.
      onEditorCall: () => rmSync(statePath, { force: true }),
    });

    // The clear, attributed message (naming the item, the round, and the action that just ran) is the whole
    // point — it is also, by construction, never the raw `Command failed: node scripts/converge-cli.mjs
    // step ...` shape the un-fixed loop let bubble up unexplained (#4055's real log line).
    expect(() => runConverge(
      { lane, item: '4356', goal: 'ship the thing' },
      { run, ensureSettingsFile: () => '/fake/hooks.json' },
    )).toThrow(/converge state file vanished for item #4356 after round 1 action 'edit'/);
  });

  // #4356 — the structural half of the fix: every one of this loop's own bookkeeping files must resolve
  // OUTSIDE the lane's own working tree. This is NOT a claim that the sibling scratch dir is unreachable —
  // the editor turn keeps its `Bash` tool, which is not confined to `cwd` — only that these files no longer
  // sit in the ONE directory that turn is handed and already operating in every round, so it has no reason to
  // stumble into them by name, by `ls`, or by a lane-wide `git status`/cleanup sweep (converge round-1
  // red-team finding on an earlier draft of this test/docblock, which DID overclaim "no path-based way").
  // Exercises read → panel → red-team → edit (advanced, so `commitConvergeRound` really runs) → land, so
  // every file kind the loop writes (state, obs, material, panel, red-team, commit-message) gets created and
  // checked — not just state/obs, which is all an earlier draft of this test covered.
  it('#4356 keeps every kind of converge bookkeeping file OUTSIDE the lane\'s own working tree', () => {
    const init = JSON.stringify({
      action: 'read', round: 1, careLevel: 'elevated', jurorsPerLens: 1, roundCap: 5,
      lenses: ['correctness'], seatableLenses: ['correctness'], mandatoryLenses: ['correctness'],
      read: { command: 'git diff', cwd: lane },
    });
    const panelStep = JSON.stringify({
      action: 'panel', round: 1, roundCap: 5,
      panel: [{ lens: 'correctness', jurors: 1, mandatory: true, mandate: 'judge it' }],
    });
    const redTeamStep = JSON.stringify({
      action: 'red-team', round: 1, roundCap: 5,
      redTeam: { jury: [{ lens: 'correctness', prompt: 'try to break it' }] },
    });
    const editStep = JSON.stringify({ action: 'edit', round: 1, roundCap: 5, edit: { prompt: 'fix the findings' } });
    const inviteStep = JSON.stringify({
      action: 'invite', round: 1, roundCap: 5, invite: { lens: 'a11y', citedFinding: 'x' },
    });
    const landStep = JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
    const run = fakeRun({
      init,
      panel: JSON.stringify({ seats: [{ lens: 'correctness', ok: true, findings: [] }] }),
      redTeamPanel: JSON.stringify({ seats: [{ lens: 'correctness', ok: true, findings: [] }] }),
      editor: JSON.stringify({ result: JSON.stringify({ advanced: true, dismissed: [] }) }),
      steps: [panelStep, redTeamStep, editStep, inviteStep, landStep],
      gitStatus: ' M src/foo.mjs\n', // a real touched file, so the accepted round actually commits
    });

    runConverge({ lane, item: '1234' }, { run, ensureSettingsFile: () => '/fake/hooks.json' });

    const scratchDir = convergeScratchDir(lane);
    expect(scratchDir.startsWith(lane)).toBe(false); // outside the lane, not a subdirectory of it
    // #4356 converge round-2 red-team finding — the invite file belongs in this list too (claim-accuracy: an
    // earlier draft's "every kind" claim left it untested).
    const bookkeepingFiles = [
      '.converge-state.json', '.converge-obs-1-0.json', '.converge-material-r1.txt',
      '.converge-panel-r1.json', '.converge-redteam-r1.json', '.converge-commit-msg-r1.txt',
      '.converge-invite-r1.json',
    ];
    for (const name of bookkeepingFiles) {
      expect(existsSync(join(scratchDir, name))).toBe(true);
      expect(existsSync(join(lane, name))).toBe(false);
    }
  });

  // #4356 converge round-1 red-team finding, proven here (round 2 flagged that no test defended this claim
  // yet): a lane slot recycled for a later item must not inherit the previous occupant's leftover scratch.
  it('#4356 resetConvergeScratchDir sweeps a stale file left by a previous occupant of the same lane slot', () => {
    const staleDir = convergeScratchDir(lane);
    const staleFile = join(staleDir, '.converge-obs-3-7.json'); // a round/index a NEW run would never reach round 1
    writeFileSync(staleFile, '{"stale": true}');
    expect(existsSync(staleFile)).toBe(true);

    const init = JSON.stringify({ action: 'edit', round: 1, roundCap: 5, edit: { prompt: 'fix the findings' } });
    const landStep = JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
    const run = fakeRun({
      init, editor: JSON.stringify({ result: JSON.stringify({ advanced: false, dismissed: [] }) }),
      steps: [landStep],
    });

    runConverge({ lane, item: '1234' }, { run, ensureSettingsFile: () => '/fake/hooks.json' });

    expect(existsSync(staleFile)).toBe(false); // swept by the reset at the start of this run
    expect(existsSync(join(convergeScratchDir(lane), '.converge-state.json'))).toBe(true); // this run's own state is still there
  });

  // #4356 converge round-2 red-team finding (SECURITY, unrecoverable in the un-fixed shape): an unconditional
  // recursive+force `rmSync` on an unvalidated `lane`-derived path must refuse a shape it cannot prove safe,
  // rather than trust every future caller to hand it an already-resolved one. `resolvePath` (used before
  // `basename`/`dirname` ever see the value) already normalizes away a literal trailing `/..` or `/.` — e.g.
  // `resolvePath('/tmp/x/..')` is `/tmp`, a normal safe basename, never a literal `..` — so those shapes
  // cannot actually reach the guard below intact; what genuinely can is a missing/empty `lane` (which would
  // otherwise silently resolve against `process.cwd()`) or one that resolves to the filesystem root itself.
  it('#4356 refuses to resolve (and never wipes) a scratch dir for a missing, empty, or filesystem-root lane path', () => {
    expect(() => resetConvergeScratchDir(undefined)).toThrow(/unsafe lane path/);
    expect(() => resetConvergeScratchDir('')).toThrow(/unsafe lane path/);
    expect(() => resetConvergeScratchDir('   ')).toThrow(/unsafe lane path/);
    expect(() => resetConvergeScratchDir('/')).toThrow(/unsafe lane path/);
    // A real, ordinary lane path is unaffected by any of the refusals above — proves the guard is narrow,
    // not a blanket refusal that would also reject legitimate lanes.
    expect(() => resetConvergeScratchDir(lane)).not.toThrow();
    expect(existsSync(lane)).toBe(true);
  });
});

describe('convergeRoundTouchedFiles (#3627 bug 14 helper — the real touched-file list for one round\'s commit)', () => {
  it('drops this wrapper\'s own `.converge-*` per-round bookkeeping and known lane-release scratch litter, '
    + 'keeps real edits (both modified-tracked and untracked-new files)', () => {
    const porcelain = [
      ' M src/foo.mjs',
      '?? new-file.mjs',
      '?? .converge-obs-1-0.json',
      '?? .converge-state.json',
      '?? .converge-material-r1.txt',
      '?? .converge-panel-r1.json',
      '?? .converge-redteam-r1.json',
      '?? .converge-invite-r1.json',
      '?? .converge-commit-msg-r1.txt',
      '?? .pr-body.md',
      '?? .commit-msg.txt',
      '',
    ].join('\n');
    const run = vi.fn(() => porcelain);
    const paths = convergeRoundTouchedFiles('/some/lane', { run });
    expect(paths).toEqual(['src/foo.mjs', 'new-file.mjs']);
    expect(run).toHaveBeenCalledWith('git', ['status', '--porcelain'], { cwd: '/some/lane' });
  });

  it('#3383 live #3564 trial finding — also drops commitBuildTurn\'s OWN `.delivery-commit-msg-<phase>.txt` '
    + 'bookkeeping (previously unexcluded, so a SECOND commitBuildTurn call picked up the FIRST call\'s leftover '
    + 'message file as an untracked "touched" path and crashed the gate-fix commit on it)', () => {
    const porcelain = [
      ' M src/foo.mjs',
      '?? .delivery-commit-msg-build.txt',
      '?? .delivery-commit-msg-gate-fix.txt',
      '',
    ].join('\n');
    const run = vi.fn(() => porcelain);
    expect(convergeRoundTouchedFiles('/lane', { run })).toEqual(['src/foo.mjs']);
  });

  it('returns an empty list when the only changes present are this wrapper\'s own bookkeeping', () => {
    const run = vi.fn(() => '?? .converge-obs-1-0.json\n?? .converge-state.json\n');
    expect(convergeRoundTouchedFiles('/lane', { run })).toEqual([]);
  });

  it('returns an empty list for a genuinely clean lane', () => {
    const run = vi.fn(() => '');
    expect(convergeRoundTouchedFiles('/lane', { run })).toEqual([]);
  });
});

describe('coAuthorTrailerFor (#3565 — the trailer a WRAPPER-OWNED commit carries per provider)', () => {
  it('names Codex for the codex provider', () => {
    expect(coAuthorTrailerFor('codex')).toBe('Co-Authored-By: Codex <noreply@openai.com>');
  });

  it('defaults to Claude for the claude-restricted provider and for any unrecognized/absent name', () => {
    expect(coAuthorTrailerFor('claude-restricted')).toBe('Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>');
    expect(coAuthorTrailerFor(undefined)).toBe('Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>');
    expect(coAuthorTrailerFor('some-future-provider')).toBe('Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>');
  });
});

describe('commitBuildTurn (#3565 — the wrapper commits the agent\'s OWN turn; the agent never runs git)', () => {
  it('stages then commits explicit paths via `git add --` + `git commit -F <msgfile> -- <paths>`, never '
    + '`git add -A`, message names the build phase + provider trailer', () => {
    const run = vi.fn(() => '');
    const writeFile = vi.fn();
    const result = commitBuildTurn(
      { lane: '/lane', item: '1234', provider: { name: 'codex' } },
      { run, writeFile, touchedFiles: () => ['a.mjs', 'b.md'] },
    );
    expect(result).toEqual({ committed: true, paths: ['a.mjs', 'b.md'] });
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [msgFile, message] = writeFile.mock.calls[0];
    expect(msgFile).toBe('/lane/.delivery-commit-msg-build.txt');
    expect(message).toMatch(/build — update a.mjs, b.md/);
    expect(message).toMatch(/Co-Authored-By: Codex <noreply@openai\.com>/);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenNthCalledWith(1, 'git', ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/'], { cwd: '/lane' });
    expect(run).toHaveBeenNthCalledWith(2, 'git', ['add', '--', 'a.mjs', 'b.md'], { cwd: '/lane' });
    expect(run).toHaveBeenNthCalledWith(3, 'git', ['commit', '-F', msgFile, '--', 'a.mjs', 'b.md'], { cwd: '/lane' });
    expect(run.mock.calls[1][1]).not.toContain('-A');
    expect(run.mock.calls[1][1]).not.toContain('--all');
  });

  it('#3383 live #3564 trial finding — `git add` before `git commit` means a genuinely NEW (never-tracked) '
    + 'touched file is committed too, not silently refused (`git commit -- <pathspec>` alone rejects an '
    + 'untracked path with "did not match any file(s) known to git" — confirmed directly against real git)', () => {
    const run = vi.fn(() => '');
    const writeFile = vi.fn();
    commitBuildTurn(
      { lane: '/lane', item: '1234' },
      { run, writeFile, touchedFiles: () => ['brand-new-file.mjs'] },
    );
    expect(run).toHaveBeenNthCalledWith(2, 'git', ['add', '--', 'brand-new-file.mjs'], { cwd: '/lane' });
  });

  it.each(['build', 'gate-fix'])('uses origin/main card text in the %s commit', (phase) => {
    const run = vi.fn((_cmd, args) => args[0] === 'ls-tree' ? 'backlog/4333-card.md' : args[0] === 'show' ? '# Guard acceptance rearm\n' : '');
    const writeFile = vi.fn();
    commitBuildTurn({ lane: '/lane', item: '4333', phase }, { run, writeFile, touchedFiles: () => ['fix.mjs'] });
    expect(writeFile.mock.calls[0][1].split('\n')[0]).toBe(`WE #4333: ${phase} — Guard acceptance rearm`);
    expect(run).toHaveBeenCalledWith('git', ['show', 'origin/main:backlog/4333-card.md'], { cwd: '/lane' });
  });

  it('names the gate-fix phase distinctly (own message file, own text) for a resumed turn\'s commit', () => {
    const run = vi.fn(() => '');
    const writeFile = vi.fn();
    const result = commitBuildTurn(
      { lane: '/lane', item: '1234', provider: { name: 'claude-restricted' }, phase: 'gate-fix' },
      { run, writeFile, touchedFiles: () => ['fix.mjs'] },
    );
    expect(result).toEqual({ committed: true, paths: ['fix.mjs'] });
    const [msgFile, message] = writeFile.mock.calls[0];
    expect(msgFile).toBe('/lane/.delivery-commit-msg-gate-fix.txt');
    expect(message).toMatch(/gate-fix — update fix.mjs/);
    expect(message).toMatch(/Co-Authored-By: Claude Sonnet 5 <noreply@anthropic\.com>/);
  });

  it('no-ops — writes no message file and calls `run` zero times — when there are no real touched files', () => {
    const run = vi.fn(() => '');
    const writeFile = vi.fn();
    const result = commitBuildTurn(
      { lane: '/lane', item: '1234' },
      { run, writeFile, touchedFiles: () => [] },
    );
    expect(result).toEqual({ committed: false, paths: [] });
    expect(writeFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('defaults `provider` to Claude when the caller passes none, same as every other CLAUDE_RESTRICTED_PROVIDER default in this file', () => {
    const run = vi.fn(() => '');
    const writeFile = vi.fn();
    commitBuildTurn({ lane: '/lane', item: '1234' }, { run, writeFile, touchedFiles: () => ['a.mjs'] });
    const [, message] = writeFile.mock.calls[0];
    expect(message).toMatch(/Co-Authored-By: Claude Sonnet 5 <noreply@anthropic\.com>/);
  });

  // build-path-codex-isolation-locus — a NON-`we` implementation lane's own commit must carry ITS repo's own
  // canonical prefix, never the hardcoded `WE #`, matching `repo-profile.mjs#briefTokensForRepo`'s
  // `ATTRIBUTION` convention already used elsewhere for fix/ci-heal. Real `repoProfileForLanePath` (not
  // injected) reads the pool-dir basename off the given `lane` path, so a REAL plateau-app-shaped path is
  // needed here (a synthetic `/lane` — every OTHER test in this describe block — correctly falls back to `WE`).
  it('names a plateau-app implementation lane\'s own commit "PLATEAU #<item>", never "WE #<item>"', () => {
    const run = vi.fn(() => '');
    const writeFile = vi.fn();
    const plateauAppLane = `${process.env.HOME}/workspace/.lanes/plateau-app/lane-4`;
    const result = commitBuildTurn(
      { lane: plateauAppLane, item: '3604', provider: { name: 'codex' } },
      { run, writeFile, touchedFiles: () => ['src/foo.tsx'] },
    );
    expect(result).toEqual({ committed: true, paths: ['src/foo.tsx'] });
    const [, message] = writeFile.mock.calls[0];
    expect(message).toMatch(/^PLATEAU #3604: build — update src\/foo/);
    expect(message).not.toMatch(/^WE #/);
  });
});

describe('runGateWithOneRetry commits the build turn itself (#3565 — before the agent-commit redesign this '
  + 'never happened; the wrapper now commits BEFORE the first verify, and again after any resume)', () => {
  it('calls commitTurn with phase "build" before the first verify, using the resolved lane path', async () => {
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'scripts/lane-pool.mjs') {
        return JSON.stringify({ lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/operations/run.mjs') {
        return JSON.stringify({ verdict: { ok: true, cwd: '/real/pool/lane-3', suite: 'run', passed: 1, failed: 0, unrun: 0, checks: [], blocking: [] } });
      }
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    const commitTurn = vi.fn(() => ({ committed: true, paths: ['a.mjs'] }));
    const provider = { name: 'codex', spawn: vi.fn() };
    const result = await runGateWithOneRetry({ lane: 3, item: '3371', sessionSlug: 'conveyor-3371', provider }, { run, commitTurn });
    expect(result.status).toBe('green');
    expect(commitTurn).toHaveBeenCalledTimes(1);
    expect(commitTurn.mock.calls[0][0]).toEqual({ lane: '/real/pool/lane-3', item: '3371', provider, phase: 'build' });
    expect(provider.spawn).not.toHaveBeenCalled(); // green on the first try — no resume, no gate-fix commit
  });

  it('commits AGAIN with phase "gate-fix" after the resume, before the second verify', async () => {
    let verifyCalls = 0;
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'scripts/lane-pool.mjs') {
        return JSON.stringify({ lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/operations/run.mjs') {
        verifyCalls += 1;
        return JSON.stringify({
          verdict: {
            ok: false, cwd: '/real/pool/lane-3', suite: 'run', passed: 1, failed: 1, unrun: 0,
            checks: [{ name: 'test:unit', outcome: 'fail' }],
            blocking: [{ check: 'test:unit', why: 'failed', detail: 'x' }],
          },
        });
      }
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    const commitTurn = vi.fn(() => ({ committed: true, paths: ['a.mjs'] }));
    const provider = { name: 'codex', spawn: vi.fn() };
    const result = await runGateWithOneRetry({ lane: 3, item: '3371', sessionSlug: 'conveyor-3371', provider }, { run, commitTurn });
    expect(result.status).toBe('red');
    expect(verifyCalls).toBe(2);
    expect(commitTurn).toHaveBeenCalledTimes(2);
    expect(commitTurn.mock.calls[0][0].phase).toBe('build');
    expect(commitTurn.mock.calls[1][0].phase).toBe('gate-fix');
  });
});

describe('resumeAgentWithGateFailure prompt (#3565 — never asks the agent to commit any more)', () => {
  it('the genuine-fail prompt never says "commit" and tells the agent the wrapper commits for it', async () => {
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'scripts/lane-pool.mjs') {
        return JSON.stringify({ lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/operations/run.mjs') return JSON.stringify({
        verdict: {
          ok: false, cwd: '/real/pool/lane-3', suite: 'run', passed: 1, failed: 1, unrun: 0,
          checks: [{ name: 'test:unit', outcome: 'fail' }],
          blocking: [{ check: 'test:unit', why: 'failed', detail: '1 error(s)' }],
        },
      });
      if (cmd === 'git') return '';
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    const provider = { spawn: vi.fn() };
    const readReport = vi.fn(() => null);
    await runGateWithOneRetry({ lane: 3, item: '3371', sessionSlug: 'conveyor-3371', provider }, { run, readReport });
    const prompt = provider.spawn.mock.calls[0][0].prompt;
    expect(prompt).toMatch(/Your gate failed/);
    expect(prompt).not.toMatch(/commit again/);
    expect(prompt).toMatch(/do NOT run `git commit` yourself/);
  });
});

describe('prefixOwnPathMentions / sanitizeOwnLocusMentions (#3565 real-trial finding — the delivery agent '
  + 'is never taught the locus-prefix convention, so its own backlog prose trips the pre-commit backstop '
  + 'once the WRAPPER is the one committing)', () => {
  it('prefixes a bare mention of a given ref with `we:`, leaving an already-prefixed one alone', () => {
    const content = 'See `scripts/foo.mjs` and we:scripts/bar.mjs for details.';
    const result = prefixOwnPathMentions(content, ['scripts/foo.mjs', 'scripts/bar.mjs']);
    expect(result).toBe('See `we:scripts/foo.mjs` and we:scripts/bar.mjs for details.');
  });

  it('fixes every occurrence of a repeated bare mention, not just the first', () => {
    const content = 'a.mjs then a.mjs again';
    expect(prefixOwnPathMentions(content, ['a.mjs'])).toBe('we:a.mjs then we:a.mjs again');
  });

  it('is a no-op for a path that never appears in the content', () => {
    const content = 'nothing path-like here';
    expect(prefixOwnPathMentions(content, ['scripts/never-mentioned.mjs'])).toBe(content);
  });

  it('sanitizeOwnLocusMentions rewrites only backlog/reports .md files among the touched paths, and skips '
    + 'non-.md touched files entirely', () => {
    const files = {
      '/lane/backlog/3565-x.md': 'Fixed `scripts/foo.mjs` in this change.',
    };
    const readFile = vi.fn((abs) => {
      if (!(abs in files)) throw new Error(`ENOENT: ${abs}`);
      return files[abs];
    });
    const writeFile = vi.fn((abs, content) => { files[abs] = content; });
    sanitizeOwnLocusMentions(
      '/lane',
      ['backlog/3565-x.md', 'scripts/foo.mjs'],
      { readFile, writeFile },
    );
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(files['/lane/backlog/3565-x.md']).toBe(
      'Fixed `we:scripts/foo.mjs` in this change.',
    );
  });

  it('#3383 SECOND live #3565 trial finding — also prefixes a bare mention of a file the delivery never '
    + 'touched (the touched-paths list has no idea it needs fixing; the real gate detector does)', () => {
    const files = {
      // Mirrors the real trial verbatim: the agent's own `## Progress` note cited `queue-store.mjs` for
      // context — never part of the diff (`scripts/operations/file-item-io.mjs` is the only touched file
      // here) — and the pre-commit `lint:locus` hook rejected the wrapper's commit for exactly this token.
      '/lane/backlog/3565-x.md': 'Reused queue-store.mjs\'s exported queueHas for the alreadyQueued check.',
    };
    const readFile = vi.fn((abs) => files[abs]);
    const writeFile = vi.fn((abs, content) => { files[abs] = content; });
    sanitizeOwnLocusMentions(
      '/lane',
      ['backlog/3565-x.md', 'scripts/operations/file-item-io.mjs'],
      { readFile, writeFile },
    );
    expect(files['/lane/backlog/3565-x.md']).toBe(
      'Reused we:queue-store.mjs\'s exported queueHas for the alreadyQueued check.',
    );
  });

  it('also prefixes a file\'s bare mention of its OWN filename (the real gate flags that too — verified '
    + 'directly against scanRepoLocusPrefixes, not assumed)', () => {
    const files = {
      '/lane/backlog/3565-x.md': 'Fixed `scripts/foo.mjs` per backlog/3565-x.md itself.',
    };
    const readFile = vi.fn((abs) => files[abs]);
    const writeFile = vi.fn((abs, content) => { files[abs] = content; });
    sanitizeOwnLocusMentions(
      '/lane',
      ['backlog/3565-x.md', 'scripts/foo.mjs'],
      { readFile, writeFile },
    );
    expect(files['/lane/backlog/3565-x.md']).toBe(
      'Fixed `we:scripts/foo.mjs` per we:backlog/3565-x.md itself.',
    );
  });

  it('sanitizeOwnLocusMentions never throws and never writes when the file has nothing to fix or cannot be read', () => {
    const readFile = vi.fn(() => { throw new Error('ENOENT'); });
    const writeFile = vi.fn();
    expect(() => sanitizeOwnLocusMentions('/lane', ['backlog/999-missing.md'], { readFile, writeFile })).not.toThrow();
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('commitBuildTurn auto-fixes locus-prefix mentions before committing (#3565 real-trial finding)', () => {
  it('rewrites a touched backlog .md file\'s bare self-mentions before writing the commit message / running git commit', () => {
    const files = {
      '/lane/backlog/1234-x.md': 'Touched `scripts/foo.mjs` in this change.',
    };
    const readFile = vi.fn((abs) => files[abs]);
    const writeFile = vi.fn((abs, content) => { files[abs] = content; });
    const run = vi.fn(() => '');
    commitBuildTurn(
      { lane: '/lane', item: '1234' },
      {
        run, writeFile, readFile,
        touchedFiles: () => ['backlog/1234-x.md', 'scripts/foo.mjs'],
      },
    );
    expect(files['/lane/backlog/1234-x.md']).toBe('Touched `we:scripts/foo.mjs` in this change.');
    expect(run).toHaveBeenCalledWith(
      'git', ['commit', '-F', '/lane/.delivery-commit-msg-build.txt', '--', 'backlog/1234-x.md', 'scripts/foo.mjs'],
      { cwd: '/lane' },
    );
  });
});

describe('commitConvergeRound (#3627 bug 14 helper — the actual per-round commit)', () => {
  // #4356 — a real (if fake-content) lane path, not the bare `/lane` this block used to use: `convergeScratchDir`
  // now resolves a REAL sibling directory (`dirname(lane)/.converge-scratch/<basename>`) and creates it, so the
  // fake lane needs a `dirname` that genuinely exists and is writable (`/` on its own is neither, on a normal
  // machine) — the same reason every OTHER real-lane test in this file uses `tmpdir()`-rooted paths. The
  // basename carries `process.pid` (converge round-2 red-team finding), not a bare `'lane'` literal, so two
  // vitest worker processes running this file's tests concurrently never resolve to the same scratch dir.
  const FAKE_LANE = join(tmpdir(), `lane-${process.pid}`);

  // #4356 converge round-1 red-team finding — `convergeScratchDir` really creates a directory on disk even
  // for this block's fake lane path; every other real-lane describe block in this file cleans up what it
  // creates, so this one does too, instead of leaving `tmpdir()/.converge-scratch/lane` behind for good.
  afterAll(() => {
    rmSync(convergeScratchDir(FAKE_LANE), { recursive: true, force: true });
  });

  it('stages then commits explicit paths via `git add --` + `git commit -F <msgfile> -- <paths>`, never '
    + '`git add -A`, message names the round', () => {
    const run = vi.fn(() => '');
    const writeFile = vi.fn();
    const result = commitConvergeRound(
      { lane: FAKE_LANE, item: '1234', round: 2 },
      { run, writeFile, touchedFiles: () => ['a.mjs', 'b.md'] },
    );
    expect(result).toEqual({ committed: true, paths: ['a.mjs', 'b.md'] });
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [msgFile, message] = writeFile.mock.calls[0];
    // #4356 — the message file lives in the per-lane scratch dir OUTSIDE the lane, never `${FAKE_LANE}/...` directly.
    expect(msgFile).toBe(`${convergeScratchDir(FAKE_LANE)}/.converge-commit-msg-r2.txt`);
    expect(message).toMatch(/round 2/);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenNthCalledWith(2, 'git', ['add', '--', 'a.mjs', 'b.md'], { cwd: FAKE_LANE });
    expect(run).toHaveBeenNthCalledWith(3, 'git', ['commit', '-F', msgFile, '--', 'a.mjs', 'b.md'], { cwd: FAKE_LANE });
    expect(run.mock.calls[0][1]).not.toContain('-A');
    expect(run.mock.calls[0][1]).not.toContain('--all');
    expect(run.mock.calls[1][1]).not.toContain('-A');
    expect(run.mock.calls[1][1]).not.toContain('--all');
  });

  it('#3383 live #3564 trial finding — stages a genuinely NEW (never-tracked) touched file too, not just '
    + 'modified-tracked ones (`git commit -- <pathspec>` alone rejects an untracked path outright — confirmed '
    + 'directly against real git)', () => {
    const run = vi.fn(() => '');
    const writeFile = vi.fn();
    commitConvergeRound(
      { lane: FAKE_LANE, item: '1234', round: 1 },
      { run, writeFile, touchedFiles: () => ['brand-new-fixture.mjs'] },
    );
    expect(run).toHaveBeenNthCalledWith(2, 'git', ['add', '--', 'brand-new-fixture.mjs'], { cwd: FAKE_LANE });
  });

  it('no-ops — writes no message file and calls `run` zero times — when there are no real touched files', () => {
    const run = vi.fn(() => '');
    const writeFile = vi.fn();
    const result = commitConvergeRound(
      { lane: FAKE_LANE, item: '1234', round: 1 },
      { run, writeFile, touchedFiles: () => [] },
    );
    expect(result).toEqual({ committed: false, paths: [] });
    expect(writeFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('parseConvergeEditResult (#3627 gap 3 helper)', () => {
  it('parses the two JSON layers of a real --output-format json editor reply', () => {
    const raw = JSON.stringify({ result: JSON.stringify({ advanced: true, dismissed: [{ summary: 'x', reason: 'not real' }] }) });
    expect(parseConvergeEditResult(raw)).toEqual({ advanced: true, dismissed: [{ summary: 'x', reason: 'not real' }] });
  });

  it('degrades to {advanced:false, dismissed:[]} on unparseable output — fail-closed, matches an editor-stall escalation, never throws', () => {
    expect(parseConvergeEditResult('not json at all')).toEqual({ advanced: false, dismissed: [] });
  });
});

describe('buildConvergeEditorArgv (#3627 gap 3 helper)', () => {
  it('is a FRESH restricted spawn (never --resume) carrying --output-format json for a parseable reply', () => {
    const argv = buildConvergeEditorArgv({ sessionId: 'item-converge-editor-r1', prompt: 'fix it', settingsFile: '/f.json' });
    expect(argv).toContain('--restricted');
    expect(argv).not.toContain('--safe-mode');
    expect(argv).not.toContain('--resume');
    expect(argv).toEqual(expect.arrayContaining(['--output-format', 'json']));
    expect(argv.filter((arg) => arg === '--model')).toHaveLength(1);
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(argv[argv.length - 1]).toBe('fix it');
  });
});

// ================================================================================================
// Bug 5 — a live #3371 attempt failed with `Error: Invalid session ID. Must be a valid UUID.` because the
// Claude CLI's own `--session-id`/`--resume` flag was fed the human-readable dispatch id (`sessionSlug`, e.g.
// `conveyor-3371`) instead of a real UUID. Fixed by minting a UUID once per delivery attempt and threading it
// through as `claudeSessionId`, kept entirely separate from `sessionSlug` (which keeps its existing job
// everywhere else — claim/release, the delivery-report lookup, the brief's own env footer, lane-pool's
// `--session=`).
// ================================================================================================
describe('runAgentToCompletion (#3627 bug 5 — real UUID session id, never sessionSlug)', () => {
  const fakeLoadItems = () => [{ num: '1234', slug: 'do-the-thing', scope: [] }];
  // #3383 mechanical-dispatcher fix — `runAgentToCompletion` now resolves the lane path itself (to read the
  // report back from the SAME lane-scoped directory the provider wrote to — see that function's own
  // docblock), so every case here needs a fake `resolveLane` too, never the real `resolveLanePath` (which
  // would shell a real `lane-pool.mjs status --json` this suite's sandboxed environment cannot run).
  const fakeResolveLane = () => '/fake/pool/lane-7';

  it('passes claudeSessionId — a real UUID — as `sessionId` to provider.spawn, never sessionSlug', async () => {
    const claudeSessionId = '11111111-1111-4111-8111-111111111111';
    const provider = { spawn: vi.fn() };
    const readReport = vi.fn(() => ({ status: 'done', outcome: 'done', filesTouched: ['a.mjs'] }));

    await runAgentToCompletion(
      { item: '1234', sessionSlug: 'conveyor-1234', lane: 7, attemptTag: '', provider, claudeSessionId },
      {
        readBrief: () => 'Read backlog/{{ITEM_SPEC_PATH_BASENAME}}.', readReport, loadItems: fakeLoadItems,
        resolveLane: fakeResolveLane,
      },
    );

    expect(provider.spawn).toHaveBeenCalledTimes(1);
    const call = provider.spawn.mock.calls[0][0];
    expect(call.sessionId).toBe(claudeSessionId);
    expect(call.sessionId).toMatch(UUID_RE);
    expect(call.sessionId).not.toBe('conveyor-1234');
  });

  it('still looks up the delivery report by sessionSlug, not by claudeSessionId — the report sidecar is keyed '
    + 'by the human-readable dispatch id', async () => {
    const readReport = vi.fn(() => ({ status: 'done', outcome: 'done', filesTouched: [] }));
    await runAgentToCompletion(
      { item: '1234', sessionSlug: 'conveyor-1234', lane: 7, attemptTag: '', provider: { spawn: vi.fn() }, claudeSessionId: 'ignored-in-this-assertion' },
      { readBrief: () => 'x', readReport, loadItems: fakeLoadItems, resolveLane: fakeResolveLane },
    );
    // #3383 — now called with the lane-scoped reports dir too (see the function's own docblock); the FIRST
    // argument (the sidecar key) is still the assertion this test is actually about.
    expect(readReport).toHaveBeenCalledWith('conveyor-1234', expect.any(String));
  });

  it('the brief env footer still carries sessionSlug (DELIVERY_SESSION), never claudeSessionId', async () => {
    const provider = { spawn: vi.fn() };
    await runAgentToCompletion(
      { item: '1234', sessionSlug: 'conveyor-1234', lane: 7, attemptTag: '', provider, claudeSessionId: '22222222-2222-4222-8222-222222222222' },
      {
        readBrief: () => '{{ITEM_SPEC_PATH_BASENAME}}', readReport: () => ({ status: 'done', outcome: 'done', filesTouched: [] }),
        loadItems: fakeLoadItems, resolveLane: fakeResolveLane,
      },
    );
    const { prompt } = provider.spawn.mock.calls[0][0];
    expect(prompt).toMatch(/\[env: DELIVERY_SESSION=conveyor-1234 /);
    expect(prompt).not.toContain('22222222-2222-4222-8222-222222222222');
  });

  it('throws when no done report comes back, unchanged from before this fix', async () => {
    await expect(runAgentToCompletion(
      { item: '1234', sessionSlug: 'conveyor-1234', lane: 7, attemptTag: '', provider: { spawn: vi.fn() }, claudeSessionId: 'x' },
      { readBrief: () => 'x', readReport: () => null, loadItems: fakeLoadItems, resolveLane: fakeResolveLane },
    )).rejects.toThrow(/exited with no done report/);
  });

  // #3383 mechanical-dispatcher fix — THE regression test for the actual bug this session fixed: the
  // read-back must resolve through the SAME lane-aware path the provider itself used, never the un-lane-aware
  // default (which always names the primary checkout, regardless of `lane`).
  it('reads the report back from the LANE-SCOPED reports dir (resolveReportsDir(lanePath)), never the '
    + 'un-lane-aware default that ignores which lane the agent actually ran in', async () => {
    const readReport = vi.fn(() => ({ status: 'done', outcome: 'done', filesTouched: [] }));
    const resolveReportsDir = vi.fn((lanePath) => `${lanePath}/.operations/delivery-reports`);
    await runAgentToCompletion(
      { item: '1234', sessionSlug: 'conveyor-1234', lane: 7, attemptTag: '', provider: { spawn: vi.fn() }, claudeSessionId: 'x' },
      {
        readBrief: () => 'x', readReport, loadItems: fakeLoadItems, resolveLane: fakeResolveLane, resolveReportsDir,
      },
    );
    expect(resolveReportsDir).toHaveBeenCalledWith('/fake/pool/lane-7');
    expect(readReport).toHaveBeenCalledWith('conveyor-1234', '/fake/pool/lane-7/.operations/delivery-reports');
  });
});

// build-orphan-adopt (#4131/#4382 fix) — `resume: true` skips the agent turn entirely when the PRIOR attempt's
// own `done` report is still there AND the lane still holds the commit it describes; it never spawns
// `provider.spawn`, which is the whole point (a resume must never re-run the agent — see this file's own
// docblock on `runAgentToCompletion`).
describe('runAgentToCompletion — resume branch (build-orphan-adopt, #4131/#4382 fix)', () => {
  const fakeResolveLane = () => '/fake/pool/lane-9';

  it('returns the existing report and never calls provider.spawn when the lane still has the commit', async () => {
    const provider = { spawn: vi.fn() };
    const doneReport = { status: 'done', outcome: 'done', filesTouched: ['a.mjs'] };
    const readReport = vi.fn(() => doneReport);
    const isLaneCommitAhead = vi.fn(() => true);

    const report = await runAgentToCompletion(
      { item: '4131', sessionSlug: 'conveyor-4131', lane: 9, attemptTag: '', claudeSessionId: 'x', provider, resume: true },
      { readReport, resolveLane: fakeResolveLane, isLaneCommitAhead },
    );

    expect(report).toBe(doneReport);
    expect(provider.spawn).not.toHaveBeenCalled();
    expect(readReport).toHaveBeenCalledWith('conveyor-4131', expect.any(String));
    expect(isLaneCommitAhead).toHaveBeenCalledWith({ lane: '/fake/pool/lane-9', run: expect.any(Function) });
  });

  it('throws (never falls back to a fresh spawn) when the report says done but the lane has no commit ahead '
    + '— the lane was reset/reused since the report was written', async () => {
    const provider = { spawn: vi.fn() };
    const readReport = vi.fn(() => ({ status: 'done', outcome: 'done', filesTouched: ['a.mjs'] }));
    await expect(runAgentToCompletion(
      { item: '4131', sessionSlug: 'conveyor-4131', lane: 9, attemptTag: '', claudeSessionId: 'x', provider, resume: true },
      { readReport, resolveLane: fakeResolveLane, isLaneCommitAhead: () => false },
    )).rejects.toThrow(/nothing to resume from/);
    expect(provider.spawn).not.toHaveBeenCalled();
  });

  it('throws when there is no report at all to resume from', async () => {
    const provider = { spawn: vi.fn() };
    await expect(runAgentToCompletion(
      { item: '4131', sessionSlug: 'conveyor-4131', lane: 9, attemptTag: '', claudeSessionId: 'x', provider, resume: true },
      { readReport: () => null, resolveLane: fakeResolveLane, isLaneCommitAhead: () => true },
    )).rejects.toThrow(/nothing to resume from/);
    expect(provider.spawn).not.toHaveBeenCalled();
  });

  it('a non-`done` report (e.g. `blocked`) is not resumable either', async () => {
    const provider = { spawn: vi.fn() };
    await expect(runAgentToCompletion(
      { item: '4131', sessionSlug: 'conveyor-4131', lane: 9, attemptTag: '', claudeSessionId: 'x', provider, resume: true },
      { readReport: () => ({ status: 'blocked' }), resolveLane: fakeResolveLane, isLaneCommitAhead: () => true },
    )).rejects.toThrow(/nothing to resume from/);
    expect(provider.spawn).not.toHaveBeenCalled();
  });

  it('resume defaults to false — every existing (pre-#4131 fix) call is unaffected', async () => {
    const provider = { spawn: vi.fn() };
    const readReport = vi.fn(() => ({ status: 'done', outcome: 'done', filesTouched: [] }));
    await runAgentToCompletion(
      { item: '1234', sessionSlug: 'conveyor-1234', lane: 7, attemptTag: '', provider, claudeSessionId: 'x' },
      { readBrief: () => 'x', readReport, loadItems: () => [{ num: '1234', slug: 'do-the-thing', scope: [] }], resolveLane: fakeResolveLane },
    );
    expect(provider.spawn).toHaveBeenCalledTimes(1); // the ordinary fresh-spawn path, unchanged.
  });
});

describe('runConvergeEdit (#3627 bug 5 — real UUID session id, not the old readable per-round string)', () => {
  it('spawns with a real-UUID --session-id, never the old `${item}-converge-editor-r${round}` literal', () => {
    const run = vi.fn(() => JSON.stringify({ result: JSON.stringify({ advanced: true, dismissed: [] }) }));
    runConvergeEdit(
      { prompt: 'fix it' },
      { item: '1234', round: 1, run, ensureSettingsFile: () => '/fake/hooks.json' },
    );
    expect(run).toHaveBeenCalledTimes(1);
    const [cmd, argv] = run.mock.calls[0];
    expect(cmd).toBe('claude');
    const idIdx = argv.indexOf('--session-id');
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(argv[idIdx + 1]).toMatch(UUID_RE);
    expect(argv[idIdx + 1]).not.toBe('1234-converge-editor-r1');
  });

  it('mints a fresh UUID per call (each converge round is its own, never-resumed session)', () => {
    const run = vi.fn(() => JSON.stringify({ result: JSON.stringify({ advanced: false, dismissed: [] }) }));
    const deps = { item: '1234', round: 1, run, ensureSettingsFile: () => '/fake/hooks.json' };
    runConvergeEdit({ prompt: 'a' }, deps);
    runConvergeEdit({ prompt: 'b' }, deps);
    const id1 = run.mock.calls[0][1][run.mock.calls[0][1].indexOf('--session-id') + 1];
    const id2 = run.mock.calls[1][1][run.mock.calls[1][1].indexOf('--session-id') + 1];
    expect(id1).not.toBe(id2);
  });

  it('accepts an injected newSessionId for a deterministic assertion', () => {
    const run = vi.fn(() => JSON.stringify({ result: JSON.stringify({ advanced: true, dismissed: [] }) }));
    runConvergeEdit(
      { prompt: 'fix it' },
      { item: '1234', round: 2, run, ensureSettingsFile: () => '/fake/hooks.json', newSessionId: () => 'fixed-uuid-for-test' },
    );
    const argv = run.mock.calls[0][1];
    expect(argv[argv.indexOf('--session-id') + 1]).toBe('fixed-uuid-for-test');
  });

  // #3627 bug 7 — this spawn never passed a `cwd`, so it inherited the wrapper's own REPO_ROOT (the module
  // `run` helper's own default) instead of the lane, hitting the exact same `--restricted`
  // confined-to-working-directory sandboxing bug 7's delivery-agent spawn did.
  it('(#3627 bug 7) passes `lane` as the real `cwd` to the underlying run call — never the wrapper\'s own '
    + 'REPO_ROOT', () => {
    const run = vi.fn(() => JSON.stringify({ result: JSON.stringify({ advanced: true, dismissed: [] }) }));
    runConvergeEdit(
      { prompt: 'fix it' },
      { item: '1234', round: 1, lane: '/real/pool/lane-3', run, ensureSettingsFile: () => '/fake/hooks.json' },
    );
    const [, , opts] = run.mock.calls[0];
    expect(opts.cwd).toBe('/real/pool/lane-3');
  });

  it('(#3627 bug 7) stamps WE_DISPATCH_KIND=delivery on the editor spawn too, same channel as the delivery '
    + 'agent\'s own spawn', () => {
    const run = vi.fn(() => JSON.stringify({ result: JSON.stringify({ advanced: true, dismissed: [] }) }));
    runConvergeEdit(
      { prompt: 'fix it' },
      { item: '1234', round: 1, lane: '/real/pool/lane-3', run, ensureSettingsFile: () => '/fake/hooks.json' },
    );
    const [, , opts] = run.mock.calls[0];
    expect(opts.env.WE_DISPATCH_KIND).toBe('delivery');
  });

  // #xu2pp2m fixer — GENERALIZED, additive `dispatchKind` param (default stays 'delivery', so every existing
  // call site above is byte-for-byte unchanged): a fixer's own converge-edit round should stamp WE_DISPATCH_KIND
  // as 'fix', not 'delivery', on the shared `runConverge`/`runConvergeEdit` this second wrapper reuses.
  it('an explicit `dispatchKind` overrides the WE_DISPATCH_KIND stamp — never behaviourally required, purely additive', () => {
    const run = vi.fn(() => JSON.stringify({ result: JSON.stringify({ advanced: true, dismissed: [] }) }));
    runConvergeEdit(
      { prompt: 'fix it' },
      { item: '2108', round: 1, lane: '/real/pool/lane-3', run, ensureSettingsFile: () => '/fake/hooks.json', dispatchKind: 'fix' },
    );
    const [, , opts] = run.mock.calls[0];
    expect(opts.env.WE_DISPATCH_KIND).toBe('fix');
  });

  // #landing-freeze-2779 — live incident regression guard (ci-heal-2779, 2026-09-26 ~20:55 ET): this spawn used
  // to build its env straight off raw `process.env` with no sanitize step, so a static, daemon-minted
  // `GH_TOKEN`/`GITHUB_TOKEN` inherited by this wrapper's own (long-lived) process rode along unchanged into
  // every converge-editor round, however stale it had gotten. See
  // `../detached-dispatch.mjs#defaultSpawnDetached`'s own docblock for the full mechanism this closes.
  it('never carries a static GH_TOKEN/GITHUB_TOKEN inherited from process.env (#landing-freeze-2779)', () => {
    const savedGh = process.env.GH_TOKEN;
    const savedGithub = process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = 'stale-static-token';
    process.env.GITHUB_TOKEN = 'stale-static-token-2';
    const run = vi.fn(() => JSON.stringify({ result: JSON.stringify({ advanced: true, dismissed: [] }) }));
    let opts;
    try {
      runConvergeEdit(
        { prompt: 'fix it' },
        { item: '2779', round: 1, lane: '/real/pool/lane-3', run, ensureSettingsFile: () => '/fake/hooks.json' },
      );
      [, , opts] = run.mock.calls[0];
    } finally {
      if (savedGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedGh;
      if (savedGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = savedGithub;
    }
    expect(opts.env.GH_TOKEN).toBeUndefined();
    expect(opts.env.GITHUB_TOKEN).toBeUndefined();
  });

  // mechanical-dispatcher follow-up to #3580 — VISIBILITY, not a real Codex converge editor (see this
  // function's own docblock). Before this, a caller's `provider` was never even threaded through to here, so
  // a Codex-selected build's converge round left no trace anywhere that it had silently run under Claude.
  it('with no `provider` passed, still spawns `claude` and reports both provider fields as claude-restricted', () => {
    const run = vi.fn(() => JSON.stringify({ result: JSON.stringify({ advanced: true, dismissed: [] }) }));
    const result = runConvergeEdit(
      { prompt: 'fix it' },
      { item: '1234', round: 1, lane: '/real/pool/lane-3', run, ensureSettingsFile: () => '/fake/hooks.json' },
    );
    expect(run.mock.calls[0][0]).toBe('claude'); // the spawn itself never changes
    expect(result.requestedProvider).toBe('claude-restricted');
    expect(result.editorProvider).toBe('claude-restricted');
  });

  it('a Codex-selected `provider` still spawns `claude` for the editor, but the mismatch is now recorded '
    + '(requestedProvider !== editorProvider), not silently dropped', () => {
    const run = vi.fn(() => JSON.stringify({ result: JSON.stringify({ advanced: false, dismissed: [] }) }));
    const result = runConvergeEdit(
      { prompt: 'fix it' },
      {
        item: '1234', round: 1, lane: '/real/pool/lane-3', run, ensureSettingsFile: () => '/fake/hooks.json',
        provider: { name: 'codex' },
      },
    );
    expect(run.mock.calls[0][0]).toBe('claude'); // no Codex converge editor exists yet — see the docblock
    expect(result.requestedProvider).toBe('codex');
    expect(result.editorProvider).toBe('claude-restricted');
  });
});

describe('buildDeliveryAgentEnv (#3627 bug 7 helper — the real env vars the brief actually needs)', () => {
  it('returns all four real values plus the existing WE_DISPATCH_KIND stamp and the reports-dir override', () => {
    const env = buildDeliveryAgentEnv({
      sessionSlug: 'conveyor-3371', item: '3371', lanePath: '/real/pool/lane-3', attemptTag: 'b',
      reportsDir: '/real/repo/.operations/delivery-reports',
    });
    expect(env).toEqual({
      WE_DISPATCH_KIND: 'delivery',
      DELIVERY_SESSION: 'conveyor-3371',
      DELIVERY_ITEM: '3371',
      LANE: '/real/pool/lane-3',
      ATTEMPT_TAG: 'b',
      OPERATION_DELIVERY_REPORTS_DIR: '/real/repo/.operations/delivery-reports',
    });
  });

  it('LANE is the RESOLVED path, never the bare lane number — the brief runs `cd $LANE`/`printenv LANE` and '
    + 'expects a real directory', () => {
    const env = buildDeliveryAgentEnv({ sessionSlug: 's', item: '1', lanePath: '/real/pool/lane-9', attemptTag: '' });
    expect(env.LANE).toBe('/real/pool/lane-9');
    expect(env.LANE).not.toBe(9);
    expect(env.LANE).not.toBe('9');
  });

  it('ATTEMPT_TAG falls back to the empty string when omitted, matching the old footer\'s behavior', () => {
    const env = buildDeliveryAgentEnv({ sessionSlug: 's', item: '1', lanePath: '/lane' });
    expect(env.ATTEMPT_TAG).toBe('');
  });

  it('DELIVERY_ITEM is always a string, even when item is handed in as a number', () => {
    const env = buildDeliveryAgentEnv({ sessionSlug: 's', item: 1234, lanePath: '/lane', attemptTag: '' });
    expect(env.DELIVERY_ITEM).toBe('1234');
  });

  // #3627 bug 9 (live #3371 attempt 4) — OPERATION_DELIVERY_REPORTS_DIR is what makes the wrapper's own
  // `tryReadDeliveryReport` read (in the wrapper's process) and the spawned agent's `delivery-report-cli.mjs`
  // write (in a SEPARATE lane clone, its own physical copy of the script) resolve to the SAME directory —
  // see this function's own docblock and `delivery-report-store.mjs#resolveDeliveryReportsDir`.
  it('carries the caller-resolved reportsDir through verbatim as OPERATION_DELIVERY_REPORTS_DIR', () => {
    const env = buildDeliveryAgentEnv({
      sessionSlug: 's', item: '1', lanePath: '/lane', attemptTag: '', reportsDir: '/wrapper/root/.operations/delivery-reports',
    });
    expect(env.OPERATION_DELIVERY_REPORTS_DIR).toBe('/wrapper/root/.operations/delivery-reports');
  });

  // build-path-codex-isolation-locus — the live #3604 finding's own blocked reason named this env var by
  // name ("IMPL_LANE unset"); this is where it is actually stamped.
  it('stamps IMPL_LANE when a cross-locus implementation lane is given', () => {
    const env = buildDeliveryAgentEnv({
      sessionSlug: 's', item: '3604', lanePath: '/impl/lane', attemptTag: '', implLane: '/impl/lane',
    });
    expect(env.IMPL_LANE).toBe('/impl/lane');
  });

  it('omits IMPL_LANE entirely (never an empty string) for an ordinary we-locus delivery — the exact same '
    + 'shape the FIRST test in this describe block already `.toEqual`s exactly, so this is not a new key an '
    + 'existing caller would see', () => {
    const env = buildDeliveryAgentEnv({ sessionSlug: 's', item: '1', lanePath: '/lane', attemptTag: '' });
    expect(Object.hasOwn(env, 'IMPL_LANE')).toBe(false);
  });
});

// ================================================================================================
// #3627 bug 8 (live #3371 attempt, confirmed 2026-09-09) — the generated hooks-only settings file carried only
// a `hooks` block. Under `--restricted` the CLI ignores the repo's normal project/user permissions files
// entirely, so with no `permissions.allow` in THIS file, an ordinary headless command (confirmed live: even
// `git --version`, `node -e ...`) came back "This command requires approval" with nobody there to approve it —
// this blocked the ONE sanctioned output channel the brief describes (`delivery-report-cli.mjs report`).
// ================================================================================================
describe('DELIVERY_HOOKS_SETTINGS permissions.allow (#3627 bug 8)', () => {
  it('carries a non-empty permissions.allow', () => {
    expect(Array.isArray(DELIVERY_HOOKS_SETTINGS.permissions?.allow)).toBe(true);
    expect(DELIVERY_HOOKS_SETTINGS.permissions.allow.length).toBeGreaterThan(0);
  });

  it('allow is exactly the same six bare tool names granted via --tools (RESTRICTED_PROVIDER_TOOLS) — broad '
    + 'enough to stop ordinary build/test/git commands from needing interactive approval, but never wider than '
    + 'the tool set --restricted already exposes; a hand-enumerated narrower "safe command" allowlist is '
    + 'deliberately NOT what this is (see the constant\'s own docblock: guard-bash.mjs/guard-lane.mjs are the '
    + 'real safety boundary, not this list)', () => {
    expect(DELIVERY_HOOKS_SETTINGS.permissions.allow).toEqual(['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep']);
  });

  it('every allow entry is a BARE tool name (this repo\'s own .claude/settings.json real syntax for an '
    + 'unconditional per-tool allow), never a narrower Tool(pattern:*) entry that would just be the brittle '
    + 'hand-enumerated list this fix is deliberately avoiding', () => {
    for (const entry of DELIVERY_HOOKS_SETTINGS.permissions.allow) {
      expect(entry).not.toContain('(');
    }
  });

  it('the hooks block still has exactly two PreToolUse matcher groups — Edit|Write and Bash', () => {
    expect(DELIVERY_HOOKS_SETTINGS.hooks.PreToolUse).toHaveLength(2);
    expect(DELIVERY_HOOKS_SETTINGS.hooks.PreToolUse[0].matcher).toBe('Edit|Write');
    expect(DELIVERY_HOOKS_SETTINGS.hooks.PreToolUse[1].matcher).toBe('Bash');
  });

  it('the Bash matcher group is unchanged by the locus/backlog-guard addition — still exactly guard-bash.mjs', () => {
    expect(DELIVERY_HOOKS_SETTINGS.hooks.PreToolUse[1].hooks).toEqual([
      { type: 'command', command: 'node scripts/guard-bash.mjs' },
    ]);
  });
});

// ================================================================================================
// #3627 bug 11 (live #3371 attempt 4, confirmed 2026-09-09) — the generated hooks-only settings file's
// Edit|Write matcher carried only guard-lane.mjs. A real live delivery attempt against backlog item #3371 had
// its delivery agent write real evidence into its own `backlog/3371-...md` card (as the brief instructs: "Keep
// its `## Progress` section synced as you go") and introduced a bare code-path reference missing a `we:` locus
// prefix — a violation only caught afterward via the agent's own `check:standards` run, costing an avoidable
// extra fix-and-recheck cycle. `lint-locus-prefix.mjs --pre` and `backlog-guard.mjs --pre` are the real
// PreToolUse(Edit|Write) gates (`we:.claude/settings.json`) that would have denied both classes of mistake at
// write-time; `check-memory.mjs` and `guard-backward-edge.mjs` stay OUT — no evidence the delivery agent's own
// writes ever touch agent-memory or backward-edge-relevant paths.
// ================================================================================================
describe('DELIVERY_HOOKS_SETTINGS Edit|Write hooks (#3627 bug 11 — lint-locus-prefix.mjs + backlog-guard.mjs)', () => {
  it('the Edit|Write matcher group carries guard-lane.mjs, lint-locus-prefix.mjs --pre, and backlog-guard.mjs '
    + '--pre — in that order, matching this repo\'s own .claude/settings.json convention', () => {
    expect(DELIVERY_HOOKS_SETTINGS.hooks.PreToolUse[0].hooks).toEqual([
      { type: 'command', command: 'node scripts/guard-lane.mjs' },
      { type: 'command', command: 'node scripts/lint-locus-prefix.mjs --pre' },
      { type: 'command', command: 'node scripts/backlog-guard.mjs --pre' },
    ]);
  });

  it('does NOT carry check-memory.mjs or guard-backward-edge.mjs — no evidence the delivery agent\'s own '
    + 'writes ever touch agent-memory or backward-edge-relevant paths', () => {
    const commands = DELIVERY_HOOKS_SETTINGS.hooks.PreToolUse[0].hooks.map((h) => h.command);
    expect(commands.some((c) => c.includes('check-memory.mjs'))).toBe(false);
    expect(commands.some((c) => c.includes('guard-backward-edge.mjs'))).toBe(false);
  });
});

// ================================================================================================
// Gap 4 — decideParkMode skipped the real `scoreEscalation` rubric (statute-touch + needs-human-judgment only).
// It now wires in the FULL real `scoreEscalation` (`scripts/lib/review-escalation.mjs`), including diff-size
// and dismissed-finding signals, via the SAME `producerReviewLabel` mapping `pr-land.mjs` itself uses.
// ================================================================================================
describe('decideParkMode (#3627 gap 4 — the real scoreEscalation rubric)', () => {
  const noVerdict = { verdict: 'land', dismissed: [] };

  it('still parks review:human on a statute-path touch (kept as its own cheap, explicit check)', () => {
    const result = decideParkMode({
      report: { outcome: 'done' }, convergeVerdict: noVerdict,
      filesTouched: ['docs/agent/platform-decisions.md'],
    });
    expect(result).toEqual({ mode: 'park', label: 'review:human', reason: 'statute/policy-core path touched' });
  });

  it('still parks review:human on the agent\'s own needs-human-judgment outcome', () => {
    const result = decideParkMode({
      report: { outcome: 'needs-human-judgment', reason: 'a genuine taste call' }, convergeVerdict: noVerdict,
      filesTouched: ['scripts/lib/foo.mjs'],
    });
    expect(result).toEqual({ mode: 'park', label: 'review:human', reason: 'a genuine taste call' });
  });

  it('still parks review:human when converge itself escalated', () => {
    const result = decideParkMode({
      report: { outcome: 'done' }, convergeVerdict: { verdict: 'escalate', reason: 'red-team broke it', dismissed: [] },
      filesTouched: ['scripts/lib/foo.mjs'],
    });
    expect(result).toEqual({ mode: 'park', label: 'review:human', reason: 'red-team broke it' });
  });

  // NOTE — these use `reports/*.md` paths, not `scripts/*`: `scripts/` is itself a real blast-radius surface
  // in `scoreEscalation` (verified directly against `isBlastRadiusPath`), so a `scripts/` path would trip the
  // rubric for a reason unrelated to what each test below is isolating (size, dismissed-findings).

  it('calls the REAL scoreEscalation for a clean small diff and labels ready-to-merge (label-on-green)', () => {
    const run = vi.fn((cmd, args) => {
      if (args.includes('merge-base')) return 'abc123\n';
      if (args.includes('diff')) return '2\t1\treports/2026-09-09-note.md\n';
      throw new Error(`unexpected: ${cmd} ${args}`);
    });
    const result = decideParkMode(
      { report: { outcome: 'done' }, convergeVerdict: noVerdict, filesTouched: ['reports/2026-09-09-note.md'], lanePath: '/lanes/lane-1' },
      { run },
    );
    expect(result.mode).toBe('label-on-green');
    expect(result.label).toBe('ready-to-merge');
    expect(result.score.escalate).toBe(false);
  });

  it('a LARGE real diff (>= the real 400-line threshold) escalates to review:pending via the real rubric, never silently clears', () => {
    const run = vi.fn((cmd, args) => {
      if (args.includes('merge-base')) return 'abc123\n';
      if (args.includes('diff')) return '300\t200\treports/2026-09-09-big.md\n';
      throw new Error(`unexpected: ${cmd} ${args}`);
    });
    const result = decideParkMode(
      { report: { outcome: 'done' }, convergeVerdict: noVerdict, filesTouched: ['reports/2026-09-09-big.md'], lanePath: '/lanes/lane-1' },
      { run },
    );
    expect(result.mode).toBe('park');
    expect(result.label).toBe('review:pending');
    expect(result.score.escalate).toBe(true);
    expect(result.score.signals.size).toBeGreaterThanOrEqual(400);
  });

  it('dismissed converge findings (from the real convergeVerdict.dismissed) escalate to review:pending via scoreEscalation', () => {
    const run = vi.fn((cmd, args) => {
      if (args.includes('merge-base')) return 'abc123\n';
      if (args.includes('diff')) return '2\t1\treports/2026-09-09-note.md\n';
      throw new Error(`unexpected: ${cmd} ${args}`);
    });
    const result = decideParkMode(
      {
        report: { outcome: 'done' },
        convergeVerdict: { verdict: 'land', dismissed: [{ summary: 'a finding the editor dismissed', reason: 'not real' }] },
        filesTouched: ['reports/2026-09-09-note.md'],
        lanePath: '/lanes/lane-1',
      },
      { run },
    );
    expect(result.mode).toBe('park');
    expect(result.label).toBe('review:pending');
    expect(result.score.signals.dismissedFindings).toBe(1);
  });

  it('computeLaneDiffStats fails soft to {changedFiles:[], diffLines:0} when git itself fails — never crashes the park decision', () => {
    const run = vi.fn(() => { throw new Error('git exploded'); });
    const stats = computeLaneDiffStats('/lanes/lane-1', { run });
    expect(stats).toEqual({ changedFiles: [], diffLines: 0 });
  });
});

// ================================================================================================
// #3850 Fork 2 (RATIFIED, (a)) — a `full` route whose ACTUAL executed vendor is not Claude may not land on
// `label-on-green` alone, whatever its escalation score. `executedVendor` is `decideParkMode`'s new, additive
// (default `'claude'`) param; every case above (which never passes it) proves the default changes nothing.
// ================================================================================================
describe('decideParkMode (#3850 Fork 2 — the land-seam hold on a delegated executed vendor)', () => {
  const noVerdict = { verdict: 'land', dismissed: [] };
  const cleanRun = vi.fn((cmd, args) => {
    if (args.includes('merge-base')) return 'abc123\n';
    if (args.includes('diff')) return '2\t1\treports/2026-09-09-note.md\n';
    throw new Error(`unexpected: ${cmd} ${args}`);
  });

  it('a Claude-executed clean diff still gets label-on-green — explicit executedVendor="claude" changes nothing', () => {
    const result = decideParkMode(
      {
        report: { outcome: 'done' }, convergeVerdict: noVerdict, filesTouched: ['reports/2026-09-09-note.md'],
        lanePath: '/lanes/lane-1', executedVendor: 'claude',
      },
      { run: cleanRun },
    );
    expect(result.mode).toBe('label-on-green');
    expect(result.label).toBe('ready-to-merge');
  });

  it('a non-Claude-executed clean diff is FORCED to park review:pending instead of label-on-green', () => {
    const result = decideParkMode(
      {
        report: { outcome: 'done' }, convergeVerdict: noVerdict, filesTouched: ['reports/2026-09-09-note.md'],
        lanePath: '/lanes/lane-1', executedVendor: 'codex',
      },
      { run: cleanRun },
    );
    expect(result.mode).toBe('park');
    expect(result.label).toBe('review:pending');
    expect(result.reason).toMatch(/#3850 Fork 2/);
    expect(result.reason).toMatch(/codex/);
  });

  it('a non-Claude executor never DOWNGRADES an existing statute/human-judgment/escalate park — those still return review:human, unaffected by executedVendor', () => {
    const result = decideParkMode({
      report: { outcome: 'done' }, convergeVerdict: noVerdict,
      filesTouched: ['docs/agent/platform-decisions.md'], executedVendor: 'codex',
    });
    expect(result).toEqual({ mode: 'park', label: 'review:human', reason: 'statute/policy-core path touched' });
  });

  it('a non-Claude executor never DOWNGRADES the real scoreEscalation rubric\'s own review:pending — same label, real reason', () => {
    const bigRun = vi.fn((cmd, args) => {
      if (args.includes('merge-base')) return 'abc123\n';
      if (args.includes('diff')) return '300\t200\treports/2026-09-09-big.md\n';
      throw new Error(`unexpected: ${cmd} ${args}`);
    });
    const result = decideParkMode(
      {
        report: { outcome: 'done' }, convergeVerdict: noVerdict, filesTouched: ['reports/2026-09-09-big.md'],
        lanePath: '/lanes/lane-1', executedVendor: 'codex',
      },
      { run: bigRun },
    );
    expect(result.mode).toBe('park');
    expect(result.label).toBe('review:pending');
    // The REAL rubric reason, not the Fork 2 reason — scoreEscalation already forced this park.
    expect(result.reason).toMatch(/scoreEscalation/);
  });

  it('omitting executedVendor entirely defaults to "claude" — byte-identical to every pre-#3850 caller', () => {
    const result = decideParkMode(
      { report: { outcome: 'done' }, convergeVerdict: noVerdict, filesTouched: ['reports/2026-09-09-note.md'], lanePath: '/lanes/lane-1' },
      { run: cleanRun },
    );
    expect(result.mode).toBe('label-on-green');
  });
});

// ================================================================================================
// #3850 Fork 2 — `deliverItem`'s own two registered providers each carry a `vendor` field in
// `DELIVERY_VENDOR_PROVIDERS`'s canonical vocabulary (never their own `name`, which is not that vocabulary —
// `CLAUDE_RESTRICTED_PROVIDER.name` is `'claude-restricted'`, not `'claude'`). This is the ACTUAL evidence
// `decideParkMode`'s `executedVendor` reads at the real call site inside `deliverItem` — see that call site's
// own `#3850 Fork 2` comment.
// ================================================================================================
describe('DELIVERY_AGENT_PROVIDERS (#3850 Fork 2 — each provider names its own canonical vendor)', () => {
  it('CLAUDE_RESTRICTED_PROVIDER vendor is "claude"', () => {
    expect(DELIVERY_AGENT_PROVIDERS['claude-restricted'].vendor).toBe('claude');
  });
  it('CODEX_PROVIDER vendor is "codex"', () => {
    expect(DELIVERY_AGENT_PROVIDERS.codex.vendor).toBe('codex');
  });
});

/**
 * #3627 bug 13 — a REALISTIC `run.mjs open-pr --json` stdout, never the flat `{pr, url}` shape a prior test
 * (and a prior fix attempt) wrongly assumed. The real shape is the FULL run-outcome envelope
 * (`cli-adapter.mjs#outcomePayload`); the submit result lives nested at `findings.submit.effects[0].result`
 * (`engine.mjs#effectFinding`), never at the top level. Transcribed from an actual CLI run, not guessed.
 */
it('#4357 formats a refusal without detail or PR', () => {
  expect(describeOpenPrRefusal({ outcome: 'unrun', reason: 'no report' })).toBe('open-refused (no report)');
});

function openPrEnvelope(result) {
  return JSON.stringify({
    runId: 'open-pr-test', op: 'open-pr', stopped: 'complete', applied: ['open-pr-test#1#0'],
    inFlight: [], pending: null, verdict: { ref: 'lane/test', base: 'main' }, // the PLAN — no `pr` here
    findings: { plan: { ref: 'lane/test', base: 'main' }, submit: { applied: true, effects: [{ type: 'open-pr.submit', status: 'applied', result, error: null }] } },
    telemetry: [], spend: { jurors: 0, costUsd: 0, wallMs: 0, durationMs: 0 },
  });
}

/**
 * #4348-open-pr-retry — a REALISTIC `run.mjs open-pr --json` stdout for the `effect-halted` stop
 * (`cli-adapter.mjs#renderOutcome`, exit code 1): the halted effect's own `result` stays `null`
 * (`effect-executor.mjs#applyPendingEffects`'s catch branch sets only `error`), and the reason is folded into
 * the effect's `.error` sentence. Transcribed from the REAL captured run record for the live #4348 incident
 * (run f4166fa3883080a9), not guessed.
 */
function openPrHaltedEnvelope(errorText) {
  return JSON.stringify({
    runId: 'open-pr-test', op: 'open-pr', stopped: 'effect-halted', applied: [],
    inFlight: [], pending: { step: 'submit', kind: 'effect', stepIndex: 1 }, verdict: { ref: 'lane/test', base: 'main' },
    findings: {
      plan: { ref: 'lane/test', base: 'main' },
      submit: { applied: false, effects: [{ type: 'open-pr.submit', status: 'pending', result: null, error: errorText }] },
    },
    telemetry: [], spend: { jurors: 0, costUsd: 0, wallMs: 0, durationMs: 0 }, error: errorText,
  });
}

// ================================================================================================
// #4348-open-pr-retry — `classifyOpenPrFailure` is what tells a `blocked-on-infra` PR-open (retryable — see
// `deliverItem`'s new `open-pending` branch) apart from a genuine refusal/bug (still `wrapper-threw`).
// ================================================================================================
describe('classifyOpenPrFailure (#4348-open-pr-retry)', () => {
  const BLOCKED_TEXT = 'open-pr: pr-land did not report a result — blocked-on-infra. The PR was NOT opened, '
    + 'and this is not a refusal you can fix by editing the request.';

  it('reads the REAL halted-effect shape (result:null, reason folded into .error) and matches the bare token', () => {
    const e = new Error('Command failed'); e.stdout = openPrHaltedEnvelope(BLOCKED_TEXT);
    expect(classifyOpenPrFailure(e)).toEqual({ reason: 'blocked-on-infra', detail: BLOCKED_TEXT });
  });

  it('falls back to the envelope\'s top-level `error` when the per-effect one is absent', () => {
    const payload = JSON.parse(openPrHaltedEnvelope(BLOCKED_TEXT));
    payload.findings.submit.effects[0].error = null;
    const e = new Error('Command failed'); e.stdout = JSON.stringify(payload);
    expect(classifyOpenPrFailure(e)).toEqual({ reason: 'blocked-on-infra', detail: BLOCKED_TEXT });
  });

  it('a genuine refusal (e.g. `check-red`) is NOT reclassified — it stays the generic wrapper-threw case', () => {
    const e = new Error('Command failed'); e.stdout = openPrHaltedEnvelope('open-pr: refused — check-red');
    expect(classifyOpenPrFailure(e)).toBeNull();
  });

  it('unparseable/absent stdout (the spawn never even started) never guesses an infra hiccup', () => {
    expect(classifyOpenPrFailure(new Error('spawn ENOENT'))).toBeNull();
    const withStdout = new Error('boom'); withStdout.stdout = 'not json';
    expect(classifyOpenPrFailure(withStdout)).toBeNull();
  });
});

// ================================================================================================
// Bug 1 (found re-reading the file end-to-end before the first real #3371 run) — `openPr`'s PR ref carried a
// literal, never-substituted `<slug>` placeholder (`lane/${item}${attemptTag}-<slug>`), which would have
// produced an invalid ref like `lane/3371-<slug>`. `openPr` is now a PURE function of its params — the caller
// resolves the item's real slug (via `findItem`, same as `resolveItemSpecPathBasename`) and passes it in.
// ================================================================================================
describe('openPr (#3627 bug 1 — the real slug, never the literal <slug> placeholder)', () => {
  // `openPr` writes a real PR-body file via `writePrBody`'s default `writeFileSync` (gap 2's own fix), so
  // these use a real temp dir for `lane` — the same pattern the `runConverge` describe block above uses.
  let lane;
  beforeEach(() => { lane = mkdtempSync(join(tmpdir(), 'deliver-item-wrapper-openpr-')); });
  afterEach(() => { rmSync(lane, { recursive: true, force: true }); });

  it('builds the PR ref using the REAL slug handed in, never the literal "<slug>" placeholder text', () => {
    const run = vi.fn(() => openPrEnvelope({ outcome: 'opened', pr: 42, url: 'https://example/pr/42' }));
    const report = { reason: 'x', filesTouched: [] };
    const result = openPr(
      { item: '3371', attemptTag: '', lane, park: { mode: 'label-on-green' }, report, slug: 'some-real-slug' },
      { run },
    );
    // `openPr` returns the REAL `.pr`/`.url` (`extractSubmitResult`'s shape), never the raw envelope it parsed.
    expect(result).toEqual({ outcome: 'opened', pr: 42, url: 'https://example/pr/42' });
    const openPrCall = run.mock.calls.find((c) => c[1]?.[1] === 'open-pr');
    expect(openPrCall).toBeDefined();
    const refFlag = openPrCall[1].find((a) => a.startsWith('--ref='));
    expect(refFlag).toBe('--ref=lane/3371-some-real-slug');
    expect(refFlag).not.toContain('<slug>');
  });

  it('includes the attemptTag between the item number and the real slug when one is given', () => {
    const run = vi.fn(() => openPrEnvelope({ outcome: 'opened', pr: 1 }));
    openPr(
      { item: '3371', attemptTag: 'b', lane, park: { mode: 'label-on-green' }, report: { reason: 'x', filesTouched: [] }, slug: 'do-the-thing' },
      { run },
    );
    const openPrCall = run.mock.calls.find((c) => c[1]?.[1] === 'open-pr');
    const refFlag = openPrCall[1].find((a) => a.startsWith('--ref='));
    expect(refFlag).toBe('--ref=lane/3371b-do-the-thing');
  });

  it('passes the exact dispatch identity and store to the producer before it opens the PR', () => {
    const run = vi.fn(() => openPrEnvelope({ outcome: 'opened', pr: 3033 }));
    openPr({ item: '4502', lane, park: { mode: 'park', label: 'review:human' },
      report: { reason: 'x', filesTouched: [] }, slug: 'example', runId: 'dispatch-lane-build', effectKey: 'dispatch:0:0' }, { run });
    expect(JSON.parse(run.mock.calls[0][2].env.WE_BUILD_PR_CONTEXT)).toEqual({
      runId: 'dispatch-lane-build', key: 'dispatch:0:0', dir: expect.any(String),
    });
  });

  it.each([
    [{ mode: 'label-on-green' }, ['--mode=label-on-green']],
    [{ mode: 'park', label: 'review:human' }, ['--mode=park', '--parkLabel=review:human']],
  ])('passes the exact argv and cwd to run (%j)', (park, modeArgs) => {
    const run = vi.fn(() => openPrEnvelope({ outcome: 'opened', pr: 5 }));
    openPr({ item: '4325', attemptTag: '', lane, park, report: { reason: 'x', filesTouched: [] }, slug: 'x' }, { run });
    expect(run).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = run.mock.calls[0];
    expect(cmd).toBe('node');
    expect(args).toEqual([
      `${REPO_ROOT}scripts/operations/run.mjs`, 'open-pr', '--ref=lane/4325-x', '--sha=HEAD', '--base=main',
      `--bodyFile=${join(lane, '.pr-body.md')}`, '--requireVerified=true', '--json', ...modeArgs,
    ]);
    expect(opts.cwd).toBe(lane);
  });

  it('refuses (throws a named error) rather than opening a PR with no real slug', () => {
    expect(() => openPr({ item: '3371', attemptTag: '', lane, park: { mode: 'label-on-green' }, report: { reason: 'x', filesTouched: [] } }))
      .toThrow(/needs the item's real slug/);
  });

  it('never calls findItem/the backlog loader itself — openPr is a pure function of its params (the caller resolves the slug)', () => {
    // No `loadItems` is threaded through `openPr` at all (removed from its signature on purpose) — this test
    // simply asserts the call succeeds with a bare `run` mock and no backlog-loading machinery in play.
    const run = vi.fn(() => openPrEnvelope({ outcome: 'opened', pr: 7 }));
    expect(() => openPr(
      { item: '1234', attemptTag: '', lane, park: { mode: 'park', label: 'review:human' }, report: { reason: 'x', filesTouched: [] }, slug: 'x' },
      { run },
    )).not.toThrow();
  });
});

// ================================================================================================
// Bug 2 (found in the same re-read) — `resolveLanePath(lane)` was a hardcoded, relative-path placeholder
// (`${REPO_ROOT}/../.lanes/web-everything/lane-${lane}`) that only resolved correctly when this file happened
// to be imported from the primary checkout root; run from an isolated worktree/clone it silently computed the
// WRONG path. It now shells `scripts/lane-pool.mjs status --json` (the single source of truth
// `lane-pool-paths.mjs`/`verify-lane.mjs` already trust) via an injectable `run` and reads the real `path`
// field off the matching lane entry — never a second, re-derived path computation.
// ================================================================================================
describe('resolveLanePath (#3627 bug 2 — real lane-pool.mjs status --json lookup, not hardcoded path math)', () => {
  const statusJson = (lanes) => JSON.stringify({ repo: 'web-everything', root: '/pool', lanes });

  it('calls lane-pool.mjs status --json (via the injected run) and returns the matching lane\'s real path', () => {
    const run = vi.fn(() => statusJson([
      { lane: 1, path: '/Users/op/workspace/.lanes/web-everything/lane-1', exists: true },
      { lane: 4, path: '/Users/op/workspace/.lanes/web-everything/lane-4', exists: true },
    ]));
    const path = resolveLanePath(4, { run });
    expect(path).toBe('/Users/op/workspace/.lanes/web-everything/lane-4');
    expect(run).toHaveBeenCalledWith('node', ['scripts/lane-pool.mjs', 'status', '--json']);
  });

  it('never derives the path from hardcoded relative-path math — the returned path need not even look like ../.lanes/web-everything/lane-N', () => {
    const run = vi.fn(() => statusJson([
      { lane: 9, path: '/completely/different/pool/location/lane-9', exists: true },
    ]));
    const path = resolveLanePath(9, { run });
    expect(path).toBe('/completely/different/pool/location/lane-9');
  });

  it('throws a named error when no matching lane entry is reported, rather than falling back to a computed path', () => {
    const run = vi.fn(() => statusJson([{ lane: 1, path: '/pool/lane-1', exists: true }]));
    expect(() => resolveLanePath(2, { run })).toThrow(/no entry\/path for lane-2/);
  });
});

describe('runGateWithOneRetry (#3627 bug 2 — threads the injected run through to resolveLanePath; '
  + '#3627 follow-up — routed through the declared `verify` operation, never raw verify-lane.mjs)', () => {
  const verifyOkJson = () => JSON.stringify({
    runId: 'run-1', op: 'verify', stopped: 'complete', applied: [],
    verdict: { ok: true, cwd: '/real/pool/lane-3', suite: 'run', passed: 2, failed: 0, unrun: 0, checks: [], blocking: [] },
  });
  const verifyRedJson = () => JSON.stringify({
    runId: 'run-1', op: 'verify', stopped: 'complete', applied: [],
    verdict: {
      ok: false, cwd: '/real/pool/lane-3', suite: 'run', passed: 1, failed: 1, unrun: 0,
      checks: [{ name: 'test:unit', outcome: 'fail' }],
      blocking: [{ check: 'test:unit', why: 'failed', detail: '3 error(s)' }],
    },
  });

  it('uses the injected run for BOTH the lane-pool.mjs status lookup and the gate itself, calling '
    + '`run.mjs verify --checkout=<resolved lane path> --json` — never raw verify-lane.mjs', async () => {
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'scripts/lane-pool.mjs') {
        return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/operations/run.mjs') {
        expect(args).toEqual(['scripts/operations/run.mjs', 'verify', '--checkout=/real/pool/lane-3', '--json']);
        return verifyOkJson();
      }
      if (cmd === 'git') return ''; // #3565 — the wrapper's own build/gate-fix commit reads `git status --porcelain`
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    const result = await runGateWithOneRetry({ lane: 3, item: '3371', sessionSlug: 'conveyor-3371' }, { run });
    expect(result).toEqual({ status: 'green', lanePath: '/real/pool/lane-3' });
    const statusCall = run.mock.calls.find((c) => c[1]?.[0] === 'scripts/lane-pool.mjs');
    expect(statusCall).toBeDefined();
    expect(statusCall[1]).toEqual(['scripts/lane-pool.mjs', 'status', '--json']);
  });

  it('reads `verdict.ok` from the JSON envelope rather than relying on a non-zero exit code — the `verify` '
    + 'OPERATION reports `stopped: complete` (exit 0) even for a red gate (compute-only, no confirm/judge), '
    + 'unlike the raw `verify-lane.mjs` home which exits 2', async () => {
    let verifyCalls = 0;
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'scripts/lane-pool.mjs') {
        return JSON.stringify({ lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/operations/run.mjs') { verifyCalls += 1; return verifyRedJson(); } // exit 0, verdict.ok=false
      if (cmd === 'git') return ''; // #3565 — the wrapper's own build/gate-fix commit reads `git status --porcelain`
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    const provider = { spawn: vi.fn() }; // stub — never spawns a real `claude`
    const result = await runGateWithOneRetry(
      { lane: 3, item: '3371', sessionSlug: 'test-3627-fake-session-no-report', provider },
      { run },
    );
    expect(result.status).toBe('red');
    expect(verifyCalls).toBe(2); // the first attempt, then exactly one retry after the resume
    expect(provider.spawn).toHaveBeenCalledTimes(1); // the one resume-with-gate-failure call
  });

  it('(#3627 bug 5) resumes with claudeSessionId — a real UUID — as BOTH sessionId and resumeSessionId, '
    + 'never sessionSlug (the CLI validates --session-id/--resume as a UUID and rejects a human-readable slug)', async () => {
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'scripts/lane-pool.mjs') {
        return JSON.stringify({ lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/operations/run.mjs') return verifyRedJson();
      if (cmd === 'git') return ''; // #3565 — the wrapper's own build/gate-fix commit reads `git status --porcelain`
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    const provider = { spawn: vi.fn() };
    const claudeSessionId = '33333333-3333-4333-8333-333333333333';
    await runGateWithOneRetry(
      { lane: 3, item: '3371', sessionSlug: 'conveyor-3371', provider, claudeSessionId },
      { run },
    );
    expect(provider.spawn).toHaveBeenCalledTimes(1);
    const call = provider.spawn.mock.calls[0][0];
    expect(call.sessionId).toBe(claudeSessionId);
    expect(call.resumeSessionId).toBe(claudeSessionId);
    expect(call.sessionId).not.toBe('conveyor-3371');
    expect(call.resumeSessionId).not.toBe('conveyor-3371');
  });

  it('(#3627 bug 5) the SAME claudeSessionId a fresh spawn used is what the resume targets — a resume must '
    + 'never mint or receive a different id than the session it is resuming', async () => {
    const claudeSessionId = '44444444-4444-4444-8444-444444444444';

    // The fresh spawn (mirrors what deliverItem's runAgentToCompletion call does).
    const freshProvider = { spawn: vi.fn() };
    freshProvider.spawn({ sessionId: claudeSessionId, prompt: 'build it' });

    // The resume, driven through the real runGateWithOneRetry with the SAME id threaded in, as deliverItem
    // threads it (both calls originate from one claudeSessionId minted once at the top of deliverItem).
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'scripts/lane-pool.mjs') {
        return JSON.stringify({ lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/operations/run.mjs') return verifyRedJson();
      if (cmd === 'git') return ''; // #3565 — the wrapper's own build/gate-fix commit reads `git status --porcelain`
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    await runGateWithOneRetry({ lane: 3, item: '3371', sessionSlug: 'conveyor-3371', provider: freshProvider, claudeSessionId }, { run });

    expect(freshProvider.spawn).toHaveBeenCalledTimes(2); // the fresh spawn above + the one resume
    const [freshCall, resumeCall] = freshProvider.spawn.mock.calls.map((c) => c[0]);
    expect(freshCall.sessionId).toBe(claudeSessionId);
    expect(resumeCall.sessionId).toBe(claudeSessionId);
    expect(resumeCall.resumeSessionId).toBe(claudeSessionId);
  });
});

// #3627 attempt-5 live-run finding (real run against backlog #3371) — `runVerifyOperation` used to collapse
// EVERY non-`ok` verdict to one flat `{ok:false}`, so a gate that never RAN (a stale/foreign verify marker,
// `verify-lane.mjs` exit 3 `superseded`) looked identical to a gate that ran and genuinely failed. The `verify`
// operation's own `assessChecks` (`scripts/operations/verify.mjs`) already keeps these apart in
// `verdict.{failed,unrun}` — this is the caller finally reading that distinction instead of throwing it away.
describe('runVerifyOperation (#3627 attempt-5 finding — three-valued outcome: pass/fail/unrun, never a flat ok/not-ok)', () => {
  it('reports `pass` for a green verdict', () => {
    const run = vi.fn(() => JSON.stringify({
      verdict: { ok: true, cwd: '/lane', suite: 'run', passed: 2, failed: 0, unrun: 0, checks: [], blocking: [] },
    }));
    const result = runVerifyOperation('/lane', { run });
    expect(result.outcome).toBe('pass');
  });

  it('reports `fail` when the suites actually ran and a check failed (verdict.failed > 0)', () => {
    const run = vi.fn(() => JSON.stringify({
      verdict: {
        ok: false, cwd: '/lane', suite: 'run', passed: 1, failed: 1, unrun: 0,
        checks: [{ name: 'test:unit', outcome: 'fail' }],
        blocking: [{ check: 'test:unit', why: 'failed', detail: '3 error(s)' }],
      },
    }));
    const result = runVerifyOperation('/lane', { run });
    expect(result.outcome).toBe('fail');
  });

  it('reports `unrun`, never `fail`, when nothing failed but the gate did not complete for this commit '
    + '(verdict.unrun > 0, verdict.failed === 0 — the stale/foreign-marker shape #3627 attempt 5 hit)', () => {
    const run = vi.fn(() => JSON.stringify({
      verdict: {
        ok: false, cwd: '/lane', suite: 'run', passed: 0, failed: 0, unrun: 1,
        checks: [{ name: 'verify-lane', outcome: 'unrun', reason: 'marker status "superseded"' }],
        blocking: [{ check: 'verify-lane', why: 'did-not-run', detail: 'usage/git error (exit 3): superseded' }],
      },
    }));
    const result = runVerifyOperation('/lane', { run });
    expect(result.outcome).toBe('unrun');
    expect(result.detail).toMatch(/did-not-run/);
  });

  it('reports `unrun` when the `run.mjs verify` invocation itself throws (operation-level crash/refusal)', () => {
    const run = vi.fn(() => { const e = new Error('spawn failed'); e.status = 1; throw e; });
    const result = runVerifyOperation('/lane', { run });
    expect(result.outcome).toBe('unrun');
  });

  it('reports `unrun` when stdout is not parseable JSON', () => {
    const run = vi.fn(() => 'not json');
    const result = runVerifyOperation('/lane', { run });
    expect(result.outcome).toBe('unrun');
  });
});

// #3627 attempt-5 live-run finding — the resumed agent's own SECOND report must be read and honored: a
// `blocked` self-diagnosis (the gate problem was not in its own diff) must surface as its own distinct
// `gate-blocked` status, never be silently mapped to `gate-red` regardless of what the second verify said.
describe('runGateWithOneRetry (#3627 attempt-5 finding — honors a resumed agent\'s second `blocked` report '
  + 'instead of collapsing every further non-ok verify into `red`)', () => {
  const verifyUnrunJson = () => JSON.stringify({
    verdict: {
      ok: false, cwd: '/real/pool/lane-3', suite: 'run', passed: 0, failed: 0, unrun: 1,
      checks: [{ name: 'verify-lane', outcome: 'unrun', reason: 'superseded' }],
      blocking: [{ check: 'verify-lane', why: 'did-not-run', detail: 'usage/git error (exit 3): superseded' }],
    },
  });

  it('returns `gate-blocked` (carrying the agent\'s own reason) when the resumed agent\'s second report says '
    + '`outcome: "blocked"` — even though the second verify is STILL non-ok', async () => {
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'scripts/lane-pool.mjs') {
        return JSON.stringify({ lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/operations/run.mjs') return verifyUnrunJson();
      if (cmd === 'git') return ''; // #3565 — the wrapper's own build/gate-fix commit reads `git status --porcelain`
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    const provider = { spawn: vi.fn() };
    const readReport = vi.fn(() => ({
      status: 'done', outcome: 'blocked',
      reason: 'the gate never ran — a stale verify marker for an unrelated sha; nothing in my diff to fix',
    }));
    const result = await runGateWithOneRetry(
      { lane: 3, item: '3371', sessionSlug: 'conveyor-3371', provider },
      { run, readReport },
    );
    expect(result.status).toBe('gate-blocked');
    expect(result.reason).toMatch(/stale verify marker/);
    expect(result.retryReport.outcome).toBe('blocked');
    expect(provider.spawn).toHaveBeenCalledTimes(1); // still exactly one resume, never a second/unbounded retry
  });

  it('still returns `red` when the resumed agent\'s second report says `outcome: "done"` but the gate is '
    + 'still genuinely failing — a `done` report never overrides a real red', async () => {
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'scripts/lane-pool.mjs') {
        return JSON.stringify({ lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/operations/run.mjs') return JSON.stringify({
        verdict: {
          ok: false, cwd: '/real/pool/lane-3', suite: 'run', passed: 1, failed: 1, unrun: 0,
          checks: [{ name: 'test:unit', outcome: 'fail' }],
          blocking: [{ check: 'test:unit', why: 'failed', detail: '1 error(s)' }],
        },
      });
      if (cmd === 'git') return ''; // #3565 — the wrapper's own build/gate-fix commit reads `git status --porcelain`
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    const provider = { spawn: vi.fn() };
    const readReport = vi.fn(() => ({ status: 'done', outcome: 'done', filesTouched: ['a.mjs'] }));
    const result = await runGateWithOneRetry(
      { lane: 3, item: '3371', sessionSlug: 'conveyor-3371', provider },
      { run, readReport },
    );
    expect(result.status).toBe('red');
  });

  it('still returns `red` (not `gate-blocked`) when no second report is available at all — an absent report '
    + 'is not a `blocked` self-diagnosis', async () => {
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'scripts/lane-pool.mjs') {
        return JSON.stringify({ lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/operations/run.mjs') return verifyUnrunJson();
      if (cmd === 'git') return ''; // #3565 — the wrapper's own build/gate-fix commit reads `git status --porcelain`
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    const provider = { spawn: vi.fn() };
    const readReport = vi.fn(() => null);
    const result = await runGateWithOneRetry(
      { lane: 3, item: '3371', sessionSlug: 'conveyor-3371', provider },
      { run, readReport },
    );
    expect(result.status).toBe('red');
  });

  it('sends the resumed agent an HONEST prompt for an `unrun` first gate — never "your gate failed, fix it" '
    + '— and explicitly invites a `blocked` report when nothing in its own diff explains it', async () => {
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'scripts/lane-pool.mjs') {
        return JSON.stringify({ lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/operations/run.mjs') return verifyUnrunJson();
      if (cmd === 'git') return ''; // #3565 — the wrapper's own build/gate-fix commit reads `git status --porcelain`
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    const provider = { spawn: vi.fn() };
    const readReport = vi.fn(() => null);
    await runGateWithOneRetry({ lane: 3, item: '3371', sessionSlug: 'conveyor-3371', provider }, { run, readReport });
    const prompt = provider.spawn.mock.calls[0][0].prompt;
    expect(prompt).not.toMatch(/Your gate failed/);
    expect(prompt).toMatch(/could not RUN/);
    expect(prompt).toMatch(/outcome: 'blocked'/);
  });

  it('sends the resumed agent the ORIGINAL "your gate failed, fix it" prompt for a genuine `fail` first gate', async () => {
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'scripts/lane-pool.mjs') {
        return JSON.stringify({ lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/operations/run.mjs') return JSON.stringify({
        verdict: {
          ok: false, cwd: '/real/pool/lane-3', suite: 'run', passed: 1, failed: 1, unrun: 0,
          checks: [{ name: 'test:unit', outcome: 'fail' }],
          blocking: [{ check: 'test:unit', why: 'failed', detail: '1 error(s)' }],
        },
      });
      if (cmd === 'git') return ''; // #3565 — the wrapper's own build/gate-fix commit reads `git status --porcelain`
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    const provider = { spawn: vi.fn() };
    const readReport = vi.fn(() => null);
    await runGateWithOneRetry({ lane: 3, item: '3371', sessionSlug: 'conveyor-3371', provider }, { run, readReport });
    const prompt = provider.spawn.mock.calls[0][0].prompt;
    expect(prompt).toMatch(/Your gate failed/);
  });
});

describe('claimItem (#3627 follow-up — routed through the declared `claim` operation, never raw backlog.mjs claim)', () => {
  it('calls `run.mjs claim --ref=<item> --json` — the exact argv the `claim` operation\'s real input schema '
    + '(`ref` required, `as`/`force` optional) accepts', () => {
    const run = vi.fn(() => '{}');
    claimItem({ item: '1234', sessionSlug: 'conveyor-1234' }, { run });
    expect(run).toHaveBeenCalledWith('node', ['scripts/operations/run.mjs', 'claim', '--ref=1234', '--json']);
  });

  it('never runs a raw `backlog.mjs claim` shell-out', () => {
    const run = vi.fn(() => '{}');
    claimItem({ item: '1234', sessionSlug: 'conveyor-1234' }, { run });
    const [, args] = run.mock.calls[0];
    expect(args.join(' ')).not.toMatch(/backlog\.mjs/);
  });

  it('never passes `--session` — the claim operation\'s real input schema (`claimOperation` in claim.mjs) has '
    + 'no such field; only `ref`/`as`/`force`', () => {
    const run = vi.fn(() => '{}');
    claimItem({ item: '1234', sessionSlug: 'conveyor-1234' }, { run });
    const [, args] = run.mock.calls[0];
    expect(args.some((a) => a.startsWith('--session'))).toBe(false);
  });
});

// #3627 secondary finding (live #3371 attempt 4 transcript, confirmed 2026-09-09 by source read of
// `lane-pool.mjs#tryClaimLane` and `guard-lane.mjs`'s occupant check) — `acquireLane`'s `--adopt` must stamp
// the delivery agent's own FUTURE session id (`claudeSessionId`, already minted before acquire runs — see
// `deliverItem`), never whatever `CLAUDE_CODE_SESSION_ID` the wrapper's own process happened to inherit from
// its caller. Left unfixed, `--adopt` stamps the DRIVER session's identity as the lane's occupant, and
// `guard-lane.mjs` then refuses the delivery agent's own Edit/Write tool calls in that exact lane because the
// occupant it stamped never matches the session the delivery agent's own spawned CLI actually runs under.
describe('acquireLane (#3627 secondary finding — --adopt must stamp the delivery agent\'s own future session id)', () => {
  it('passes CLAUDE_CODE_SESSION_ID=<claudeSessionId> in the acquire subprocess\'s env — never left to inherit '
    + 'whatever the wrapper\'s own process ambiently carries', () => {
    // `run` returns '' for every call here (including the post-acquire `lane-pool.mjs status` lookup), so
    // `resolveLanePath` throws on the unparseable '' and acquireLane's own best-effort try/catch swallows it —
    // exactly 2 calls (acquire, then the status lookup that fails), never a 3rd `verify-lane.mjs reset` call.
    const run = vi.fn(() => '');
    acquireLane(
      { lane: 3, sessionSlug: 'conveyor-3371', scope: 'we:scripts/lib/foo.mjs', item: '3371', claudeSessionId: '77777777-7777-4777-8777-777777777777' },
      { run },
    );
    expect(run).toHaveBeenCalledTimes(2);
    const [, args, opts] = run.mock.calls[0];
    expect(args).toEqual([
      'scripts/lane-pool.mjs', 'acquire', '--lane=3', '--purpose=conveyor-delivery',
      '--session=conveyor-3371', '--scope=we:scripts/lib/foo.mjs', '--item=3371', '--adopt',
    ]);
    expect(opts.env.CLAUDE_CODE_SESSION_ID).toBe('77777777-7777-4777-8777-777777777777');
  });

  it('still carries the rest of the wrapper\'s own inherited env — the override adds one key, never replaces '
    + 'the whole env', () => {
    const previous = process.env.WE_ACQUIRE_LANE_TEST_MARKER;
    process.env.WE_ACQUIRE_LANE_TEST_MARKER = 'present';
    try {
      const run = vi.fn(() => '');
      acquireLane(
        { lane: 3, sessionSlug: 's', scope: 'we:x', item: '1', claudeSessionId: '88888888-8888-4888-8888-888888888888' },
        { run },
      );
      const [, , opts] = run.mock.calls[0];
      expect(opts.env.WE_ACQUIRE_LANE_TEST_MARKER).toBe('present');
    } finally {
      if (previous === undefined) delete process.env.WE_ACQUIRE_LANE_TEST_MARKER;
      else process.env.WE_ACQUIRE_LANE_TEST_MARKER = previous;
    }
  });

  // #3627 attempt-5 live-run finding (backlog #3371) — a fresh acquire must clear a STALE `.git/.lane-verify`
  // marker left by a prior occupant of the same lane, or `verify-lane.mjs verify` refuses to even START the
  // gate for this attempt's own commit (exit 3, `superseded`), which the `verify` operation then misreports as
  // `unrun`. See `scripts/verify-lane.mjs`'s own `reset` subcommand docblock for the real marker path/shape
  // this reuses instead of guessing at a `rm -rf`.
  it('resolves the just-acquired lane\'s real path and clears any stale verify marker via `verify-lane.mjs '
    + 'reset`, using the SAME CLAUDE_CODE_SESSION_ID override the acquire call itself used', () => {
    const calls = [];
    const run = vi.fn((cmd, args, opts) => {
      calls.push(args);
      if (args[0] === 'scripts/lane-pool.mjs' && args[1] === 'acquire') return '';
      if (args[0] === 'scripts/lane-pool.mjs' && args[1] === 'status') {
        return JSON.stringify({ lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/verify-lane.mjs' && args[1] === 'reset') {
        expect(opts.env.CLAUDE_CODE_SESSION_ID).toBe('99999999-9999-4999-8999-999999999999');
        return JSON.stringify({ status: 'reset' });
      }
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    acquireLane(
      { lane: 3, sessionSlug: 'conveyor-3371', scope: 'we:x', item: '3371', claudeSessionId: '99999999-9999-4999-8999-999999999999' },
      { run },
    );
    expect(calls).toEqual([
      ['scripts/lane-pool.mjs', 'acquire', '--lane=3', '--purpose=conveyor-delivery', '--session=conveyor-3371', '--scope=we:x', '--item=3371', '--adopt'],
      ['scripts/lane-pool.mjs', 'status', '--json'],
      ['scripts/verify-lane.mjs', 'reset', '--repo=/real/pool/lane-3', '--json'],
    ]);
  });

  it('swallows a `reset` refusal (e.g. a live foreign lease) rather than failing the whole acquire', () => {
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'scripts/lane-pool.mjs' && args[1] === 'acquire') return '';
      if (args[0] === 'scripts/lane-pool.mjs' && args[1] === 'status') {
        return JSON.stringify({ lanes: [{ lane: 3, path: '/real/pool/lane-3', exists: true }] });
      }
      if (args[0] === 'scripts/verify-lane.mjs' && args[1] === 'reset') {
        const err = new Error('refused: active-lease');
        err.status = 3;
        throw err;
      }
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    });
    expect(() => acquireLane(
      { lane: 3, sessionSlug: 'conveyor-3371', scope: 'we:x', item: '3371', claudeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { run },
    )).not.toThrow();
  });
});

describe('resetStaleVerifyMarker (#3627 attempt-5 finding — shells verify-lane.mjs\'s own sanctioned `reset`)', () => {
  it('calls `verify-lane.mjs reset --repo=<lanePath> --json` with CLAUDE_CODE_SESSION_ID set to claudeSessionId', () => {
    const run = vi.fn(() => JSON.stringify({ status: 'reset' }));
    resetStaleVerifyMarker('/real/pool/lane-4', { run, claudeSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect(run).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = run.mock.calls[0];
    expect(cmd).toBe('node');
    expect(args).toEqual(['scripts/verify-lane.mjs', 'reset', '--repo=/real/pool/lane-4', '--json']);
    expect(opts.env.CLAUDE_CODE_SESSION_ID).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });

  it('never throws when the underlying `run` throws (best-effort, matching a `reset` refusal or a missing lane)', () => {
    const run = vi.fn(() => { throw new Error('boom'); });
    expect(() => resetStaleVerifyMarker('/real/pool/lane-4', { run, claudeSessionId: 'x' })).not.toThrow();
  });
});

// ================================================================================================
// build-path-codex-isolation-locus — the live #3604 finding: dispatching a plateau-app-scoped card via the
// mechanical build path reached the Codex wrapper, but the wrapper only ever acquired a WE lane — Codex
// reported `blocked` ("IMPL_LANE unset", and the plateau-app files were never in any lane it could reach).
// This section covers the fix's own new pure helpers directly; the provider-level `lanePathOverride` behavior
// is covered above (`CODEX_PROVIDER.spawn lanePathOverride` / `CLAUDE_RESTRICTED_PROVIDER.spawn
// lanePathOverride`), and `deliverItem`'s own end-to-end wiring is covered in the final describe block below.
// ================================================================================================
describe('resolveDeliveryLocus (build-path-codex-isolation-locus — which repo an item\'s own scope names)', () => {
  it('defaults to `we` for an empty/no scope — byte-identical to this wrapper\'s behavior before this '
    + 'function existed', () => {
    expect(resolveDeliveryLocus('').profile.key).toBe('we');
    expect(resolveDeliveryLocus('').multiRepo).toBe(false);
    expect(resolveDeliveryLocus(undefined).profile.key).toBe('we');
  });

  it('resolves a we-only scope to `we`', () => {
    const locus = resolveDeliveryLocus('we:scripts/lib/foo.mjs,we:scripts/lib/bar.mjs');
    expect(locus.profile.key).toBe('we');
    expect(locus.multiRepo).toBe(false);
  });

  it('resolves a single non-we locus (the live #3604 shape) to that repo\'s own profile', () => {
    const locus = resolveDeliveryLocus('plateau-app:src/pages/Foo.tsx,plateau-app:src/pages/Bar.tsx');
    expect(locus.multiRepo).toBe(false);
    expect(locus.profile.key).toBe('plateau-app');
    expect(locus.profile.checkoutPath.endsWith('/workspace/plateau-app')).toBe(true);
  });

  it('also resolves the legacy `plateau:` scope prefix to the SAME plateau-app profile (repo-profile.mjs\'s '
    + 'own alias — legacy `plateau` is abandoned, superseded by `plateau-app`)', () => {
    expect(resolveDeliveryLocus('plateau:src/x.ts').profile.key).toBe('plateau-app');
  });

  it('resolves a single frontierui locus', () => {
    expect(resolveDeliveryLocus('fui:packages/x.ts').profile.key).toBe('frontierui');
    expect(resolveDeliveryLocus('frontierui:packages/x.ts').profile.key).toBe('frontierui');
  });

  it('refuses to resolve — reports multiRepo:true — when scope spans TWO OR MORE distinct repos, a genuine '
    + '"couple" build this wrapper defers rather than guesses at (a `we:` + `plateau-app:` mix, e.g. #2662)', () => {
    const locus = resolveDeliveryLocus('we:backlog/2662-x.md,plateau-app:src/y.tsx');
    expect(locus.multiRepo).toBe(true);
    expect(locus.profile).toBe(null);
    expect(locus.keys.sort()).toEqual(['plateau-app', 'we']);
  });

  it('also refuses two non-we repos scoped together', () => {
    const locus = resolveDeliveryLocus('frontierui:a.ts,plateau-app:b.ts');
    expect(locus.multiRepo).toBe(true);
    expect(locus.keys.sort()).toEqual(['frontierui', 'plateau-app']);
  });
});

describe('acquireImplLane (build-path-codex-isolation-locus)', () => {
  it('acquires UNNUMBERED, against the profile\'s own checkoutPath, with --item= (so the drain\'s existing '
    + 'by-item release sweep finds this lane too)', () => {
    const run = vi.fn(() => '/real/pool-pa/lane-4');
    const path = acquireImplLane(
      { sessionSlug: 'conveyor-3604', claudeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', item: '3604', profile: repoProfile('plateau-app') },
      { run },
    );
    expect(path).toBe('/real/pool-pa/lane-4');
    const [cmd, args] = run.mock.calls[0];
    expect(cmd).toBe('node');
    expect(args).toEqual(expect.arrayContaining([
      'scripts/lane-pool.mjs', 'acquire', '--purpose=conveyor-delivery-impl',
      '--session=conveyor-3604', '--item=3604', '--adopt',
    ]));
    expect(args.some((a) => a.startsWith('--repo=') && a.endsWith('/workspace/plateau-app'))).toBe(true);
    expect(args.some((a) => a.startsWith('--lane='))).toBe(false);
    expect(args).toContain('--wait-ms=60000');
  });

  it('reports pool saturation as an empty string, never a throw — the caller (deliverItem) decides what that means', () => {
    const run = vi.fn(() => '');
    const path = acquireImplLane(
      { sessionSlug: 's', claudeSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', item: '1', profile: repoProfile('frontierui') },
      { run },
    );
    expect(path).toBe('');
  });
});

describe('stageDeliveryReportCliIntoLane (build-path-codex-isolation-locus)', () => {
  it('copies the delivery-report CLI\'s own closure to the SAME repo-relative paths inside the foreign lane '
    + '— never a dedicated subdir — so the brief\'s hardcoded `node scripts/operations/delivery-report-cli.mjs` '
    + 'command works completely unmodified whichever repo the lane belongs to', () => {
    const written = {};
    const readFile = vi.fn((p) => `// content of ${p}`);
    const ensureDir = vi.fn();
    const writeFile = vi.fn((p, data) => { written[p] = data; });
    stageDeliveryReportCliIntoLane('/impl/lane', { repoRoot: '/we/root', readFile, ensureDir, writeFile });
    for (const rel of DELIVERY_REPORT_CLI_REL_FILES) {
      expect(readFile).toHaveBeenCalledWith(`/we/root/${rel}`);
      expect(written[`/impl/lane/${rel}`]).toBe(`// content of /we/root/${rel}`);
    }
  });

  it('refuses an empty lanePath rather than silently staging nowhere', () => {
    expect(() => stageDeliveryReportCliIntoLane('')).toThrow(/non-empty absolute path/);
  });
});

// ================================================================================================
// #3627 bug 13 — `deliverItem`'s success-path result string read `prResult.number`, but `openPr`'s return
// should be `open-pr.mjs`'s `classifySubmit` shape, which names the PR `pr`, never `number`. Renaming
// `.number` to `.pr` was NOT the full fix, though: `run.mjs open-pr --json` does not print `classifySubmit`'s
// shape directly — it prints the FULL run-outcome envelope (`cli-adapter.mjs#outcomePayload`), which has no
// top-level `pr`/`url` at all. The real submit result sits nested at `findings.submit.effects[0].result`
// (confirmed empirically by actually running `run.mjs open-pr --json`, never by reading the source alone).
// `openPr` now runs its parsed stdout through `extractSubmitResult` before returning, so `prResult.pr` reads
// the real thing. Live on attempt 6/PR #2109 this printed "PR #undefined" even though the PR opened correctly.
// `deliverItem` itself has no injection points for its own internal calls (see the file-top mock block for why
// every dependency here is mocked at ITS OWN boundary — `execFileSync`/`readFileSync`/`findItem`/
// `tryReadDeliveryReport` — rather than deliverItem's signature), so this drives the REAL, unmodified
// `deliverItem` end to end.
// ================================================================================================
describe('deliverItem (#3627 bug 13 — the success-path result string names the real PR field)', () => {
  let lane;

  beforeEach(() => {
    lane = mkdtempSync(join(tmpdir(), 'deliver-item-wrapper-deliveritem-'));
    findItem.mockReturnValue({ num: '9999', slug: 'bug13-fix', specPath: 'backlog/9999-bug13-fix.md', scope: [] });
    tryReadDeliveryReport.mockReturnValue({ status: 'done', outcome: 'done', filesTouched: ['a.mjs'], reason: 'did it' });
    execFileSync.mockImplementation((cmd, args = []) => {
      const a = args || [];
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
        return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
      }
      if (cmd === 'node' && a[0] === 'scripts/verify-lane.mjs') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'verify') {
        return JSON.stringify({
          runId: 'run-1', op: 'verify', stopped: 'complete', applied: [],
          verdict: { ok: true, cwd: lane, suite: 'run', passed: 2, failed: 0, unrun: 0, checks: [], blocking: [] },
        });
      }
      if (cmd === 'node' && a[0] === 'scripts/converge-cli.mjs' && a[1] === 'init') {
        // land immediately — no edit round needed; bug 14's own commit path has its own dedicated tests above.
        return JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
      }
      if (cmd === 'git') return ''; // decideParkMode's own diff-stats read; empty is a safe, real answer
      if (cmd === 'node' && String(a[0]).endsWith('scripts/operations/run.mjs') && a[1] === 'open-pr') {
        // the REAL `run.mjs open-pr --json` shape: the full run-outcome envelope, with the actual `pr`/`url`
        // nested at `findings.submit.effects[0].result` — never a flat `{pr, url}` object (that was the exact
        // repro for bug 13 still being live after a first, insufficient fix attempt).
        return openPrEnvelope({ outcome: 'opened', pr: 4321, url: 'https://example/pr/4321' });
      }
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
    });
  });

  afterEach(() => {
    rmSync(lane, { recursive: true, force: true });
    // `mockClear()`, never `mockReset()` — `findItem` was created as `vi.fn(actual.findItem)` (see the file-top
    // mock block) so every OTHER describe block above that relies on real `findItem` behavior keeps working;
    // `mockReset()` would strip that default real implementation for the rest of the file.
    findItem.mockClear();
    tryReadDeliveryReport.mockReset();
    execFileSync.mockReset();
  });

  it('refuses to publish a build with no durable dispatch identity', async () => {
    await expect(deliverItem({ item: '9999', lane: 7, scope: [], sessionSlug: 'conveyor-9999', attemptTag: '' },
      { spawn: vi.fn() }, { newSessionId: () => 'uuid-fixed' }))
      .rejects.toThrow('requires a durable dispatch identity');
    expect(execFileSync.mock.calls.some(c => c[0] === 'node' && c[1]?.[1] === 'open-pr')).toBe(false);
  });

  it('uses the real `pr` field — never `number` — so the result names the actual PR, not "PR #undefined"', async () => {
    const result = await deliverItem(
      { item: '9999', lane: 7, scope: [], sessionSlug: 'conveyor-9999', attemptTag: '', runId: 'dispatch-lane-fixture', effectKey: 'dispatch:0:0' },
      { spawn: vi.fn() },
      { newSessionId: () => 'uuid-fixed' },
    );
    expect(result.result).toContain('PR #4321');
    expect(result.result).not.toContain('undefined');
  });

  // #3850 Fork 2 — END-TO-END through the REAL `deliverItem`, not just `decideParkMode` in isolation: proves
  // the real spawned `provider.vendor` actually reaches the park decision and shows up in the real PR outcome.
  it('a Claude-executed delivery (provider.vendor="claude", the real registered CLAUDE_RESTRICTED_PROVIDER shape) opens label-on-green (ready-to-merge)', async () => {
    const result = await deliverItem(
      { item: '9999', lane: 7, scope: [], sessionSlug: 'conveyor-9999', attemptTag: '', runId: 'dispatch-lane-fixture', effectKey: 'dispatch:0:0' },
      { spawn: vi.fn(), vendor: 'claude' },
      { newSessionId: () => 'uuid-fixed' },
    );
    // `deliverItem`'s own `finish()` returns only `{item, result}` — `result` is the human-readable outcome
    // string `PR #<n> (<park label>)` (see its own `finish(\`PR #${prResult.pr} (${parkDecision.label})\`, …)`
    // call), so the park mode this test proves is read off THAT string, not a `.park` field that does not exist.
    expect(result.result).toBe('PR #4321 (ready-to-merge)');
  });

  it('a non-Claude-executed delivery (provider.vendor="codex", the real registered CODEX_PROVIDER shape) is FORCED to review:pending — never lands unreviewed on label-on-green', async () => {
    const result = await deliverItem(
      { item: '9999', lane: 7, scope: [], sessionSlug: 'conveyor-9999', attemptTag: '', runId: 'dispatch-lane-fixture', effectKey: 'dispatch:0:0' },
      { spawn: vi.fn(), vendor: 'codex' },
      { newSessionId: () => 'uuid-fixed' },
    );
    expect(result.result).toBe('PR #4321 (review:pending)');
  });

  // ==============================================================================================
  // build-path-codex-isolation-locus — the live #3604 fix, END TO END through the REAL, unmodified
  // `deliverItem`: a single non-we locus (plateau-app) acquires its OWN implementation lane, spawns the
  // agent turn AND runs the gate/converge/PR against it — never the WE lane `lane: 7` would resolve to.
  // ==============================================================================================
  describe('a single non-we locus (plateau-app) — build-path-codex-isolation-locus', () => {
    let implLane;

    beforeEach(() => {
      implLane = mkdtempSync(join(tmpdir(), 'deliver-item-wrapper-impllane-'));
      findItem.mockReturnValue({ num: '3604', slug: 'plateau-thing', specPath: 'backlog/3604-plateau-thing.md', scope: ['plateau-app:src/foo.tsx'] });
    });

    afterEach(() => {
      rmSync(implLane, { recursive: true, force: true });
    });

    it('acquires the implementation lane, spawns with lanePathOverride, and opens the PR AGAINST IT', async () => {
      const spawn = vi.fn();
      execFileSync.mockImplementation((cmd, args = []) => {
        const a = args || [];
        if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') {
          return a.includes('--purpose=conveyor-delivery-impl') ? implLane : '';
        }
        if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
          return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
        }
        if (cmd === 'node' && a[0] === 'scripts/verify-lane.mjs') return '{}';
        if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') return '{}';
        if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'verify') {
          return JSON.stringify({
            runId: 'run-1', op: 'verify', stopped: 'complete', applied: [],
            verdict: { ok: true, cwd: implLane, suite: 'run', passed: 2, failed: 0, unrun: 0, checks: [], blocking: [] },
          });
        }
        if (cmd === 'node' && a[0] === 'scripts/converge-cli.mjs' && a[1] === 'init') {
          return JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
        }
        if (cmd === 'git') return '';
        if (cmd === 'node' && String(a[0]).endsWith('scripts/operations/run.mjs') && a[1] === 'open-pr') {
          return openPrEnvelope({ outcome: 'opened', pr: 5555, url: 'https://example/pr/5555' });
        }
        throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
      });
      tryReadDeliveryReport.mockReturnValue({ status: 'done', outcome: 'done', filesTouched: ['src/foo.tsx'], reason: 'did it' });

      const result = await deliverItem(
        { item: '3604', lane: 7, scope: ['plateau-app:src/foo.tsx'], sessionSlug: 'conveyor-3604', attemptTag: '', runId: 'dispatch-lane-fixture', effectKey: 'dispatch:0:0' },
        { spawn, vendor: 'codex' },
        { newSessionId: () => 'uuid-fixed' },
      );

      expect(result.result).toBe('PR #5555 (review:pending)');
      // the agent's own turn ran with cwd = the impl lane, never the WE lane.
      expect(spawn.mock.calls[0][0].lanePathOverride).toBe(implLane);
      // the PR itself opened FROM the impl lane (its own `gh`/git state), not WE's.
      const openPrCall = execFileSync.mock.calls.find((c) => c[1]?.[1] === 'open-pr');
      expect(openPrCall[2].cwd).toBe(implLane);
    });

    it('releases the implementation lane too (via the cross-pool sweep — its lane NUMBER is never learned by '
      + 'this wrapper) when the agent reports not-ready', async () => {
      execFileSync.mockImplementation((cmd, args = []) => {
        const a = args || [];
        if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') {
          return a.includes('--purpose=conveyor-delivery-impl') ? implLane : '';
        }
        if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
          return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
        }
        if (cmd === 'node' && a[0] === 'scripts/verify-lane.mjs') return '{}';
        if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') return '{}';
        if (cmd === 'node' && a[0] === 'scripts/backlog.mjs' && a[1] === 'release') return '';
        if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'release') return '';
        throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
      });
      tryReadDeliveryReport.mockReturnValue({ status: 'done', outcome: 'blocked', filesTouched: [], reason: 'blockedBy 1 re-opened' });

      const result = await deliverItem(
        { item: '3604', lane: 7, scope: ['plateau-app:src/foo.tsx'], sessionSlug: 'conveyor-3604', attemptTag: '', runId: 'dispatch-lane-fixture', effectKey: 'dispatch:0:0' },
        { spawn: vi.fn(), vendor: 'codex' },
        { newSessionId: () => 'uuid-fixed' },
      );

      expect(result.result).toBe('not-ready (blockedBy 1 re-opened)');
      expect(execFileSync.mock.calls.some((c) => (
        c[0] === 'node' && c[1][0] === 'scripts/lane-pool.mjs' && c[1][1] === 'release' && c[1].includes('--all-pools')
      ))).toBe(true);
    });

    it('a saturated implementation-lane pool refuses BEFORE claiming the item — no free lane means no claim', async () => {
      const calls = [];
      execFileSync.mockImplementation((cmd, args = []) => {
        const a = args || [];
        calls.push([cmd, a]);
        if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') {
          return a.includes('--purpose=conveyor-delivery-impl') ? '' : ''; // both empty — WE's own return is unused anyway
        }
        if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
          return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
        }
        if (cmd === 'node' && a[0] === 'scripts/backlog.mjs' && a[1] === 'release') return '';
        if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'release') return '';
        throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
      });

      const result = await deliverItem(
        { item: '3604', lane: 7, scope: ['plateau-app:src/foo.tsx'], sessionSlug: 'conveyor-3604', attemptTag: '', runId: 'dispatch-lane-fixture', effectKey: 'dispatch:0:0' },
        { spawn: vi.fn(), vendor: 'codex' },
        { newSessionId: () => 'uuid-fixed' },
      );

      expect(result.result).toBe('blocked-on-infra (no free plateau-app lane)');
      expect(calls.some((c) => c[0] === 'node' && c[1][0] === 'scripts/operations/run.mjs' && c[1][1] === 'claim')).toBe(false);
    });
  });

  it('build-path-codex-isolation-locus — refuses a genuine multi-repo "couple" scope (e.g. #2662, we + '
    + 'plateau-app together) BEFORE acquiring anything, rather than guessing at merge order', async () => {
    findItem.mockReturnValue({ num: '2662', slug: 'couple-thing', specPath: 'backlog/2662-couple-thing.md', scope: ['we:backlog/2662-couple-thing.md', 'plateau-app:src/y.tsx'] });
    execFileSync.mockImplementation((cmd, args = []) => {
      throw new Error(`unexpected execFileSync — the couple refusal must fire before any acquire (${cmd} ${JSON.stringify(args)})`);
    });

    await expect(deliverItem(
      { item: '2662', lane: 7, scope: ['we:backlog/2662-couple-thing.md', 'plateau-app:src/y.tsx'], sessionSlug: 'conveyor-2662', attemptTag: '' },
      { spawn: vi.fn(), vendor: 'codex' },
      { newSessionId: () => 'uuid-fixed' },
    )).rejects.toThrow(/multi-repo "couple" build/);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('mergeSettleResult (the positional `outcome` always wins over anything `result` supplies)', () => {
  it('overrides a same-named `outcome` field inside `result`', () => {
    expect(mergeSettleResult('not-ready', { outcome: 'pr-opened', reason: 'x' })).toEqual({ outcome: 'not-ready', reason: 'x' });
  });
  it('merges every other field from `result` through untouched', () => {
    expect(mergeSettleResult('gate-blocked', { reason: 'r', pr: 42 })).toEqual({ outcome: 'gate-blocked', reason: 'r', pr: 42 });
  });
  it('tolerates a missing/null `result`', () => {
    expect(mergeSettleResult('gate-red')).toEqual({ outcome: 'gate-red' });
    expect(mergeSettleResult('gate-red', null)).toEqual({ outcome: 'gate-red' });
  });
});

// ================================================================================================
// #4349 — a finished delivery wrapper never settled its own run-store effect or released the build-dispatch
// claim, so a no-op dispatch held one of the daemon's cap slots for hours and re-dispatched into the same
// failure. `deliverItem` now settles (`deliver-item-settle.mjs`) and releases/holds the claim
// (`build-dispatch-claim.mjs`) on every terminal exit when its `launch` carries `runId`/`effectKey` (threaded
// from `effect-executor.mjs`'s own per-sink `ctx`, see `dispatch-lane-io.mjs`/`dispatch-providers/build.mjs`/
// `deliver-item-run.mjs`'s own #4349 notes). Drives the REAL, unmodified `deliverItem` end to end against REAL
// on-disk run-store + build-dispatch-claim files (temp dirs, never the repo's own `.operations/` state) — the
// same "mock only execFileSync/fs's one read, everything else real" discipline the rest of this file uses.
// ================================================================================================
describe('deliverItem (#4349 — settles its run-store effect + releases/holds the build-dispatch claim)', () => {
  let lane;
  let runsDir;
  let coordRoot;

  beforeEach(() => {
    lane = mkdtempSync(join(tmpdir(), 'deliver-item-wrapper-settle-'));
    runsDir = mkdtempSync(join(tmpdir(), 'deliver-item-wrapper-settle-runs-'));
    coordRoot = mkdtempSync(join(tmpdir(), 'deliver-item-wrapper-settle-coord-'));
    process.env.OPERATION_RUNS_DIR = runsDir;
    // `releaseBuildDispatchClaim`/`placeBuildDispatchHold` inside `deliverItem` call the claim module with NO
    // injected `lockRoot` (by design — that is the real production call shape), so they resolve their root via
    // `resolveCoordinationRoot()`. Pointing THAT at a throwaway temp dir via its own env override, rather than
    // mocking the module, lets this test drive the real, unmodified call graph end to end while never touching
    // the host's actual coordination root.
    process.env.WE_COORDINATION_ROOT = coordRoot;
    findItem.mockReturnValue({ num: '9001', slug: 'settle-thing', specPath: 'backlog/9001-settle-thing.md', scope: [] });
  });

  afterEach(() => {
    delete process.env.OPERATION_RUNS_DIR;
    delete process.env.WE_COORDINATION_ROOT;
    rmSync(lane, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
    rmSync(coordRoot, { recursive: true, force: true });
    findItem.mockClear();
    tryReadDeliveryReport.mockReset();
    execFileSync.mockReset();
  });

  /** Seeds a schema-valid, `in-flight` `dispatch-lane` run record — the exact shape `applyPendingEffects`
   *  leaves behind before its sink ever reports back. */
  function seedInFlightRun(id) {
    const store = createFileRunStore(runsDir);
    const run = {
      ...newRunRecord({ id, op: 'dispatch-lane' }),
      pending: { kind: 'effect', step: 'dispatch', stepIndex: 0 },
      effects: [{
        key: 'dispatch:0:0', type: 'conveyor.dispatch-delivery-agent', stepIndex: 0, index: 0, status: 'in-flight',
        handle: 'pid:424242', expectedBy: new Date(Date.now() + 90 * 60_000).toISOString(),
        payload: { num: '9001', launchKind: 'build' }, result: null, error: null,
      }],
    };
    store.write(run);
    return store;
  }

  it('#4649 settles a mixed-locus preflight without acquiring or releasing any lane', async () => {
    const store = seedInFlightRun('mixed-locus');
    acquireBuildDispatchClaim({ num: '9001', scope: [] });
    execFileSync.mockClear();
    await expect(deliverItem({ item: '9001', lane: 7, scope: 'we:a,plateau-app:b', sessionSlug: 'conveyor-9001', runId: 'mixed-locus', effectKey: 'dispatch:0:0' }, { spawn: vi.fn() })).rejects.toThrow(/more than one repo/);
    expect(store.read('mixed-locus').effects[0]).toMatchObject({ status: 'failed', result: { outcome: 'unsupported-locus' }, error: expect.stringContaining('#4289') });
    expect(listBuildDispatchClaims()).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('#4649 settles a session preflight throw with the original reason', async () => {
    const store = seedInFlightRun('session-throws');
    acquireBuildDispatchClaim({ num: '9001', scope: [] });
    execFileSync.mockClear();
    await expect(deliverItem({ item: '9001', lane: 7, scope: 'we:a', sessionSlug: 'conveyor-9001', runId: 'session-throws', effectKey: 'dispatch:0:0' }, { spawn: vi.fn() }, { newSessionId: () => { throw new Error('session preflight refused'); } })).rejects.toThrow('session preflight refused');
    expect(store.read('session-throws').effects[0]).toMatchObject({ status: 'failed', error: 'session preflight refused' });
    expect(listBuildDispatchClaims()).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('PR #2921 review — a RESUMED delivery re-leases its lane with --no-reset, never re-claims the (already '
    + 'active) item, reuses the prior done report, and settles the ORIGINAL row from its own outcome — never '
    + '`wrapper-threw`', async () => {
    const store = seedInFlightRun('dispatch-lane-9001r');
    acquireBuildDispatchClaim({ num: '9001', scope: [] });
    tryReadDeliveryReport.mockReturnValue({ status: 'done', outcome: 'blocked', filesTouched: ['x.mjs'], reason: 'blockedBy 1 re-opened' });
    const acquires = [];
    execFileSync.mockImplementation((cmd, args = []) => {
      const a = args || [];
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') { acquires.push(a); return ''; }
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
        return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
      }
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') {
        throw new Error('claim: status is "active", expected "open" — a resume must never re-claim');
      }
      if (cmd === 'git' && a[0] === 'rev-list') return '1\n';
      if (cmd === 'node' && a[0] === 'scripts/backlog.mjs' && a[1] === 'release') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'release') return '';
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
    });
    const spawn = vi.fn();

    const result = await deliverItem(
      {
        item: '9001', lane: 7, scope: [], sessionSlug: 'conveyor-9001', attemptTag: '',
        runId: 'dispatch-lane-9001r', effectKey: 'dispatch:0:0', resume: true,
      },
      { spawn },
      { newSessionId: () => 'uuid-fixed' },
    );

    expect(acquires).toEqual([expect.arrayContaining(['--lane=7', '--no-reset'])]);
    expect(spawn).not.toHaveBeenCalled(); // no fresh agent turn on a resume
    // The prior report's OWN outcome drives the finish (blocked with files touched → blocked-mid-build).
    expect(result.result).toMatch(/^blocked-mid-build \(blockedBy 1 re-opened/);
    const settledEntry = store.read('dispatch-lane-9001r').effects[0];
    expect(settledEntry.status).toBe('applied');
    expect(settledEntry.result.outcome).toBe('blocked-mid-build');
  });

  it('Done-when 1 — a `not-ready` finish settles the effect `applied` with `result.outcome === "not-ready"` '
    + 'and releases the build-dispatch claim', async () => {
    const store = seedInFlightRun('dispatch-lane-9001a');
    acquireBuildDispatchClaim({ num: '9001', scope: [] });
    expect(listBuildDispatchClaims().map((c) => c.meta.num)).toEqual(['9001']);

    tryReadDeliveryReport.mockReturnValue({ status: 'done', outcome: 'blocked', filesTouched: [], reason: 'blockedBy 1 re-opened' });
    execFileSync.mockImplementation((cmd, args = []) => {
      const a = args || [];
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
        return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
      }
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/backlog.mjs' && a[1] === 'release') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'release') return '';
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
    });

    const result = await deliverItem(
      {
        item: '9001', lane: 7, scope: [], sessionSlug: 'conveyor-9001', attemptTag: '',
        runId: 'dispatch-lane-9001a', effectKey: 'dispatch:0:0',
      },
      { spawn: vi.fn() },
      { newSessionId: () => 'uuid-fixed' },
    );

    expect(result.result).toBe('not-ready (blockedBy 1 re-opened)');
    const settledEntry = store.read('dispatch-lane-9001a').effects[0];
    expect(settledEntry.status).toBe('applied');
    expect(settledEntry.result).toEqual({ outcome: 'not-ready', reason: 'blockedBy 1 re-opened' });
    expect(listBuildDispatchClaims()).toEqual([]);
    // This IS the actual guarantee that stops the re-dispatch loop: assert the hold itself, not just the
    // settle + claim release (both of which would stay green even if `hold: report.reason` were dropped
    // from the `not-ready` `settleTerminal` call).
    expect(listBuildDispatchHolds().map((h) => h.meta.num)).toEqual(['9001']);
    expect(listBuildDispatchHolds()[0].meta.reason).toBe('blockedBy 1 re-opened');
  });

  it('a `gate-red` finish also settles the run-store effect + releases the build-dispatch claim — a '
    + 'DIFFERENT terminal outcome than the `not-ready` test above reaching the same settle/release call', async () => {
    seedInFlightRun('dispatch-lane-9001b');
    acquireBuildDispatchClaim({ num: '9001', scope: [] });
    tryReadDeliveryReport.mockReturnValue({ status: 'done', outcome: 'done', filesTouched: ['a.mjs'], reason: 'did it' });
    execFileSync.mockImplementation((cmd, args = []) => {
      const a = args || [];
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
        return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
      }
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/verify-lane.mjs') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'verify') {
        return JSON.stringify({
          runId: 'run-1', op: 'verify', stopped: 'complete', applied: [],
          verdict: { ok: false, cwd: lane, suite: 'run', passed: 1, failed: 1, unrun: 0, checks: [], blocking: [{ name: 'unit' }] },
        });
      }
      if (cmd === 'node' && a[0] === 'scripts/backlog.mjs' && a[1] === 'release') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'release') return '';
      if (cmd === 'git') return ''; // decideParkMode/commitBuildTurn's own diff-stats reads
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
    });

    const result = await deliverItem(
      {
        item: '9001', lane: 7, scope: [], sessionSlug: 'conveyor-9001', attemptTag: '',
        runId: 'dispatch-lane-9001b', effectKey: 'dispatch:0:0',
      },
      { spawn: vi.fn() },
      { newSessionId: () => 'uuid-fixed' },
    );

    expect(result.result).toBe('gate-red');
    const store = createFileRunStore(runsDir);
    expect(store.read('dispatch-lane-9001b').effects[0].status).toBe('applied');
    expect(store.read('dispatch-lane-9001b').effects[0].result).toEqual({ outcome: 'gate-red' });
    expect(listBuildDispatchClaims()).toEqual([]);
    // `gate-red` is a non-`not-ready` terminal outcome, and the whole point of generalizing the hold is that
    // it fires here too, not only on `not-ready`.
    expect(listBuildDispatchHolds().map((h) => h.meta.num)).toEqual(['9001']);
    expect(listBuildDispatchHolds()[0].meta.reason).toBe('gate-red');
  });

  it('a `gate-blocked` finish (the resumed agent\'s own honest `blocked` self-diagnosis, a DIFFERENT terminal '
    + 'outcome than `gate-red`) also places a hold, keyed by the agent\'s own reason', async () => {
    seedInFlightRun('dispatch-lane-9001g');
    acquireBuildDispatchClaim({ num: '9001', scope: [] });
    tryReadDeliveryReport
      .mockReturnValueOnce({ status: 'done', outcome: 'done', filesTouched: ['a.mjs'], reason: 'did it' })
      .mockReturnValueOnce({ status: 'done', outcome: 'blocked', reason: 'stale verify marker for an unrelated sha' });
    execFileSync.mockImplementation((cmd, args = []) => {
      const a = args || [];
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
        return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
      }
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/verify-lane.mjs') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'verify') {
        return JSON.stringify({
          runId: 'run-1', op: 'verify', stopped: 'complete', applied: [],
          verdict: {
            ok: false, cwd: lane, suite: 'run', passed: 0, failed: 0, unrun: 1, checks: [],
            blocking: [{ check: 'verify-lane', why: 'did-not-run', detail: 'usage/git error (exit 3): superseded' }],
          },
        });
      }
      if (cmd === 'node' && a[0] === 'scripts/backlog.mjs' && a[1] === 'release') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'release') return '';
      if (cmd === 'git') return '';
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
    });

    const result = await deliverItem(
      {
        item: '9001', lane: 7, scope: [], sessionSlug: 'conveyor-9001', attemptTag: '',
        runId: 'dispatch-lane-9001g', effectKey: 'dispatch:0:0',
      },
      { spawn: vi.fn() },
      { newSessionId: () => 'uuid-fixed' },
    );

    expect(result.result).toBe('gate-blocked (stale verify marker for an unrelated sha)');
    expect(listBuildDispatchClaims()).toEqual([]);
    expect(listBuildDispatchHolds().map((h) => h.meta.num)).toEqual(['9001']);
    expect(listBuildDispatchHolds()[0].meta.reason).toBe('stale verify marker for an unrelated sha');
  });

  it('a `blocked-mid-build` finish (real work already in the lane, a runtime blocker mid-build) also places '
    + 'a hold, keyed by the agent\'s own reason', async () => {
    seedInFlightRun('dispatch-lane-9001h');
    acquireBuildDispatchClaim({ num: '9001', scope: [] });
    tryReadDeliveryReport.mockReturnValue({
      status: 'done', outcome: 'blocked', filesTouched: ['a.mjs'], reason: 'infra hiccup mid-build',
    });
    execFileSync.mockImplementation((cmd, args = []) => {
      const a = args || [];
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
        return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
      }
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/backlog.mjs' && a[1] === 'release') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'release') return '';
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
    });

    const result = await deliverItem(
      {
        item: '9001', lane: 7, scope: [], sessionSlug: 'conveyor-9001', attemptTag: '',
        runId: 'dispatch-lane-9001h', effectKey: 'dispatch:0:0',
      },
      { spawn: vi.fn() },
      { newSessionId: () => 'uuid-fixed' },
    );

    expect(result.result).toBe('blocked-mid-build (infra hiccup mid-build)');
    expect(listBuildDispatchClaims()).toEqual([]);
    expect(listBuildDispatchHolds().map((h) => h.meta.num)).toEqual(['9001']);
    expect(listBuildDispatchHolds()[0].meta.reason).toBe('infra hiccup mid-build');
  });

  it('a `blocked-on-infra` finish (no free implementation lane for a non-we locus) also places a hold, so a '
    + 'saturated pool does not get re-tried every ~2 minutes either', async () => {
    seedInFlightRun('dispatch-lane-9002i');
    acquireBuildDispatchClaim({ num: '9002', scope: [] });
    findItem.mockReturnValue({ num: '9002', slug: 'plateau-thing', specPath: 'backlog/9002-plateau-thing.md', scope: ['plateau-app:src/foo.tsx'] });
    execFileSync.mockImplementation((cmd, args = []) => {
      const a = args || [];
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') return ''; // saturated
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
        return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
      }
      if (cmd === 'node' && a[0] === 'scripts/backlog.mjs' && a[1] === 'release') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'release') return '';
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
    });

    const result = await deliverItem(
      {
        item: '9002', lane: 7, scope: ['plateau-app:src/foo.tsx'], sessionSlug: 'conveyor-9002', attemptTag: '',
        runId: 'dispatch-lane-9002i', effectKey: 'dispatch:0:0',
      },
      { spawn: vi.fn(), vendor: 'codex' },
      { newSessionId: () => 'uuid-fixed' },
    );

    expect(result.result).toBe('blocked-on-infra (no free plateau-app lane)');
    expect(listBuildDispatchClaims()).toEqual([]);
    expect(listBuildDispatchHolds().map((h) => h.meta.num)).toEqual(['9002']);
    expect(listBuildDispatchHolds()[0].meta.reason).toBe('no free plateau-app lane');
  });

  it.each([
    ['refused', null, 'unverified', null],
    ['unrun', null, 'exit 3 with no parseable report', null],
    ['refused', 777, 'check-red', null],
    ['unrun', 777, 'check-timeout', null],
    ['refused', null, 'unverified', 'sha'],
    ['refused', null, 'unverified', 'ref'],
  ])('#4357 %s pr=%s reason=%s fault=%s preserves the real refusal', async (outcome, pr, reason, fault) => {
    telemetryFaults.failures = [];
    const real = await vi.importActual('node:child_process');
    const git = (args) => real.execFileSync('git', args, { cwd: lane, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['clone', '--shared', '--no-checkout', process.cwd(), '.']);
    const sha = git(['rev-parse', 'HEAD']);
    const store = seedInFlightRun('refusal-4357');
    acquireBuildDispatchClaim({ num: '9001', scope: [] });
    const detail = 'refusing to land: recorded verification is for 5348fd58, not the HEAD being landed (d7350a37)';
    const submit = { outcome, pr, reason, detail };
    tryReadDeliveryReport.mockReturnValue({ status: 'done', outcome: 'done', filesTouched: ['a.mjs'],
      learning: fault === 'ref' ? { kind: 'lesson', summary: 'test' } : null });
    execFileSync.mockImplementation((cmd, args = [], opts = {}) => {
      const a = args || [];
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
        return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
      }
      if (cmd === 'node' && a[0] === 'scripts/verify-lane.mjs') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'verify') {
        return JSON.stringify({
          runId: 'run-1', op: 'verify', stopped: 'complete', applied: [],
          verdict: { ok: true, cwd: lane, suite: 'run', passed: 2, failed: 0, unrun: 0, checks: [], blocking: [] },
        });
      }
      if (cmd === 'node' && a[0] === 'scripts/converge-cli.mjs' && a[1] === 'init') {
        return JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
      }
      if (cmd === 'git') {
        if (a[0] === 'rev-parse' && a[1] === 'HEAD') {
          if (fault === 'sha') throw new Error('sha unavailable');
          return git(a);
        }
        if (a[0] === 'update-ref') {
          if (fault === 'ref') throw new Error('ref unavailable');
          expect(opts.cwd).toBe(lane);
          return git(a);
        }
        return '';
      }
      if (cmd === 'node' && a[0] === 'scripts/conveyor/learnings-drop.mjs') throw new Error('learning unavailable');
      if (cmd === 'node' && String(a[0]).endsWith('scripts/operations/run.mjs') && a[1] === 'open-pr') {
        return openPrEnvelope(submit);
      }
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
    });
    const lines = [];
    const { code, result } = await runDeliverItemCli([
      '--num=9001', '--lane=7', '--session=conveyor-9001', '--provider=claude-restricted',
      '--run-id=refusal-4357', '--effect-key=dispatch:0:0',
    ], { deliver: (launch) => deliverItem(launch, { spawn: vi.fn(), vendor: 'claude' }, { newSessionId: () => 'uuid-fixed' }),
      write: line => lines.push(line), writeErr: line => lines.push(line) });
    console.log(lines.at(-1));
    expect(code).toBe(0);
    expect(result.result).toBe(`${pr ? `PR #${pr} ` : ''}open-refused (${reason}): ${detail}`);
    expect(lines.at(-1)).toContain(`finished — ${result.result}`);
    expect(lines.join('')).not.toContain('PR #null');
    const settled = store.read('refusal-4357').effects[0].result;
    expect(settled).toMatchObject({ outcome: 'open-refused', reason, detail });
    expect(telemetryFaults.failures).toEqual([{ error: 'open-refused', attrs: settled }]);
    expect(execFileSync.mock.calls.some(([cmd, a]) => cmd === 'node' && a[1] === 'release')).toBe(false);
    expect(git(['rev-parse', 'HEAD'])).toBe(sha);
    if (pr) {
      expect(settled.pr).toBe(pr);
      expect(listBuildDispatchClaims()).toHaveLength(1);
      expect(listBuildDispatchHolds()).toEqual([]);
      expect(execFileSync.mock.calls.some(([cmd, a]) => cmd === 'git' && a[0] === 'update-ref')).toBe(false);
    } else {
      expect(listBuildDispatchClaims()).toEqual([]);
      expect(listBuildDispatchHolds()[0].meta.reason).toBe(`open-refused: ${reason}`);
      expect(settled).toMatchObject({ lane, sha: fault === 'sha' ? null : sha,
        keepRef: fault ? null : `refs/keep/9001-${sha.slice(0, 8)}` });
      if (!fault) {
        git(['reset', '--soft', 'HEAD~1']);
        expect(git(['rev-parse', settled.keepRef])).toBe(sha);
        expect(git(['cat-file', '-t', sha])).toBe('commit');
        console.log(`retained ${settled.keepRef} = ${sha}; reset HEAD = ${git(['rev-parse', 'HEAD'])}`);
      }
    }
  });

  it('a `pr-opened` finish settles the effect but leaves the claim HELD and places NO hold — an opened PR is '
    + 'not a failure the daemon should cool down on', async () => {
    seedInFlightRun('dispatch-lane-9003j');
    acquireBuildDispatchClaim({ num: '9003', scope: [] });
    findItem.mockReturnValue({ num: '9003', slug: 'pr-thing', specPath: 'backlog/9003-pr-thing.md', scope: [] });
    tryReadDeliveryReport.mockReturnValue({ status: 'done', outcome: 'done', filesTouched: ['a.mjs'], reason: 'did it' });
    execFileSync.mockImplementation((cmd, args = []) => {
      const a = args || [];
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
        return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
      }
      if (cmd === 'node' && a[0] === 'scripts/verify-lane.mjs') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'verify') {
        return JSON.stringify({
          runId: 'run-1', op: 'verify', stopped: 'complete', applied: [],
          verdict: { ok: true, cwd: lane, suite: 'run', passed: 2, failed: 0, unrun: 0, checks: [], blocking: [] },
        });
      }
      if (cmd === 'node' && a[0] === 'scripts/converge-cli.mjs' && a[1] === 'init') {
        return JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
      }
      if (cmd === 'git') return '';
      if (cmd === 'node' && String(a[0]).endsWith('scripts/operations/run.mjs') && a[1] === 'open-pr') {
        return openPrEnvelope({ outcome: 'opened', pr: 9876, url: 'https://example/pr/9876' });
      }
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
    });

    const result = await deliverItem(
      {
        item: '9003', lane: 7, scope: [], sessionSlug: 'conveyor-9003', attemptTag: '',
        runId: 'dispatch-lane-9003j', effectKey: 'dispatch:0:0',
      },
      { spawn: vi.fn(), vendor: 'claude' },
      { newSessionId: () => 'uuid-fixed' },
    );

    expect(result.result).toContain('PR #9876');
    const store = createFileRunStore(runsDir);
    expect(store.read('dispatch-lane-9003j').effects[0].status).toBe('applied');
    // the claim is deliberately left ALONE on a PR outcome — `build-dispatch-daemon.mjs#doneWhy`'s own
    // PR-observed retirement owns this, not the wrapper racing ahead of it.
    expect(listBuildDispatchClaims().map((c) => c.meta.num)).toEqual(['9003']);
    expect(listBuildDispatchHolds()).toEqual([]);
  });

  it('a `blocked-on-infra` PR-open (#4348-open-pr-retry — a GitHub rate limit AFTER the lane ref is already '
    + 'pushed) settles as `open-pending`, never the generic `wrapper-threw`, and places a hold so it is not '
    + 'rebuilt — the actual retry is a LATER daemon tick, not this wrapper', async () => {
    seedInFlightRun('dispatch-lane-9004m');
    acquireBuildDispatchClaim({ num: '9004', scope: [] });
    findItem.mockReturnValue({ num: '9004', slug: 'infra-thing', specPath: 'backlog/9004-infra-thing.md', scope: [] });
    tryReadDeliveryReport.mockReturnValue({ status: 'done', outcome: 'done', filesTouched: ['a.mjs'], reason: 'did it' });
    execFileSync.mockImplementation((cmd, args = []) => {
      const a = args || [];
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
        return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
      }
      if (cmd === 'node' && a[0] === 'scripts/verify-lane.mjs') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'verify') {
        return JSON.stringify({
          runId: 'run-1', op: 'verify', stopped: 'complete', applied: [],
          verdict: { ok: true, cwd: lane, suite: 'run', passed: 2, failed: 0, unrun: 0, checks: [], blocking: [] },
        });
      }
      if (cmd === 'node' && a[0] === 'scripts/converge-cli.mjs' && a[1] === 'init') {
        return JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
      }
      if (cmd === 'git') return '';
      if (cmd === 'node' && String(a[0]).endsWith('scripts/operations/run.mjs') && a[1] === 'open-pr') {
        // the REAL shape a rate-limited `gh pr create` produces end to end: `run.mjs open-pr --json` exits 1
        // (`effect-halted`), still printing the outcome envelope to stdout — exactly what `execFileSync` throws.
        const err = new Error('Command failed: run.mjs open-pr'); err.status = 1; err.stderr = '';
        err.stdout = openPrHaltedEnvelope(
          'open-pr: pr-land did not report a result — blocked-on-infra. The PR was NOT opened, and this is not '
          + 'a refusal you can fix by editing the request.',
        );
        throw err;
      }
      if (cmd === 'node' && a[0] === 'scripts/backlog.mjs' && a[1] === 'release') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'release') return '';
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
    });

    const result = await deliverItem(
      {
        item: '9004', lane: 7, scope: [], sessionSlug: 'conveyor-9004', attemptTag: '',
        runId: 'dispatch-lane-9004m', effectKey: 'dispatch:0:0',
      },
      { spawn: vi.fn(), vendor: 'claude' },
      { newSessionId: () => 'uuid-fixed' },
    );

    expect(result.result).toMatch(/^open-pending \(blocked-on-infra/);
    const store = createFileRunStore(runsDir);
    expect(store.read('dispatch-lane-9004m').effects[0].status).toBe('applied');
    expect(store.read('dispatch-lane-9004m').effects[0].result).toEqual({ outcome: 'open-pending', reason: 'blocked-on-infra' });
    // Never rebuilt: the claim is released AND a hold is placed, exactly like every other non-PR terminal
    // outcome above. The difference from `wrapper-threw` is legibility (a dry-run/status read can now tell
    // "this will self-recover" apart from "something actually broke"), never the re-dispatch guard itself.
    expect(listBuildDispatchClaims()).toEqual([]);
    expect(listBuildDispatchHolds().map((h) => h.meta.num)).toEqual(['9004']);
    expect(listBuildDispatchHolds()[0].meta.reason).toBe('open-pending');
  });

  it('finding #7 — a throw AFTER an earlier `settleTerminal` already ran (here, `finish()` itself blowing up '
    + 'right after the `pr-opened` branch settled) never re-fires: the outer catch\'s `wrapper-threw` settle '
    + 'must not release the claim `pr-opened` deliberately left held, nor place a `wrapper-threw` hold over it',
  async () => {
    seedInFlightRun('dispatch-lane-9003k');
    acquireBuildDispatchClaim({ num: '9003', scope: [] });
    findItem.mockReturnValue({ num: '9003', slug: 'pr-thing', specPath: 'backlog/9003-pr-thing.md', scope: [] });
    tryReadDeliveryReport.mockReturnValue({ status: 'done', outcome: 'done', filesTouched: ['a.mjs'], reason: 'did it' });
    execFileSync.mockImplementation((cmd, args = []) => {
      const a = args || [];
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
        return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
      }
      if (cmd === 'node' && a[0] === 'scripts/verify-lane.mjs') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'verify') {
        return JSON.stringify({
          runId: 'run-1', op: 'verify', stopped: 'complete', applied: [],
          verdict: { ok: true, cwd: lane, suite: 'run', passed: 2, failed: 0, unrun: 0, checks: [], blocking: [] },
        });
      }
      if (cmd === 'node' && a[0] === 'scripts/converge-cli.mjs' && a[1] === 'init') {
        return JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
      }
      if (cmd === 'git') return '';
      if (cmd === 'node' && String(a[0]).endsWith('scripts/operations/run.mjs') && a[1] === 'open-pr') {
        return openPrEnvelope({ outcome: 'opened', pr: 9877, url: 'https://example/pr/9877' });
      }
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
    });

    telemetryFaults.throwOnNextRootOk = true;
    await expect(deliverItem(
      {
        item: '9003', lane: 7, scope: [], sessionSlug: 'conveyor-9003', attemptTag: '',
        runId: 'dispatch-lane-9003k', effectKey: 'dispatch:0:0',
      },
      { spawn: vi.fn(), vendor: 'claude' },
      { newSessionId: () => 'uuid-fixed' },
    )).rejects.toThrow(/telemetry root\.ok threw after settle/);

    const store = createFileRunStore(runsDir);
    // the run-store settle from the FIRST (`pr-opened`) call stands — the outer catch's own settle attempt is
    // a no-op and must not overwrite it with `wrapper-threw`.
    expect(store.read('dispatch-lane-9003k').effects[0].result).toEqual({ outcome: 'pr-opened', pr: 9877, park: expect.any(String) });
    // the claim `pr-opened` deliberately left HELD must still be held — not released by the later throw.
    expect(listBuildDispatchClaims().map((c) => c.meta.num)).toEqual(['9003']);
    // and no `wrapper-threw` hold was placed over the (correctly absent) `pr-opened` non-hold.
    expect(listBuildDispatchHolds()).toEqual([]);
  });

  it('with no `runId`/`effectKey`, ONLY the run-store settle is a no-op — the claim release and hold still '
    + 'fire, because a hand-run CLI invocation with no dispatch-lane run behind it still took a real claim and '
    + 'should still have it released/held like any other attempt; every existing caller/test in this file that '
    + 'predates #4349 keeps working unchanged either way', async () => {
    acquireBuildDispatchClaim({ num: '9001', scope: [] });
    tryReadDeliveryReport.mockReturnValue({ status: 'done', outcome: 'blocked', filesTouched: [], reason: 'stale/superseded' });
    execFileSync.mockImplementation((cmd, args = []) => {
      const a = args || [];
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
        return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
      }
      if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') return '{}';
      if (cmd === 'node' && a[0] === 'scripts/backlog.mjs' && a[1] === 'release') return '';
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'release') return '';
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
    });

    const result = await deliverItem(
      { item: '9001', lane: 7, scope: [], sessionSlug: 'conveyor-9001', attemptTag: '' },
      { spawn: vi.fn() },
      { newSessionId: () => 'uuid-fixed' },
    );

    expect(result.result).toBe('not-ready (stale/superseded)');
    expect(listBuildDispatchClaims()).toEqual([]);
    expect(listBuildDispatchHolds().map((h) => h.meta.num)).toEqual(['9001']);
    expect(listBuildDispatchHolds()[0].meta.reason).toBe('stale/superseded');
  });

  // Acquisition itself can refuse before this attempt owns any resource.
  it('settles `failed` + releases the claim even when `acquireLane` itself throws, before this attempt '
    + 'owns a lane (and therefore without any release attempt)', async () => {
    mkdirSync(join(lane, '.git'), { recursive: true });
    const lease = join(lane, '.git', '.lane-lease');
    const foreign = JSON.stringify({ holder: 'foreign-owner', reserved: true });
    writeFileSync(lease, foreign);
    const store = seedInFlightRun('dispatch-lane-9001c');
    acquireBuildDispatchClaim({ num: '9001', scope: [] });
    execFileSync.mockImplementation((cmd, args = []) => {
      const a = args || [];
      if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'acquire') {
        throw new Error('lane pool exhausted');
      }
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(a)})`);
    });

    await expect(deliverItem(
      {
        item: '9001', lane: 7, scope: [], sessionSlug: 'conveyor-9001', attemptTag: '',
        runId: 'dispatch-lane-9001c', effectKey: 'dispatch:0:0',
      },
      { spawn: vi.fn() },
      { newSessionId: () => 'uuid-fixed' },
    )).rejects.toThrow(/lane pool exhausted/);

    const settledEntry = store.read('dispatch-lane-9001c').effects[0];
    expect(settledEntry.status).toBe('failed');
    expect(settledEntry.error).toContain('lane pool exhausted');
    expect(listBuildDispatchClaims()).toEqual([]);
    // `wrapper-threw` is exactly as re-dispatch-loop-prone as `not-ready` (a deterministic throw would
    // otherwise get re-tried every ~2 minutes with no cooldown at all).
    expect(listBuildDispatchHolds().map((h) => h.meta.num)).toEqual(['9001']);
    expect(listBuildDispatchHolds()[0].meta.reason).toBe('wrapper-threw');
    expect(readFileSync(lease, 'utf8')).toBe(foreign);
    expect(execFileSync.mock.calls.some(([, args]) => args?.[1] === 'release')).toBe(false);
  });
});

// ================================================================================================
// 117 S3a (D7 FINAL) — the build path on the unified detached worker wrapper, behind `WE_WORKER_WRAPPER`.
// OFF is byte-identical to before; ON hands the child to `runWorker` with the schema on the argv and reads the
// build report back from the v2 envelope.
// ================================================================================================
describe('117 S3a: CLAUDE_RESTRICTED_PROVIDER on the unified worker wrapper', () => {
  const REQUEST = { sessionId: '77777777-7777-4777-8777-777777777777', prompt: 'build item #4001', lane: 3, sessionSlug: 'conveyor-4001', item: '4001', attemptTag: '' };
  const fakeIo = (over = {}) => ({
    ensureSettingsFile: vi.fn(() => '/fake/.operations/delivery-agent-hooks-settings.json'),
    spawnAgent: vi.fn(async () => ({ stdout: '', stderr: '' })),
    resolveLane: vi.fn(() => '/fake/pool/lane-3'),
    resolveReportsDir: vi.fn(() => '/fake/pool/lane-3/.operations/delivery-reports'),
    ...over,
  });
  const DONE = { v: 1, outcome: 'done', summary: 'built it', blocker: null, findingsAddressed: [], filesTouched: ['a.mjs'], learning: null };

  it('knob OFF: no schema flags, the old spawn runs, and nothing is returned (byte-identical)', async () => {
    const io = fakeIo({ workerWrapper: false, runWorkerFn: vi.fn() });
    const out = await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(REQUEST, io);
    expect(out).toBeUndefined();
    expect(io.runWorkerFn).not.toHaveBeenCalled();
    const [argv] = io.spawnAgent.mock.calls[0];
    expect(argv).not.toContain('--json-schema');
    expect(argv.at(-1)).toBe('build item #4001');
  });

  it('knob ON: runWorker gets role build, launcher claude-p, the 60-minute budget, the delivery env and a schema argv', async () => {
    const runWorkerFn = vi.fn(async () => ({ envelope: { v: 2 } }));
    const io = fakeIo({ workerWrapper: true, runWorkerFn });
    await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(REQUEST, io);
    expect(io.spawnAgent).not.toHaveBeenCalled(); // the wrapper owns the process
    const [spec, wio] = runWorkerFn.mock.calls[0];
    expect(spec).toMatchObject({ role: 'build', launcher: 'claude-p', session: 'conveyor-4001', command: 'claude', cwd: '/fake/pool/lane-3', timeoutMs: DELIVERY_AGENT_SPAWN_TIMEOUT_MS, item: '4001' });
    expect(spec.env.WE_DISPATCH_KIND).toBe('delivery');
    expect(spec.argv).toContain('-p');
    expect(spec.argv[spec.argv.indexOf('--output-format') + 1]).toBe('json');
    expect(JSON.parse(spec.argv[spec.argv.indexOf('--json-schema') + 1]).$id).toBe('we.worker-result/v1');
    expect(spec.argv.at(-1)).toContain('build item #4001');
    expect(spec.argv.at(-1)).toContain('StructuredOutput');
    expect(typeof wio.legacyRead).toBe('function');
  });

  it('knob ON, resumed turn: --resume is kept and the schema is on it too (D7: resume with the schema)', async () => {
    const runWorkerFn = vi.fn(async () => ({ envelope: { v: 2 } }));
    await DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn({ ...REQUEST, resumeSessionId: 'abc-resume' }, fakeIo({ workerWrapper: true, runWorkerFn }));
    const [spec] = runWorkerFn.mock.calls[0];
    expect(spec.argv).toContain('--resume');
    expect(spec.argv).toContain('-p');
    expect(spec.argv).toContain('--json-schema');
  });

  it('knob ON, end to end with the REAL runWorker: the stdout structured_output becomes the build report and a v2 record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3a-'));
    const prev = process.env.OPERATION_COMPLETIONS_DIR;
    process.env.OPERATION_COMPLETIONS_DIR = dir;
    try {
      const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', structured_output: DONE });
      const provider = { ...DELIVERY_AGENT_PROVIDERS['claude-restricted'], spawn: (req) => DELIVERY_AGENT_PROVIDERS['claude-restricted'].spawn(req, fakeIo({ workerWrapper: true, spawnAgent: vi.fn(async () => ({ stdout, stderr: '' })) })) };
      const readReport = vi.fn(() => { throw new Error('the delivery report must not be read in wrapped mode'); });
      const report = await runAgentToCompletion(
        { item: '4001', sessionSlug: 'conveyor-4001', lane: 3, attemptTag: '', provider, claudeSessionId: REQUEST.sessionId },
        { readBrief: () => 'Read backlog/{{ITEM_SPEC_PATH_BASENAME}}.', readReport, loadItems: () => [{ num: '4001', slug: 'x', scope: [] }], resolveLane: () => '/fake/pool/lane-3' },
      );
      expect(report).toMatchObject({ status: 'done', outcome: 'done', filesTouched: ['a.mjs'] });
      expect(JSON.parse(readFileSync(join(dir, 'conveyor-4001.json'), 'utf8'))).toMatchObject({ v: 2, kind: 'build', status: 'done', outcome: 'done', source: 'worker-result' });
    } finally {
      if (prev === undefined) delete process.env.OPERATION_COMPLETIONS_DIR; else process.env.OPERATION_COMPLETIONS_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('buildReportFromEnvelope (same shape as the delivery report it replaces)', () => {
    const env = (result, over = {}) => ({ v: 2, status: 'done', item: '4001', startedAt: '2026-10-08T10:00:00.000Z', updatedAt: '2026-10-08T10:01:00.000Z', result, ...over });
    const blocked = (kind, files = []) => ({ ...DONE, outcome: 'blocked', filesTouched: files, summary: 'stuck', blocker: { kind, component: 'c', evidence: { text: 'why', refs: [] }, proposedFix: null, ruling: null, deniedCommand: null, retryable: false } });
    it('done / needs-ruling / other blocked / no-change map to the three build outcomes', () => {
      expect(buildReportFromEnvelope({ envelope: env(DONE) }, 's')).toMatchObject({ status: 'done', outcome: 'done', filesTouched: ['a.mjs'] });
      expect(buildReportFromEnvelope({ envelope: env(blocked('needs-ruling')) }, 's')).toMatchObject({ outcome: 'needs-human-judgment', filesTouched: [] });
      expect(buildReportFromEnvelope({ envelope: env(blocked('gate-red', ['b.mjs'])) }, 's')).toMatchObject({ outcome: 'blocked', filesTouched: ['b.mjs'] });
      expect(buildReportFromEnvelope({ envelope: env({ ...DONE, outcome: 'no-change', filesTouched: [] }) }, 's')).toMatchObject({ outcome: 'blocked', filesTouched: [] });
    });
    it('the old delivery report comes through untouched when the wrapper fell back to it', () => {
      const legacy = { status: 'done', outcome: 'done', filesTouched: ['z.mjs'], learning: { kind: 'friction' } };
      expect(buildReportFromEnvelope({ envelope: env(DONE), legacyRecord: legacy }, 's')).toBe(legacy);
    });
    it('unparseable, aborted and not-done throw the same crash error a missing report always did', () => {
      for (const e of [env({ outcome: 'unparseable' }, { parse: { ok: false, reason: 'timeout' } }), env({ outcome: 'aborted' }), env(null, { status: 'started' })]) {
        expect(() => buildReportFromEnvelope({ envelope: e }, 'conveyor-4001')).toThrow(/exited with no done report/);
      }
      expect(envelopeReportOrNull(null, 's')).toBeNull();
    });
  });
});
