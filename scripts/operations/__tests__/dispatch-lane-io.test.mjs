import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentArgv, createTickReader, createDispatchSinks, defaultClaudeProvider, dispatchLaneGrant, laneRepoKey, leanRepairGrant, reserveBuildLane, resolveDispatchSettingsEnv, DISPATCH_BASH_TIMEOUT_ENV } from '../dispatch-lane-io.mjs';
import { LEAN_FIX_HOOKS_SETTINGS, LEAN_FIX_REQUIRED_GUARDS, LEAN_FIX_TOOLS } from '../minimal-context-provider.mjs';
import { spawnPreventionLandingJob } from '../../lib/prevention-landing-job.mjs';
import { NO_PROMPT_COMMAND_RULES } from '../../lib/no-prompt-command-rules.mjs';
import { shapeDispatchRead, DISPATCH_EFFECT } from '../dispatch-lane.mjs';

vi.mock('../minimal-context-provider.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, LEAN_FIX_HOOKS_SETTINGS: vi.fn(actual.LEAN_FIX_HOOKS_SETTINGS) };
});

// Remote runners (Forge file copies) do not carry .claude/; fall back to a committed copy of its hooks.
const here = dirname(fileURLToPath(import.meta.url));
const realSettings = resolve(here, '../../../.claude/settings.json');
const CANONICAL_SETTINGS = existsSync(realSettings) ? realSettings : resolve(here, 'fixtures/lean-hooks-claude-settings.json');
vi.mocked(LEAN_FIX_HOOKS_SETTINGS).mockImplementation(((actual) => (p = CANONICAL_SETTINGS) => actual(p, {
  repoRoot: resolve(here, '../../..'), guardRoot: resolve(here, '../../..'),
}))(
  vi.mocked(LEAN_FIX_HOOKS_SETTINGS).getMockImplementation(),
));

describe('lean repair security boundaries', () => {
  async function fixture(run) {
    const { LEAN_FIX_HOOKS_SETTINGS: read } = await vi.importActual('../minimal-context-provider.mjs');
    const root = mkdtempSync(join(tmpdir(), "lean 'security $ "));
    const repoRoot = join(root, 'repo');
    const guardRoot = join(root, 'pinned');
    const settings = JSON.parse(fs.readFileSync(CANONICAL_SETTINGS, 'utf8'));
    const scripts = [...JSON.stringify(settings).matchAll(/scripts\/[\w/-]+\.mjs/g)].map(m => m[0]);
    for (const base of [repoRoot, guardRoot]) {
      for (const script of scripts) {
        const path = join(base, script);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'process.stdout.write("hook ran");');
      }
    }
    const path = join(root, 'settings.json');
    const load = () => { writeFileSync(path, JSON.stringify(settings)); return read(path, { repoRoot, guardRoot }); };
    try { await run({ settings, load, root, repoRoot, guardRoot }); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('retains deny and ask rules without inventing blanket Bash or Agent allows', async () => {
    await fixture(({ settings, load }) => {
      settings.permissions = { allow: ['Read'], deny: ['Bash(rm:*)', 'Edit(secret/**)'], ask: ['Agent', 'Bash(git push:*)'] };
      expect(load().permissions).toEqual(settings.permissions);
      for (const launchKind of ['fix', 'ci-heal']) {
        const argv = buildAgentArgv({ root: '/repo', payload: { launchKind, lane: 7, prompt: 'Repair this PR.' }, loadRepairSettings: load });
        const { permissions } = JSON.parse(argv[argv.indexOf('--settings') + 1]);
        expect(permissions.deny).toEqual(settings.permissions.deny);
        expect(permissions.ask).toEqual(settings.permissions.ask);
        expect(permissions.allow).not.toContain('Bash');
        expect(permissions.allow).not.toContain('Agent');
      }
    });
  });

  it.each(['async', 'echo', 'comment', 'shell tail', 'wrong launcher', 'missing Stop launcher', 'symlink target'])(
    'rejects %s guards based on their actual execution target', async (fault) => {
      await fixture(({ settings, load, root, repoRoot, guardRoot }) => {
        expect(() => load()).not.toThrow();
        const bash = settings.hooks.PreToolUse.find(e => e.matcher === 'Bash').hooks[0];
        if (fault === 'async') bash.async = true;
        if (fault === 'echo') bash.command = 'echo scripts/guard-bash.mjs';
        if (fault === 'comment') bash.command = 'true # scripts/guard-bash.mjs';
        if (fault === 'shell tail') bash.command += ' || true';
        if (fault === 'wrong launcher') bash.command = bash.command.replace('node "$launcher"', 'echo "$launcher"');
        if (fault === 'missing Stop launcher') rmSync(join(guardRoot, 'scripts/hooks/run-pinned-guard.mjs'));
        if (fault === 'symlink target') {
          const target = join(repoRoot, 'scripts/broadcast-inject.mjs');
          rmSync(target);
          const noop = join(root, 'noop.mjs');
          writeFileSync(noop, '');
          fs.symlinkSync(noop, target);
        }
        expect(() => load()).toThrow();
      });
    },
  );

  it.each(['Stop', 'SubagentStop', 'PostToolUse', 'UserPromptSubmit'])(
    'rejects asynchronous %s hooks too', async event => {
      await fixture(({ settings, load }) => {
        expect(() => load()).not.toThrow();
        settings.hooks[event][0].hooks[0].async = true;
        expect(() => load()).toThrow();
      });
    },
  );

  it('resolves hooks before executing from scratch with quoted paths and a different HOME', async () => {
    await fixture(({ load, root }) => {
      const hooks = load().hooks;
      const commands = Object.values(hooks).flatMap(entries => entries.flatMap(e => e.hooks)).map(h => h.command);
      const direct = commands.filter(command => command.startsWith('node '));
      expect(direct.length).toBeGreaterThan(0);
      for (const command of commands) {
        expect(execFileSync('sh', ['-c', command], {
          cwd: root, encoding: 'utf8', env: { ...process.env, HOME: join(root, 'different-home') },
        })).toBe('hook ran');
      }
    });
  });

  it('never grants a pool, a sibling lane, or unrelated explicit permissions', () => {
    const options = { poolDirs: () => ['/w/.lanes/web-everything'] };
    const payload = { launchKind: 'fix', lane: 7 };
    expect(leanRepairGrant(payload, null, options).additionalDirectories).toEqual(['/w/.lanes/web-everything/lane-7']);
    for (const dir of ['/w/.lanes/web-everything', '/w/.lanes/web-everything/lane-8', '/primary', '/w/.lanes/web-everything/lane-7/..']) {
      expect(() => leanRepairGrant(payload, { additionalDirectories: [dir], allow: ['Bash'] }, options)).toThrow();
    }
    expect(() => leanRepairGrant({ launchKind: 'fix' }, null, options)).toThrow();
    expect(() => leanRepairGrant(payload, {
      additionalDirectories: ['/w/.lanes/web-everything/lane-7'], allow: ['Bash'],
    }, options)).toThrow(/permissions outside/);
  });
});

describe('lean repair background argv', () => {
  const options = (launchKind) => ({
    root: '/repo',
    payload: { launchKind, lane: 7, num: '3037', sessionSlug: 'repair-3037', prompt: 'Repair this PR.' },
    settingsEnv: { PATH: '/fixture/bin' },
    worktreeSettings: { bgIsolation: 'none' },
  });

  it('fix and ci-heal --bg argv carries the restricted lean flags and a routed --model', () => {
    for (const kind of ['fix', 'ci-heal']) {
      const argv = buildAgentArgv(options(kind));
      expect(argv).toContain('--restricted');
      expect(argv[argv.indexOf('--tools') + 1]).toBe('Bash,Edit,Write,Read,Glob,Grep,Agent');
      expect(argv[argv.indexOf('--tools') + 1].split(',')).toContain('Agent');
      expect(buildAgentArgv(options('build'))).not.toContain('--tools');
      expect(argv).toContain('--strict-mcp-config');
      expect(argv).toContain('--disable-slash-commands');
      expect(argv).toContain('--model');
      expect(argv[argv.indexOf('--model') + 1]).toMatch(/^[^-].+/);
    }
  });

  it('fix resume stays a bare --bg --resume <id> <prompt>', () => {
    expect(buildAgentArgv({
      ...options('fix'), resumeSessionId: 'existing-session', extraArgs: ['--verbose'],
      systemPromptFile: 'brief.md', table: { model: 'sonnet' },
    })).toEqual(['--bg', '--resume', 'existing-session', 'Repair this PR.']);
  });

  it('non-fix background argv stays byte-identical without --restricted', () => {
    const argv = buildAgentArgv({ ...options('build'), table: { model: 'sonnet', effort: 'high' } });
    expect(argv).not.toContain('--restricted');
    expect(argv).toEqual([
      '--bg', '-n', 'repair-3037', '--settings',
      JSON.stringify({ env: { PATH: '/fixture/bin', WE_CONVEYOR_WORKER: '1' }, worktree: { bgIsolation: 'none' } }),
      '--effort', 'high', '--model', 'sonnet', 'Repair this PR.',
    ]);
  });

  it('fix and ci-heal argv and settings reference nothing under the user home config (portable)', () => {
    for (const kind of ['fix', 'ci-heal']) {
      const text = JSON.stringify(buildAgentArgv({ ...options(kind), systemPromptFile: '/repo/.operations/brief.md' }));
      expect(text).not.toMatch(/\.claude\/(CLAUDE\.md|projects|settings)/);
      expect(text).not.toMatch(/\/memory\b|MEMORY\.md/);
      expect(text.includes(`${process.env.HOME}/.claude`)).toBe(false);
    }
  });

  it('fix and ci-heal preserve permissions and pinned hooks while resolving direct hooks', () => {
    const canonical = JSON.parse(fs.readFileSync(CANONICAL_SETTINGS, 'utf8'));
    const expectedPre = canonical.hooks.PreToolUse.filter(entry => ['Edit|Write', 'Bash'].includes(entry.matcher));
    for (const kind of ['fix', 'ci-heal']) {
      const argv = buildAgentArgv(options(kind));
      expect(argv.filter(arg => arg === '--settings')).toHaveLength(1);
      const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
      expect(settings.env).toEqual({ PATH: '/fixture/bin', WE_CONVEYOR_WORKER: '1' });
      expect(settings.worktree).toEqual({ bgIsolation: 'none' });
      expect(settings.permissions?.allow).toEqual([...new Set([
        ...canonical.permissions.allow, ...leanRepairGrant(options(kind).payload, null, { root: '/repo' }).allow])]);
      expect(settings.permissions?.deny).toEqual(canonical.permissions.deny);
      expect(settings.permissions?.ask).toEqual(canonical.permissions.ask);
      expect(settings.hooks).toEqual(LEAN_FIX_HOOKS_SETTINGS().hooks);
      expect(Object.keys(settings.hooks)).toEqual(Object.keys(canonical.hooks));
      expect(expectedPre.length).toBeGreaterThan(0);
      const commands = ['PreToolUse', 'Stop'].flatMap(event => settings.hooks[event].flatMap(entry => entry.hooks.map(hook => hook.command)));
      for (const command of commands) {
        expect(command).not.toMatch(/^node scripts\//);
        expect(command).not.toContain('$HOME');
        expect(command).toContain('scripts/hooks/run-pinned-guard.mjs');
      }
      for (const [matcher, guards] of [
        ['Bash', ['guard-bash.mjs']],
        ['Edit|Write', ['guard-lane.mjs', 'lint-locus-prefix.mjs --pre', 'lint-invisible-characters.mjs',
          'check-memory.mjs --pre', 'backlog-guard.mjs --pre', 'guard-backward-edge.mjs']],
      ]) {
        const matched = settings.hooks.PreToolUse.filter(entry => entry.matcher === matcher).flatMap(entry => entry.hooks);
        for (const guard of guards) expect(matched.some(hook => hook.command.includes(`scripts/${guard};`))).toBe(true);
      }
    }
  });

  it.each(['--settings', '--tools', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools',
    '--setting-sources', '--bare', '--safe-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions',
    '--permission-mode', '--add-dir', '--mcp-config'])(
    'refuses %s boundary overrides for fix and ci-heal, while build and resume retain their behavior', (flag) => {
      for (const extraArgs of [[flag, 'override'], [`${flag}=override`]]) {
        for (const kind of ['fix', 'ci-heal']) {
          expect(() => buildAgentArgv({ ...options(kind), extraArgs })).toThrow(expect.objectContaining({ notApplied: true }));
          expect(buildAgentArgv({ ...options(kind), extraArgs, resumeSessionId: 'existing-session' }))
            .toEqual(['--bg', '--resume', 'existing-session', 'Repair this PR.']);
        }
        expect(buildAgentArgv({ ...options('build'), extraArgs })).toEqual(expect.arrayContaining(extraArgs));
      }
    },
  );

  // Individual guards and the broadcast hooks, not only their matchers: an entry that survives with one guard
  // dropped, swapped for another command, renamed to a look-alike, or narrowed off a lean tool must fail closed.
  const entriesOf = (hooks, event, matcher) => (hooks[event] ?? []).filter(entry => entry.matcher === matcher);
  const dropGuard = (hooks, event, matcher, script) => {
    for (const entry of entriesOf(hooks, event, matcher)) entry.hooks = entry.hooks.filter(hook => !hook.command.includes(script));
    hooks[event] = hooks[event].filter(entry => entry.hooks.length > 0);
  };
  const swapGuard = (hooks, event, matcher, script, replacement) => {
    for (const entry of entriesOf(hooks, event, matcher)) {
      for (const hook of entry.hooks) hook.command = hook.command.split(script).join(replacement);
    }
  };
  const GUARD_FAULTS = {
    'async Bash guard': (h) => { h.PreToolUse.find(e => e.matcher === 'Bash').hooks[0].async = true; },
    'echo stand-in Bash guard': (h) => { h.PreToolUse.find(e => e.matcher === 'Bash').hooks[0].command = 'echo scripts/guard-bash.mjs'; },
    'missing Bash guard-bash (entry kept)': (h) => swapGuard(h, 'PreToolUse', 'Bash', 'scripts/guard-bash.mjs', 'scripts/noop.mjs'),
    'look-alike Bash guard-bash': (h) => swapGuard(h, 'PreToolUse', 'Bash', 'scripts/guard-bash.mjs', 'scripts/guard-bash.mjs.disabled'),
    'missing Edit|Write guard-lane (entry kept)': (h) => dropGuard(h, 'PreToolUse', 'Edit|Write', 'scripts/guard-lane.mjs'),
    'missing Edit|Write guard-backward-edge (entry kept)': (h) => dropGuard(h, 'PreToolUse', 'Edit|Write', 'scripts/guard-backward-edge.mjs'),
    'Edit|Write guard narrowed to Edit': (h) => { entriesOf(h, 'PreToolUse', 'Edit|Write').forEach(entry => { entry.matcher = 'Edit'; }); },
    'pre-mode flag dropped from check-memory': (h) => swapGuard(h, 'PreToolUse', 'Edit|Write', 'scripts/check-memory.mjs --pre', 'scripts/check-memory.mjs'),
    'missing Agent|Task guard-prep': (h) => dropGuard(h, 'PreToolUse', 'Agent|Task', 'scripts/guard-prep.mjs'),
    'missing Stop guard (entry kept)': (h) => swapGuard(h, 'Stop', undefined, 'scripts/guard-stop-passive-wait.mjs', 'scripts/noop.mjs'),
    'missing SubagentStop background-running guard': (h) => dropGuard(h, 'SubagentStop', undefined, 'scripts/guard-stop-background-running.mjs'),
    'missing PostToolUse Edit|Write backlog-guard (entry kept)': (h) => dropGuard(h, 'PostToolUse', 'Edit|Write', 'scripts/backlog-guard.mjs'),
    'missing PostToolUse Edit|Write record-touch (entry kept)': (h) => dropGuard(h, 'PostToolUse', 'Edit|Write', 'scripts/readiness/record-touch.mjs'),
    'PostToolUse backlog-guard swapped to its --pre mode': (h) => swapGuard(h, 'PostToolUse', 'Edit|Write', 'scripts/backlog-guard.mjs', 'scripts/backlog-guard.mjs --pre'),
    'Stop guard run without --stop-hook': (h) => swapGuard(h, 'Stop', undefined, '--stop-hook scripts/', 'scripts/'),
    'SubagentStop background-running guard run without --stop-hook': (h) => swapGuard(h, 'SubagentStop', undefined, '--stop-hook scripts/guard-stop-background-running.mjs', 'scripts/guard-stop-background-running.mjs'),
    'missing PostToolUse broadcast': (h) => dropGuard(h, 'PostToolUse', undefined, 'scripts/broadcast-inject.mjs'),
    'PostToolUse broadcast narrowed to Read': (h) => { entriesOf(h, 'PostToolUse', undefined).forEach(entry => { entry.matcher = 'Read'; }); },
    'missing UserPromptSubmit broadcast': (h) => { delete h.UserPromptSubmit; },
  };

  it.each(['unreadable', 'invalid JSON', 'missing hooks', 'missing Edit|Write', 'missing Bash', 'missing Stop', 'empty guard',
    ...Object.keys(GUARD_FAULTS)])(
    'fails closed at argv build time on %s repo settings; build and resume remain available', (fault) => {
      const canonicalText = fs.readFileSync(CANONICAL_SETTINGS, 'utf8');
      const canonical = JSON.parse(canonicalText);
      if (fault === 'missing hooks') delete canonical.hooks;
      if (fault === 'missing Stop') delete canonical.hooks.Stop;
      if (fault === 'missing Edit|Write' || fault === 'missing Bash') {
        canonical.hooks.PreToolUse = canonical.hooks.PreToolUse.filter(entry => entry.matcher !== fault.slice(8));
      }
      if (fault === 'empty guard') canonical.hooks.PreToolUse.find(entry => entry.matcher === 'Bash').hooks = [];
      GUARD_FAULTS[fault]?.(canonical.hooks);
      const dir = mkdtempSync(join(tmpdir(), 'lean-hooks-'));
      const faultPath = join(dir, 'settings.json');
      if (fault !== 'unreadable') writeFileSync(faultPath, fault === 'invalid JSON' ? '{' : JSON.stringify(canonical));
      const read = vi.mocked(LEAN_FIX_HOOKS_SETTINGS).getMockImplementation();
      vi.mocked(LEAN_FIX_HOOKS_SETTINGS).mockImplementation(() => read(faultPath));
      try {
        for (const kind of ['fix', 'ci-heal']) {
          expect(() => buildAgentArgv(options(kind))).toThrow(expect.objectContaining({
            notApplied: true, message: expect.stringContaining('restore the repo settings before retrying'),
          }));
        }
        expect(() => buildAgentArgv(options('build'))).not.toThrow();
        expect(buildAgentArgv({ ...options('fix'), resumeSessionId: 'existing-session' }))
          .toEqual(['--bg', '--resume', 'existing-session', 'Repair this PR.']);
      } finally { vi.mocked(LEAN_FIX_HOOKS_SETTINGS).mockImplementation(read); rmSync(dir, { recursive: true, force: true }); }
      // A fresh read must recover immediately once the canonical settings are available again.
      expect(() => buildAgentArgv(options('fix'))).not.toThrow();
    },
  );

  // The manifest must name every hook the repo settings run on a lean tool, so a guard added to the settings
  // and later dropped is caught too. Session bookkeeping events are not guards; any other event must be listed.
  it('the required-guard manifest names every repo hook that covers a lean tool', () => {
    const BOOKKEEPING_EVENTS = ['SessionStart', 'SessionEnd'];
    const { hooks } = JSON.parse(fs.readFileSync(CANONICAL_SETTINGS, 'utf8'));
    const manifestEvents = new Set(LEAN_FIX_REQUIRED_GUARDS.map(rule => rule.event));
    expect(Object.keys(hooks).filter(event => !manifestEvents.has(event) && !BOOKKEEPING_EVENTS.includes(event))).toEqual([]);
    const covers = (matcher, tool) => matcher === undefined || matcher === '' || matcher === '*'
      || new RegExp(`^(?:${matcher})$`).test(tool);
    // The guard a command runs: its last `scripts/…mjs` (with a launcher or script mode flag), never the
    // launcher or its repair hint.
    const scriptOf = (command) => [...command.matchAll(/(?:--[\w-]+ )?scripts\/[\w./-]+\.mjs(?: --[\w-]+)?/g)]
      .map(match => match[0]).filter(script => !script.includes('scripts/hooks/')).at(-1);
    const unlisted = [];
    for (const event of manifestEvents) {
      const rules = LEAN_FIX_REQUIRED_GUARDS.filter(rule => rule.event === event);
      const tools = rules.some(rule => rule.tools) ? LEAN_FIX_TOOLS.split(',') : [undefined];
      for (const tool of tools) {
        const listed = rules.filter(rule => !rule.tools || rule.tools.includes(tool)).flatMap(rule => rule.scripts);
        for (const entry of hooks[event] ?? []) {
          if (tool !== undefined && !covers(entry.matcher, tool)) continue;
          for (const hook of entry.hooks) {
            const script = scriptOf(hook.command);
            if (!listed.includes(script)) unlisted.push(`${event}${tool ? `[${tool}]` : ''} ${script ?? hook.command}`);
          }
        }
      }
    }
    expect(unlisted).toEqual([]);
  });

  // PR #7332 round 2 (red team): `--restricted` ignores user, project and local settings files, and the sinks
  // write the lane grant into the scratch cwd's settings.local.json. So the grant must ride in the launch argv
  // itself — one `--add-dir` per directory plus the `--settings` permissions — or the repair cannot edit its lane.
  const settingsOf = (argv) => JSON.parse(argv[argv.indexOf('--settings') + 1]);
  const addDirsOf = (argv) => argv.flatMap((arg, i) => (arg === '--add-dir' ? [argv[i + 1]] : []));
  const LANE_GRANT = leanRepairGrant({ launchKind: 'fix', lane: 7 }, null, { root: '/repo' });

  it.each(['fix', 'ci-heal'])('%s grants the configured pool through implicit and sink-supplied argv', (kind) => {
    const root = '/workspace/web-everything';
    try {
      vi.stubEnv('HOME', '/fixture/home');
      for (const [override, pool] of [
        ['/tmp/custom-pool', '/tmp/custom-pool'],
        ['~/custom pool', '/fixture/home/custom pool'],
      ]) {
        vi.stubEnv('LANE_POOL_ROOT', override);
        for (const [repo, directory] of [['we', 'web-everything'], ['frontierui', 'frontierui'], ['plateau-app', 'plateau-app']]) {
          const payload = { ...options(kind).payload, repo };
          const lane = join(pool, directory, 'lane-7');
          const grant = dispatchLaneGrant(payload, { root, exists: () => false });
          expect(grant.additionalDirectories).toEqual([lane]);
          expect(leanRepairGrant(payload, null, { root, exists: () => false }).additionalDirectories).toEqual([lane]);
          for (const laneGrant of [undefined, grant]) {
            const argv = buildAgentArgv({ ...options(kind), root, payload, laneGrant });
            expect(addDirsOf(argv)).toEqual([lane]);
            expect(settingsOf(argv).permissions.additionalDirectories).toEqual([lane]);
            expect(settingsOf(argv).permissions.allow).toEqual(expect.arrayContaining([
              `Edit(${lane}/**)`, `Write(${lane}/**)`,
            ]));
          }
          for (const dir of [join('/workspace/.lanes', directory, 'lane-7'), join(pool, directory), join(pool, directory, 'lane-8')]) {
            expect(() => buildAgentArgv({ ...options(kind), root, payload,
              laneGrant: { additionalDirectories: [dir] } })).toThrow(/only the assigned lane/);
          }
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('carries an explicit lane grant into --add-dir and the --settings permissions for fix and ci-heal', () => {
    for (const kind of ['fix', 'ci-heal']) {
      const argv = buildAgentArgv({ ...options(kind), laneGrant: LANE_GRANT });
      expect(addDirsOf(argv)).toEqual(LANE_GRANT.additionalDirectories);
      expect(addDirsOf(argv)).toHaveLength(1);
      // `--add-dir <directories...>` is variadic: a flag must close it, so the prompt is never read as a directory.
      const last = argv.lastIndexOf('--add-dir');
      expect(argv[last + 2]).toMatch(/^--/);
      expect(argv.at(-1)).toBe('Repair this PR.');
      const { permissions } = settingsOf(argv);
      expect(permissions.additionalDirectories).toEqual(addDirsOf(argv));
      expect(permissions.allow).toEqual(expect.arrayContaining(LANE_GRANT.allow));
      expect(buildAgentArgv({ ...options(kind), laneGrant: LANE_GRANT, resumeSessionId: 'existing-session' }))
        .toEqual(['--bg', '--resume', 'existing-session', 'Repair this PR.']);
    }
    expect(buildAgentArgv({ ...options('build'), laneGrant: LANE_GRANT })).not.toContain('--add-dir');
  });

  it('derives the grant from the payload lane and scope when none is passed (the direct reconcile fix path)', () => {
    const payload = { ...options('fix').payload, lane: 12, scope: ['we:scripts/a.mjs'] };
    const argv = buildAgentArgv({ ...options('fix'), payload });
    expect(addDirsOf(argv)).toEqual([expect.stringMatching(/\/\.lanes\/web(?:-)?everything\/lane-12$/)]);
    expect(settingsOf(argv).permissions.allow).toEqual(expect.arrayContaining([expect.stringMatching(/^Edit\(.*\/lane-12\/\*\*\)$/)]));
  });

  it('validates an explicit grant against the dispatcher root, refusing another workspace', () => {
    const payload = { ...options('fix').payload, lane: 7 };
    const root = '/portable/workspace/we';
    const laneGrant = leanRepairGrant(payload, null, { root, exists: () => false });
    const argv = buildAgentArgv({ ...options('fix'), root, payload, laneGrant });
    expect(addDirsOf(argv)).toEqual(['/portable/workspace/.lanes/web-everything/lane-7']);
    expect(settingsOf(argv).permissions.additionalDirectories).toEqual(addDirsOf(argv));
    expect(settingsOf(argv).permissions.allow).toContain(`Bash(node ${root}/scripts/conveyor/resolve-conflict.mjs:*)`);
    expect(() => buildAgentArgv({ ...options('fix'), root: '/other/workspace/we', payload, laneGrant }))
      .toThrow(/only the assigned lane/);
    expect(buildAgentArgv({ ...options('fix'), root: '/other/workspace/we', payload, laneGrant, resumeSessionId: 'existing' }))
      .toEqual(['--bg', '--resume', 'existing', payload.prompt]);
  });

  // Self-review (round 2): the repo comes from the dispatch's own `repo`, never only from the scope — a sibling
  // repo's card may list a `we:` path first, and a ci-heal may carry no scope at all.
  it('grants only the named lane in the dispatch repo, whatever the scope lists first', () => {
    for (const repo of ['frontierui', 'frontier-ui/frontierui']) {
      for (const scope of [undefined, [], ['we:scripts/a.mjs', 'frontierui:src/b.ts']]) {
        const payload = { ...options('fix').payload, lane: 3, repo, scope };
        const dirs = addDirsOf(buildAgentArgv({ ...options('fix'), payload }));
        expect(dirs).toEqual([expect.stringMatching(/\/\.lanes\/frontierui\/lane-3$/)]);
        expect(dispatchLaneGrant(payload, { root: '/w/webeverything', exists: () => false }).additionalDirectories)
          .toEqual(['/w/.lanes/frontierui/lane-3']);
      }
    }
    expect(laneRepoKey({ repo: 'plateauapp/plateau-app' })).toBe('plateau-app');
    expect(laneRepoKey({ repo: 'unknown/repo', scope: ['plateau-app:src/a.ts'] })).toBe('plateau-app');
    expect(laneRepoKey({ repo: 'constructor' })).toBe('we');
    expect(laneRepoKey({})).toBe('we');
  });

  it('refuses laneless launches even with an empty explicit grant', () => {
    for (const laneGrant of [undefined, {}, { additionalDirectories: [], allow: [] }]) {
      for (const scope of [undefined, ['plateau-app:src/a.ts']]) {
        expect(() => buildAgentArgv({ ...options('ci-heal'), laneGrant,
          payload: { ...options('ci-heal').payload, lane: undefined, scope } })).toThrow(/no lane directory/);
      }
    }
  });

  it('fails closed, never launching an unusable session, when no lane directory can be granted', () => {
    const none = { poolDirs: () => [] };
    for (const laneGrant of [null, { additionalDirectories: [''] }]) {
      for (const lane of [undefined, 4]) {
        expect(() => leanRepairGrant({ launchKind: 'fix', lane }, laneGrant, none))
          .toThrow(expect.objectContaining({ notApplied: true, message: expect.stringContaining('no lane directory') }));
      }
    }
    for (const lane of [undefined, '', '../x', '.', '0', '01', '7\n8', '７']) {
      expect(() => leanRepairGrant({ launchKind: 'fix', lane }, null,
        { poolDirs: () => ['/w/.lanes/web-everything'] })).toThrow(/no lane directory/);
    }
  });

  it('the sink forwards its lane grant to the launch argv, not only to settings.local.json', async () => {
    const requests = [];
    const grant = leanRepairGrant({ launchKind: 'ci-heal', lane: 40 }, null, { root: '/repo/webeverything' });
    const sinks = createDispatchSinks({
      root: '/repo/webeverything', mintSessionId: () => 'sess-grant-1', now: () => new Date('2026-11-22T00:00:00Z'),
      sessionCwdFor: () => '/tmp/scratch-grant', ensureSessionCwd: (d) => d, resolveSettingsEnv: () => ({}),
      resolveLaneGrant: () => grant, grantLanePermission: () => {}, ensureWorktreeIsolation: () => {},
      reserveLane: () => ({ reserved: false }), releaseLane: () => {},
      provider: async (request) => { requests.push(request); return 'sess-grant-1'; },
    });
    await sinks[DISPATCH_EFFECT]({ num: '4210', lane: 40, launchKind: 'ci-heal', sessionSlug: 'ci-heal-4210', prompt: '# go', scope: ['we:scripts/a.mjs'] });
    expect(requests[0].laneGrant).toEqual(grant);
    expect(requests[0].dispatchRoot).toBe('/repo/webeverything');
    const argvs = [];
    defaultClaudeProvider({ ...requests[0], cwd: '/tmp/scratch-grant' }, {
      spawnAgent: (argv) => { argvs.push(argv); return ''; }, wrapKind: () => false,
    });
    expect(addDirsOf(argvs[0])).toEqual(grant.additionalDirectories);
    expect(settingsOf(argvs[0]).permissions.allow).toEqual(expect.arrayContaining(grant.allow));
  });

  it('accepts a required guard moved to a combined or catch-all matcher that still covers the lean tool', () => {
    const read = vi.mocked(LEAN_FIX_HOOKS_SETTINGS).getMockImplementation();
    const canonical = JSON.parse(fs.readFileSync(CANONICAL_SETTINGS, 'utf8'));
    canonical.hooks.PreToolUse.find(entry => entry.matcher === 'Bash').matcher = 'Bash|Monitor';
    canonical.hooks.PreToolUse.find(entry => entry.matcher === 'Agent|Task').matcher = '*';
    const dir = mkdtempSync(join(tmpdir(), 'lean-hooks-'));
    const path = join(dir, 'settings.json');
    try {
      writeFileSync(path, JSON.stringify(canonical));
      const loaded = read(path).hooks;
      expect(loaded.PreToolUse.map(entry => entry.matcher)).toEqual(canonical.hooks.PreToolUse.map(entry => entry.matcher));
      expect(loaded.PreToolUse.map(entry => entry.hooks)).toEqual(LEAN_FIX_HOOKS_SETTINGS().hooks.PreToolUse.map(entry => entry.hooks));
      expect(Object.keys(loaded)).toEqual(Object.keys(canonical.hooks));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the tick reader handoff', () => {
  const at = '2026-10-06T12:00:00.000Z';
  const bookkeeping = { tick: 3, buildGuards: [] };
  const stdin = JSON.stringify({ bookkeeping });
  const tick = {
    decisions: { spawnBuilds: [{ num: '3037', lane: 8 }], statusLine: 'handed-off tick' },
    nextState: { tick: 4 },
  };
  const envelope = {
    at, bookkeepingHash: createHash('sha256').update(stdin).digest('hex'), tick,
  };
  function fixture(file = envelope, overrides = {}, template = 'dispatch brief') {
    const runNode = vi.fn(() => JSON.stringify({ decisions: {}, nextState: { tick: 99 } }));
    const readText = vi.fn((path) => {
      if (path === '/tmp/bookkeeping.json') return JSON.stringify({ bookkeeping, config: { verbose: true } });
      if (path === '/tmp/tick.json') {
        if (file instanceof Error) throw file;
        return typeof file === 'string' ? file : JSON.stringify(file);
      }
      return template;
    });
    const read = createTickReader({
      runNode, readText, now: () => new Date(at),
      loadItems: () => [{ num: '3037', slug: 'tick-handoff', scope: ['we:scripts/operations/'] }],
      listInFlightDispatches: () => ({ runs: [], unreadable: 0 }),
      recordLiveness: (value) => value, listAgents: () => [],
      checkAlreadyDone: () => ({ done: false, checked: true, pr: null }),
      checkBuildDelivery: () => null,
      readScorecards: () => [], readSizePolicy: () => ({}), readPromotions: () => [],
      readDeliveryAgentOverride: () => null,
      ...overrides,
    });
    return { runNode, readText, read: (options = {}) => read({
      num: '3037', bookkeepingFile: '/tmp/bookkeeping.json', tickFile: '/tmp/tick.json', ...options,
    }) };
  }

  it('uses a fresh tick file with the matching forwarded bookkeeping hash before the verbose rewrite', () => {
    const { read, runNode } = fixture();
    expect(read({ verbose: false })).toMatchObject({
      launch: tick.decisions.spawnBuilds[0], nextState: tick.nextState, statusLine: 'handed-off tick',
    });
    expect(runNode).not.toHaveBeenCalled();
  });

  it.each([
    ['stale', { ...envelope, at: '2026-10-06T11:54:59.000Z' }],
    ['exactly five minutes old', { ...envelope, at: '2026-10-06T11:55:00.000Z' }],
    ['hash mismatch', { ...envelope, bookkeepingHash: 'wrong' }],
    ['future', { ...envelope, at: '2026-10-06T12:01:01.000Z' }],
    ['invalid timestamp', { ...envelope, at: 'invalid' }],
    ['unreadable', new Error('ENOENT')],
    ['malformed JSON', '{'],
    ['missing tick', { ...envelope, tick: undefined }],
    ['malformed tick', { ...envelope, tick: [] }],
  ])('falls back from a %s tick file', (_name, file) => {
    const { read, runNode } = fixture(file);
    expect(read().nextState).toEqual({ tick: 99 });
    expect(runNode).toHaveBeenCalledTimes(1);
    expect(runNode.mock.calls[0][1].input).toBe(stdin);
  });

  it('checks the in-flight guard before reading a tick file', () => {
    const { read, readText, runNode } = fixture(envelope, {
      listInFlightDispatches: () => ({ runs: [{ status: 'in-flight', live: true }], unreadable: 0 }),
      recordLiveness: (value) => ({ ...value, runs: value.runs.map(r => ({ ...r, live: true })) }),
    });
    expect(read().launch).toBeNull();
    expect(readText.mock.calls.some(([path]) => path === '/tmp/tick.json')).toBe(false);
    expect(runNode).not.toHaveBeenCalled();
  });

  it('accepts a Date.now-style clock for a tick file', () => {
    const { read, runNode } = fixture(envelope, { now: () => Date.parse(at) });
    expect(read().launch).toEqual(tick.decisions.spawnBuilds[0]);
    expect(runNode).not.toHaveBeenCalled();
  });

  // xykwe0h — the build-delivered gate only fires if readTick carries checkBuildDelivery's answer through as `buildDelivery`.
  describe.each([['fix', 'spawnFixes'], ['ci-heal', 'spawnCiHeals']])('%s raw template boundary', (kind, list) => {
    const repairEnvelope = { ...envelope, tick: {
      decisions: { [list]: [{ num: '3037', lane: 8, pr: 701, reason: 'red-ci' }] }, nextState: {},
    } };
    it.each(['', ' ', '\t', '\n', '\r', '\r\n', ' \t\r\n'])('refuses %j before build requirements or operator steps', task => {
      const { read } = fixture(repairEnvelope, { laneRefForPr: () => 'lane/3037-repair' }, task);
      expect(() => read()).toThrow('dispatch-lane: the delivery-agent brief template is empty — refusing to dispatch an agent with no instructions');
    });
    it('accepts a non-empty template and injects the complete block exactly once', () => {
      const { read } = fixture(repairEnvelope, { laneRefForPr: () => 'lane/3037-repair' }, 'Repair this PR.');
      const shaped = shapeDispatchRead(read(), { num: '3037' });
      expect(shaped.launchKind).toBe(kind);
      expect(shaped.prompt.startsWith(`${NO_PROMPT_COMMAND_RULES}\n\n`)).toBe(true);
      expect(shaped.prompt.split(NO_PROMPT_COMMAND_RULES)).toHaveLength(2);
      expect(shaped.prompt).toContain('Repair this PR.');
    });
  });

  it('wires checkBuildDelivery into the read as buildDelivery for a build launch', () => {
    const delivered = { outcome: 'pr-merged', pr: 4288, reason: 'PR #4288 merged' };
    const checkBuildDelivery = vi.fn(() => delivered);
    const { read } = fixture(envelope, { checkBuildDelivery });
    expect(read().buildDelivery).toEqual(delivered);
    expect(checkBuildDelivery).toHaveBeenCalledWith('3037');
  });

  it('a throwing checkBuildDelivery fails soft to buildDelivery null and still launches', () => {
    const { read } = fixture(envelope, { checkBuildDelivery: () => { throw new Error('gh down'); } });
    const out = read();
    expect(out.buildDelivery).toBeNull();
    expect(out.launch).toEqual(tick.decisions.spawnBuilds[0]);
  });

  it('does not call checkBuildDelivery when nothing is cleared for launch', () => {
    const checkBuildDelivery = vi.fn(() => ({ outcome: 'pr-open', pr: 1, reason: 'x' }));
    const { read } = fixture({ ...envelope, tick: { ...tick, decisions: { spawnBuilds: [], statusLine: 'idle' } } }, { checkBuildDelivery });
    expect(read().buildDelivery).toBeNull();
    expect(checkBuildDelivery).not.toHaveBeenCalled();
  });

  it('ignores the tick file for whole-queue reads', () => {
    const { read, readText, runNode } = fixture();
    runNode.mockReturnValue(JSON.stringify({ decisions: {
      admission: { queue: [], held: [], planned: [] },
    } }));
    expect(read({ all: true })).toEqual([]);
    expect(runNode).toHaveBeenCalledTimes(1);
    expect(readText.mock.calls.some(([path]) => path === '/tmp/tick.json')).toBe(false);
  });
});

// x87v3ed — reserve the lane BEFORE the build session launches.
describe('x87v3ed — the build launch reserves its lane first', () => {
  const payload = { num: '5189', launchKind: 'build', lane: 2, sessionSlug: 'conveyor-5189', scope: ['we:scripts/a.mjs'], prompt: 'brief' };
  const baseSinks = (extra) => createDispatchSinks({
    root: '/repo/webeverything', mintSessionId: () => 'sess-1', now: () => new Date('2026-10-08T00:00:00Z'),
    sessionCwdFor: () => '/tmp/scratch', ensureSessionCwd: (d) => d, resolveSettingsEnv: () => ({}),
    resolveLaneGrant: () => ({}), grantLanePermission: () => {}, ensureWorktreeIsolation: () => {},
    ...extra,
  });
  it('reserves lane N under the worker\'s own session slug', () => {
    const calls = [];
    const r = reserveBuildLane(payload, { enabled: true, run: (cmd, argv, o) => { calls.push({ cmd, argv, env: o.env }); return ''; }, root: '/r' });
    expect(r).toEqual({ reserved: true, lane: 2, session: 'conveyor-5189' });
    expect(calls[0].argv).toEqual(expect.arrayContaining(['scripts/lane-pool.mjs', 'acquire', '--lane=2', '--session=conveyor-5189', '--item=5189']));
  });
  it('refuses with notApplied, before any process, when the lane is already leased', () => {
    const run = () => { throw Object.assign(new Error('x'), { stderr: 'lane-2 is leased by review-4306 — a LIVE lease' }); };
    let err; try { reserveBuildLane(payload, { enabled: true, run }); } catch (e) { err = e; }
    expect(err?.notApplied).toBe(true);
    expect(err.message).toMatch(/lane-reserve-failed.*LIVE lease/);
  });
  it('is off for non-build kinds and when not enabled', () => {
    const run = () => { throw new Error('must not run'); };
    expect(reserveBuildLane({ ...payload, launchKind: 'prepare' }, { enabled: true, run }).reserved).toBe(false);
    expect(reserveBuildLane(payload, { enabled: false, run }).reserved).toBe(false);
  });
  it('the sink reserves BEFORE the provider spawns, and never spawns when the reservation fails', async () => {
    const order = [];
    const sinks = baseSinks({
      reserveLane: () => { order.push('reserve'); return { reserved: true, lane: 2, session: 'conveyor-5189' }; },
      provider: async () => { order.push('spawn'); return 'handle-1'; },
    });
    await sinks[DISPATCH_EFFECT](payload, {});
    expect(order).toEqual(['reserve', 'spawn']);
    let spawned = false;
    const refusing = baseSinks({
      reserveLane: () => { throw Object.assign(new Error('lane-reserve-failed'), { notApplied: true }); },
      provider: async () => { spawned = true; return 'h'; },
    });
    await expect(refusing[DISPATCH_EFFECT](payload, {})).rejects.toThrow(/lane-reserve-failed/);
    expect(spawned).toBe(false);
  });
  it('hands the reserved lane back when the launch definitely started nothing', async () => {
    const released = [];
    const sinks = baseSinks({
      reserveLane: () => ({ reserved: true, lane: 2, session: 'conveyor-5189' }),
      releaseLane: (r) => released.push(r),
      provider: async () => { throw Object.assign(new Error('bad'), { notApplied: true }); },
    });
    await expect(sinks[DISPATCH_EFFECT](payload, {})).rejects.toThrow();
    expect(released).toEqual([{ reserved: true, lane: 2, session: 'conveyor-5189' }]);
  });
});

// PR #5729 — a daemon's gh refusal shim is its auth boundary: a dispatch that cannot install it never starts.
describe('PR #5729 — daemon dispatch fails closed without the gh refusal shim', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const DAEMONS = [['explicit', { WE_GH_DAEMON_CALLER: 'review-daemon' }], ['XPC-only', { XPC_SERVICE_NAME: 'com.we.review-daemon' }]];
  const payload = { num: '5189', launchKind: 'build', lane: 2, sessionSlug: 'conveyor-5189', scope: ['we:scripts/a.mjs'], prompt: 'brief' };
  // A real gh on PATH (records any call) and a HOME whose `.claude` is read-only, so the shim-dir mkdir is EACCES.
  function unwritableShimHome(marker) {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-gh-guard-'));
    const bin = join(dir, 'bin');
    const claude = join(dir, 'home', '.claude');
    mkdirSync(bin);
    mkdirSync(claude, { recursive: true });
    const invoked = join(dir, 'gh-invoked');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho called >> '${invoked}'\n`, { mode: 0o755 });
    chmodSync(claude, 0o500);
    vi.stubEnv('HOME', join(dir, 'home'));
    vi.stubEnv('PATH', bin);
    vi.stubEnv('WE_GH_DAEMON_CALLER', marker.WE_GH_DAEMON_CALLER ?? '');
    vi.stubEnv('XPC_SERVICE_NAME', marker.XPC_SERVICE_NAME ?? '');
    return { invoked, cleanup: () => { chmodSync(claude, 0o700); rmSync(dir, { recursive: true, force: true }); } };
  }
  const sinksWith = (provider) => createDispatchSinks({
    root: '/repo/webeverything', mintSessionId: () => 'sess-1', now: () => new Date('2026-10-22T00:00:00Z'),
    sessionCwdFor: () => '/tmp/scratch', ensureSessionCwd: (d) => d, resolveSettingsEnv: resolveDispatchSettingsEnv,
    resolveLaneGrant: () => ({}), grantLanePermission: () => {}, ensureWorktreeIsolation: () => {},
    reserveLane: () => ({ reserved: false }), releaseLane: () => {}, provider,
  });

  it.each(DAEMONS)('daemon dispatch refuses an unwritable shim dir before invoking the provider (%s)', async (_kind, marker) => {
    const f = unwritableShimHome(marker);
    try {
      const provider = vi.fn(async () => 'handle-1');
      const err = await sinksWith(provider)[DISPATCH_EFFECT](payload, {}).then(() => null, (e) => e);
      expect(err?.message).toMatch(/dispatch refused: gh-shim: refusing daemon dispatch without the gh auth guard/);
      expect(err?.notApplied).toBe(true); // definitely not started: retryable, never an UNKNOWN in-flight entry
      expect(provider).not.toHaveBeenCalled();
      expect(existsSync(f.invoked)).toBe(false);
    } finally { f.cleanup(); }
  });

  it('an interactive dispatch keeps the best-effort fallback: the provider runs without shim settings', async () => {
    const f = unwritableShimHome({});
    try {
      const provider = vi.fn(async () => 'handle-1');
      await sinksWith(provider)[DISPATCH_EFFECT](payload, {});
      expect(provider).toHaveBeenCalledTimes(1);
      expect(provider.mock.calls[0][0].settingsEnv).toEqual(DISPATCH_BASH_TIMEOUT_ENV);
    } finally { f.cleanup(); }
  });

  it.each(DAEMONS)('the prevention landing job refuses to spawn without the guard (%s)', (_kind, marker) => {
    vi.stubEnv('WE_GH_DAEMON_CALLER', marker.WE_GH_DAEMON_CALLER ?? '');
    vi.stubEnv('XPC_SERVICE_NAME', marker.XPC_SERVICE_NAME ?? '');
    const spawnDetached = vi.fn(() => ({ pid: 4242 }));
    const r = spawnPreventionLandingJob({ title: 't', kind: 'story', size: 1, digest: 'd', scope: 'we:x', queue: true }, {
      spawnDetached, logPathFor: () => '/dev/null',
      resolveSettingsEnv: () => { throw new Error('gh-shim: refusing daemon dispatch without the gh auth guard'); },
    });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/refusing to spawn without the gh auth guard/) });
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('the prevention landing job stays fail-soft for an interactive caller', () => {
    vi.stubEnv('WE_GH_DAEMON_CALLER', '');
    vi.stubEnv('XPC_SERVICE_NAME', '');
    const spawnDetached = vi.fn(() => ({ pid: 4242 }));
    const r = spawnPreventionLandingJob({ title: 't', kind: 'story', size: 1, digest: 'd', scope: 'we:x', queue: true }, {
      spawnDetached, logPathFor: () => '/dev/null', resolveSettingsEnv: () => { throw new Error('boom'); },
    });
    expect(r.ok).toBe(true);
    expect(spawnDetached.mock.calls[0][1].settingsEnv).toBeNull();
  });
});
