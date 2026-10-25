/**
 * @file codex-direct-task.test.mjs — the mechanical parts of the personal Codex-direct-task escape hatch,
 * proved with real git regressions and without spawning Codex (mirrors `judge-spawn.test.mjs`'s split:
 * pure argv/plan functions get cheap, exhaustive tests; the one thing that actually needed a real process — whether agentic mode's `--json`
 * stream shows granular tool calls — was checked with a real, live `codex exec` invocation while building this
 * file, recorded in the module's own header and in the delivering PR, not re-proved here).
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepAliveScript } from '../lib/test-keepalive.mjs';
import { CODEX_TASK_RULES, CODEX_REVIEW_TASK_RULES } from '../lib/build-policy.mjs';
import {
  startDetachedJob, waitForJob, readJobRecord, writeJobRecord, cliExitCode, jobIsAlive, readPidStart, readPidState,
  PID_START_TIMEOUT_MS, JOB_RECORD_INIT_DEADLINE_MS,
  CODEX_CLI,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_CLONE_TIMEOUT_MS,
  GIT_STEP_TIMEOUT_MS,
  EXEC_DIAGNOSTIC_TAIL_BYTES,
  CODEX_EFFORT_MAP,
  CODEX_MODEL,
  CODEX_TIER_EFFORT,
  resolveCodexEffort,
  resolveCodexHome,
  findRolloutFile,
  parseRolloutQuota,
  readRolloutQuota,
  collectAndClearRolloutQuota,
  buildCodexDirectTaskArgv,
  buildCodexPrompt,
  buildScratchCloneArgv,
  planDepsInstall,
  parseJsonlLine,
  parseJsonlEvents,
  summarizeEvents,
  defaultExecFn,
  detachedGateExecFn,
  setupScratchClone,
  captureDiff,
  runGate,
  runCodexDirectExec,
  codexDirectTask,
} from '../codex-direct-task.mjs';

// Historical orchestration fixtures isolate the new independently tested self-review.
beforeEach(() => vi.stubEnv('WE_BUILD_SELF_REVIEW_ENABLED', 'false'));
afterEach(() => vi.unstubAllEnvs());

/** A fixture `--dir` standing for a WE checkout: the default full gate needs its scripts/verify-lane.mjs. */
function weCheckout(dir) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'verify-lane.mjs'), '');
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

describe('defaultExecFn — real child-process output buffering', () => {
  it('returns the full stdout when output exceeds Node’s default 1 MiB buffer', () => {
    const outputSize = 2 * 1024 * 1024;
    const output = defaultExecFn(process.execPath, [
      '-e', `process.stdout.write('x'.repeat(${outputSize}))`,
    ]);
    expect(output.length).toBeGreaterThan(1024 * 1024);
    expect(output).toBe('x'.repeat(outputSize));
  });
});

describe('buildCodexDirectTaskArgv — pure argv for agentic/workspace-write mode', () => {
  it('#4665 encodes exact edit roots and temp environment without shell interpolation', () => {
    const roots = ['/lane/.git', '/pool/.admission/heavy', '/tmp/a "quoted" \\ root'];
    const argv = buildCodexDirectTaskArgv({ cwd: '/lane', writableRoots: roots, tempRoot: roots[2] });
    expect(argv).toContain('sandbox_workspace_write.network_access=true');
    const encoded = argv.find((v) => v.startsWith('sandbox_workspace_write.writable_roots='));
    expect(JSON.parse(encoded.split('=').slice(1).join('='))).toEqual(roots);
    for (const name of ['TMPDIR', 'TMP', 'TEMP']) {
      expect(argv).toContain(`shell_environment_policy.set.${name}=${JSON.stringify(roots[2])}`);
    }
    expect(argv).not.toContain('danger-full-access');
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(() => buildCodexDirectTaskArgv({ cwd: '/lane', writableRoots: [''] })).toThrow(/writableRoots/);
  });

  it('#4665 leaves read-only argv unchanged even when edit roots are supplied', () => {
    const argv = buildCodexDirectTaskArgv({ cwd: '/lane', review: true, writableRoots: ['/lane/.git'], tempRoot: '/tmp/job' });
    expect(argv).toEqual(buildCodexDirectTaskArgv({ cwd: '/lane', review: true }));
    expect(flagValue(argv, '-s')).toBe('read-only');
    expect(argv.some((v) => /sandbox_workspace_write|shell_environment_policy/.test(v))).toBe(false);
  });

  it('always carries exec, --json, workspace-write sandbox, and -C, never a positional prompt', () => {
    const argv = buildCodexDirectTaskArgv({ cwd: '/tmp/scratch' });
    expect(argv[0]).toBe('exec');
    expect(argv).toContain('--json');
    expect(flagValue(argv, '-s')).toBe('workspace-write');
    expect(flagValue(argv, '-C')).toBe('/tmp/scratch');
    expect(argv).toContain('--skip-git-repo-check');
    // No positional prompt anywhere in argv — the task rides stdin (avoids the #3371-probe-0 stdin trap).
    expect(argv.some((a) => a.includes('Add') || a.includes('task'))).toBe(false);
  });

  it('requires a non-empty cwd', () => {
    expect(() => buildCodexDirectTaskArgv({})).toThrow(/cwd/);
    expect(() => buildCodexDirectTaskArgv({ cwd: '  ' })).toThrow(/cwd/);
  });

  it('adds -o only when outputLastMessageFile is given', () => {
    expect(buildCodexDirectTaskArgv({ cwd: '/d' })).not.toContain('-o');
    const argv = buildCodexDirectTaskArgv({ cwd: '/d', outputLastMessageFile: '/d/last.txt' });
    expect(flagValue(argv, '-o')).toBe('/d/last.txt');
  });

  it('does NOT pass --ephemeral by default, but does when asked', () => {
    expect(buildCodexDirectTaskArgv({ cwd: '/d' })).not.toContain('--ephemeral');
    expect(buildCodexDirectTaskArgv({ cwd: '/d', ephemeral: true })).toContain('--ephemeral');
  });

  it('forwards --add-dir once per entry', () => {
    const argv = buildCodexDirectTaskArgv({ cwd: '/d', addDirs: ['/a', '/b'] });
    const idxs = argv.reduce((acc, a, i) => (a === '--add-dir' ? [...acc, i] : acc), []);
    expect(idxs.map((i) => argv[i + 1])).toEqual(['/a', '/b']);
  });

  it('maps model to -m, rejecting a flag-shaped value', () => {
    expect(flagValue(buildCodexDirectTaskArgv({ cwd: '/d', model: 'gpt-5-codex' }), '-m')).toBe('gpt-5-codex');
    expect(() => buildCodexDirectTaskArgv({ cwd: '/d', model: '--danger' })).toThrow();
  });

  it('forwards effort through CODEX_EFFORT_MAP unchanged and rejects unknown levels', () => {
    for (const [level, mapped] of Object.entries(CODEX_EFFORT_MAP)) {
      const argv = buildCodexDirectTaskArgv({ cwd: '/d', effort: level });
      expect(flagValue(argv, '-c')).toBe(`model_reasoning_effort=${mapped}`);
    }
    expect(() => buildCodexDirectTaskArgv({ cwd: '/d', effort: 'enormous' })).toThrow(/effort/);
  });

  // #3635 follow-up: the map WAS a clamp (`xhigh`/`max` → `high`, no `ultra`), copied from a sibling file
  // that assumed Codex stopped at `high`. `gpt-6-astra`'s own catalogue lists all six levels and a live
  // `codex exec -c model_reasoning_effort=<level>` ping for `xhigh`/`max`/`ultra` each completed normally,
  // so the clamp was silently downgrading an explicitly requested level. Pin the identity so it can't
  // regress into a clamp again.
  it('#3635: CODEX_EFFORT_MAP is an IDENTITY over the six real levels — nothing is clamped to high', () => {
    expect(CODEX_EFFORT_MAP).toEqual({
      low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'ultra',
    });
    for (const level of ['xhigh', 'max', 'ultra']) {
      expect(flagValue(buildCodexDirectTaskArgv({ cwd: '/d', effort: level }), '-c'))
        .toBe(`model_reasoning_effort=${level}`);
    }
  });

  it('#3635: an inherited Object.prototype key is not a valid effort', () => {
    expect(() => buildCodexDirectTaskArgv({ cwd: '/d', effort: 'constructor' })).toThrow(/effort/);
    expect(() => buildCodexDirectTaskArgv({ cwd: '/d', effort: 'toString' })).toThrow(/effort/);
  });

  // #x8wbivt — the ratified model/effort pin. The whole point is that a real constructed argv NEVER omits
  // `-m`/`-c` even when a caller passes neither — never inherit the CLI's own implicit default.
  it('uses the worker route while keeping CODEX_MODEL as Astra identity', () => {
    expect(CODEX_MODEL).toBe('gpt-6-astra');
    const argv = buildCodexDirectTaskArgv({ cwd: '/d' });
    expect(flagValue(argv, '-m')).toBe('gpt-6.1-sol');
  });

  it('#x8wbivt: an explicit model still overrides the pin', () => {
    const argv = buildCodexDirectTaskArgv({ cwd: '/d', model: 'gpt-5.6-sol' });
    expect(flagValue(argv, '-m')).toBe('gpt-5.6-sol');
  });

  it("#x8wbivt: pins effort to the sonnet rung's medium when neither effort nor tier is given", () => {
    const argv = buildCodexDirectTaskArgv({ cwd: '/d' });
    expect(flagValue(argv, '-c')).toBe('model_reasoning_effort=medium');
  });
});

describe('#x8wbivt — CODEX_TIER_EFFORT / resolveCodexEffort: the ratified three-rung effort ladder', () => {
  it('the ladder maps haiku/sonnet/opus to low/medium/high — the pin is on EFFORT, not model', () => {
    expect(CODEX_TIER_EFFORT).toEqual({ haiku: 'low', sonnet: 'medium', opus: 'high' });
  });

  it('resolves each tier to its real model_reasoning_effort value', () => {
    expect(resolveCodexEffort({ tier: 'haiku' })).toBe('low');
    expect(resolveCodexEffort({ tier: 'sonnet' })).toBe('medium');
    expect(resolveCodexEffort({ tier: 'opus' })).toBe('high');
  });

  it('an explicit effort always wins over tier', () => {
    expect(resolveCodexEffort({ tier: 'haiku', effort: 'high' })).toBe('high');
  });

  it('defaults to the sonnet rung when neither tier nor effort is given', () => {
    expect(resolveCodexEffort({})).toBe('medium');
    expect(resolveCodexEffort()).toBe('medium');
  });

  it('rejects an unknown tier', () => {
    expect(() => resolveCodexEffort({ tier: 'fable' })).toThrow(/tier/);
    expect(() => resolveCodexEffort({ tier: 'constructor' })).toThrow(/tier/);
  });

  // #3635 follow-up: `tier` was validated but `effort` sailed through unchecked, so a typo either surfaced
  // late (inside buildCodexDirectTaskArgv) or not at all for a caller using this function standalone. The
  // @returns contract was false for the same reason — `xhigh`/`max` came back unmapped while the doc
  // claimed a CODEX_TIER_EFFORT value. Both halves are pinned here.
  it('#3635: rejects an unknown effort, symmetrically with tier', () => {
    expect(() => resolveCodexEffort({ effort: 'enormous' })).toThrow(/effort/);
    expect(() => resolveCodexEffort({ effort: 'constructor' })).toThrow(/effort/);
    expect(() => resolveCodexEffort({ tier: 'opus', effort: 'enormous' })).toThrow(/effort/);
  });

  it('#3635: every return value is a real CODEX_EFFORT_MAP key — including above `high`', () => {
    for (const level of Object.keys(CODEX_EFFORT_MAP)) {
      const resolved = resolveCodexEffort({ effort: level });
      expect(resolved).toBe(level);
      expect(Object.keys(CODEX_EFFORT_MAP)).toContain(resolved);
      // …and whatever comes back is accepted verbatim by the argv builder — the real contract.
      expect(flagValue(buildCodexDirectTaskArgv({ cwd: '/d', effort: resolved }), '-c'))
        .toBe(`model_reasoning_effort=${level}`);
    }
    for (const tier of Object.keys(CODEX_TIER_EFFORT)) {
      expect(Object.keys(CODEX_EFFORT_MAP)).toContain(resolveCodexEffort({ tier }));
    }
  });

  it('every resolved tier value round-trips through buildCodexDirectTaskArgv as a real -c flag', () => {
    for (const tier of Object.keys(CODEX_TIER_EFFORT)) {
      const argv = buildCodexDirectTaskArgv({ cwd: '/d', effort: resolveCodexEffort({ tier }) });
      expect(flagValue(argv, '-c')).toBe(`model_reasoning_effort=${CODEX_TIER_EFFORT[tier]}`);
    }
  });
});

describe('buildCodexPrompt — folds in the do-not-commit instruction', () => {
  it('keeps the task text verbatim and appends the constraint', () => {
    const p = buildCodexPrompt('Add a comment to notes.txt');
    expect(p).toContain('Add a comment to notes.txt');
    expect(p).toMatch(/do not run `git commit`/);
    expect(p).toMatch(/do not run `git push`/);
  });

  it('tells Codex to run tests only through the heavy-admission queue (heavy-enforce)', () => {
    const p = buildCodexPrompt('Add a comment to notes.txt');
    expect(p).toContain('node scripts/readiness/heavy-admission.mjs run -- npx vitest run <test-file>');
    expect(p).toMatch(/Never run a bare `npx vitest`, `npm test`, or `node scripts\/check-standards\.mjs`/);
  });

  it('rejects an empty task', () => {
    expect(() => buildCodexPrompt('')).toThrow();
    expect(() => buildCodexPrompt('   ')).toThrow();
  });
});

describe('buildCodexPrompt — fixed task rules', () => {
  it('appends the verbatim build block exactly once', () => {
    const prompt = buildCodexPrompt('Add a comment to notes.txt');
    expect(prompt).toContain(CODEX_TASK_RULES);
    expect(prompt.endsWith(CODEX_TASK_RULES)).toBe(true);
    expect(prompt.split(CODEX_TASK_RULES)).toHaveLength(2);
    expect(prompt.split('Task rules (fixed; follow them exactly):')).toHaveLength(2);
  });

  it('appends the read-only block exactly once without build-only rules', () => {
    const prompt = buildCodexPrompt('Review notes.txt', { review: true });
    expect(prompt).toContain(CODEX_REVIEW_TASK_RULES);
    expect(prompt.endsWith(CODEX_REVIEW_TASK_RULES)).toBe(true);
    expect(prompt.split(CODEX_REVIEW_TASK_RULES)).toHaveLength(2);
    expect(prompt.split('Task rules (fixed; follow them exactly):')).toHaveLength(2);
    expect(prompt).not.toContain('$TMPDIR');
    expect(prompt).not.toContain('npm run test:unit');
  });

  it('keeps each fixed block within twelve lines', () => {
    expect(CODEX_TASK_RULES.split('\n').length).toBeLessThanOrEqual(12);
    expect(CODEX_REVIEW_TASK_RULES.split('\n').length).toBeLessThanOrEqual(12);
  });
});

describe('buildScratchCloneArgv — pure local-clone argv', () => {
  it('clones repoRoot into dest, quietly', () => {
    expect(buildScratchCloneArgv({ repoRoot: '/repo', dest: '/tmp/x' })).toEqual(['clone', '--quiet', '/repo', '/tmp/x']);
  });
  it('requires both paths', () => {
    expect(() => buildScratchCloneArgv({ dest: '/tmp/x' })).toThrow(/repoRoot/);
    expect(() => buildScratchCloneArgv({ repoRoot: '/repo' })).toThrow(/dest/);
  });
});

describe('planDepsInstall — ci vs install vs nothing, over an injected existsFn', () => {
  it('returns null when there is no package.json', () => {
    expect(planDepsInstall('/d', () => false)).toBeNull();
  });
  it('uses npm ci when a lockfile is present', () => {
    const existsFn = (p) => p.endsWith('package.json') || p.endsWith('package-lock.json');
    expect(planDepsInstall('/d', existsFn)).toEqual({ bin: 'npm', args: ['ci'] });
  });
  it('falls back to npm install with no lockfile', () => {
    const existsFn = (p) => p.endsWith('package.json');
    expect(planDepsInstall('/d', existsFn)).toEqual({ bin: 'npm', args: ['install'] });
  });
});

describe('JSONL parsing — tolerant of blank/malformed lines, never throws', () => {
  it('parseJsonlLine returns null for blank or unparsable input', () => {
    expect(parseJsonlLine('')).toBeNull();
    expect(parseJsonlLine('   ')).toBeNull();
    expect(parseJsonlLine('not json')).toBeNull();
    expect(parseJsonlLine('{"a":1}')).toEqual({ a: 1 });
  });

  it('parseJsonlEvents drops blank/unparsable lines and keeps order', () => {
    const stdout = '{"type":"a"}\n\n{"type":"b"}\nnope\n{"type":"c"}\n';
    expect(parseJsonlEvents(stdout).map((e) => e.type)).toEqual(['a', 'b', 'c']);
  });
});

describe('summarizeEvents — the real agentic-mode event shape observed in a live codex exec run', () => {
  // This is the ACTUAL (trimmed) shape a real `codex exec --json -s workspace-write` run produced against a
  // real scratch git repo, adding a one-line comment to notes.txt — see the module header for the full
  // transcript and the exact command. Pinned here so a future Codex CLI update that changes this shape fails
  // a test instead of silently degrading `summarizeEvents`.
  const REAL_EVENTS = [
    { type: 'thread.started', thread_id: '01a08aed-f2ec-7ad0-b4e2-7a7ab89abb98' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I will read notes.txt…' } },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/bash -lc 'pwd; rg --files'", status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/bash -lc 'pwd; rg --files'", aggregated_output: 'notes.txt\n', exit_code: 0, status: 'completed' } },
    { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: "/bin/bash -lc 'cat notes.txt'", status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: "/bin/bash -lc 'cat notes.txt'", aggregated_output: 'scratch file for a probe\n', exit_code: 0, status: 'completed' } },
    { type: 'item.started', item: { id: 'item_3', type: 'file_change', changes: [{ path: '/scratch/notes.txt', kind: 'update' }], status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: '/scratch/notes.txt', kind: 'update' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'Added a purpose comment. No other edits.' } },
    { type: 'turn.completed', usage: { input_tokens: 62159, cached_input_tokens: 53504, output_tokens: 219 } },
  ];

  it('extracts the thread id, turn count, every tool command, every file change, and the terminal status', () => {
    const s = summarizeEvents(REAL_EVENTS);
    expect(s.threadId).toBe('01a08aed-f2ec-7ad0-b4e2-7a7ab89abb98');
    expect(s.turns).toBe(1);
    expect(s.commands).toEqual(["/bin/bash -lc 'pwd; rg --files'", "/bin/bash -lc 'cat notes.txt'"]);
    expect(s.filesChanged).toEqual([{ path: '/scratch/notes.txt', kind: 'update' }]);
    expect(s.agentMessages).toEqual(['I will read notes.txt…', 'Added a purpose comment. No other edits.']);
    expect(s.terminal).toBe('turn.completed');
    expect(s.usage.input_tokens).toBe(62159);
  });

  it('reads the LAST terminal event, never the first, over a multi-turn stream', () => {
    const events = [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      { type: 'turn.completed', usage: { input_tokens: 1 } },
      { type: 'turn.started' },
      { type: 'turn.failed', error: { message: 'boom' } },
    ];
    expect(summarizeEvents(events).terminal).toBe('turn.failed');
  });

  it('reports null/empty over an empty stream (a spawn that produced no output at all)', () => {
    const s = summarizeEvents([]);
    expect(s.threadId).toBeNull();
    expect(s.terminal).toBeNull();
    expect(s.commands).toEqual([]);
    expect(s.filesChanged).toEqual([]);
  });
});

describe('#x8wbivt Fork 4 — the ratified quota signal: locate, parse, read, and read-then-delete', () => {
  describe('resolveCodexHome', () => {
    it('honours $CODEX_HOME when set', () => {
      expect(resolveCodexHome({ CODEX_HOME: '/custom/codex-home' })).toBe('/custom/codex-home');
    });
    it('falls back to ~/.codex when unset/blank', () => {
      expect(resolveCodexHome({})).toMatch(/\.codex$/);
      expect(resolveCodexHome({ CODEX_HOME: '   ' })).toMatch(/\.codex$/);
    });
  });

  describe('findRolloutFile — walks sessions/ recursively over an injected readdirFn, matches by trailing thread id', () => {
    // Mirrors the REAL layout observed live: <codexHome>/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<threadId>.jsonl
    function fakeTree(byDir) {
      return (dir) => (byDir[dir] ?? []);
    }

    it('finds the file nested three directories deep', () => {
      const readdirFn = fakeTree({
        '/home/.codex/sessions': [{ name: '2026', isDirectory: () => true }],
        '/home/.codex/sessions/2026': [{ name: '09', isDirectory: () => true }],
        '/home/.codex/sessions/2026/09': [{ name: '11', isDirectory: () => true }],
        '/home/.codex/sessions/2026/09/11': [
          { name: 'rollout-2026-09-11T16-45-34-01a09237-efe4-7520-a96c-95ff14613b28.jsonl', isDirectory: () => false },
          { name: 'rollout-2026-09-11T17-00-00-unrelated-thread-id.jsonl', isDirectory: () => false },
        ],
      });
      const found = findRolloutFile({
        codexHome: '/home/.codex', threadId: '01a09237-efe4-7520-a96c-95ff14613b28', readdirFn,
      });
      expect(found).toBe('/home/.codex/sessions/2026/09/11/rollout-2026-09-11T16-45-34-01a09237-efe4-7520-a96c-95ff14613b28.jsonl');
    });

    it('returns null when no file matches', () => {
      const readdirFn = fakeTree({ '/home/.codex/sessions': [{ name: 'x.jsonl', isDirectory: () => false }] });
      expect(findRolloutFile({ codexHome: '/home/.codex', threadId: 'nope', readdirFn })).toBeNull();
    });

    it('tolerates a missing sessions/ directory (a fresh CODEX_HOME) — returns null, never throws', () => {
      const readdirFn = () => { throw new Error('ENOENT'); };
      expect(findRolloutFile({ codexHome: '/fresh', threadId: 't1', readdirFn })).toBeNull();
    });

    it('requires codexHome and threadId', () => {
      expect(findRolloutFile({ threadId: 't1' })).toBeNull();
      expect(findRolloutFile({ codexHome: '/h' })).toBeNull();
    });
  });

  describe('parseRolloutQuota — over a REAL observed rollout line shape (live codex-cli 0.153.4, #x8wbivt)', () => {
    // This is the ACTUAL (trimmed) event a real non-ephemeral `codex exec` run wrote to its rollout file —
    // captured live while building this feature. Pinned here so a future Codex CLI change to this shape fails
    // a test instead of silently breaking quota parsing, same discipline `summarizeEvents`'s own REAL_EVENTS
    // fixture uses.
    const REAL_ROLLOUT_LINES = [
      '{"timestamp":"2026-09-11T20:45:34.674Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a09237-efe4-7520-a96c-95ff14613b28"}}',
      '{"timestamp":"2026-09-11T20:45:45.451Z","ordinal":16,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":11123}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":27.0,"window_minutes":300,"resets_at":1789175180},"secondary":{"used_percent":12.0,"window_minutes":10080,"resets_at":1789761980},"plan_type":"prolite","rate_limit_reached_type":null}}}',
    ].join('\n');

    it('extracts used_percent/window_minutes/resets_at/plan_type from the primary window', () => {
      const q = parseRolloutQuota(REAL_ROLLOUT_LINES);
      expect(q).toEqual({
        usedPercent: 27.0, windowMinutes: 300, resetsAt: 1789175180, planType: 'prolite',
        raw: expect.objectContaining({ limit_id: 'codex' }),
      });
    });

    it('takes the LAST token_count event when a multi-turn rollout logs more than one', () => {
      const lines = [
        '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":5,"window_minutes":300,"resets_at":1},"plan_type":"prolite"}}}',
        '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":9,"window_minutes":300,"resets_at":2},"plan_type":"prolite"}}}',
      ].join('\n');
      expect(parseRolloutQuota(lines).usedPercent).toBe(9);
    });

    it('returns null for a rollout with no token_count event, and never throws on malformed lines', () => {
      expect(parseRolloutQuota('{"type":"session_meta"}\nnot json\n')).toBeNull();
      expect(parseRolloutQuota('')).toBeNull();
      expect(() => parseRolloutQuota('garbage\n{{{')).not.toThrow();
    });
  });

  describe('readRolloutQuota — READ-ONLY: never deletes anything (preserves codex exec resume)', () => {
    it('reads the quota and has no deletion capability at all (no removeFileFn param)', () => {
      const readFileFn = vi.fn(() => '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":50,"window_minutes":300,"resets_at":9},"plan_type":"prolite"}}}');
      const readdirFn = () => [{ name: 'rollout-x-t1.jsonl', isDirectory: () => false }];
      const result = readRolloutQuota({ codexHome: '/h', threadId: 't1', readdirFn, readFileFn });
      expect(result.quota.usedPercent).toBe(50);
      expect(result.rolloutFile).toBe('/h/sessions/rollout-x-t1.jsonl');
      expect(result.deleted).toBeUndefined(); // unlike collectAndClearRolloutQuota, this shape never claims a deletion
    });

    it('returns a null quota (not a throw) when no rollout file is found', () => {
      const readdirFn = () => [];
      expect(readRolloutQuota({ codexHome: '/h', threadId: 't1', readdirFn })).toEqual({ quota: null, rolloutFile: null });
    });

    it('returns rolloutFile with a null quota when the file exists but fails to read', () => {
      const readdirFn = () => [{ name: 'rollout-x-t1.jsonl', isDirectory: () => false }];
      const readFileFn = () => { throw new Error('EACCES'); };
      const result = readRolloutQuota({ codexHome: '/h', threadId: 't1', readdirFn, readFileFn });
      expect(result.quota).toBeNull();
      expect(result.rolloutFile).toBe('/h/sessions/rollout-x-t1.jsonl');
    });
  });

  describe('collectAndClearRolloutQuota — #x8wbivt Fork 4 RATIFIED shape: read the record, THEN delete the file', () => {
    it('reads the quota and deletes the rollout file afterward', () => {
      const removeFileFn = vi.fn();
      const readFileFn = () => '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":33,"window_minutes":300,"resets_at":9},"plan_type":"prolite"}}}';
      const readdirFn = () => [{ name: 'rollout-x-t1.jsonl', isDirectory: () => false }];
      const result = collectAndClearRolloutQuota({ codexHome: '/h', threadId: 't1', readdirFn, readFileFn, removeFileFn });
      expect(result.quota.usedPercent).toBe(33);
      expect(result.deleted).toBe(true);
      expect(removeFileFn).toHaveBeenCalledWith('/h/sessions/rollout-x-t1.jsonl');
    });

    it('EVEN ON A FAILURE PATH — a read that throws still deletes the file (nothing lingers)', () => {
      const removeFileFn = vi.fn();
      const readFileFn = () => { throw new Error('corrupt rollout'); };
      const readdirFn = () => [{ name: 'rollout-x-t1.jsonl', isDirectory: () => false }];
      const result = collectAndClearRolloutQuota({ codexHome: '/h', threadId: 't1', readdirFn, readFileFn, removeFileFn });
      expect(result.quota).toBeNull();
      expect(result.deleted).toBe(true);
      expect(removeFileFn).toHaveBeenCalledWith('/h/sessions/rollout-x-t1.jsonl');
    });

    it('a removeFileFn that itself throws does not propagate — best-effort cleanup', () => {
      const readFileFn = () => '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":1,"window_minutes":300,"resets_at":9},"plan_type":"prolite"}}}';
      const readdirFn = () => [{ name: 'rollout-x-t1.jsonl', isDirectory: () => false }];
      const removeFileFn = () => { throw new Error('EBUSY'); };
      expect(() => collectAndClearRolloutQuota({ codexHome: '/h', threadId: 't1', readdirFn, readFileFn, removeFileFn })).not.toThrow();
    });

    it('never deletes anything when no rollout file is found', () => {
      const removeFileFn = vi.fn();
      const result = collectAndClearRolloutQuota({ codexHome: '/h', threadId: 't1', readdirFn: () => [], removeFileFn });
      expect(result.deleted).toBe(false);
      expect(removeFileFn).not.toHaveBeenCalled();
    });
  });
});

describe('setupScratchClone — clones locally and installs deps, over injected execFn/mkTempDir/existsFn', () => {
  it('returns scratch metadata only after async installation succeeds, with a bounded default', async () => {
    let finishInstall;
    const installExecFn = vi.fn(() => new Promise(resolve => { finishInstall = resolve; }));
    const pending = setupScratchClone({
      repoRoot: '/repo', mkTempDir: () => '/scratch', existsFn: () => true,
      execFn: () => '', installExecFn,
    });
    expect(pending).toBeInstanceOf(Promise);
    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(installExecFn.mock.calls[0][2].timeout).toBe(DEFAULT_INSTALL_TIMEOUT_MS);
    expect(DEFAULT_INSTALL_TIMEOUT_MS).toBe(5 * 60 * 1000);
    finishInstall('installed');
    await expect(pending).resolves.toMatchObject({ dest: '/scratch', depsInstall: { bin: 'npm', args: ['ci'] } });
  });

  it('fails the task on a real async install timeout before starting Codex', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'codex-install-timeout-'));
    const spawnFn = vi.fn();
    try {
      await expect(codexDirectTask({
        task: 'fixture', repoRoot: '/repo', mkTempDir: () => dest, existsFn: () => true,
        execFn: () => '', spawnFn, gate: 'none', selfReview: false, log: false,
        installTimeoutMs: 100,
        installExecFn: (_bin, _args, options) => detachedGateExecFn(process.execPath,
          ['-e', keepAliveScript({ maxLifetimeMs: 10000 })], options),
      })).rejects.toThrow('timed out after 100ms');
      expect(spawnFn).not.toHaveBeenCalled();
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('awaits an optional install runner with an explicit timeout and propagates failure', async () => {
    let finishInstall;
    const execFn = vi.fn(() => '');
    const installExecFn = vi.fn(() => new Promise((resolve, reject) => { finishInstall = reject; }));
    const pending = setupScratchClone({
      repoRoot: '/repo', mkTempDir: () => '/scratch', existsFn: () => true,
      execFn, installExecFn, installTimeoutMs: 100, installStdio: ['ignore', 2, 2],
    });
    expect(pending).toBeInstanceOf(Promise);
    expect(installExecFn).toHaveBeenCalledWith('npm', ['ci'], {
      cwd: '/scratch', stdio: ['ignore', 2, 2], timeout: 100,
    });
    expect(execFn.mock.calls.every(([bin]) => bin === 'git')).toBe(true);
    finishInstall(new Error('install timed out'));
    await expect(pending).rejects.toThrow('install timed out');
  });

  it('relays async install output and names the step when it fails, bounded to the diagnostic tail', async () => {
    const diagnostics = [];
    const huge = `${'x'.repeat(EXEC_DIAGNOSTIC_TAIL_BYTES * 2)}END`;
    const failure = Object.assign(new Error('gate exited 1'), { stdout: 'npm stdout\n', stderr: `npm ERR! ${huge}` });
    await expect(setupScratchClone({
      repoRoot: '/repo', mkTempDir: () => '/scratch', existsFn: () => true, execFn: () => '',
      installExecFn: () => Promise.reject(failure), diagnosticFn: text => diagnostics.push(text),
    })).rejects.toMatchObject({ message: 'dependency install (npm ci) failed: exited 1', cause: failure });
    expect(diagnostics[0]).toBe('npm stdout\n');
    expect(diagnostics[1].endsWith('END\n')).toBe(true);
    expect(diagnostics[1].length).toBeLessThanOrEqual(EXEC_DIAGNOSTIC_TAIL_BYTES + 2);

    diagnostics.length = 0;
    await setupScratchClone({
      repoRoot: '/repo', mkTempDir: () => '/scratch', existsFn: () => true, execFn: () => '',
      installExecFn: () => Promise.resolve('added 1 package'), diagnosticFn: text => diagnostics.push(text),
    });
    expect(diagnostics).toEqual(['added 1 package\n']);
  });

  it('runs the scratch clone through an optional async runner with its own deadline, before installing', async () => {
    let finishClone;
    const execFn = vi.fn(() => '');
    const cloneExecFn = vi.fn(() => new Promise(resolve => { finishClone = resolve; }));
    const installExecFn = vi.fn(() => Promise.resolve(''));
    const pending = setupScratchClone({
      repoRoot: '/repo', mkTempDir: () => '/scratch', existsFn: () => true,
      execFn, cloneExecFn, installExecFn, diagnosticFn: () => {},
    });
    expect(cloneExecFn).toHaveBeenCalledWith('git', ['clone', '--quiet', '/repo', '/scratch'],
      { timeout: DEFAULT_CLONE_TIMEOUT_MS });
    expect(execFn.mock.calls.some(([, args]) => args[0] === 'clone')).toBe(false);
    await Promise.resolve();
    expect(installExecFn).not.toHaveBeenCalled();
    finishClone('');
    await expect(pending).resolves.toMatchObject({ dest: '/scratch', cloned: true });
    expect(installExecFn).toHaveBeenCalledOnce();

    await expect(setupScratchClone({
      repoRoot: '/repo', mkTempDir: () => '/scratch', existsFn: () => true, execFn, installExecFn,
      cloneExecFn: () => Promise.reject(new Error('gate timed out after 50ms')), cloneTimeoutMs: 50, diagnosticFn: () => {},
    })).rejects.toThrow('scratch clone (git clone) failed: timed out after 50ms');
    expect(installExecFn).toHaveBeenCalledOnce();
  });

  it('#3782: clones from repoRoot, LEAVES origin at the local clone source by default, and REPORTS the real remote without wiring it in', () => {
    const calls = [];
    const execFn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      if (bin === 'git' && args.includes('get-url')) return 'https://github.com/x/y.git\n';
      return '';
    };
    const mkTempDir = (prefix) => `${prefix}FAKE`;
    const existsFn = (p) => p.endsWith('package.json') || p.endsWith('package-lock.json');

    const result = setupScratchClone({ repoRoot: '/repo', execFn, mkTempDir, existsFn });

    expect(result.dest).toMatch(/FAKE$/);
    expect(result.depsInstall).toEqual({ bin: 'npm', args: ['ci'] });
    // clone happened first, against the real buildScratchCloneArgv recipe
    const cloneCall = calls.find((c) => c.bin === 'git' && c.args[0] === 'clone');
    expect(cloneCall.args).toEqual(buildScratchCloneArgv({ repoRoot: '/repo', dest: result.dest }));
    // the real remote is resolved and reported...
    expect(result.realOrigin).toBe('https://github.com/x/y.git');
    // ...but NEVER wired into the clone's own git config by default (#3782 — the security-hardening fix:
    // a scratch clone's origin must not be silently made push-capable to the real remote).
    expect(result.originWired).toBe(false);
    expect(calls.some((c) => c.bin === 'git' && c.args.includes('set-url'))).toBe(false);
    // deps actually installed in the clone
    expect(calls.some((c) => c.bin === 'npm' && c.args[0] === 'ci' && c.opts?.cwd === result.dest)).toBe(true);
  });

  it('#3782: wireOriginToRemote:true opts back into rewriting origin to the real remote', () => {
    const calls = [];
    const execFn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      if (bin === 'git' && args.includes('get-url')) return 'https://github.com/x/y.git\n';
      return '';
    };
    const result = setupScratchClone({
      repoRoot: '/repo', execFn, mkTempDir: (p) => `${p}FAKE`, existsFn: () => false, wireOriginToRemote: true,
    });

    expect(result.realOrigin).toBe('https://github.com/x/y.git');
    expect(result.originWired).toBe(true);
    expect(calls.some((c) => c.bin === 'git' && c.args.includes('set-url') && c.args.includes('https://github.com/x/y.git'))).toBe(true);
    // Both remote reads/writes are bounded, so no sync git call on the scratch path can block signals forever.
    const remoteCalls = calls.filter((c) => c.bin === 'git' && c.args.includes('remote'));
    expect(remoteCalls).toHaveLength(2);
    for (const c of remoteCalls) expect(c.opts?.timeout).toBe(GIT_STEP_TIMEOUT_MS);
  });

  it('#3782: wireOriginToRemote:true is a no-op (originWired stays false) when repoRoot has no origin to resolve', () => {
    const execFn = (bin, args) => {
      if (bin === 'git' && args.includes('get-url')) throw new Error('no such remote');
      return '';
    };
    const result = setupScratchClone({
      repoRoot: '/repo', execFn, mkTempDir: (p) => `${p}FAKE`, existsFn: () => false, wireOriginToRemote: true,
    });
    expect(result.realOrigin).toBeNull();
    expect(result.originWired).toBe(false);
  });

  it('tolerates a repoRoot with no origin remote — clone still succeeds', () => {
    const execFn = (bin, args) => {
      if (bin === 'git' && args.includes('get-url')) throw new Error('no such remote');
      return '';
    };
    const result = setupScratchClone({
      repoRoot: '/repo', execFn, mkTempDir: (p) => `${p}FAKE`, existsFn: () => false,
    });
    expect(result.dest).toMatch(/FAKE$/);
    expect(result.depsInstall).toBeNull(); // existsFn says no package.json
    expect(result.realOrigin).toBeNull();
    expect(result.originWired).toBe(false);
  });

  it('skips dep install when installDeps is false, even with a lockfile present', () => {
    const execFn = () => '';
    const result = setupScratchClone({
      repoRoot: '/repo', execFn, mkTempDir: (p) => `${p}FAKE`, existsFn: () => true, installDeps: false,
    });
    expect(result.depsInstall).toBeNull();
  });

  it('requires a non-empty repoRoot', () => {
    expect(() => setupScratchClone({ execFn: () => '' })).toThrow(/repoRoot/);
  });
});

function initGitRepo(dir) {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'core.quotePath', 'true');
  git('-c', 'user.name=Direct Task Test', '-c', 'user.email=direct-task@example.test',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null',
    'commit', '--quiet', '--allow-empty', '-m', 'Test baseline');
  return git;
}

describe('captureDiff — the review artifact, never a commit/push', () => {
  it('bounds every git read with an explicit deadline so a hung one fails the run', () => {
    const calls = [];
    captureDiff({ dir: '/scratch', startSha: 'sha0', execFn: (bin, args, opts) => { calls.push({ bin, opts }); return ''; } });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(({ bin, opts }) => bin === 'git' && opts.timeout === GIT_STEP_TIMEOUT_MS)).toBe(true);
  });

  it('returns readable lines for real modified and untracked status entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-direct-status-test-'));
    try {
      const git = initGitRepo(dir);
      const startSha = git('rev-parse', 'HEAD');
      writeFileSync(join(dir, 'tracked.txt'), 'original\n');
      git('add', 'tracked.txt');
      writeFileSync(join(dir, 'tracked.txt'), 'modified\n');
      writeFileSync(join(dir, 'untracked.txt'), 'new\n');
      const result = captureDiff({ dir, startSha });
      expect(result.status).not.toContain('\0');
      expect(result.status.split('\n')).toEqual(['AM tracked.txt', '?? untracked.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['a file.txt', 'café.txt', 'a"quote.txt', 'a\nline.txt'])('captures an untracked filename with spaces, Unicode or quoting: %j', (filename) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-codex-direct-git-test-'));
    try {
      const git = initGitRepo(dir);
      const startSha = git('rev-parse', 'HEAD');
      writeFileSync(join(dir, filename), 'new file review evidence\n');
      const report = captureDiff({ dir, startSha });
      expect(report.hasChanges).toBe(true);
      expect(report.diff).toContain('+new file review evidence');
      expect(report.diffStat).toContain('1 file changed');
      expect(execFileSync('git', ['-C', dir, 'diff', '--name-only', '-z', startSha], { encoding: 'utf8' }))
        .toBe(`${filename}\0`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Every real call is shaped `['-C', dir, <subcommand>, ...]` (see `captureDiff`'s own `execFn('git', ['-C',
  // dir, 'status', ...])` etc.), so these mocks match on `args.includes(...)`, never `args[0]`.
  it('reports a clean tree as no changes', () => {
    const execFn = (bin, args) => {
      if (args.includes('status')) return '';
      if (args.includes('diff') && args.includes('--stat')) return '';
      if (args.includes('diff')) return '';
      if (args.includes('log')) return '';
      return '';
    };
    const r = captureDiff({ dir: '/d', startSha: 'abc123', execFn });
    expect(r.hasChanges).toBe(false);
    expect(r.commits).toEqual([]);
  });

  it('intent-to-adds untracked files (content-free) so they surface in the diff, and reports the diff/stat', () => {
    const calls = [];
    const execFn = (bin, args) => {
      calls.push(args.join(' '));
      if (args.includes('status')) return '?? new-file.txt\0 M existing.txt\0';
      if (args.includes('diff') && args.includes('--stat')) return ' 2 files changed\n';
      if (args.includes('diff')) return 'diff --git a/existing.txt …';
      if (args.includes('log')) return '';
      return '';
    };
    const r = captureDiff({ dir: '/d', startSha: 'abc123', execFn });
    // Every read carries the shared lane pins between `-C <dir>` and the subcommand.
    expect(calls.some((c) => /^-C \/d .*core\.fsmonitor=false .* add --intent-to-add -- new-file\.txt$/.test(c))).toBe(true);
    expect(r.hasChanges).toBe(true);
    expect(r.diffStat).toContain('2 files changed');
  });

  it('never stages real content — the only `add` call it can make is --intent-to-add', () => {
    const calls = [];
    const execFn = (bin, args) => {
      calls.push(args);
      if (args.includes('status')) return '?? x.txt\0';
      return '';
    };
    captureDiff({ dir: '/d', startSha: 'abc', execFn });
    const addCalls = calls.filter((a) => a.includes('add'));
    expect(addCalls.length).toBeGreaterThan(0);
    expect(addCalls.every((a) => a.includes('--intent-to-add'))).toBe(true);
  });

  it('surfaces commits Codex made despite the prompt instruction, via `git log startSha..HEAD`', () => {
    const execFn = (bin, args) => {
      if (args.includes('status')) return '';
      if (args.includes('log')) return 'abcdef1 codex: whoops, committed anyway\n';
      return '';
    };
    const r = captureDiff({ dir: '/d', startSha: 'abc', execFn });
    expect(r.commits).toEqual(['abcdef1 codex: whoops, committed anyway']);
    expect(r.hasChanges).toBe(true);
  });

  it('requires dir and startSha', () => {
    expect(() => captureDiff({ startSha: 'x', execFn: () => '' })).toThrow(/dir/);
    expect(() => captureDiff({ dir: '/d', execFn: () => '' })).toThrow(/startSha/);
  });
});

describe('runGate — none/standards/full, never commits', () => {
  it.each(['standards', 'related', 'full'])('awaits async %s gate success and failure', async mode => {
    const execFn = vi.fn(() => { throw new Error('synchronous gate must not run'); });
    const asyncExecFn = vi.fn(async () => 'gate output');
    const options = { dir: '/d', mode, execFn, asyncExecFn, existsFn: () => true };
    expect(await runGate(options)).toMatchObject({ pass: true, steps: [{ output: 'gate output' }] });
    asyncExecFn.mockRejectedValueOnce(Object.assign(new Error('failed'), { stdout: 'gate failed', stderr: '' }));
    expect(await runGate(options)).toMatchObject({ pass: false, steps: [{ output: 'gate failed' }] });
    expect(execFn).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'success', script: 'console.log("gate output")' },
    { label: 'failure', script: 'process.exit(7)', rejects: true },
    { label: 'timeout', script: keepAliveScript({ maxLifetimeMs: 10000 }), options: { timeout: 100 }, rejects: true },
    { label: 'output limit', script: 'console.log("x".repeat(4096))', options: { maxBuffer: 1024 }, rejects: true },
    { label: 'spawn error', bin: 'missing-codex-gate-executable', rejects: true },
  ])('async gate cleans signal listeners after $label', async ({ script, options, rejects, bin }) => {
    const counts = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
    const pending = detachedGateExecFn(bin ?? process.execPath, ['-e', script ?? ''], options);
    if (rejects) await expect(pending).rejects.toThrow();
    else expect(await pending).toContain('gate output');
    expect(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))).toEqual(counts);
  });

  // A descendant in its own process group survives the group kill and keeps the gate's pipes open, so
  // `close` never arrives: the wrapper must settle on its own within timeout + close grace.
  it.each([
    { label: 'timeout', parent: keepAliveScript({ maxLifetimeMs: 10000 }), options: { timeout: 1000 }, rejects: /timed out/ },
    { label: 'nonzero exit', parent: 'process.exit(7)', rejects: /gate exited 7/ },
    { label: 'zero exit', parent: 'console.log("gate output"); process.exit(0)' },
    { label: 'output limit', parent: `console.log("x".repeat(4096)); ${keepAliveScript({ maxLifetimeMs: 10000 })}`,
      options: { maxBuffer: 1024 }, rejects: /maxBuffer/ },
  ])('settles after $label while a detached descendant holds stdio', async ({ parent, options, rejects }) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-direct-gate-holder-'));
    const pidFile = join(dir, 'holder.pid');
    const holder = keepAliveScript({ maxLifetimeMs: 8000 });
    const script = `const g = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(holder)}],
      { detached: true, stdio: 'inherit' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); g.unref(); ${parent}`;
    const counts = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
    const started = Date.now();
    try {
      const pending = detachedGateExecFn(process.execPath, ['-e', script], { ...options, closeGraceMs: 300 });
      if (rejects) await expect(pending).rejects.toThrow(rejects);
      else expect(await pending).toContain('gate output');
      expect(Date.now() - started).toBeLessThan((options?.timeout ?? 0) + 300 + 2000);
      expect(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))).toEqual(counts);
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('mode "none" runs nothing and passes', () => {
    const execFn = vi.fn();
    const r = runGate({ dir: '/d', mode: 'none', execFn });
    expect(r.ran).toBe(false);
    expect(r.pass).toBe(true);
    expect(execFn).not.toHaveBeenCalled();
  });

  it('mode "standards" runs only check:standards', () => {
    const execFn = vi.fn(() => 'ok');
    const r = runGate({ dir: '/d', mode: 'standards', execFn });
    expect(r.steps.map((s) => s.cmd)).toEqual(['npm run check:standards']);
    expect(r.pass).toBe(true);
    // The sync gate gets the async gate's wall, so a descendant holding its pipes cannot block it forever.
    expect(execFn.mock.calls[0][2]).toMatchObject({ timeout: DEFAULT_TIMEOUT_MS });
  });

  it('mode "full" runs verify-lane with the whole unit tier and standards', () => {
    const execFn = vi.fn(() => 'ok');
    // `/d` stands in for a WE checkout, which has scripts/verify-lane.mjs.
    const r = runGate({ dir: '/d', mode: 'full', execFn, existsFn: () => true });
    expect(r.steps.map((s) => s.cmd)).toEqual(['node scripts/verify-lane.mjs run --gate=npm run test:unit && npm run check:standards']);
  });

  it('a failing step is caught and reported, not thrown — and marks the gate failed', () => {
    const execFn = vi.fn((bin, args) => {
      if (args.some(a => a.includes('check:standards'))) { const e = new Error('exit 1'); e.stdout = 'BAD'; throw e; }
      return 'ok';
    });
    const r = runGate({ dir: '/d', mode: 'full', execFn, existsFn: () => true });
    expect(r.pass).toBe(false);
    expect(r.steps[0].pass).toBe(false);
    expect(r.steps[0].output).toContain('BAD');
    expect(r.steps).toHaveLength(1); // verify-lane owns the full gate
  });
});

describe('runCodexDirectExec / codexDirectTask — the orchestrator, over an injected spawnFn + execFn', () => {
  /** Same fakeSpawn shape `judge-spawn.test.mjs` uses — records argv/stdin, replays canned stdout. */
  function fakeSpawn(stdout, { code = 0, chunks } = {}) {
    const seen = { cli: null, argv: null, opts: null, stdin: '' };
    const fn = (cli, argv, opts) => {
      seen.cli = cli; seen.argv = argv; seen.opts = opts;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { on: () => {}, end: (d) => { seen.stdin = d; } };
      child.kill = () => {};
      setTimeout(() => {
        for (const chunk of chunks ?? [stdout]) child.stdout.emit('data', Buffer.from(chunk));
        child.emit('close', code);
      }, 0);
      return child;
    };
    return { fn, seen };
  }

  it('awaits the async gate again after a self-review repair', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-direct-regate-'));
    const { fn: spawnFn } = fakeSpawn('{"type":"thread.started","thread_id":"builder"}\n');
    const gateExecFn = vi.fn(async () => 'gate output');
    const selfReviewFn = vi.fn().mockResolvedValueOnce(['repair fixture']).mockResolvedValueOnce([]);
    const execFn = (bin, args) => {
      if (bin !== 'git') throw new Error('synchronous gate must not run');
      return args.includes('--absolute-git-dir') ? join(dir, 'metadata') : args.includes('rev-parse') ? 'sha' : '';
    };
    try {
      const report = await codexDirectTask({ task: 'fixture', dir, gate: 'standards', selfReview: true,
        stream: false, log: false, execFn, gateExecFn, spawnFn, selfReviewFn,
        readQuotaFn: () => ({ quota: null, rolloutFile: null }) });
      expect(gateExecFn).toHaveBeenCalledTimes(2);
      expect(report.selfReview.rounds).toBe(1);
      expect(report.gate).toMatchObject({ pass: true, steps: [{ output: 'gate output' }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['SIGINT', false], ['SIGINT', true], ['SIGTERM', false], ['SIGTERM', true],
  ])('kills the child group and re-delivers %s (group kill throws: %s)', async (signal, groupKillThrows) => {
    const counts = ['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s));
    const dir = mkdtempSync(join(tmpdir(), 'we-direct-signal-test-'));
    const child = new EventEmitter();
    child.pid = 12345;
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null)); });
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === process.pid) {
        expect(['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s))).toEqual(counts);
      } else if (groupKillThrows) throw new Error('group unavailable');
      return true;
    });
    try {
      const pending = runCodexDirectExec({
        dir, task: 't', logFile: join(dir, 'events.jsonl'), stream: false, spawnFn: () => child,
      });
      process.emit(signal);
      const result = await pending;
      expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(kill).toHaveBeenCalledWith(process.pid, signal);
      expect(result).toMatchObject({ code: null, timedOut: false });
      expect(['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s))).toEqual(counts);
    } finally {
      kill.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves UTF-8 split inside an emoji in both the JSONL log and parsed summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-codex-utf8-test-'));
    const logFile = join(dir, 'events.jsonl');
    const counts = ['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s));
    const message = 'Updated café 🚀';
    const stdout = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }) + '\n';
    const bytes = Buffer.from(stdout);
    const split = bytes.indexOf(Buffer.from('🚀')) + 2;
    const { fn } = fakeSpawn(stdout, { chunks: [bytes.subarray(0, split), bytes.subarray(split)] });
    try {
      const result = await runCodexDirectExec({ dir, task: 't', logFile, stream: false, spawnFn: fn });
      expect(['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s))).toEqual(counts);
      expect(result.stdout).toBe(stdout);
      expect(readFileSync(logFile, 'utf8')).toBe(stdout);
      expect(summarizeEvents(parseJsonlEvents(result.stdout)).agentMessages).toEqual([message]);
      expect(result.stdout).not.toContain('�');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])('uses the real git directory for a linked worktree default log and preserves explicit logs (explicit: %s)', async (explicitLog) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-codex-direct-worktree-test-'));
    const worktree = join(dir, 'linked');
    try {
      const git = initGitRepo(dir);
      git('worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
      expect(statSync(join(worktree, '.git')).isFile()).toBe(true);
      const gitDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
      const stdout = '{}\n';
      const { fn: spawnFn, seen } = fakeSpawn(stdout);
      const logFile = explicitLog ? join(dir, 'logs', 'custom.jsonl') : undefined;
      const report = await codexDirectTask({ dir: worktree, task: 'Inspect the checkout', gate: 'none', stream: false, spawnFn, logFile });
      expect(seen.opts.cwd).toBe(worktree);
      expect(report.exitCode).toBe(0);
      expect(report.logFile).toBe(logFile ?? join(gitDir, 'codex-direct-task.jsonl'));
      expect(report.logFile.startsWith(join(worktree, '.git') + '/')).toBe(false);
      expect(readFileSync(report.logFile, 'utf8')).toBe(stdout);
      expect(report.diff.hasChanges).toBe(false);
      expect(flagValue(seen.argv, '-o')).toBe(join(gitDir, 'codex-direct-task-last-message.txt'));
      const roots = JSON.parse(seen.argv.find((v) => v.startsWith('sandbox_workspace_write.writable_roots=')).split('=').slice(1).join('='));
      expect(roots[0]).toBe(gitDir);
      expect(roots[2]).toBe(seen.opts.env.TMPDIR);
      expect(statSync(roots[2]).isDirectory()).toBe(true);
      rmSync(roots[2], { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isolates review final-message files so a previous clear verdict cannot be reused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-codex-review-output-'));
    try {
      const paths = [];
      for (let i = 0; i < 2; i++) {
        const { fn } = fakeSpawn('{}\n');
        const r = await runCodexDirectExec({ dir, gitDir: dir, review: true, task: 'review',
          logFile: join(dir, 'events.jsonl'), stream: false, spawnFn: fn });
        paths.push(r.outputLastMessageFile);
        if (i === 0) writeFileSync(r.outputLastMessageFile, '{"findings":[]}');
        else expect(() => readFileSync(r.outputLastMessageFile, 'utf8')).toThrow();
      }
      expect(paths[0]).not.toBe(paths[1]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('spawns codex with the exact argv buildCodexDirectTaskArgv would produce, writes the task to stdin, and logs raw stdout to the log file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-codex-direct-test-'));
    const logFile = join(dir, 'events.jsonl');
    const stdout = '{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.completed","usage":{}}\n';
    const { fn, seen } = fakeSpawn(stdout);
    try {
      const r = await runCodexDirectExec({ dir, task: 'do the thing', logFile, stream: false, spawnFn: fn });
      expect(seen.cli).toBe(CODEX_CLI);
      expect(seen.argv).toEqual(buildCodexDirectTaskArgv({ cwd: dir, outputLastMessageFile: join(dir, '.git', 'codex-direct-task-last-message.txt') }));
      expect(seen.stdin).toContain('do the thing');
      expect(seen.stdin).toMatch(/do not run `git commit`/);
      expect(r.stdout).toBe(stdout);
      const logged = readFileSync(logFile, 'utf8');
      expect(logged).toBe(stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])('SIGKILLs the process group and child on timeout (group kill throws: %s)', async (groupKillThrows) => {
    const groupKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (groupKillThrows) throw new Error('group unavailable');
      return true;
    });
    const dir = mkdtempSync(join(tmpdir(), 'we-codex-direct-test-'));
    const logFile = join(dir, 'events.jsonl');
    let killed = false;
    let spawnOpts;
    const spawnFn = (cli, argv, opts) => {
      spawnOpts = opts;
      let closeCb = null;
      return {
        pid: 12345,
        stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(Buffer.from('{"type":"turn.started"}\n')), 0); } },
        stderr: { on: () => {} },
        stdin: { on: () => {}, end: () => {} },
        // A real child only emits 'close' AFTER it is actually killed — simulate that instead of never closing,
        // so the promise this test awaits actually settles (the SIGKILL itself does not resolve anything; the
        // subsequent 'close' event is what `runCodexDirectExec` waits for).
        on: (e, cb) => { if (e === 'close') closeCb = cb; },
        kill: () => { killed = true; if (closeCb) setTimeout(() => closeCb(null), 1); },
      };
    };
    try {
      const r = await runCodexDirectExec({ dir, task: 't', logFile, stream: false, timeoutMs: 5, spawnFn });
      expect(spawnOpts.detached).toBe(true);
      expect(groupKill).toHaveBeenCalledWith(-12345, 'SIGKILL');
      expect(killed).toBe(true);
      expect(r.timedOut).toBe(true);
    } finally {
      groupKill.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settles a timed-out run while a detached descendant still holds the worker pipes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-codex-holder-test-'));
    const pidFile = join(dir, 'holder.pid');
    const holder = keepAliveScript({ maxLifetimeMs: 8000 });
    const script = `const g = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(holder)}],
      { detached: true, stdio: 'inherit' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); g.unref();
      ${keepAliveScript({ maxLifetimeMs: 10000 })}`;
    const spawnFn = (_cli, _argv, opts) => spawn(process.execPath, ['-e', script], opts);
    const started = Date.now();
    try {
      const r = await runCodexDirectExec({ dir, gitDir: dir, task: 't', logFile: join(dir, 'events.jsonl'),
        stream: false, timeoutMs: 1000, closeGraceMs: 300, spawnFn });
      expect(r.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(1000 + 300 + 2000);
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('kills a same-group straggler when a finished run settles without close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-codex-straggler-test-'));
    const pidFile = join(dir, 'straggler.pid');
    const straggler = keepAliveScript({ maxLifetimeMs: 8000 });
    const script = `const g = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(straggler)}],
      { stdio: 'inherit' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); process.exit(0);`;
    const spawnFn = (_cli, _argv, opts) => spawn(process.execPath, ['-e', script], opts);
    const started = Date.now();
    try {
      const r = await runCodexDirectExec({ dir, gitDir: dir, task: 't', logFile: join(dir, 'events.jsonl'),
        stream: false, closeGraceMs: 300, spawnFn });
      expect(r).toMatchObject({ code: 0, timedOut: false });
      expect(Date.now() - started).toBeLessThan(300 + 2000);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('#4665 isolates each edit run, honors the pool override, and leaves review permissions alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-codex-permissions-test-'));
    weCheckout(dir);
    const allocated = [];
    const env = { ...process.env, LANE_POOL_ROOT: join(dir, 'pool override'), TMPDIR: '/old/tmp' };
    const execFn = (bin, args) => args.includes('--absolute-git-dir') ? join(dir, 'metadata') : args.includes('rev-parse') ? 'sha' : '';
    try {
      for (const review of [false, false, true]) {
        const { fn: spawnFn, seen } = fakeSpawn('{}\n');
        await codexDirectTask({ dir, task: 't', review, env, execFn, spawnFn, stream: false });
        if (review) {
          expect(seen.opts.env).toBe(env);
          expect(flagValue(seen.argv, '-s')).toBe('read-only');
          expect(seen.argv.some((v) => /sandbox_workspace_write|shell_environment_policy/.test(v))).toBe(false);
        } else {
          const root = seen.opts.env.TMPDIR;
          expect(allocated).not.toContain(root);
          allocated.push(root);
          expect(statSync(root).isDirectory()).toBe(true);
          expect(seen.opts.env).toMatchObject({ LANE_POOL_ROOT: env.LANE_POOL_ROOT, TMP: root, TEMP: root });
          expect(seen.argv).toContain('sandbox_workspace_write.network_access=true');
          expect(seen.argv).toContain(`sandbox_workspace_write.writable_roots=${JSON.stringify([join(dir, 'metadata'), join(env.LANE_POOL_ROOT, '.admission', 'heavy'), root])}`);
          expect(seen.argv).toContain(`shell_environment_policy.set.TMPDIR=${JSON.stringify(root)}`);
        }
      }
    } finally {
      for (const root of allocated) rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the actual route once and observes the rollout bucket even after quota collection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-codex-route-'));
    const { fn: spawnFn, seen } = fakeSpawn('{"type":"thread.started","thread_id":"t"}\n{"type":"turn.completed"}\n');
    const lines = [];
    try {
      const report = await codexDirectTask({ task: 't', dir, review: true, taskKind: 'prepare', size: 8,
        model: 'x', tier: 'haiku', stream: false, spawnFn, log: l => lines.push(l),
        execFn: (_bin, args) => args.includes('--absolute-git-dir') ? join(dir, 'metadata') : args.includes('rev-parse') ? 'sha' : '',
        clearRolloutAfterRun: true,
        collectQuotaFn: () => ({ quota: { raw: { limit_id: 'observed-bucket', primary: { used_percent: 9 } } }, deleted: true }),
      });
      expect(report.route).toEqual({ kind: 'prepare-complex', model: 'x', effort: 'low', sources: { model: 'explicit', effort: 'explicit' }, bucket: null });
      expect(report).toMatchObject({ model: 'x', effort: 'low' });
      expect(flagValue(seen.argv, '-m')).toBe('x');
      expect(seen.argv).toContain('model_reasoning_effort=low');
      expect(lines.filter(l => l.startsWith('codex-route ·'))).toHaveLength(1);
      expect(lines).toContain('codex-usage · bucket=observed-bucket primary.used_percent=9');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    ['false (silenced)', false, false],
    ['a non-function value (stderr fallback)', true, true],
    ['a throwing logger (swallowed)', () => { throw new Error('logger down'); }, false],
  ])('log %s never aborts the run, and provenance reaches stderr only when it should', async (_name, log, expectStderr) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-codex-nolog-'));
    const { fn: spawnFn, seen } = fakeSpawn('{"type":"thread.started","thread_id":"t"}\n{"type":"turn.completed"}\n');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provenance = () => errSpy.mock.calls.map(c => String(c[0])).filter(l => /^(policy-cascade|codex-usage) ·/.test(l));
    try {
      const report = await codexDirectTask({ task: 'fix a typo', dir, gate: 'none', selfReview: false, log,
        model: 'x', tier: 'haiku', stream: false, spawnFn,
        execFn: (_bin, args) => args.includes('--absolute-git-dir') ? join(dir, 'metadata') : args.includes('rev-parse') ? 'sha' : '',
        clearRolloutAfterRun: true,
        collectQuotaFn: () => ({ quota: { raw: { limit_id: 'observed-bucket', primary: { used_percent: 9 } } }, deleted: true }),
      });
      expect(seen.argv).toBeDefined();
      expect(report.events.threadId).toBe('t');
      if (expectStderr) expect(provenance()).toContain('codex-usage · bucket=observed-bucket primary.used_percent=9');
      else expect(provenance()).toEqual([]);
    } finally { errSpy.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('codexDirectTask: with an explicit --dir, does NOT create a scratch clone, and captures a real diff via execFn', async () => {
    const stdout = '{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.completed","usage":{}}\n';
    const { fn: spawnFn } = fakeSpawn(stdout);
    const execCalls = [];
    const execFn = (bin, args, opts) => {
      execCalls.push({ bin, args });
      if (args.includes('--absolute-git-dir')) return join(args[1], 'git-metadata');
      if (args.includes('rev-parse')) return 'startsha123\n';
      if (args.includes('status')) return ' M edited.txt\0';
      if (args.includes('diff') && args.includes('--stat')) return ' 1 file changed\n';
      if (args.includes('diff')) return 'diff --git a/edited.txt …';
      if (args.includes('log')) return '';
      return '';
    };
    const dir = mkdtempSync(join(tmpdir(), 'we-codex-direct-test-'));
    try {
      const report = await codexDirectTask({
        task: 'edit a file', dir, gate: 'none', stream: false, execFn, spawnFn,
        readQuotaFn: () => ({ quota: null, rolloutFile: null }),
      });
      expect(report.scratch.created).toBe(false);
      expect(report.dir).toBe(dir);
      expect(report.startSha).toBe('startsha123');
      expect(report.logFile).toBe(join(dir, 'git-metadata', 'codex-direct-task.jsonl'));
      expect(report.diff.hasChanges).toBe(true);
      expect(report.events.threadId).toBe('t1');
      expect(execCalls.some((c) => c.bin === 'git' && c.args.includes('clone'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('codexDirectTask: with no --dir, requires repoRoot and creates a scratch clone first', async () => {
    const { fn: spawnFn } = fakeSpawn('{"type":"turn.completed","usage":{}}\n');
    await expect(codexDirectTask({ task: 't', execFn: () => '', spawnFn })).rejects.toThrow(/repoRoot/);
  });

  it('codexDirectTask: no --dir + repoRoot given → clones, then runs codex, then diffs the CLONE, never the source', async () => {
    const stdout = '{"type":"turn.completed","usage":{}}\n';
    const { fn: spawnFn, seen } = fakeSpawn(stdout);
    const execFn = (bin, args) => {
      if (bin === 'git' && args[0] === 'clone') return '';
      if (bin === 'git' && args.includes('get-url')) throw new Error('no origin');
      if (args.includes('--absolute-git-dir')) return join(args[1], 'git-metadata');
      if (bin === 'git' && args.includes('rev-parse')) return 'sha0\n';
      if (bin === 'git' && args.includes('status')) return '';
      if (bin === 'git' && args.includes('diff')) return '';
      if (bin === 'git' && args.includes('log')) return '';
      return '';
    };
    const report = await codexDirectTask({
      task: 't', repoRoot: '/repo', gate: 'none', stream: false, execFn, spawnFn,
      mkTempDir: (p) => `${p}FAKE`, existsFn: () => false,
    });
    expect(report.scratch.created).toBe(true);
    expect(report.dir).toMatch(/FAKE$/);
    expect(flagValueFrom(seen.argv, '-C')).toBe(report.dir);
    // #3782: no origin on repoRoot here (get-url throws) — realOrigin is honestly null, origin was never wired.
    expect(report.scratch.realOrigin).toBeNull();
    expect(report.scratch.originWired).toBe(false);
  });

  it('#3782: codexDirectTask threads through the default (origin left local, real remote only reported) and the wireOriginToRemote opt-in end to end', async () => {
    const stdout = '{"type":"turn.completed","usage":{}}\n';
    const { fn: spawnFn } = fakeSpawn(stdout);
    const setUrlCalls = [];
    const execFn = (bin, args) => {
      if (bin === 'git' && args[0] === 'clone') return '';
      if (bin === 'git' && args.includes('get-url')) return 'git@github.com:x/y.git\n';
      if (bin === 'git' && args.includes('set-url')) { setUrlCalls.push(args); return ''; }
      if (args.includes('--absolute-git-dir')) return join(args[1], 'git-metadata');
      if (bin === 'git' && args.includes('rev-parse')) return 'sha0\n';
      if (bin === 'git' && args.includes('status')) return '';
      if (bin === 'git' && args.includes('diff')) return '';
      if (bin === 'git' && args.includes('log')) return '';
      return '';
    };
    const baseOpts = {
      task: 't', repoRoot: '/repo', gate: 'none', stream: false, execFn, spawnFn,
      mkTempDir: (p) => `${p}FAKE`, existsFn: () => false,
    };

    const defaultReport = await codexDirectTask(baseOpts);
    expect(defaultReport.scratch.realOrigin).toBe('git@github.com:x/y.git');
    expect(defaultReport.scratch.originWired).toBe(false);
    expect(setUrlCalls).toHaveLength(0);

    const wiredReport = await codexDirectTask({ ...baseOpts, wireOriginToRemote: true });
    expect(wiredReport.scratch.realOrigin).toBe('git@github.com:x/y.git');
    expect(wiredReport.scratch.originWired).toBe(true);
    expect(setUrlCalls).toHaveLength(1);
  });

  function flagValueFrom(argv, flag) {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  }

  describe('#x8wbivt Fork 4 — codexDirectTask wires the quota signal into its report', () => {
    it('surfaces quotaUsedPercent/quotaWindowMinutes/quotaResetsAt/quotaPlanType via the injected readQuotaFn (default: read-only)', async () => {
      const stdout = '{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.completed","usage":{}}\n';
      const { fn: spawnFn } = fakeSpawn(stdout);
      const execFn = (bin, args) => (args.includes('--absolute-git-dir') ? join(args[1], 'git-metadata') : args.includes('rev-parse') ? 'sha0\n' : '');
      const dir = mkdtempSync(join(tmpdir(), 'we-codex-direct-test-'));
      const readQuotaFn = vi.fn(({ threadId }) => {
        expect(threadId).toBe('t1');
        return { quota: { usedPercent: 42, windowMinutes: 300, resetsAt: 12345, planType: 'prolite' }, rolloutFile: '/h/sessions/x.jsonl' };
      });
      try {
        const report = await codexDirectTask({ task: 't', dir, gate: 'none', stream: false, execFn, spawnFn, readQuotaFn });
        expect(readQuotaFn).toHaveBeenCalledOnce();
        expect(report.quotaUsedPercent).toBe(42);
        expect(report.quotaWindowMinutes).toBe(300);
        expect(report.quotaResetsAt).toBe(12345);
        expect(report.quotaPlanType).toBe('prolite');
        expect(report.quotaRolloutFile).toBe('/h/sessions/x.jsonl');
        expect(report.quotaRolloutCleared).toBe(false); // default path never deletes
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('uses collectQuotaFn (read-then-delete) instead when clearRolloutAfterRun is true', async () => {
      const stdout = '{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.completed","usage":{}}\n';
      const { fn: spawnFn } = fakeSpawn(stdout);
      const execFn = (bin, args) => (args.includes('--absolute-git-dir') ? join(args[1], 'git-metadata') : args.includes('rev-parse') ? 'sha0\n' : '');
      const dir = mkdtempSync(join(tmpdir(), 'we-codex-direct-test-'));
      const readQuotaFn = vi.fn();
      const collectQuotaFn = vi.fn(() => ({ quota: { usedPercent: 7, windowMinutes: 300, resetsAt: 1, planType: 'prolite' }, rolloutFile: '/h/sessions/x.jsonl', deleted: true }));
      try {
        const report = await codexDirectTask({
          task: 't', dir, gate: 'none', stream: false, execFn, spawnFn, clearRolloutAfterRun: true, readQuotaFn, collectQuotaFn,
        });
        expect(collectQuotaFn).toHaveBeenCalledOnce();
        expect(readQuotaFn).not.toHaveBeenCalled();
        expect(report.quotaUsedPercent).toBe(7);
        expect(report.quotaRolloutCleared).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('never looks up quota for an --ephemeral run (no rollout was ever written)', async () => {
      const stdout = '{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.completed","usage":{}}\n';
      const { fn: spawnFn } = fakeSpawn(stdout);
      const execFn = (bin, args) => (args.includes('--absolute-git-dir') ? join(args[1], 'git-metadata') : args.includes('rev-parse') ? 'sha0\n' : '');
      const dir = mkdtempSync(join(tmpdir(), 'we-codex-direct-test-'));
      const readQuotaFn = vi.fn();
      const collectQuotaFn = vi.fn();
      try {
        const report = await codexDirectTask({
          task: 't', dir, gate: 'none', stream: false, execFn, spawnFn, ephemeral: true, readQuotaFn, collectQuotaFn,
        });
        expect(readQuotaFn).not.toHaveBeenCalled();
        expect(collectQuotaFn).not.toHaveBeenCalled();
        expect(report.quotaUsedPercent).toBeNull();
        expect(report.quotaRolloutFile).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('never looks up quota when the run produced no thread id at all (nothing to key the lookup on)', async () => {
      const stdout = '{"type":"turn.completed","usage":{}}\n'; // no thread.started
      const { fn: spawnFn } = fakeSpawn(stdout);
      const execFn = (bin, args) => (args.includes('--absolute-git-dir') ? join(args[1], 'git-metadata') : args.includes('rev-parse') ? 'sha0\n' : '');
      const dir = mkdtempSync(join(tmpdir(), 'we-codex-direct-test-'));
      const readQuotaFn = vi.fn();
      try {
        const report = await codexDirectTask({ task: 't', dir, gate: 'none', stream: false, execFn, spawnFn, readQuotaFn });
        expect(readQuotaFn).not.toHaveBeenCalled();
        expect(report.quotaUsedPercent).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});


describe('direct task routes', () => {
  it.each([
    [{ taskKind: 'fix' }, 'gpt-6.1-sol', 'high'],
    [{ taskKind: 'prepare', size: 8 }, 'gpt-6-astra', 'high'],
    [{ taskKind: 'trivial' }, 'gpt-6-luna', 'low'],
    [{ taskKind: 'trivial', model: 'x', tier: 'opus' }, 'x', 'high'],
    [{ review: true }, 'gpt-6.1-sol', 'medium'],
  ])('routes argv %j', (opts, model, effort) => {
    const argv = buildCodexDirectTaskArgv({ cwd: '/tmp/task', ...opts });
    expect(flagValue(argv, '-m')).toBe(model);
    expect(argv).toContain(`model_reasoning_effort=${effort}`);
  });
});


describe('direct CLI flags reach the actual spawn and JSON result', () => {
  it.each([
    [['--task-kind=fix'], 'fix', 'gpt-6.1-sol', 'high', 'tool', 'tool'],
    [['--task-kind=prepare', '--size=8'], 'prepare-complex', 'gpt-6-astra', 'high', 'tool', 'tool'],
    [['--task-kind=trivial'], 'trivial', 'gpt-6-luna', 'low', 'tool', 'tool'],
    [['--task-kind=trivial', '--model=x', '--tier=opus'], 'trivial', 'x', 'high', 'explicit', 'explicit'],
    [['--review'], 'review', 'gpt-6.1-sol', 'medium', 'tool', 'tool'],
  ])('%j', (flags, kind, model, effort, modelSource, effortSource) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-direct-cli-'));
    weCheckout(dir);
    const preload = `import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { EventEmitter } from 'node:events';
      cp.execFileSync = (_bin, args) => args.includes('--absolute-git-dir') ? ${JSON.stringify(join(dir, 'metadata'))} : args.includes('rev-parse') ? 'sha' : '';
      cp.spawn = (_bin, argv) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = { on() {}, end() { setTimeout(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\\n'));
          child.emit('close', 0);
        }, 0); } };
        child.kill = () => {};
        return child;
      };
      syncBuiltinESMExports();`;
    try {
      const stdout = execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
        'scripts/codex-direct-task.mjs', '--task=fixture', `--dir=${dir}`, '--json', '--no-stream', '--ephemeral', ...flags],
      { encoding: 'utf8', env: { ...process.env, WE_CODEX_MODEL_BY_TASK: '{}' } });
      const report = JSON.parse(stdout);
      expect(report.route).toMatchObject({ kind, model, effort, sources: { model: modelSource, effort: effortSource } });
      expect(flagValue(report.argv, '-m')).toBe(model);
      expect(report.argv).toContain(`model_reasoning_effort=${effort}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // Text mode exits 1 on a red gate, and `--no-self-review` reaches codexDirectTask: with self-review forced on by
  // the environment, `--ephemeral` is refused (exit 1) unless the flag turns it off.
  it.each([
    ['a green gate with --no-self-review exits 0', true, ['--no-self-review'], 0],
    ['a red gate in text mode exits 1', false, ['--no-self-review'], 1],
    ['a task exiting 7 in foreground text mode exits 1', true, ['--no-self-review'], 1, 7],
    ['--ephemeral without --no-self-review is refused while self-review is on', true, [], 1],
  ])('%s', (_name, gateGreen, flags, status, runCode = 0) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-direct-cli-exit-'));
    weCheckout(dir);
    const preload = `import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { EventEmitter } from 'node:events';
      cp.execFileSync = (bin, args) => {
        if (bin === 'npm' && args.includes('check:standards') && !${gateGreen}) throw Object.assign(new Error('standards red'), { status: 1 });
        return args.includes('--absolute-git-dir') ? ${JSON.stringify(join(dir, 'metadata'))} : args.includes('rev-parse') ? 'sha' : '';
      };
      cp.spawn = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = { on() {}, end() { setTimeout(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\\n'));
          child.emit('close', ${runCode});
        }, 0); } };
        child.kill = () => {};
        return child;
      };
      syncBuiltinESMExports();`;
    try {
      const run = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
        'scripts/codex-direct-task.mjs', '--task=fixture', `--dir=${dir}`, '--no-stream', '--ephemeral', '--gate=standards', ...flags],
      { encoding: 'utf8', env: { ...process.env, WE_CODEX_MODEL_BY_TASK: '{}', WE_BUILD_SELF_REVIEW_ENABLED: 'true' } });
      expect(run.status, run.stderr).toBe(status);
      if (status === 0) expect(run.stdout).toContain('gate (standards): PASS');
      else if (runCode) expect(run.stdout).toContain(`exit: ${runCode}`);
      else if (flags.length) expect(run.stdout).toContain('gate (standards): FAIL');
      else expect(run.stderr).toContain('--ephemeral requires self-review off');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([{ flags: [] }, { flags: ['--json'] }])('an unreadable foreground task file exits 1 with flags $flags and ignores the child-delay hook', ({ flags }) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-direct-cli-unreadable-'));
    try {
      const run = spawnSync(process.execPath, ['scripts/codex-direct-task.mjs',
        `--task-file=${join(dir, 'missing-task.txt')}`, ...flags], {
        encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024,
        env: { ...process.env, CODEX_DIRECT_TASK_TEST_CHILD_DELAY_MS: '10000' },
      });
      expect(run.error).toBeUndefined();
      expect(run.status, run.stderr).toBe(1);
      expect(run.stderr).toContain('ENOENT');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('detached jobs', () => {
  let jobsDir;
  beforeEach(() => { jobsDir = mkdtempSync(join(tmpdir(), 'codex-jobs-test-')); });
  afterEach(() => { rmSync(jobsDir, { recursive: true, force: true }); });

  function fixture({ pid = 123 } = {}) {
    let time = 0;
    let record = { id: 'test-job', pid, status: 'running', startedAt: new Date(0).toISOString(),
      resultPath: 'test-job.result.json', exitCode: null };
    const child = new EventEmitter();
    child.pid = pid;
    child.unref = vi.fn();
    child.on('exit', code => { record = { ...record, status: code === 0 ? 'done' : 'failed', exitCode: code }; });
    const readRecord = vi.fn(() => ({ ...record }));
    const writeRecord = vi.fn(updated => { record = updated; });
    const sleep = vi.fn(async ms => { time += ms; });
    const options = { jobId: record.id, jobsDir, readRecord, writeRecord, isAlive: () => true,
      sleep, now: () => time, pollMs: 1000 };
    return { child, options, sleep, writeRecord };
  }

  it('done: fake child completion returns done/0 without sleeping', async () => {
    const f = fixture();
    f.child.emit('exit', 0);
    expect(await waitForJob(f.options)).toEqual({ status: 'done', exitCode: 0, resultPath: 'test-job.result.json', code: 0 });
    expect(f.sleep).not.toHaveBeenCalled();
  });

  it.each([0, 20, 100, 249, 249.9, 'abc', -1, NaN, Infinity, ''])('rejects invalid maxMs=%s before any IO in the exported wait', async maxMs => {
    const f = fixture();
    const isAlive = vi.fn();
    const updateRecord = vi.fn();
    const now = vi.fn();
    await expect(waitForJob({ ...f.options, maxMs, isAlive, updateRecord, now }))
      .rejects.toThrow('codex-direct-task wait: --max-ms must be between 250 and 540000');
    expect(f.options.readRecord).not.toHaveBeenCalled();
    expect(isAlive).not.toHaveBeenCalled();
    expect(updateRecord).not.toHaveBeenCalled();
    expect(f.writeRecord).not.toHaveBeenCalled();
    expect(f.sleep).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it.each(['0', '20', '100', '249', 'abc', '-1', '', 'NaN', 'Infinity', null])('wait CLI reports a usage error for --max-ms=%s without job IO', maxMs => {
    const preload = `
      import fs from 'node:fs';
      import asyncFs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      for (const api of [fs, asyncFs]) {
        for (const [name, original] of Object.entries(api)) {
          if (typeof original !== 'function') continue;
          api[name] = Object.assign((...args) => {
            if (args.some(arg => typeof arg === 'string' && arg.startsWith(process.env.CODEX_JOBS_DIR))) {
              process.stderr.write('unexpected job IO: ' + name + '\\n');
              throw new Error('unexpected job IO');
            }
            return original(...args);
          }, original);
        }
      }
      process.kill = () => { process.stderr.write('unexpected PID probe\\n'); throw new Error('unexpected PID probe'); };
      syncBuiltinESMExports();`;
    const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      'scripts/codex-direct-task.mjs', 'wait', '--job=blocked', maxMs === null ? '--max-ms' : `--max-ms=${maxMs}`], {
      encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024,
      env: { ...process.env, CODEX_JOBS_DIR: jobsDir },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(2);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe('codex-direct-task wait: --max-ms must be between 250 and 540000\n');
  });

  it.each(['250', '540000', '1080000', undefined])('wait CLI accepts max-ms=%s and reports a completed job', maxMs => {
    const record = { id: 'accepted', pid: process.pid, status: 'done', exitCode: 0, resultPath: 'result.json' };
    writeJobRecord(record, { jobsDir });
    const child = spawnSync(process.execPath, ['scripts/codex-direct-task.mjs', 'wait', '--job=accepted',
      ...(maxMs === undefined ? [] : [`--max-ms=${maxMs}`])], {
      encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024,
      env: { ...process.env, CODEX_JOBS_DIR: jobsDir },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toEqual({ status: 'done', exitCode: 0, resultPath: record.resultPath });
  });

  it('bounds a never-resolving reader by the requested 250 ms deadline', async () => {
    const maxMs = 250;
    const readRecord = vi.fn(() => new Promise(() => {}));
    const started = performance.now();
    expect(await waitForJob({ jobId: 'blocked', jobsDir, readRecord, maxMs }))
      .toEqual({ status: 'running', exitCode: null, resultPath: null, code: 75 });
    // Literal bound: the requested 250 ms plus 50 ms for host scheduling, never another grace window.
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(240);
    expect(elapsed).toBeLessThan(300);
    expect(readRecord).toHaveBeenCalledOnce();
  });

  it('reads a real temporary record through the default async path', async () => {
    const record = { id: 'async-read', pid: process.pid, status: 'done', exitCode: 0, resultPath: 'result.json' };
    writeJobRecord(record, { jobsDir });
    const read = vi.spyOn(fsPromises, 'readFile');
    try {
      expect(await waitForJob({ jobId: record.id, jobsDir, maxMs: 1000 }))
        .toEqual({ status: 'done', exitCode: 0, resultPath: record.resultPath, code: 0 });
      expect(read).toHaveBeenCalledWith(join(jobsDir, `${record.id}.json`), 'utf8');
    } finally { read.mockRestore(); }
  });

  it('bounds a blocked default async filesystem read by the requested 250 ms budget', async () => {
    const read = vi.spyOn(fsPromises, 'readFile').mockImplementation(() => new Promise(() => {}));
    const started = performance.now();
    try {
      expect(await waitForJob({ jobId: 'blocked', jobsDir, maxMs: 250 }))
        .toEqual({ status: 'running', exitCode: null, resultPath: null, code: 75 });
      expect(performance.now() - started).toBeLessThan(300);
      expect(read).toHaveBeenCalledOnce();
    } finally { read.mockRestore(); }
  });

  it('wait CLI exits 75 at max-ms=250 when an async reader leaves an active handle', () => {
    const maxMs = 250;
    const preload = `
      import fs from 'node:fs/promises';
      import { register } from 'node:module';
      // Keep the loader's own reads in its worker. The blanket override below
      // must stall application IO, rather than prevent the CLI from loading.
      register('data:text/javascript,export {}');
      fs.readFile = () => {
        ${keepAliveScript({ maxLifetimeMs: 10000 })}
        return new Promise(() => {});
      };`;
    const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      'scripts/codex-direct-task.mjs', 'wait', '--job=blocked', `--max-ms=${maxMs}`], {
      encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024,
      env: { ...process.env, CODEX_JOBS_DIR: jobsDir },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(75);
    expect(JSON.parse(child.stdout)).toEqual({ status: 'running', exitCode: null, resultPath: null });
  });

  it('wait CLI bounds a stuck job-record read at max-ms=250 without intercepting module-loader reads', () => {
    const maxMs = 250;
    const preload = `
      import fs from 'node:fs/promises';
      const readFile = fs.readFile;
      fs.readFile = (...args) => {
        if (String(args[0]).endsWith('/blocked.json')) {
          ${keepAliveScript({ maxLifetimeMs: 10000 })}
          return new Promise(() => {});
        }
        return readFile(...args);
      };`;
    const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      'scripts/codex-direct-task.mjs', 'wait', '--job=blocked', `--max-ms=${maxMs}`], {
      encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024,
      env: { ...process.env, CODEX_JOBS_DIR: jobsDir },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(75);
    expect(JSON.parse(child.stdout)).toEqual({ status: 'running', exitCode: null, resultPath: null });
  });

  it('bounds a never-settling poll sleep by the same deadline', async () => {
    const f = fixture();
    const sleep = vi.fn(() => new Promise(() => {}));
    const started = performance.now();
    expect(await waitForJob({ ...f.options, now: Date.now, sleep, maxMs: 250 }))
      .toMatchObject({ status: 'running', code: 75 });
    expect(performance.now() - started).toBeLessThan(300);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('persists a dead PID through the default async atomic writer', async () => {
    const record = { id: 'async-write', pid: process.pid, status: 'running', exitCode: null, resultPath: 'result.json' };
    writeJobRecord(record, { jobsDir });
    const write = vi.spyOn(fsPromises, 'writeFile');
    const rename = vi.spyOn(fsPromises, 'rename');
    try {
      expect(await waitForJob({ jobId: record.id, jobsDir, isAlive: () => false, maxMs: 1000 }))
        .toMatchObject({ status: 'failed', exitCode: 1, code: 1 });
      const path = join(jobsDir, `${record.id}.json`);
      expect(write).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), expect.any(String), { mode: 0o600 });
      expect(rename).toHaveBeenCalledWith(write.mock.calls[0][0], path);
      expect(readJobRecord(record.id, { jobsDir })).toMatchObject({ status: 'failed', exitCode: 1 });
    } finally {
      write.mockRestore();
      rename.mockRestore();
    }
  });

  it('default PID probe fails a running job whose live PID now belongs to a different process (PID reuse)', async () => {
    // process.pid is alive, but its start time is not the one recorded at spawn — the job's own process is gone.
    const record = { id: 'pid-reused', pid: process.pid, pidStart: 'Thu Jan  1 00:00:00 1970', status: 'running',
      exitCode: null, resultPath: 'result.json' };
    writeJobRecord(record, { jobsDir });
    expect(await waitForJob({ jobId: record.id, jobsDir, maxMs: 1000 }))
      .toMatchObject({ status: 'failed', exitCode: 1, code: 1 });
    expect(readJobRecord(record.id, { jobsDir })).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('default PID probe keeps a running job alive while its recorded start time still matches', async () => {
    const pidStart = readPidStart(process.pid);
    expect(pidStart).toMatch(/\S/);
    const record = { id: 'pid-same', pid: process.pid, pidStart, status: 'running', exitCode: null, resultPath: 'result.json' };
    writeJobRecord(record, { jobsDir });
    expect(await waitForJob({ jobId: record.id, jobsDir, maxMs: 250, pollMs: 50 }))
      .toMatchObject({ status: 'running', exitCode: null, code: 75 });
    expect(readJobRecord(record.id, { jobsDir })).toMatchObject({ status: 'running' });
  });

  it.each([
    ['no start time recorded (legacy record)', undefined, () => 'anything', true],
    ['a null start time (ps failed at spawn)', null, () => 'anything', true],
    ['a matching start time', 'Fri Oct 23 20:10:13 2026', () => 'Fri Oct 23 20:10:13 2026', true],
    ['a different start time', 'Fri Oct 23 20:10:13 2026', () => 'Sat Oct 24 01:00:00 2026', false],
    ['a live PID with no readable start time', 'Fri Oct 23 20:10:13 2026', () => null, false],
  ])('jobIsAlive with %s', (_label, pidStart, readStart, expected) => {
    expect(jobIsAlive({ pid: process.pid, pidStart }, { readStart })).toBe(expected);
  });

  it('jobIsAlive never consults the start time for a PID that is gone', () => {
    const readStart = vi.fn(() => 'x');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    try {
      expect(jobIsAlive({ pid: 123, pidStart: 'x' }, { readStart, readState: readStart })).toBe(false);
      expect(readStart).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });

  // An exited child its parent never reaped still answers kill(pid, 0) and keeps its start time.
  it.each([
    ['a zombie with an unchanged start time', 'Fri Oct 23 20:10:13 2026', 'Z', false],
    ['a foreground zombie with an unchanged start time', 'Fri Oct 23 20:10:13 2026', 'Z+', false],
    ['a legacy record (no start time) whose PID is a zombie', undefined, 'Z', false],
    ['a null start time whose PID is a zombie', null, 'Zs', false],
    ['a sleeping process with a matching start time', 'Fri Oct 23 20:10:13 2026', 'S', true],
    ['a legacy record whose PID is running', undefined, 'R+', true],
    ['a PID that vanished before the state probe', 'Fri Oct 23 20:10:13 2026', null, false],
  ])('jobIsAlive with %s', (_label, pidStart, state, expected) => {
    const readStart = vi.fn(() => 'Fri Oct 23 20:10:13 2026');
    expect(jobIsAlive({ pid: process.pid, pidStart }, { readStart, readState: () => state })).toBe(expected);
    if (state === null || state.startsWith('Z')) expect(readStart).not.toHaveBeenCalled();
  });

  it('jobIsAlive fails closed when the state probe does not answer, on both record shapes', () => {
    const readState = () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); };
    for (const pidStart of ['Fri Oct 23 20:10:13 2026', undefined]) {
      expect(() => jobIsAlive({ pid: process.pid, pidStart }, { readStart: () => pidStart, readState })).toThrow('timed out');
    }
  });

  it('a zombie job with an unchanged start time is recovered as failed (code 1), not left running', async () => {
    const pidStart = 'Fri Oct 23 20:10:13 2026';
    const record = { id: 'zombie', pid: process.pid, pidStart, status: 'running', exitCode: null, resultPath: 'result.json' };
    writeJobRecord(record, { jobsDir });
    const isAlive = rec => jobIsAlive(rec, { readStart: () => pidStart, readState: () => 'Z+' });
    expect(await waitForJob({ jobId: record.id, jobsDir, isAlive, maxMs: 1000 }))
      .toMatchObject({ status: 'failed', exitCode: 1, code: 1 });
    expect(readJobRecord(record.id, { jobsDir })).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('a state probe that does not answer fails the wait closed (exit 2) without marking the job failed', async () => {
    const record = { id: 'ps-state-hung', pid: process.pid, status: 'running', exitCode: null, resultPath: 'result.json' };
    writeJobRecord(record, { jobsDir });
    const isAlive = rec => jobIsAlive(rec, { readState: () => { throw new Error('ps timed out'); } });
    expect(await waitForJob({ jobId: record.id, jobsDir, isAlive, maxMs: 1000 })).toMatchObject({ code: 2 });
    expect(readJobRecord(record.id, { jobsDir })).toMatchObject({ status: 'running', exitCode: null });
  });

  it('readPidState reads a bounded, locale- and zone-pinned ps state; null for no such pid, throws when ps does not answer', () => {
    const execFn = vi.fn(() => ' Z+ \n');
    expect(readPidState(42, { execFn })).toBe('Z+');
    expect(execFn).toHaveBeenCalledWith('ps', ['-o', 'stat=', '-p', '42'], expect.objectContaining({
      timeout: PID_START_TIMEOUT_MS, env: expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC' }),
    }));
    expect(readPidState(42, { execFn: () => { throw Object.assign(new Error('ps exited 1'), { status: 1 }); } })).toBeNull();
    expect(readPidState(42, { execFn: () => '\n' })).toBeNull();
    expect(readPidState(0, { execFn })).toBeNull();
    expect(() => readPidState(42, { execFn: () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); } }))
      .toThrow('timed out');
    expect(readPidState(process.pid)).toMatch(/^[^Z\s]/);
  });

  it('readPidStart reads a bounded, locale- and zone-pinned ps start time; null for no such pid, throws when ps does not answer', () => {
    const execFn = vi.fn(() => '  Fri Oct 23  1:10:13 2026\n');
    expect(readPidStart(42, { execFn })).toBe('Fri Oct 23 1:10:13 2026');
    expect(execFn).toHaveBeenCalledWith('ps', ['-o', 'lstart=', '-p', '42'], expect.objectContaining({
      timeout: PID_START_TIMEOUT_MS, env: expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC' }),
    }));
    // The probe runs between spawn and the record write: a slow ps must never outlast the child's wait for it.
    expect(PID_START_TIMEOUT_MS * 2).toBeLessThanOrEqual(JOB_RECORD_INIT_DEADLINE_MS);
    expect(readPidStart(42, { execFn: () => { throw Object.assign(new Error('ps exited 1'), { status: 1 }); } })).toBeNull();
    expect(readPidStart(42, { execFn: () => '\n' })).toBeNull();
    expect(() => readPidStart(42, { execFn: () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); } }))
      .toThrow('timed out');
  });

  it('a start-time probe that does not answer fails the wait closed (exit 2) without marking the job failed', async () => {
    const record = { id: 'ps-hung', pid: process.pid, pidStart: 'Fri Oct 23 20:10:13 2026', status: 'running',
      exitCode: null, resultPath: 'result.json' };
    writeJobRecord(record, { jobsDir });
    const isAlive = rec => jobIsAlive(rec, { readStart: () => { throw new Error('ps timed out'); } });
    expect(await waitForJob({ jobId: record.id, jobsDir, isAlive, maxMs: 1000 })).toMatchObject({ code: 2 });
    expect(readJobRecord(record.id, { jobsDir })).toMatchObject({ status: 'running', exitCode: null });
  });

  it('startDetachedJob records a null pidStart when the start-time probe fails', async () => {
    const child = new EventEmitter();
    child.pid = 321;
    child.unref = vi.fn();
    const spawnFn = vi.fn(() => { queueMicrotask(() => child.emit('spawn')); return child; });
    const job = await startDetachedJob({ args: ['--task=x', '--detach'], jobsDir, spawnFn, now: () => 0, random: () => 'nostart',
      nodePath: 'node', scriptPath: 'scripts/codex-direct-task.mjs', env: {}, readStart: () => { throw new Error('no ps'); } });
    expect(job.pidStart).toBeNull();
    expect(readJobRecord(job.id, { jobsDir })).toMatchObject({ pid: 321, pidStart: null, status: 'running' });
  });

  it.each([['', 'an empty string'], [7, 'a number']])('rejects a record whose pidStart is %j (%s)', (pidStart) => {
    writeFileSync(join(jobsDir, 'bad-start.json'), JSON.stringify({ id: 'bad-start', pid: 1, pidStart, status: 'running',
      exitCode: null, resultPath: 'r.json' }));
    expect(() => readJobRecord('bad-start', { jobsDir })).toThrow('incomplete job record');
  });

  it('clears the budget timer after an immediate asynchronous read', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.child.emit('exit', 0);
      expect(await waitForJob({ ...f.options, readRecord: async () => f.options.readRecord() }))
        .toMatchObject({ status: 'done', code: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('bounds a stalled async write without renaming after the deadline', async () => {
    const record = { id: 'blocked-write', pid: process.pid, status: 'running', exitCode: null, resultPath: 'result.json' };
    writeJobRecord(record, { jobsDir });
    let settleWrite;
    const write = vi.spyOn(fsPromises, 'writeFile').mockImplementation(() => new Promise(resolveWrite => { settleWrite = resolveWrite; }));
    const rename = vi.spyOn(fsPromises, 'rename');
    const rm = vi.spyOn(fsPromises, 'rm');
    const started = performance.now();
    try {
      expect(await waitForJob({ jobId: record.id, jobsDir, isAlive: () => false, maxMs: 250 }))
        .toMatchObject({ status: 'running', code: 75 });
      expect(performance.now() - started).toBeLessThan(300);
      expect(write).toHaveBeenCalledOnce();
      expect(readJobRecord(record.id, { jobsDir })).toEqual(record);
      expect(rm).not.toHaveBeenCalled();
      settleWrite();
      await vi.waitFor(() => expect(rm).toHaveBeenCalledWith(write.mock.calls[0][0], { force: true }));
      expect(rename).not.toHaveBeenCalled();
      expect(readJobRecord(record.id, { jobsDir })).toEqual(record);
    } finally {
      settleWrite?.();
      write.mockRestore();
      rename.mockRestore();
      rm.mockRestore();
    }
  });

  it('returns at the deadline during stuck tmp removal', async () => {
    const record = { id: 'stuck-cleanup', pid: process.pid, status: 'running', exitCode: null, resultPath: 'result.json' };
    writeJobRecord(record, { jobsDir });
    let finishCleanup;
    const gate = new Promise(resolveCleanup => { finishCleanup = resolveCleanup; });
    const originalRm = fsPromises.rm;
    const rm = vi.spyOn(fsPromises, 'rm').mockImplementation(async (...args) => {
      await gate;
      return originalRm(...args);
    });
    const started = performance.now();
    try {
      expect(await waitForJob({ jobId: record.id, jobsDir, isAlive: () => false, maxMs: 250 }))
        .toMatchObject({ status: 'running', code: 75 });
      expect(performance.now() - started).toBeLessThan(300);
      expect(rm).toHaveBeenCalledOnce();
      expect(readJobRecord(record.id, { jobsDir })).toMatchObject({ status: 'failed', exitCode: 1 });
    } finally {
      finishCleanup();
      await Promise.all(rm.mock.results.map(result => result.value));
      rm.mockRestore();
    }
  });

  it('timeout-then-done: first wait returns running/75 and a later wait returns done/0', async () => {
    const f = fixture();
    expect(await waitForJob({ ...f.options, maxMs: 1500 })).toMatchObject({ status: 'running', exitCode: null, code: 75 });
    expect(f.sleep.mock.calls).toEqual([[1000], [500]]);
    f.child.emit('exit', 0);
    expect(await waitForJob(f.options)).toMatchObject({ status: 'done', exitCode: 0, code: 0 });
  });

  it('polls again and observes completion during a wait', async () => {
    const f = fixture();
    expect(await waitForJob({ ...f.options, sleep: async ms => { await f.sleep(ms); f.child.emit('exit', 0); } }))
      .toMatchObject({ status: 'done', code: 0 });
    expect(f.sleep).toHaveBeenCalledOnce();
  });

  it.each([7, 0, null])('failed: propagates exit code %s with fallback 1', async exitCode => {
    const f = fixture();
    f.child.emit('exit', exitCode);
    // A failed record with a legacy zero code must never report success.
    if (exitCode === 0) f.options.readRecord = () => ({ status: 'failed', exitCode, resultPath: 'result' });
    expect(await waitForJob(f.options)).toMatchObject({ status: 'failed', code: exitCode || 1 });
  });

  it('reserves process exit 75 for running jobs, including completion during a poll', async () => {
    const f = fixture();
    expect(await waitForJob({ ...f.options, sleep: async ms => {
      await f.sleep(ms);
      f.child.emit('exit', 75);
    } })).toMatchObject({ status: 'failed', exitCode: 75, code: 1 });
    expect(await waitForJob(f.options)).toMatchObject({ status: 'failed', exitCode: 75, code: 1 });
  });

  it('wait CLI reports terminal exit 75 as failure on successive calls without rewriting the task code', () => {
    const record = { id: 'terminal-75', pid: process.pid, status: 'failed', exitCode: 75,
      resultPath: 'result.json', finishedAt: new Date(0).toISOString() };
    writeJobRecord(record, { jobsDir });
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = spawnSync(process.execPath, ['scripts/codex-direct-task.mjs', 'wait',
        `--job=${record.id}`, '--max-ms=250'], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, CODEX_JOBS_DIR: jobsDir },
      });
      expect(child.error).toBeUndefined();
      expect(JSON.parse(child.stdout)).toEqual({ status: 'failed', exitCode: 75, resultPath: record.resultPath });
      expect(child.status, child.stderr).toBe(1);
      expect(readJobRecord(record.id, { jobsDir })).toEqual(record);
    }
  });

  it('maps exit 75 discovered by the dead-PID recovery reread to terminal failure', async () => {
    const f = fixture();
    const readRecord = vi.fn().mockImplementationOnce(f.options.readRecord).mockImplementation(() => {
      f.child.emit('exit', 75);
      return f.options.readRecord();
    });
    expect(await waitForJob({ ...f.options, isAlive: () => false, readRecord }))
      .toMatchObject({ status: 'failed', exitCode: 75, code: 1 });
    expect(readRecord).toHaveBeenCalledTimes(2);
    expect(f.writeRecord).not.toHaveBeenCalled();
  });

  it.each([null, 'SIGINT', 'SIGTERM', 'after startup'])('unowned --job invocation leaves a live owner record intact on %s', signal => {
    const record = { id: 'other-owner', pid: process.pid, status: 'running', exitCode: null,
      resultPath: 'result.json', startedAt: new Date(0).toISOString() };
    writeJobRecord(record, { jobsDir });
    const preload = join(jobsDir, 'unowned-preload.mjs');
    writeFileSync(preload, signal === 'after startup' ? `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const read = fs.readFileSync;
      let first = true;
      fs.readFileSync = function (path, ...args) {
        const value = read.call(this, path, ...args);
        if (first && String(path).endsWith('other-owner.json')) {
          first = false;
          return JSON.stringify({ ...JSON.parse(value), pid: process.pid });
        }
        return value;
      };
      syncBuiltinESMExports();
    ` : signal ? `
      const original = process.once;
      process.once = function (name, listener) {
        const result = original.call(this, name, listener);
        if (name === ${JSON.stringify(signal)}) setImmediate(() => process.kill(process.pid, name));
        return result;
      };
    ` : '');
    const child = spawnSync(process.execPath, ['--import', preload, 'scripts/codex-direct-task.mjs',
      `--job=${record.id}`], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, CODEX_JOBS_DIR: jobsDir },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : signal === 'after startup' ? 2 : 1);
    if (!signal) expect(child.stderr).toContain('job record was not initialized by launcher');
    expect(readJobRecord(record.id, { jobsDir })).toEqual(record);
    process.kill(record.pid, 0);
  }, 12000);

  it('dead PID while running becomes failed/1 and persists its finish time', async () => {
    const f = fixture();
    expect(await waitForJob({ ...f.options, isAlive: () => false })).toMatchObject({ status: 'failed', exitCode: 1, code: 1 });
    expect(f.writeRecord).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', exitCode: 1, finishedAt: new Date(0).toISOString() }));
  });

  it.each([
    ['EPERM', 'running', null, 75],
    ['ESRCH', 'failed', 1, 1],
    ['EIO', 'failed', null, 2],
  ])('default PID probe receiving %s returns %s with code %s/%s', async (errorCode, status, exitCode, code) => {
    // A real, live, non-zombie PID: the default state probe runs real ps after an EPERM, so a made-up PID
    // would (correctly) read as gone.
    const f = fixture({ pid: process.pid });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(errorCode), { code: errorCode });
    });
    try {
      expect(await waitForJob({ ...f.options, isAlive: undefined, maxMs: 1000 }))
        .toMatchObject({ status, exitCode, code });
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(process.pid, 0);
      if (errorCode === 'ESRCH') {
        expect(f.writeRecord).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', exitCode: 1 }));
      } else {
        expect(f.writeRecord).not.toHaveBeenCalled();
      }
    } finally { kill.mockRestore(); }
  });

  it.each([
    ['done', 0, { status: 'done', exitCode: 0, resultPath: 'result.json', code: 0 }],
    ['failed', 23, { status: 'failed', exitCode: 23, resultPath: 'result.json', code: 23 }],
    ['running', null, { status: 'running', exitCode: null, resultPath: 'result.json', code: 75 }],
    ['missing', null, { status: 'failed', exitCode: null, resultPath: null, code: 2 }],
  ])('max-ms=250 reports a %s job through the default async reader within the requested deadline', async (status, exitCode, expected) => {
    const record = { id: 'minimum-budget', pid: process.pid, status, exitCode, resultPath: 'result.json' };
    if (status !== 'missing') writeJobRecord(record, { jobsDir });
    const read = vi.spyOn(fsPromises, 'readFile');
    const isAlive = vi.fn(() => true);
    const updateRecord = vi.fn();
    const started = performance.now();
    try {
      expect(await waitForJob({ jobId: record.id, jobsDir, maxMs: 250, isAlive, updateRecord }))
        .toEqual(expected);
      expect(performance.now() - started).toBeLessThan(status === 'running' ? 300 : 200);
      expect(read).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledWith(join(jobsDir, `${record.id}.json`), 'utf8');
      expect(isAlive).toHaveBeenCalledTimes(status === 'running' ? 1 : 0);
      expect(updateRecord).not.toHaveBeenCalled();
    } finally {
      // A missing record's late rejection must be observed too.
      await Promise.allSettled(read.mock.results.map(result => result.value));
      read.mockRestore();
    }
  });

  it('max-ms=250 returns running/75 at the requested deadline with a blocked reader and no probes or writes', async () => {
    const maxMs = 250;
    vi.useFakeTimers();
    try {
      const f = fixture();
      const readRecord = vi.fn(() => new Promise(() => {}));
      const isAlive = vi.fn(() => false);
      const updateRecord = vi.fn();
      let result;
      const waiting = waitForJob({ ...f.options, readRecord, maxMs, isAlive, updateRecord, now: Date.now })
        .then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(249);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(result).toEqual({ status: 'running', exitCode: null, resultPath: null, code: 75 });
      expect(vi.getTimerCount()).toBe(0);
      expect(readRecord).toHaveBeenCalledOnce();
      expect(isAlive).not.toHaveBeenCalled();
      expect(updateRecord).not.toHaveBeenCalled();
      expect(f.sleep).not.toHaveBeenCalled();
      expect(f.writeRecord).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(['done', 'failed', 'missing'])('max-ms=250 observes a %s snapshot resolving before the requested deadline', async status => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const readRecord = vi.fn(async () => {
        await new Promise(resolveRead => setTimeout(resolveRead, 200));
        if (status === 'missing') throw new Error('unknown job');
        return { ...f.options.readRecord(), status, exitCode: status === 'done' ? 0 : 23 };
      });
      const isAlive = vi.fn();
      let result;
      const waiting = waitForJob({ ...f.options, readRecord, isAlive, maxMs: 250, now: Date.now })
        .then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(199);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(result).toEqual(status === 'missing'
        ? { status: 'failed', exitCode: null, resultPath: null, code: 2 }
        : { status, exitCode: status === 'done' ? 0 : 23, resultPath: 'test-job.result.json', code: status === 'done' ? 0 : 23 });
      expect(readRecord).toHaveBeenCalledOnce();
      expect(isAlive).not.toHaveBeenCalled();
      expect(f.sleep).not.toHaveBeenCalled();
      expect(f.writeRecord).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['done', 'failed', 'missing'])('max-ms=250 ignores a %s snapshot settling at the requested deadline', async status => {
    const f = fixture();
    const readRecord = vi.fn(async () => {
      await f.sleep(250);
      if (status === 'missing') throw new Error('unknown job');
      return { ...f.options.readRecord(), status, exitCode: status === 'done' ? 0 : 23 };
    });
    const isAlive = vi.fn();
    expect(await waitForJob({ ...f.options, readRecord, isAlive, maxMs: 250 }))
      .toEqual({ status: 'running', exitCode: null, resultPath: null, code: 75 });
    expect(readRecord).toHaveBeenCalledOnce();
    expect(isAlive).not.toHaveBeenCalled();
    expect(f.writeRecord).not.toHaveBeenCalled();
  });

  it.each([250, 500])('does not start another read when polling reaches the %s ms deadline', async maxMs => {
    const f = fixture();
    expect(await waitForJob({ ...f.options, maxMs }))
      .toMatchObject({ status: 'running', code: 75 });
    expect(f.sleep.mock.calls).toEqual([[maxMs]]);
    expect(f.options.readRecord).toHaveBeenCalledOnce();
    expect(f.writeRecord).not.toHaveBeenCalled();
  });

  it('documents usage errors, the default, the cap and the single deadline in --help and the header', () => {
    const child = spawnSync(process.execPath, ['scripts/codex-direct-task.mjs', '--help'], {
      encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    for (const documentation of [child.stdout, readFileSync('scripts/codex-direct-task.mjs', 'utf8')]) {
      expect(documentation).toContain('Values below 250 or non-numeric values are usage errors (exit 2), before any job IO.');
      expect(documentation).toContain('Omitted defaults to 540000 ms; values above 540000 are clamped to 540000 ms.');
      expect(documentation).toContain('All IO shares that single requested deadline; no floor or additional grace.');
    }
  });

  it('max-ms=250 observes an already-resolved async terminal read', async () => {
    const f = fixture();
    f.child.emit('exit', 0);
    expect(await waitForJob({ ...f.options, readRecord: async () => f.options.readRecord(), maxMs: 250 }))
      .toEqual({ status: 'done', exitCode: 0, resultPath: 'test-job.result.json', code: 0 });
    expect(f.sleep).not.toHaveBeenCalled();
    expect(f.writeRecord).not.toHaveBeenCalled();
  });

  it.each([250, 1000])('uses no synchronous filesystem calls in the default wait path with maxMs=%s', maxMs => {
    const record = { id: 'no-sync', pid: process.pid, status: 'running', exitCode: null, resultPath: 'result.json' };
    writeJobRecord(record, { jobsDir });
    const boot = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      let waiting = false;
      for (const name of Object.keys(fs)) {
        if (name.endsWith('Sync') && typeof fs[name] === 'function') {
          const original = fs[name];
          fs[name] = Object.assign((...args) => {
            if (waiting) throw new Error('unexpected synchronous fs: ' + name);
            return original(...args);
          }, original);
        }
      }
      syncBuiltinESMExports();
      // Install before import so captured defaults (including jobFs) are guarded,
      // but allow the module loader's startup IO until the wait actually begins.
      const { waitForJob } = await import('./scripts/codex-direct-task.mjs');
      waiting = true;
      const result = await waitForJob({ jobId: 'no-sync', jobsDir: process.env.CODEX_JOBS_DIR,
        maxMs: ${maxMs}, isAlive: () => false });
      process.stdout.write(JSON.stringify(result));
      process.exit(result.code);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
      encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024,
      env: { ...process.env, CODEX_JOBS_DIR: jobsDir },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(1);
    expect(JSON.parse(child.stdout)).toEqual({ status: 'failed', exitCode: 1, resultPath: record.resultPath, code: 1 });
    expect(readJobRecord(record.id, { jobsDir })).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('checks the deadline again after a dead-PID probe before updating its record', async () => {
    const f = fixture();
    const updateRecord = vi.fn();
    expect(await waitForJob({ ...f.options, maxMs: 250, updateRecord,
      isAlive: async () => { await f.sleep(250); return false; },
    })).toMatchObject({ status: 'running', code: 75 });
    expect(updateRecord).not.toHaveBeenCalled();
    expect(f.writeRecord).not.toHaveBeenCalled();
  });

  it.each(['readRecord', 'isAlive', 'updateRecord', 'writeRecord'])('bounds a delayed %s by the requested 250 ms budget using the injected clock and sleep', async operation => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const completed = vi.fn();
      const sleep = vi.fn(ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)));
      const pending = vi.fn(async () => {
        await sleep(1000);
        completed();
        if (operation === 'isAlive') return false;
        return f.options.readRecord();
      });
      let result;
      const waiting = waitForJob({ ...f.options, maxMs: 250, now: Date.now, sleep,
        isAlive: () => false, [operation]: pending,
      }).then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(249);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({ status: 'running', exitCode: null, code: 75 });
      expect(pending).toHaveBeenCalledOnce();
      expect(completed).not.toHaveBeenCalled();
      expect(f.writeRecord).not.toHaveBeenCalled();
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(['timeout', 'rejection'])('dead-PID fresh read fails closed on %s without writing', async outcome => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const pending = new Promise((resolveRead, rejectRead) => {
        setTimeout(() => {
          if (outcome === 'rejection') rejectRead(new Error('fresh record unavailable'));
          else resolveRead(f.options.readRecord());
        }, outcome === 'rejection' ? 1 : 1000);
      });
      const readRecord = vi.fn()
        .mockImplementationOnce(f.options.readRecord)
        .mockImplementationOnce(() => pending);
      const waiting = waitForJob({ ...f.options, readRecord, isAlive: () => false, maxMs: 250, now: Date.now });
      await vi.advanceTimersByTimeAsync(250);
      expect(await waiting).toMatchObject(outcome === 'timeout'
        ? { status: 'running', exitCode: null, code: 75 }
        : { status: 'failed', exitCode: null, code: 2 });
      expect(readRecord).toHaveBeenCalledTimes(2);
      expect(f.writeRecord).not.toHaveBeenCalled();
      if (outcome === 'timeout') {
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.writeRecord).not.toHaveBeenCalled();
      }
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('shares the remaining budget across asynchronous reads, probes and updates', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
      const updateRecord = vi.fn(async () => { await sleep(1000); return f.options.readRecord(); });
      let result;
      const waiting = waitForJob({ ...f.options, maxMs: 250, now: Date.now, sleep,
        readRecord: async () => { await sleep(100); return f.options.readRecord(); },
        isAlive: async () => { await sleep(100); return false; }, updateRecord,
      }).then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(249);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({ status: 'running', code: 75 });
      expect(updateRecord).toHaveBeenCalledOnce();
      expect(f.writeRecord).not.toHaveBeenCalled();
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(['readRecord', 'isAlive', 'updateRecord', 'writeRecord'])('fails closed with exit 2 when asynchronous %s rejects', async operation => {
    const f = fixture();
    expect(await waitForJob({ ...f.options, maxMs: 250, now: Date.now, sleep: undefined,
      isAlive: () => false, [operation]: async () => { throw new Error('IO unavailable'); },
    })).toMatchObject({ status: 'failed', exitCode: null, code: 2 });
    expect(f.writeRecord).not.toHaveBeenCalled();
  });

  it('unreadable dead-PID bookkeeping fails closed with exit 2', async () => {
    const f = fixture();
    expect(await waitForJob({ ...f.options, isAlive: () => false,
      updateRecord: () => { throw new Error('record unreadable'); },
    })).toMatchObject({ status: 'failed', code: 2 });
    expect(f.writeRecord).not.toHaveBeenCalled();
  });

  it('dead-PID update does not overwrite a record that became done between probe and write', async () => {
    const running = { id: 'completion-race', pid: 123, status: 'running',
      startedAt: new Date(0).toISOString(), resultPath: 'result.json', exitCode: null };
    writeJobRecord(running, { jobsDir });
    const completed = { ...running, status: 'done', exitCode: 0, finishedAt: new Date(1000).toISOString() };
    const read = vi.spyOn(fsPromises, 'readFile');
    const originalWrite = fsPromises.writeFile;
    const write = vi.spyOn(fsPromises, 'writeFile');
    const rename = vi.spyOn(fsPromises, 'rename');
    try {
      const result = await waitForJob({
        jobId: running.id, jobsDir,
        isAlive: async () => {
          // Land the child's terminal record after the running snapshot and probe.
          await originalWrite(join(jobsDir, `${running.id}.json`), JSON.stringify(completed));
          return false;
        },
        sleep: vi.fn(() => { throw new Error('unexpected sleep'); }), maxMs: 1000,
      });
      expect(result).toEqual({ status: 'done', exitCode: 0, resultPath: running.resultPath, code: 0 });
      expect(read).toHaveBeenCalledTimes(2);
      expect(write).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(readJobRecord(running.id, { jobsDir })).toEqual(completed);
    } finally {
      read.mockRestore();
      write.mockRestore();
      rename.mockRestore();
    }
  });

  it.each([undefined, 540000 * 2])('defaults or clamps maxMs=%s to 540000 ms; exit 75 allows the operator to wait again', async maxMs => {
    const f = fixture();
    expect(await waitForJob({ ...f.options, maxMs, pollMs: 540000 }))
      .toMatchObject({ status: 'running', code: 75 });
    expect(f.sleep.mock.calls).toEqual([[540000]]);
  });

  it.each([250, undefined])('unknown and unreadable jobs fail closed with exit 2 at maxMs=%s', async maxMs => {
    for (const jobId of ['missing', '../escape', undefined]) {
      expect(await waitForJob({ jobId, jobsDir, maxMs }))
        .toEqual({ status: 'failed', exitCode: null, resultPath: null, code: 2 });
    }
    writeFileSync(join(jobsDir, 'broken.json'), '{');
    expect(await waitForJob({ jobId: 'broken', jobsDir, maxMs })).toMatchObject({ code: 2 });
  });

  it.each([250, undefined])('rejects incomplete persisted records rather than declaring success at maxMs=%s', async maxMs => {
    writeFileSync(join(jobsDir, 'incomplete.json'), JSON.stringify({ id: 'incomplete', status: 'done' }));
    expect(await waitForJob({ jobId: 'incomplete', jobsDir, maxMs })).toMatchObject({ code: 2 });
  });

  it.each(['--detach', '--detach=true'])('detach %s writes a running record, redirects files, unrefs and returns before child completion', async detachFlag => {
    const child = new EventEmitter();
    child.pid = 321;
    child.unref = vi.fn();
    const spawnFn = vi.fn(() => { queueMicrotask(() => child.emit('spawn')); return child; });
    const args = ['--task=literal $(no-shell)', detachFlag, '--dir=checkout'];
    const readStart = vi.fn(() => 'Fri Oct 23 20:10:13 2026');
    const job = await startDetachedJob({ args, jobsDir, spawnFn, now: () => 0, random: () => 'random',
      nodePath: 'node', scriptPath: 'scripts/codex-direct-task.mjs', env: {}, readStart });
    expect(readStart).toHaveBeenCalledWith(321);
    expect(job).toEqual({ id: '0-random', pid: 321, pidStart: 'Fri Oct 23 20:10:13 2026', status: 'running', startedAt: new Date(0).toISOString(),
      resultPath: join(jobsDir, '0-random.result.json'), exitCode: null, recordPath: join(jobsDir, '0-random.json') });
    const { recordPath, ...record } = job;
    expect(readJobRecord(job.id, { jobsDir })).toEqual(record);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(spawnFn).toHaveBeenCalledWith('node', ['scripts/codex-direct-task.mjs', args[0], args[2], '--json', '--no-stream', '--job=0-random'],
      { detached: true, stdio: ['ignore', expect.any(Number), expect.any(Number)], env: { CODEX_JOBS_DIR: jobsDir } });
    const spawnOptions = spawnFn.mock.calls[0][2];
    expect(spawnOptions.detached).toBe(true);
    expect(spawnOptions.stdio).not.toBe('pipe');
    expect(spawnOptions.stdio).not.toContain('pipe');
    expect(readFileSync(job.resultPath, 'utf8')).toBe('');
    expect(readFileSync(join(jobsDir, '0-random.stderr.log'), 'utf8')).toBe('');
    expect(args).toContain(detachFlag);
  });

  it.each([
    { flags: [], runCode: 0 },
    { flags: ['--no-stream'], runCode: 0 },
    { flags: ['--no-stream='], runCode: 0 },
    { flags: [], runCode: 7 },
    { flags: [], runCode: 0, install: 'ci' },
    { flags: [], runCode: 0, install: 'install' },
  ])('detached CLI writes one JSON report and logs events with $flags and exit $runCode and install $install', async ({ flags, runCode, install }) => {
    const preload = join(jobsDir, 'result-preload.mjs');
    const logFile = join(jobsDir, 'events.jsonl');
    const installed = join(jobsDir, 'installed');
    writeFileSync(preload, `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { EventEmitter } from 'node:events';
      import { join } from 'node:path';
      import { writeFileSync } from 'node:fs';
      const spawn = cp.spawn;
      const execFileSync = cp.execFileSync;
      const installScript = 'console.log("added 1 package"); console.error("installer diagnostic");'
        + 'require("node:fs").writeFileSync(' + ${JSON.stringify(JSON.stringify(installed))} + ', "installed")';
      const seedClone = dest => {
        writeFileSync(join(dest, 'package.json'), '{}');
        if (${JSON.stringify(install)} === 'ci') writeFileSync(join(dest, 'package-lock.json'), '{}');
      };
      cp.execFileSync = (bin, args, options) => {
        if (bin === 'git' && args[0] === 'clone') seedClone(args.at(-1));
        if (bin === 'npm') return execFileSync(process.execPath,
          ['-e', installScript], options);
        return args.includes('--absolute-git-dir')
          ? join(process.env.CODEX_JOBS_DIR, 'metadata') : args.includes('rev-parse') ? 'sha' : '';
      };
      cp.spawn = (bin, args, options) => {
        if (bin === process.execPath) return spawn(bin, args, options);
        if (bin === 'git' && args[0] === 'clone') {
          seedClone(args.at(-1));
          return spawn(process.execPath, ['-e', ''], options);
        }
        if (bin === 'npm') return spawn(process.execPath, ['-e', installScript], options);
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = { on() {}, end() { setImmediate(() => {
          child.stdout.emit('data', Buffer.from('{"type":"turn.completed"}\\n'));
          child.emit('close', ${runCode});
        }); } };
        child.kill = () => {};
        return child;
      };
      syncBuiltinESMExports();
    `);
    const launcher = spawnSync(process.execPath, ['scripts/codex-direct-task.mjs', '--detach',
      '--task=fixture', ...(install ? [`--repo-root=${jobsDir}`] : [`--dir=${jobsDir}`]),
      '--gate=none', '--no-self-review', `--log=${logFile}`, ...flags], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      env: { ...process.env, CODEX_JOBS_DIR: jobsDir, NODE_OPTIONS: `--import=${preload}` },
    });
    expect(launcher.error).toBeUndefined();
    expect(launcher.status, launcher.stderr).toBe(0);
    const job = readJobRecord(JSON.parse(launcher.stdout).id, { jobsDir });
    try {
      expect(await waitForJob({ jobId: job.id, jobsDir, maxMs: 10000 })).toMatchObject({
        status: runCode === 0 ? 'done' : 'failed', exitCode: runCode, code: runCode,
      });
      expect(readFileSync(logFile, 'utf8')).toContain('{"type":"turn.completed"}');
      const result = JSON.parse(readFileSync(job.resultPath, 'utf8'));
      expect(result).toMatchObject({
        exitCode: runCode, events: { terminal: 'turn.completed' },
      });
      if (install) {
        expect(result.scratch.depsInstall.args).toEqual([install]);
        expect(readFileSync(installed, 'utf8')).toBe('installed');
        expect(readFileSync(join(jobsDir, `${job.id}.stderr.log`), 'utf8')).toContain('added 1 package');
        rmSync(result.dir, { recursive: true, force: true });
      }
    } finally {
      try { process.kill(job.pid, 'SIGTERM'); } catch { /* already stopped */ }
    }
  }, 20000);

  it.each([
    ...['ci', 'install'].flatMap(install => ['SIGINT', 'SIGTERM', 'timeout'].map(signal => ({ phase: 'install', install, signal }))),
    ...['SIGINT', 'SIGTERM', 'timeout'].map(signal => ({ phase: 'clone', install: 'ci', signal })),
  ])(
    'detached CLI $signal during $phase (npm $install) stops the step group without corrupting results', async ({ phase, install, signal }) => {
      const preload = join(jobsDir, 'install-preload.mjs');
      const worker = join(jobsDir, 'install-worker.cjs');
      const ready = join(jobsDir, 'install.ready');
      const completed = join(jobsDir, 'install.completed');
      const scratchPath = join(jobsDir, 'scratch.path');
      const tag = phase.toUpperCase();
      const stepTimeoutMs = phase === 'clone' ? DEFAULT_CLONE_TIMEOUT_MS : DEFAULT_INSTALL_TIMEOUT_MS;
      writeFileSync(worker, `
        const { writeFileSync } = require('node:fs');
        const { spawn } = require('node:child_process');
        if (process.argv[2] === 'descendant') {
          console.log('${tag}_STDOUT'); console.error('${tag}_STDERR');
          writeFileSync(${JSON.stringify(ready)}, String(process.pid));
          setTimeout(() => writeFileSync(${JSON.stringify(completed)}, '${tag}_COMPLETED_AFTER_CANCEL'), 1200);
        } else {
          spawn(process.execPath, [__filename, 'descendant'], { stdio: 'inherit' });
        }
      `);
      writeFileSync(preload, `
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { EventEmitter } from 'node:events';
        import { writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const { spawn, execFileSync } = cp;
        // Shorten only the explicit install deadline so the CLI timeout path stays hermetic and fast.
        if (${JSON.stringify(signal)} === 'timeout') {
          const schedule = globalThis.setTimeout;
          globalThis.setTimeout = (fn, ms, ...args) => schedule(fn,
            ms === ${stepTimeoutMs} ? 1000 : ms, ...args);
        }
        const seedClone = dest => {
          writeFileSync(${JSON.stringify(scratchPath)}, dest);
          writeFileSync(join(dest, 'package.json'), '{}');
          if (${JSON.stringify(install)} === 'ci') writeFileSync(join(dest, 'package-lock.json'), '{}');
        };
        const slow = ${JSON.stringify(phase)};
        cp.execFileSync = (bin, args, options) => {
          if (bin === 'npm') return execFileSync(process.execPath, [${JSON.stringify(worker)}], options);
          if (bin === 'git' && args[0] === 'clone') {
            seedClone(args.at(-1));
            if (slow === 'clone') return execFileSync(process.execPath, [${JSON.stringify(worker)}], options);
          }
          return args.includes('--absolute-git-dir') ? join(process.env.CODEX_JOBS_DIR, 'metadata')
            : args.includes('rev-parse') ? 'sha' : '';
        };
        cp.spawn = (bin, args, options) => {
          if (bin === process.execPath) return spawn(bin, args, options);
          if (bin === 'git' && args[0] === 'clone') {
            seedClone(args.at(-1));
            return spawn(process.execPath, slow === 'clone' ? [${JSON.stringify(worker)}] : ['-e', ''], options);
          }
          if (bin === 'npm') {
            if (slow === 'clone') writeFileSync(${JSON.stringify(completed)}, 'INSTALL_STARTED_AFTER_CANCEL');
            return spawn(process.execPath, [${JSON.stringify(worker)}], options);
          }
          const child = new EventEmitter();
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          child.stdin = { on() {}, end() { setImmediate(() => child.emit('close', 0)); } };
          child.kill = () => {};
          return child;
        };
        syncBuiltinESMExports();
      `);
      const launcher = spawnSync(process.execPath, ['scripts/codex-direct-task.mjs', '--detach',
        `--repo-root=${jobsDir}`, '--task=fixture', '--gate=none', '--no-self-review'], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, CODEX_JOBS_DIR: jobsDir, NODE_OPTIONS: `--import=${preload}` },
      });
      expect(launcher.status, launcher.stderr).toBe(0);
      const job = readJobRecord(JSON.parse(launcher.stdout).id, { jobsDir });
      try {
        if (signal !== 'timeout') {
          await vi.waitFor(() => expect(readFileSync(ready, 'utf8')).toMatch(/^\d+$/), { timeout: 10000 });
          expect(process.kill(job.pid, signal)).toBe(true);
        }
        const exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
        const result = await waitForJob({ jobId: job.id, jobsDir, maxMs: 10000, pollMs: 20 });
        expect(result).toMatchObject({ status: 'failed', exitCode });
        await new Promise(resolve => setTimeout(resolve, 1400));
        expect(() => readFileSync(completed)).toThrow();
        expect(readJobRecord(job.id, { jobsDir })).toMatchObject({
          status: 'failed', exitCode,
        });
        expect(readFileSync(job.resultPath, 'utf8')).toBe('');
        if (signal === 'timeout') {
          const label = phase === 'clone' ? 'scratch clone (git clone)' : `dependency install (npm ${install})`;
          const stderrLog = readFileSync(join(jobsDir, `${job.id}.stderr.log`), 'utf8');
          expect(stderrLog).toContain(`${label} failed: timed out after ${stepTimeoutMs}ms`);
          // The piped step's own diagnostics are relayed to the job's stderr log, never to its result file.
          expect(stderrLog).toContain(`${tag}_STDERR`);
        }
      } finally {
        try { process.kill(job.pid, 'SIGKILL'); } catch { /* exited */ }
        try { process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
        try { rmSync(readFileSync(scratchPath, 'utf8'), { recursive: true, force: true }); } catch { /* no clone */ }
      }
    }, 20000);

  it.each(['standards', 'related', 'full'].flatMap(mode => ['SIGINT', 'SIGTERM'].map(signal => ({ mode, signal }))))(
    'detached CLI cancellation by $signal during $mode gate stops the gate group and records failure', async ({ mode, signal }) => {
      const preload = join(jobsDir, 'gate-preload.mjs');
      const worker = join(jobsDir, 'gate-worker.cjs');
      const ready = join(jobsDir, 'gate.ready');
      const completed = join(jobsDir, 'gate.completed');
      weCheckout(jobsDir);
      writeFileSync(worker, `
        const { writeFileSync } = require('node:fs');
        const { spawn } = require('node:child_process');
        if (process.argv[2] === 'descendant') {
          writeFileSync(${JSON.stringify(ready)}, String(process.pid));
          setTimeout(() => writeFileSync(${JSON.stringify(completed)}, 'completed'), 1500);
        } else {
          spawn(process.execPath, [__filename, 'descendant'], { stdio: 'inherit' });
        }
      `);
      writeFileSync(preload, `
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { EventEmitter } from 'node:events';
        import { join } from 'node:path';
        const { spawn, execFileSync } = cp;
        const isGate = bin => bin === 'npm' || bin === 'node';
        cp.execFileSync = (bin, args, options) => isGate(bin)
          ? execFileSync(process.execPath, [${JSON.stringify(worker)}], options)
          : args.includes('--absolute-git-dir') ? join(process.env.CODEX_JOBS_DIR, 'metadata')
            : args.includes('rev-parse') ? 'sha' : '';
        cp.spawn = (bin, args, options) => {
          if (bin === process.execPath) return spawn(bin, args, options);
          if (isGate(bin)) return spawn(process.execPath, [${JSON.stringify(worker)}], options);
          const child = new EventEmitter();
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          child.stdin = { on() {}, end() { setImmediate(() => child.emit('close', 0)); } };
          child.kill = () => {};
          return child;
        };
        syncBuiltinESMExports();
      `);
      const launcher = spawnSync(process.execPath, ['scripts/codex-direct-task.mjs', '--detach',
        `--dir=${jobsDir}`, '--task=fixture', `--gate=${mode}`, '--no-self-review'], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, CODEX_JOBS_DIR: jobsDir, NODE_OPTIONS: `--import=${preload}` },
      });
      expect(launcher.status, launcher.stderr).toBe(0);
      const job = readJobRecord(JSON.parse(launcher.stdout).id, { jobsDir });
      try {
        await vi.waitFor(() => expect(readFileSync(ready, 'utf8')).toMatch(/^\d+$/), { timeout: 10000 });
        expect(process.kill(job.pid, signal)).toBe(true);
        const result = await waitForJob({ jobId: job.id, jobsDir, maxMs: 10000, pollMs: 20 });
        expect(result).toMatchObject({ status: 'failed', exitCode: signal === 'SIGINT' ? 130 : 143 });
        await new Promise(resolve => setTimeout(resolve, 1700));
        expect(() => readFileSync(completed)).toThrow();
      } finally {
        try { process.kill(job.pid, 'SIGKILL'); } catch { /* exited */ }
        try { process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
      }
    }, 20000);

  it('spawn errors reject without publishing a running job', async () => {
    const spawnFn = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('spawn unavailable')));
      return child;
    };
    await expect(startDetachedJob({ jobsDir, spawnFn, now: () => 0, random: () => 'error' })).rejects.toThrow('spawn unavailable');
    expect(() => readJobRecord('0-error', { jobsDir })).toThrow();
  });

  it('parent survival: real detach exits 0 promptly while its child is running with a live PID, then wait completes it', () => {
    const options = { encoding: 'utf8', maxBuffer: 1024 * 1024,
      env: { ...process.env, CODEX_JOBS_DIR: jobsDir, CODEX_DIRECT_TASK_TEST_CHILD_DELAY_MS: '6000' } };
    let job;
    try {
      const started = performance.now();
      const launcher = spawnSync(process.execPath, ['scripts/codex-direct-task.mjs', '--detach',
        `--task-file=${join(jobsDir, 'nonexistent-task.txt')}`], { ...options, timeout: 4000 });
      const elapsed = performance.now() - started;
      expect(launcher.error).toBeUndefined();
      expect(launcher.status, launcher.stderr).toBe(0);
      job = JSON.parse(launcher.stdout);
      expect(job.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
      expect(job.recordPath).toBe(join(jobsDir, `${job.id}.json`));
      expect(elapsed).toBeLessThan(4000);
      const running = readJobRecord(job.id, { jobsDir });
      expect(running).toMatchObject({ status: 'running', exitCode: null });
      expect(() => process.kill(running.pid, 0)).not.toThrow();
      const waiter = spawnSync(process.execPath, ['scripts/codex-direct-task.mjs', 'wait',
        `--job=${job.id}`, '--max-ms=20000'], { ...options, timeout: 25000 });
      expect(waiter.error).toBeUndefined();
      expect(waiter.status, waiter.stderr).toBe(1);
      expect(JSON.parse(waiter.stdout)).toMatchObject({ status: 'failed', exitCode: 1 });
      expect(readJobRecord(job.id, { jobsDir })).toMatchObject({ status: 'failed', exitCode: 1,
        finishedAt: expect.any(String) });
    } finally {
      if (job) {
        const record = readJobRecord(job.id, { jobsDir });
        if (record.status === 'running') {
          try { process.kill(record.pid, 'SIGTERM'); } catch { /* child already exited */ }
        }
      }
    }
  }, 35000);

  it.each([
    { exitCode: 7, timedOut: false, pass: true, expected: 1 },
    { exitCode: 7, timedOut: true, pass: false, expected: 1 },
    { exitCode: 0, timedOut: true, pass: true, expected: 1 },
    { exitCode: 0, timedOut: false, pass: false, expected: 1 },
  ])('foreground maps task exit $exitCode with timeout=$timedOut and gate=$pass to $expected', ({ exitCode, timedOut, pass, expected }) => {
    const report = { exitCode, timedOut, gate: { pass } };
    expect(cliExitCode(report)).toBe(expected);
    expect(cliExitCode(report, { json: true })).toBe(0);
  });

  const jsonTaskArgs = ['--task=fixture', '--json', '--no-stream', '--no-self-review'];
  it.each(['SIGINT', 'SIGTERM'])('detached CLI cancellation by %s during startup records failure', async signal => {
    const preload = join(jobsDir, 'startup-preload.mjs');
    const ready = join(jobsDir, 'startup.ready');
    writeFileSync(preload, `
      import { writeFileSync } from 'node:fs';
      process.on('newListener', signal => {
        if (signal === 'SIGTERM') setImmediate(() => writeFileSync(${JSON.stringify(ready)}, 'ready'));
      });
    `);
    const launcher = spawnSync(process.execPath, ['scripts/codex-direct-task.mjs', '--detach', '--task=fixture'], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      env: { ...process.env, CODEX_JOBS_DIR: jobsDir, CODEX_DIRECT_TASK_TEST_CHILD_DELAY_MS: '10000',
        NODE_OPTIONS: `--import=${preload}` },
    });
    expect(launcher.error).toBeUndefined();
    expect(launcher.status, launcher.stderr).toBe(0);
    const job = JSON.parse(launcher.stdout);
    const { pid } = readJobRecord(job.id, { jobsDir });
    try {
      // A live startup-delay child has the job handler but no worker cleanup handler yet.
      const deadline = Date.now() + 5000;
      while (true) {
        try { if (readFileSync(ready, 'utf8') === 'ready') break; } catch { /* child is importing */ }
        if (Date.now() >= deadline) throw new Error('startup signal handler did not become ready');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      process.kill(pid, signal);
      const result = await waitForJob({ jobId: job.id, jobsDir, maxMs: 5000 });
      const exitCode = signal === 'SIGINT' ? 130 : 143;
      expect(result).toMatchObject({ status: 'failed', exitCode, code: exitCode });
      expect(readJobRecord(job.id, { jobsDir })).toMatchObject({ finishedAt: expect.any(String) });
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
  }, 15000);

  it.each(['SIGINT', 'SIGTERM'])('detached CLI cancellation by %s stops the worker and its descendants before recording failure', async signal => {
    // Exercise the real launcher, CLI signal listeners and process group. Only git and Codex are substituted.
    const preload = join(jobsDir, 'cancel-preload.mjs');
    const worker = join(jobsDir, 'worker.cjs');
    writeFileSync(worker, `
      const { appendFileSync, writeFileSync } = require('node:fs');
      const { spawn } = require('node:child_process');
      const { join } = require('node:path');
      const root = process.env.CODEX_JOBS_DIR;
      const role = process.argv[2];
      writeFileSync(join(root, role + '.pid'), String(process.pid));
      const beat = () => appendFileSync(join(root, role + '.beats'), '.');
      beat();
      setInterval(beat, 20);
      if (role === 'worker') spawn(process.execPath, [__filename, 'descendant'], { stdio: 'ignore' });
    `);
    writeFileSync(preload, `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const spawn = cp.spawn;
      cp.execFileSync = (bin, args) => args.includes('--absolute-git-dir')
        ? join(process.env.CODEX_JOBS_DIR, 'metadata') : args.includes('rev-parse') ? 'sha' : '';
      cp.spawn = (bin, args, options) => bin === process.execPath ? spawn(bin, args, options)
        : spawn(process.execPath, [${JSON.stringify(worker)}, 'worker'], options);
      syncBuiltinESMExports();
    `);
    const options = { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      env: { ...process.env, CODEX_JOBS_DIR: jobsDir, NODE_OPTIONS: `--import=${preload}` } };
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async predicate => {
      const deadline = Date.now() + 10000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('cancellation fixture did not become ready');
        await pause(20);
      }
    };
    let job;
    let wrapperPid;
    try {
      const launcher = spawnSync(process.execPath, ['scripts/codex-direct-task.mjs', '--detach',
        `--dir=${jobsDir}`, '--task=fixture', '--gate=none', '--no-self-review', '--no-stream'], options);
      expect(launcher.error).toBeUndefined();
      expect(launcher.status, launcher.stderr).toBe(0);
      job = JSON.parse(launcher.stdout);
      wrapperPid = readJobRecord(job.id, { jobsDir }).pid;
      await until(() => {
        try { return readFileSync(join(jobsDir, 'descendant.beats'), 'utf8').length > 0; }
        catch { return false; }
      });
      process.kill(wrapperPid, signal);
      await until(() => readJobRecord(job.id, { jobsDir }).status !== 'running');
      const exitCode = signal === 'SIGINT' ? 130 : 143;
      expect(readJobRecord(job.id, { jobsDir })).toMatchObject({ status: 'failed', exitCode,
        finishedAt: expect.any(String) });
      expect(await waitForJob({ jobId: job.id, jobsDir })).toMatchObject({ status: 'failed', exitCode, code: exitCode });
      const beats = () => ['worker', 'descendant'].map(role => readFileSync(join(jobsDir, `${role}.beats`), 'utf8'));
      const atExit = beats();
      await pause(250);
      expect(beats(), 'worker and descendant must stop executing after cancellation').toEqual(atExit);
    } finally {
      // Also reap the deliberately orphaned workers on the pre-fix red run.
      for (const role of ['worker', 'descendant']) {
        try {
          const pid = Number(readFileSync(join(jobsDir, `${role}.pid`), 'utf8'));
          if (role === 'worker') { try { process.kill(-pid, 'SIGKILL'); } catch { /* already stopped */ } }
          process.kill(pid, 'SIGKILL');
        } catch { /* already stopped or never started */ }
      }
      if (wrapperPid) { try { process.kill(wrapperPid, 'SIGKILL'); } catch { /* already stopped */ } }
    }
  }, 20000);

  it.each([
    { label: 'validation failure', args: [], processCode: 2, recordCode: 2 },
    { label: 'success', args: [...jsonTaskArgs, '--review'], processCode: 0, recordCode: 0,
      report: { exitCode: 0, timedOut: false, gate: { pass: true } } },
    { label: 'nonzero task in JSON mode', args: [...jsonTaskArgs, '--gate=none'], processCode: 0, recordCode: 7, runCode: 7,
      report: { exitCode: 7, timedOut: false, gate: { pass: true } } },
    { label: 'task exit 75 in JSON mode', args: [...jsonTaskArgs, '--gate=none'], processCode: 0, recordCode: 75, runCode: 75,
      report: { exitCode: 75, timedOut: false, gate: { pass: true } } },
    { label: 'timeout in JSON mode', args: [...jsonTaskArgs, '--gate=none', '--timeout-ms=10'], processCode: 0, recordCode: 1, timeout: true,
      report: { exitCode: null, timedOut: true, gate: { pass: true } } },
    { label: 'failed gate in JSON mode', args: [...jsonTaskArgs, '--gate=standards'], processCode: 0, recordCode: 1, gateFails: true,
      report: { exitCode: 0, timedOut: false, gate: { ran: true, pass: false } } },
    { label: 'unreadable task file', args: ['--task-file=missing-detached-task-fixture'], processCode: 1, recordCode: 1 },
  ])('CLI $label atomically records the internal job outcome', async ({ args, processCode, recordCode, runCode = 0, timeout = false, gateFails = false, report }) => {
    // Bootstrap the record with the actual child PID; task execution and gates stay hermetic.
    const boot = `
      import { writeFileSync } from 'node:fs';
      import { join, resolve } from 'node:path';
      import { pathToFileURL } from 'node:url';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { EventEmitter } from 'node:events';
      const scenario = JSON.parse(process.env.TEST_JOB_SCENARIO);
      cp.execFileSync = (bin, args) => {
        if (bin === 'npm' && args.includes('check:standards') && scenario.gateFails) {
          throw Object.assign(new Error('standards failed'), { status: 1 });
        }
        return args.includes('--absolute-git-dir')
          ? join(process.env.CODEX_JOBS_DIR, 'metadata') : args.includes('rev-parse') ? 'sha' : '';
      };
      cp.spawn = (bin) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        if (bin === 'npm' || bin === 'node') {
          child.kill = () => {};
          setImmediate(() => child.emit('close', scenario.gateFails ? 1 : 0));
          return child;
        }
        let completion;
        child.stdin = { on() {}, end() {
          if (scenario.timeout) completion = setTimeout(() => child.emit('close', 0), 1000);
          else queueMicrotask(() => child.emit('close', scenario.runCode));
        } };
        child.kill = () => { clearTimeout(completion); queueMicrotask(() => child.emit('close', null)); };
        return child;
      };
      syncBuiltinESMExports();
      const script = resolve('scripts/codex-direct-task.mjs');
      writeFileSync(join(process.env.CODEX_JOBS_DIR, 'cli-job.json'), JSON.stringify({
        id: 'cli-job', pid: process.pid, status: 'running', startedAt: new Date().toISOString(),
        resultPath: 'cli-result.json', exitCode: null,
      }));
      process.argv = [process.execPath, script, '--job=cli-job', '--dir=' + process.env.CODEX_JOBS_DIR, ...JSON.parse(process.env.TEST_JOB_ARGS)];
      await import(pathToFileURL(script).href);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
      encoding: 'utf8', timeout: 10000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, CODEX_JOBS_DIR: jobsDir, TEST_JOB_ARGS: JSON.stringify(args),
        TEST_JOB_SCENARIO: JSON.stringify({ runCode, timeout, gateFails }) },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(processCode);
    if (report) expect(JSON.parse(child.stdout)).toMatchObject(report);
    expect(readJobRecord('cli-job', { jobsDir })).toMatchObject({ status: recordCode === 0 ? 'done' : 'failed', exitCode: recordCode,
      finishedAt: expect.any(String) });
    expect(await waitForJob({ jobId: 'cli-job', jobsDir })).toMatchObject({
      status: recordCode === 0 ? 'done' : 'failed', exitCode: recordCode, code: recordCode === 75 ? 1 : recordCode,
    });
  });

  it('atomic updates persist terminal records', () => {
    const record = { id: 'atomic', pid: 123, status: 'failed', startedAt: new Date(0).toISOString(),
      resultPath: 'result.json', exitCode: 9, finishedAt: new Date(1000).toISOString() };
    const fsDeps = { writeFileSync: vi.fn(), renameSync: vi.fn() };
    writeJobRecord(record, { jobsDir, fsDeps });
    const [temp, contents] = fsDeps.writeFileSync.mock.calls[0];
    expect(JSON.parse(contents)).toEqual(record);
    expect(temp).toMatch(/\.tmp$/);
    expect(fsDeps.renameSync).toHaveBeenCalledWith(temp, join(jobsDir, 'atomic.json'));
    writeJobRecord(record, { jobsDir });
    expect(readJobRecord('atomic', { jobsDir })).toEqual(record);
  });
});
