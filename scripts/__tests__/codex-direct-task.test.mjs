/**
 * @file codex-direct-task.test.mjs — the mechanical parts of the personal Codex-direct-task escape hatch,
 * proved with real git regressions and without spawning Codex (mirrors `judge-spawn.test.mjs`'s split:
 * pure argv/plan functions get cheap, exhaustive tests; the one thing that actually needed a real process — whether agentic mode's `--json`
 * stream shows granular tool calls — was checked with a real, live `codex exec` invocation while building this
 * file, recorded in the module's own header and in the delivering PR, not re-proved here).
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_CLI,
  DEFAULT_TIMEOUT_MS,
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
  setupScratchClone,
  captureDiff,
  runGate,
  runCodexDirectExec,
  codexDirectTask,
} from '../codex-direct-task.mjs';

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
  it('#x8wbivt: pins -m to CODEX_MODEL (gpt-6-astra) when no model is given', () => {
    expect(CODEX_MODEL).toBe('gpt-6-astra');
    const argv = buildCodexDirectTaskArgv({ cwd: '/d' });
    expect(flagValue(argv, '-m')).toBe('gpt-6-astra');
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
    expect(calls).toContain('-C /d add --intent-to-add -- new-file.txt');
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
  it('mode "none" (default) runs nothing and passes', () => {
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
  });

  it('mode "full" runs check:standards then the full vitest suite', () => {
    const execFn = vi.fn(() => 'ok');
    const r = runGate({ dir: '/d', mode: 'full', execFn });
    expect(r.steps.map((s) => s.cmd)).toEqual(['npm run check:standards', 'npm run test:unit']);
  });

  it('a failing step is caught and reported, not thrown — and marks the gate failed', () => {
    const execFn = vi.fn((bin, args) => {
      if (args.includes('check:standards')) { const e = new Error('exit 1'); e.stdout = 'BAD'; throw e; }
      return 'ok';
    });
    const r = runGate({ dir: '/d', mode: 'full', execFn });
    expect(r.pass).toBe(false);
    expect(r.steps[0].pass).toBe(false);
    expect(r.steps[0].output).toContain('BAD');
    expect(r.steps[1].pass).toBe(true); // the second step still ran
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
      const report = await codexDirectTask({ dir: worktree, task: 'Inspect the checkout', stream: false, spawnFn, logFile });
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

  it('#4665 isolates each edit run, honors the pool override, and leaves review permissions alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-codex-permissions-test-'));
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
