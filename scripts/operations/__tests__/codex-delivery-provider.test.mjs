/**
 * @file codex-delivery-provider.test.mjs — argv-contract + thread-mapping coverage for #3580's REAL Codex
 * implementation of the `DeliveryAgentProvider` port (`we:scripts/operations/codex-delivery-provider.mjs`).
 *
 * SAME REASONING `deliver-item-wrapper.test.mjs` states for the Claude side, applied to the second CLI: "the
 * argv IS the contract with the CLI and a test that asserts it is the only thing standing between a flag
 * rename and a silent non-dispatch." Everything asserted below was FIRST observed in a real `codex exec`
 * invocation (codex-cli 0.153.4) and only THEN pinned here — `we:docs/agent/prototype-based-dev.md`'s
 * "mocking the spawn is the exact seam every real bug lived in" discipline. No test in this file runs a real
 * `codex` process; the process boundary is mocked, and the behaviour it is mocked to have is the behaviour
 * that was measured.
 *
 * THE MEASURED FACTS THESE TESTS EXIST TO FREEZE, each from a live run:
 *   - a fresh `codex exec` with this exact argv blocked ~10s, exited 0, and wrote the requested file;
 *   - a `codex exec resume <thread-id>` with this exact argv blocked ~9s, re-announced the SAME thread id, and
 *     recalled the previous turn from memory — a genuine continuation, not a new session;
 *   - `codex exec resume --help` lists NO `-s` and NO `-C`, which is WHY the sandbox rides `-c` and the resume
 *     branch omits `-C`;
 *   - `-c project_doc_max_bytes=0` genuinely suppressed the AGENTS.md auto-load (the agent said so when asked);
 *   - the `filesystem` deny map was honoured in the same run.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  CODEX_CLI, CODEX_DELIVERY_MODEL, CODEX_DELIVERY_EFFORT, CODEX_DELIVERY_EFFORT_LEVELS,
  CODEX_THREAD_DIR_NAME, buildCodexDeliveryArgv, parseCodexThreadId, assertDenyPathsUsable,
  defaultDeliveryDenyPaths, defaultSpawnCodexAgent, codexThreadIdPath, readCodexThreadId, writeCodexThreadId,
  FIX_REPORT_CLI_REL_FILES, CODEX_FIX_REPORT_CLI_STAGING_SUBDIR, stageFixReportCliIntoLane,
} from '../codex-delivery-provider.mjs';
import { usageReportSecretDir } from '../../lib/usage-report-secret-paths.mjs';
import { parseCodexTurnTokenUsage, recordCodexTurnUsage } from '../codex-delivery-provider.mjs';
import { createMemoryTelemetryStore, createTelemetryRecorder, setActiveRecorder } from '../telemetry-store.mjs';

const LANE = '/Users/x/workspace/.lanes/web-everything/lane-7';
const DENY = ['/Users/x/workspace/webeverything/**'];

/**
 * #3383 mechanical-dispatcher follow-up — `defaultSpawnCodexAgent` is now ASYNC, built on
 * `scripts/lib/spawn-to-completion.mjs#spawnToCompletion`'s real async `child_process.spawn()` primitive
 * instead of the old synchronous `execFileSync`. Its own injectable seam is therefore `spawnFn` (a
 * `child_process.spawn`-shaped function returning an EventEmitter-ish `ChildProcess`), not the old bare
 * `exec` (an `execFileSync`-shaped function returning a plain string synchronously). This fakes JUST enough
 * of a real `ChildProcess` for `spawnToCompletion` to drive to completion: `stdout`/`stderr` streams,
 * an async `'exit'` followed by the final output and `'close'`, and a real-shaped `resourceUsage()`.
 */
function fakeChildProcess({ stdout = '', stderr = '', code = 0, signal = null, resourceUsage = { userCPUTime: 1000, systemCPUTime: 500 } } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    resourceUsage: () => resourceUsage,
  });
  queueMicrotask(() => {
    child.emit('exit', code, signal);
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit('close', code, signal);
  });
  return child;
}

describe('buildCodexDeliveryArgv — the fresh-spawn shape', () => {
  it('is the exact argv a real `codex exec` run was verified against', () => {
    expect(buildCodexDeliveryArgv({ prompt: 'BUILD', cwd: LANE, denyPaths: DENY })).toEqual([
      'exec',
      '-C', LANE,
      '--json',
      '--skip-git-repo-check',
      '-m', CODEX_DELIVERY_MODEL,
      '-c', `model_reasoning_effort=${CODEX_DELIVERY_EFFORT}`,
      '--strict-config',
      '-c', 'permissions={locked={extends=":workspace",filesystem={"/Users/x/workspace/webeverything/**"="deny"}}}',
      '-c', 'default_permissions=locked',
      '-c', 'project_doc_max_bytes=0',
      'BUILD',
    ]);
  });

  // THE LOAD-BEARING NEGATIVE. `-s` is the obvious way to get write access and it is WRONG here twice over:
  // `codex exec resume` does not accept it at all (so it cannot give this port one posture across both
  // branches), and #3371 Probe 14f measured that `-s` silently makes the `permissions` deny map have ZERO
  // effect. A future edit that "helpfully" adds `-s workspace-write` would look harmless and would quietly
  // disable the sandbox this provider's whole safety argument rests on.
  it('passes NO `-s` sandbox flag — the sandbox rides `-c default_permissions=locked` instead', () => {
    const argv = buildCodexDeliveryArgv({ prompt: 'BUILD', cwd: LANE, denyPaths: DENY });
    expect(argv).not.toContain('-s');
    expect(argv).not.toContain('--sandbox');
    expect(argv).not.toContain('workspace-write');
    expect(argv).toContain('default_permissions=locked');
  });

  // `--ephemeral` writes no session to disk, and a session never persisted cannot be resumed. This port
  // REQUIRES resume (the gate-failure hand-back), unlike the fire-and-forget judge role which does pass it.
  it('passes NO `--ephemeral` — persistence is what makes the gate-failure resume possible at all', () => {
    expect(buildCodexDeliveryArgv({ prompt: 'BUILD', cwd: LANE, denyPaths: DENY })).not.toContain('--ephemeral');
  });

  it('always pins the model explicitly (#x8wbivt "never inherit, never implicit")', () => {
    const argv = buildCodexDeliveryArgv({ prompt: 'BUILD', cwd: LANE, denyPaths: DENY });
    expect(argv[argv.indexOf('-m') + 1]).toBe(CODEX_DELIVERY_MODEL);
  });

  it('puts the prompt LAST and positionally — safe only because the spawn closes stdin', () => {
    const argv = buildCodexDeliveryArgv({ prompt: 'THE PROMPT', cwd: LANE, denyPaths: DENY });
    expect(argv.at(-1)).toBe('THE PROMPT');
  });

  it('forwards an explicit effort unchanged, with no clamp (#x8wbivt: clamping silently downgraded a choice)', () => {
    for (const level of CODEX_DELIVERY_EFFORT_LEVELS) {
      const argv = buildCodexDeliveryArgv({ prompt: 'B', cwd: LANE, denyPaths: DENY, effort: level });
      expect(argv).toContain(`model_reasoning_effort=${level}`);
    }
  });

  it('refuses a bad prompt / cwd / model / effort by NAME rather than building a broken argv', () => {
    expect(() => buildCodexDeliveryArgv({ prompt: '', cwd: LANE, denyPaths: DENY })).toThrow(/`prompt`/);
    expect(() => buildCodexDeliveryArgv({ prompt: 'B', cwd: '', denyPaths: DENY })).toThrow(/`cwd`/);
    expect(() => buildCodexDeliveryArgv({ prompt: 'B', cwd: LANE, denyPaths: DENY, model: '--evil' })).toThrow(/`model`/);
    expect(() => buildCodexDeliveryArgv({ prompt: 'B', cwd: LANE, denyPaths: DENY, effort: 'turbo' })).toThrow(/`effort`/);
    expect(() => buildCodexDeliveryArgv({ prompt: 'B', cwd: LANE, denyPaths: [] })).toThrow(/denyPaths/);
  });
});

describe('buildCodexDeliveryArgv — the resume shape', () => {
  it('is `exec resume <thread-id>` and carries the IDENTICAL sandbox/doctrine config as the fresh branch', () => {
    expect(buildCodexDeliveryArgv({
      prompt: 'FIX THE GATE', cwd: LANE, denyPaths: DENY, resumeThreadId: '01a09890-c29f-7ce1-ab81-3d3a6ea6c68d',
    })).toEqual([
      'exec', 'resume', '01a09890-c29f-7ce1-ab81-3d3a6ea6c68d',
      '--json',
      '--skip-git-repo-check',
      '-m', CODEX_DELIVERY_MODEL,
      '-c', `model_reasoning_effort=${CODEX_DELIVERY_EFFORT}`,
      '--strict-config',
      '-c', 'permissions={locked={extends=":workspace",filesystem={"/Users/x/workspace/webeverything/**"="deny"}}}',
      '-c', 'default_permissions=locked',
      '-c', 'project_doc_max_bytes=0',
      'FIX THE GATE',
    ]);
  });

  it('4443: nonempty writableRoots yield identical permission args on fresh and resume, with no -s', () => {
    const o = { prompt: 'P', cwd: LANE, denyPaths: DENY, writableRoots: ['/Users/x/we-lane'] };
    const fresh = buildCodexDeliveryArgv(o);
    const resumed = buildCodexDeliveryArgv({ ...o, resumeThreadId: 'tid' });
    expect(fresh).toContain('permissions={locked={extends=":workspace",filesystem={"/Users/x/workspace/webeverything/**"="deny","/Users/x/we-lane"="write"}}}');
    expect(fresh.slice(3)).toEqual(resumed.slice(3));
    expect(fresh).not.toContain('-s');
    expect(resumed).not.toContain('--add-dir');
  });

  // `codex exec resume --help`'s real flag list has no `-C`. Passing one is an argv error, not a no-op, so the
  // resume's working root MUST come from the spawned process's own `cwd` option instead.
  it('omits `-C` — `codex exec resume` does not accept it; cwd rides the spawn options', () => {
    const argv = buildCodexDeliveryArgv({ prompt: 'F', cwd: LANE, denyPaths: DENY, resumeThreadId: 'tid' });
    expect(argv).not.toContain('-C');
    expect(argv).not.toContain(LANE);
  });

  it('keeps the two branches identical apart from the head and the missing `-C`', () => {
    const fresh = buildCodexDeliveryArgv({ prompt: 'P', cwd: LANE, denyPaths: DENY });
    const resumed = buildCodexDeliveryArgv({ prompt: 'P', cwd: LANE, denyPaths: DENY, resumeThreadId: 'tid' });
    expect(fresh.slice(3)).toEqual(resumed.slice(3));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// #3635 Fork 1 — "Every Codex invocation names its model explicitly."
//
// This provider was ALREADY compliant on behaviour: it has always pushed `-m` unconditionally, so unlike the
// judge seat it was never riding `codex exec`'s implicit default. What it carried instead was a hand-copied
// `'gpt-6-astra'` literal — a THIRD copy of a ratified constant, whose own header called the duplication out
// as a real follow-up. These freeze both halves: the pin is emitted on every path, and it is the SHARED
// constant, so a re-ratification of the model cannot land on one copy and silently miss this one.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('#3635 — the delivery agent names its model explicitly, from the one ratified source', () => {
  const ROUTING = () => import('../../lib/codex-model-routing.mjs');

  it('emits -m with the ratified pin on the FRESH-SPAWN path', () => {
    const argv = buildCodexDeliveryArgv({ prompt: 'BUILD', cwd: LANE, denyPaths: DENY });
    const at = argv.indexOf('-m');
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe('gpt-6-astra');
    expect(argv.filter((a) => a === '-m')).toHaveLength(1);
  });

  it('emits the SAME -m on the RESUME path — a continuation cannot drift onto another model', () => {
    const argv = buildCodexDeliveryArgv({ prompt: 'F', cwd: LANE, denyPaths: DENY, resumeThreadId: 'tid' });
    expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-6-astra');
  });

  it('emits an explicit -c model_reasoning_effort on BOTH paths — effort is pinned, never inherited', () => {
    for (const opts of [{}, { resumeThreadId: 'tid' }]) {
      const argv = buildCodexDeliveryArgv({ prompt: 'P', cwd: LANE, denyPaths: DENY, ...opts });
      expect(argv, JSON.stringify(opts))
        .toEqual(expect.arrayContaining(['-c', `model_reasoning_effort=${CODEX_DELIVERY_EFFORT}`]));
    }
  });

  it('CODEX_DELIVERY_MODEL is an ALIAS of the shared constant, not a second declaration of the literal', async () => {
    const { CODEX_MODEL } = await ROUTING();
    expect(CODEX_DELIVERY_MODEL).toBe(CODEX_MODEL);
  });

  it('the accepted effort vocabulary is DERIVED from the shared map, not retyped', async () => {
    const { CODEX_EFFORT_MAP } = await ROUTING();
    expect(CODEX_DELIVERY_EFFORT_LEVELS).toEqual(Object.keys(CODEX_EFFORT_MAP));
    // The unclamped top three are genuinely accepted, not just listed.
    for (const level of ['xhigh', 'max', 'ultra']) {
      expect(CODEX_DELIVERY_EFFORT_LEVELS, level).toContain(level);
    }
  });

  it('the default effort is the ratified `sonnet` rung, resolved rather than retyped', async () => {
    const { resolveCodexEffort, CODEX_TIER_EFFORT } = await ROUTING();
    expect(CODEX_DELIVERY_EFFORT).toBe(resolveCodexEffort({ tier: 'sonnet' }));
    expect(CODEX_DELIVERY_EFFORT).toBe(CODEX_TIER_EFFORT.sonnet);
  });

  it('REGRESSION — no reachable input omits -m', () => {
    for (const opts of [{}, { model: undefined }, { resumeThreadId: 'tid' }, { effort: 'ultra' }]) {
      const argv = buildCodexDeliveryArgv({ prompt: 'P', cwd: LANE, denyPaths: DENY, ...opts });
      expect(argv, JSON.stringify(opts)).toContain('-m');
    }
  });

  it('still refuses a flag-shaped or empty model rather than falling back to the implicit default', () => {
    for (const bad of ['--evil', '-x', '', '   ', null, 42]) {
      expect(
        () => buildCodexDeliveryArgv({ prompt: 'P', cwd: LANE, denyPaths: DENY, model: bad }),
        JSON.stringify(bad),
      ).toThrow(/plain non-empty string/);
    }
  });
});

describe('parseCodexThreadId', () => {
  // The literal event shape observed on the wire, verbatim from a real run's stdout.
  const LIVE = '{"type":"thread.started","thread_id":"01a09890-c29f-7ce1-ab81-3d3a6ea6c68d"}\n'
    + '{"type":"turn.started"}\n{"type":"turn.completed"}\n';

  it('pulls the id out of the real `thread.started` event shape', () => {
    expect(parseCodexThreadId(LIVE)).toBe('01a09890-c29f-7ce1-ab81-3d3a6ea6c68d');
  });

  it('survives non-JSON noise on the stream rather than losing an id a later line still carries', () => {
    expect(parseCodexThreadId(`Reading additional input from stdin...\n{not json\n${LIVE}`))
      .toBe('01a09890-c29f-7ce1-ab81-3d3a6ea6c68d');
  });

  it('returns null — never throws — when there is no id to find', () => {
    expect(parseCodexThreadId('')).toBeNull();
    expect(parseCodexThreadId(null)).toBeNull();
    expect(parseCodexThreadId('{"type":"turn.completed"}')).toBeNull();
    expect(parseCodexThreadId('{"type":"thread.started"}')).toBeNull();
  });
});

describe('assertDenyPathsUsable / defaultDeliveryDenyPaths', () => {
  it('defaults to denying the whole primary checkout root PLUS the usage-report external secret dir, glob-suffixed', () => {
    // #3383 — every default deny now ALSO covers ~/.we-usage-report/ (scripts/lib/usage-report-secret-paths.mjs),
    // imported from the SAME shared module usage-report.mjs itself resolves, so the two can never drift.
    const secretGlob = `${usageReportSecretDir()}/**`;
    expect(defaultDeliveryDenyPaths('/repo/root/')).toEqual(['/repo/root/**', secretGlob]);
    expect(defaultDeliveryDenyPaths('/repo/root')).toEqual(['/repo/root/**', secretGlob]);
  });

  it('passes a deny that does not cover the lane straight through', () => {
    expect(assertDenyPathsUsable(DENY, LANE)).toBe(DENY);
  });

  // An impossible configuration must fail at argv-build time, not as a baffling mid-run permission error
  // twenty minutes into a real build.
  it('refuses a deny entry that would cover the agent\'s OWN lane', () => {
    expect(() => assertDenyPathsUsable(['/Users/x/workspace/.lanes/**'], LANE))
      .toThrow(/covers the agent's own lane/);
    expect(() => assertDenyPathsUsable([LANE], LANE)).toThrow(/covers the agent's own lane/);
  });

  it('refuses a missing lane path', () => {
    expect(() => assertDenyPathsUsable(DENY, '')).toThrow(/`lanePath`/);
  });
});

// #3383 mechanical-dispatcher Bug 1 — `stageFixReportCliIntoLane` is THE FIX for the sandbox-vs-report-path
// collision (see its own docblock): copy `fix-report-cli.mjs`'s dependency closure into the agent's lane,
// preserving each file's repo-relative path so its existing relative imports resolve unchanged. Real fs
// (mirrors the sidecar suite above's own real-temp-dir convention), because the whole point is that the
// COPIED files are genuinely importable afterward, which a mocked fs cannot prove.
describe('stageFixReportCliIntoLane (#3383 mechanical-dispatcher Bug 1)', () => {
  it('copies every file in the dependency closure into the lane, preserving each repo-relative path', () => {
    const root = mkdtempSync(join(tmpdir(), 'we-codex-fix-cli-root-'));
    const lane = mkdtempSync(join(tmpdir(), 'we-codex-fix-cli-lane-'));
    try {
      const contents = {};
      for (const rel of FIX_REPORT_CLI_REL_FILES) contents[rel] = readFileSync(join(process.cwd(), rel), 'utf8');
      const readFile = (p) => {
        const rel = FIX_REPORT_CLI_REL_FILES.find((r) => p === join(root, r));
        if (!rel) throw new Error(`unexpected read: ${p}`);
        return contents[rel];
      };
      const staged = stageFixReportCliIntoLane(lane, { repoRoot: root, readFile });
      expect(staged).toBe(join(lane, CODEX_FIX_REPORT_CLI_STAGING_SUBDIR, 'scripts/operations/fix-report-cli.mjs'));
      for (const rel of FIX_REPORT_CLI_REL_FILES) {
        const dest = join(lane, CODEX_FIX_REPORT_CLI_STAGING_SUBDIR, rel);
        expect(existsSync(dest)).toBe(true);
        expect(readFileSync(dest, 'utf8')).toBe(contents[rel]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(lane, { recursive: true, force: true });
    }
  });

  // Confirms the copy PRESERVES each file's relative import path well enough to ACTUALLY LOAD as a real Node
  // ESM module graph — a genuine, freshly-spawned `node` process doing a plain dynamic `import()`, not
  // vitest's own module loader (vite's dev-server loader refuses to load a module from outside its configured
  // project root at all — a sandboxing limit of the TEST runner, not of the staged file itself; a real `codex
  // exec` process loads it as a plain Node ESM file with no such restriction). An unresolved relative import
  // (`./fix-report-store.mjs`, `./fix-report-record.mjs`, `../lib/write-all-sync.mjs`) throws
  // `ERR_MODULE_NOT_FOUND` and this process exits non-zero; success prints the two exported function names.
  it('the staged copy is genuinely loadable — every relative import resolves inside the lane', () => {
    const shadowRoot = mkdtempSync(join(tmpdir(), 'we-codex-fix-cli-shadow-'));
    const lane = mkdtempSync(join(tmpdir(), 'we-codex-fix-cli-import-'));
    try {
      for (const rel of FIX_REPORT_CLI_REL_FILES) {
        const dest = join(shadowRoot, rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(join(process.cwd(), rel), 'utf8'));
      }
      const staged = stageFixReportCliIntoLane(lane, { repoRoot: shadowRoot });
      const script = `import(${JSON.stringify(`file://${staged}`)}).then(`
        + 'm => { console.log(typeof m.runReport, typeof m.runShow); process.exit(0); }, '
        + '(e) => { console.error(e); process.exit(1); });';
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      expect(out.trim()).toBe('function function');
    } finally {
      rmSync(shadowRoot, { recursive: true, force: true });
      rmSync(lane, { recursive: true, force: true });
    }
  });

  it('refuses a missing lane path', () => {
    expect(() => stageFixReportCliIntoLane('')).toThrow(/`lanePath`/);
  });

  it('is idempotent — re-staging the same lane just overwrites, never throws', () => {
    const lane = mkdtempSync(join(tmpdir(), 'we-codex-fix-cli-idem-'));
    const readFile = () => 'content';
    try {
      const first = stageFixReportCliIntoLane(lane, { repoRoot: '/fake/root', readFile });
      const second = stageFixReportCliIntoLane(lane, { repoRoot: '/fake/root', readFile });
      expect(first).toBe(second);
    } finally {
      rmSync(lane, { recursive: true, force: true });
    }
  });
});

describe('defaultSpawnCodexAgent — the blocking primitive', () => {
  // THE SINGLE MOST LOAD-BEARING OPTION IN THIS FILE. `codex exec`'s own help: a positional prompt PLUS a
  // piped, never-closed stdin hangs forever. `execFileSync` cannot write to a child's stdin, so `'ignore'`
  // (i.e. /dev/null, immediate EOF) is the only thing standing between this provider and a 60-minute hang.
  it('hands the child an IGNORED stdin — the stdin-trap avoidance the positional prompt depends on', async () => {
    const spawnFn = vi.fn(() => fakeChildProcess({}));
    await defaultSpawnCodexAgent(['exec', 'x'], { cwd: LANE }, { spawnFn });
    expect(spawnFn.mock.calls[0][2].stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('calls the `codex` binary and returns the child\'s stdout (the thread id lives nowhere else)', async () => {
    const spawnFn = vi.fn(() => fakeChildProcess({ stdout: 'STDOUT-BACK' }));
    const result = await defaultSpawnCodexAgent(['exec'], {}, { spawnFn });
    expect(result.stdout).toBe('STDOUT-BACK');
    expect(spawnFn.mock.calls[0][0]).toBe(CODEX_CLI);
    expect(CODEX_CLI).toBe('codex');
  });

  // #3383 mechanical-dispatcher follow-up — `timeout`/`killSignal` are now consumed BY `spawnToCompletion`
  // itself (its own dedicated suite, `scripts/lib/__tests__/spawn-to-completion.test.mjs`, proves the real
  // kill-on-timeout behavior with fake timers) rather than forwarded to the raw `spawn()` call, so this test
  // asserts defaultSpawnCodexAgent threads its OWN real CLI defaults into that shared primitive — verified via
  // a real `getrusage`-shaped `resourceUsage` coming back out, proving the whole chain is wired end to end.
  it('keeps SIGKILL reclamation and a caller-supplied timeout, mirroring dispatch-lane-io.mjs#spawnAgentToCompletion', async () => {
    const spawnFn = vi.fn(() => fakeChildProcess({ resourceUsage: { userCPUTime: 4200, systemCPUTime: 800 } }));
    const result = await defaultSpawnCodexAgent(['exec'], { timeout: 1234 }, { spawnFn });
    // `timeout`/`killSignal`/`encoding`/`maxBuffer` are extracted by `spawnToCompletion` before the raw
    // `spawn()` call, so they never appear in `spawnFn`'s own opts — only genuine child-process options
    // (`cwd`, `env`, `stdio`) do. `stdio` is the one this file's own defaults set unconditionally.
    expect(spawnFn.mock.calls[0][2]).not.toHaveProperty('timeout');
    expect(spawnFn.mock.calls[0][2]).not.toHaveProperty('killSignal');
    expect(spawnFn.mock.calls[0][2].stdio).toEqual(['ignore', 'pipe', 'pipe']);
    // The real payoff of the async conversion: a genuine child `resourceUsage` comes back, not fabricated.
    expect(result.resourceUsage).toEqual({ userCPUTime: 4200, systemCPUTime: 800 });
  });
});

describe('the sessionSlug → Codex thread id sidecar', () => {
  // Codex has no `--session-id`: it mints its own thread id and announces it in the stream. This sidecar is
  // what lets the port's `spawn({ resumeSessionId })` contract stay UNCHANGED for both providers.
  it('round-trips a thread id through a real temp .operations/ sidecar', () => {
    const root = `${mkdtempSync(join(tmpdir(), 'we-codex-thread-'))}/`;
    try {
      expect(readCodexThreadId('sess-1', root)).toBeNull();
      const written = writeCodexThreadId('sess-1', 'tid-abc', root);
      expect(written).toBe(codexThreadIdPath('sess-1', root));
      expect(existsSync(written)).toBe(true);
      expect(readCodexThreadId('sess-1', root)).toBe('tid-abc');
      expect(JSON.parse(readFileSync(written, 'utf8'))).toMatchObject({ sessionSlug: 'sess-1', threadId: 'tid-abc' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('lands under the same `.operations/` sidecar family the delivery report and failure captures use', () => {
    expect(codexThreadIdPath('s', '/root/')).toBe(`/root/.operations/${CODEX_THREAD_DIR_NAME}/s.json`);
  });

  // Best-effort by construction: losing the crumb costs the ability to resume (which the provider then reports
  // loudly), and must never fail a build that has otherwise just succeeded.
  it('never throws on an unwritable/unreadable sidecar — it degrades to null', () => {
    expect(writeCodexThreadId('s', 'tid', '/nonexistent-root-\0/')).toBeNull();
    expect(readCodexThreadId('s', '/definitely/not/a/real/root/')).toBeNull();
  });
});


// ── SELF-TRACKED TOKEN USAGE (epic #3383 usage-ledger follow-up) ───────────────────────────────────────────
describe('parseCodexTurnTokenUsage', () => {
  it("reads the terminal turn.completed event's own usage block from a real-shaped JSONL stream", () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } }),
    ].join('\n');
    expect(parseCodexTurnTokenUsage(stdout)).toEqual({ tokensIn: 100, tokensOut: 10, tokensCacheRead: 40, tokensCacheWrite: 0 });
  });

  it("scans from the END for the terminal event — an earlier retry's own turn.started never wins", () => {
    const stdout = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'error', message: 'transient' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }),
    ].join('\n');
    expect(parseCodexTurnTokenUsage(stdout)).toEqual({ tokensIn: 5, tokensOut: 2, tokensCacheRead: 0, tokensCacheWrite: 0 });
  });

  it('returns null (never throws) when there is no terminal event at all', () => {
    expect(parseCodexTurnTokenUsage('')).toBeNull();
    expect(parseCodexTurnTokenUsage(JSON.stringify({ type: 'turn.started' }))).toBeNull();
    expect(parseCodexTurnTokenUsage('not json at all')).toBeNull();
  });

  it('returns null when the terminal event carries no usage block', () => {
    expect(parseCodexTurnTokenUsage(JSON.stringify({ type: 'turn.completed' }))).toBeNull();
  });
});

describe('recordCodexTurnUsage', () => {
  it('records the four dispatch.tokens.* metrics against the ACTIVE recorder, tagged provider:codex + the delivery model', () => {
    const store = createMemoryTelemetryStore();
    const rec = createTelemetryRecorder({ store, enabled: true, now: () => new Date('2026-09-12T10:00:00.000Z'), resource: {} });
    const restore = setActiveRecorder(rec);
    try {
      const stdout = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } });
      recordCodexTurnUsage(stdout);
      const metrics = store.readAll().events.filter((e) => e.event === 'metric');
      expect(metrics).toHaveLength(4);
      const byName = Object.fromEntries(metrics.map((m) => [m.name, m]));
      expect(byName['dispatch.tokens.input'].value).toBe(100);
      expect(byName['dispatch.tokens.output'].value).toBe(10);
      expect(byName['dispatch.tokens.cache_read'].value).toBe(40);
      expect(byName['dispatch.tokens.cache_write'].value).toBe(0);
      for (const m of metrics) {
        expect(m.attributes.provider).toBe('codex');
        expect(m.attributes.model).toBe(CODEX_DELIVERY_MODEL);
      }
    } finally { restore(); }
  });

  it('records nothing (never throws) when stdout carries no usage — e.g. a resume with no terminal event yet', () => {
    const store = createMemoryTelemetryStore();
    const rec = createTelemetryRecorder({ store, enabled: true, now: () => new Date(), resource: {} });
    const restore = setActiveRecorder(rec);
    try {
      expect(() => recordCodexTurnUsage('not json')).not.toThrow();
      expect(store.readAll().events.filter((e) => e.event === 'metric')).toHaveLength(0);
    } finally { restore(); }
  });
});
