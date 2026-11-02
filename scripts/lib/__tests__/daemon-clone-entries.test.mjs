import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { cloneRuntimeEntries } from '../daemon-clone-entries.mjs';
import { DAEMON_ENTRY_MODULES } from '../daemon-boot-smoke.mjs';
import { closureHits, collectImportClosure } from '../import-closure.mjs';
import { collectRunClosure, decideSkipRebuild, makeSkipCheck } from '../daemon-rebuild/skip-unrelated.mjs';
import { decideRestart } from '../daemon-self-sync.mjs';
import { checkCodeUnchanged } from '../daemon-live-smoke.mjs';
import { loadReadOnlyOps } from '../read-only-ops.mjs';
import * as importClosureModule from '../import-closure.mjs';
import { isReviewCodePath } from '../../operations/review-dispatch.mjs';
import { isPromoteCodePath } from '../../operations/promote-draft-pr-dispatch.mjs';
import { isFixCodePath } from '../../conveyor/reconcile-fix-dispatch.mjs';

// Load the dispatch graphs during collection; their cold transforms can exceed a test's 5s budget.
const classifiers = { isReviewCodePath, isPromoteCodePath, isFixCodePath };

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'clone-entries-'));
  dirs.push(dir);
  const root = join(dir, 'clone');
  const launchAgentsDir = join(dir, 'agents');
  mkdirSync(root); mkdirSync(launchAgentsDir);
  return { dir, root, launchAgentsDir };
}
const plistJSON = (f, plist) => JSON.stringify({ WorkingDirectory: f.root, ...plist });

it('keeps clone discovery unwired pending inert-source proof', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const references = [];
  const visit = directory => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!['__tests__', 'soak', 'node_modules'].includes(entry.name)) visit(path);
      } else if (entry.isFile() && /\.[cm]?[jt]s$/.test(path) && !/\.(test|spec)\./.test(path)
        && path !== 'scripts/lib/daemon-clone-entries.mjs') {
        if (/daemon-clone-entries|\bcloneRuntimeEntries\b/.test(readFileSync(join(root, path), 'utf8'))) references.push(path);
      }
    }
  };
  visit('scripts'); visit('skills-src');
  expect(references).toEqual([]);
});

it.each(['collectRunClosure', 'makeSkipCheck', 'decideRestart', 'checkCodeUnchanged', 'loadReadOnlyOps',
  'isReviewCodePath', 'isPromoteCodePath', 'isFixCodePath'])(
  'missing runtime roots remain unknown at every closure consumer: %s', async consumer => {
    const { root } = fixture();
    writeFileSync(join(root, 'readable.mjs'), 'export {};');
    const entries = ['readable.mjs', 'missing.mjs'];
    const changedFiles = ['scripts/unrelated.mjs'];
    const closure = collectImportClosure({ root, entries });
    expect(closure).toBeNull();
    if (consumer === 'collectRunClosure') {
      const graph = collectRunClosure({ root, entries, byName: () => [] });
      expect(graph).toBeNull();
      expect(decideSkipRebuild({ closure: graph, changedFiles }).skip).toBe(false);
    } else if (consumer === 'makeSkipCheck') {
      expect(makeSkipCheck({ root, entries, surface: () => [],
        env: { WE_DAEMON_REBUILD_SKIP_UNRELATED: '1' } })(changedFiles).skip).toBe(false);
    } else if (consumer === 'decideRestart') {
      expect(decideRestart({ closure, changedFiles, uptimeMs: 100, minIntervalMs: 0 }).restart).toBe(true);
    } else if (consumer === 'checkCodeUnchanged') {
      expect(checkCodeUnchanged({ root, check: { codeEntries: entries }, changedFiles })).toBe(false);
    } else if (consumer === 'loadReadOnlyOps') {
      // This consumer scans trusted code, never the proposed checkout. Feed the actual
      // missing-sibling result through that boundary and prove it reached the collector.
      const spy = vi.spyOn(importClosureModule, 'collectImportClosure').mockReturnValue(closure);
      const options = {
        importModule: async () => ({ OPERATIONS: { 'heavy-queue': {} },
          resolveOperation: async () => ({ declaration: { steps: [{ step: { kind: 'compute' } }] } }) }),
        lstat: () => ({ isFile: () => true, size: 1 }), readFile: () => Buffer.from('x'),
      };
      try {
        expect(await loadReadOnlyOps(root, options)).toEqual(new Set());
        expect(spy).toHaveBeenCalledOnce();
        spy.mockReturnValue({ complete: true, files: new Set(['readable.mjs']), jsonNames: new Set() });
        expect(await loadReadOnlyOps(root, options)).toEqual(new Set(['heavy-queue']));
      } finally { spy.mockRestore(); }
    } else {
      const classify = classifiers[consumer];
      expect(classify(changedFiles[0], { closure })).toBe(true);
      expect(classify(changedFiles[0], { closure: collectImportClosure({ root, entries: ['readable.mjs'] }) })).toBe(false);
    }
  });

it.each(['absent', 'relative', 'subdirectory', 'external', 'malformed'])(
  'refuses an absolute entry with unsupported WorkingDirectory=%s', cwd => {
    const f = fixture();
    const WorkingDirectory = { relative: '.', subdirectory: join(f.root, 'scripts'), external: f.dir, malformed: 42 }[cwd];
    writeFileSync(join(f.launchAgentsDir, 'com.we.cwd.plist'), 'plist');
    expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0, stdout: JSON.stringify({
      WorkingDirectory, ProgramArguments: ['node', join(f.root, 'worker.mjs')],
    }) }) })).toThrow('WorkingDirectory must be the clone root');
  });

it('permits a WorkingDirectory alias of the clone root', () => {
  const f = fixture();
  const alias = join(f.dir, 'alias');
  symlinkSync(f.root, alias);
  writeFileSync(join(f.launchAgentsDir, 'com.we.cwd.plist'), 'plist');
  expect(cloneRuntimeEntries({ ...f, run: () => ({ status: 0, stdout: plistJSON(f, {
    WorkingDirectory: alias, ProgramArguments: ['node', join(alias, 'worker.mjs')],
  }) }) })).toContain('worker.mjs');
});

it.each(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'bun.lock', 'bun.lockb', 'scripts/daemon-rebuild-settings.json', '.npmrc', '.node-version',
  '.nvmrc', 'skills-src/conveyor/prompt.md', '.claude/settings.json', 'config/runtime.json'])(
  'retains conservative treatment for non-source runtime inputs: %s', path => {
    const { root } = fixture();
    writeFileSync(join(root, 'entry.mjs'), "export const dataFile = 'runtime.json';");
    const closure = collectImportClosure({ root, entries: ['entry.mjs'] });
    expect(closure.complete).toBe(true);
    expect(decideSkipRebuild({ closure, changedFiles: [path] }).skip).toBe(false);
    expect(decideSkipRebuild({ closure, changedFiles: ['docs/a.md'] }).skip).toBe(true);
  });

it.each([false, true])('missing hop-zero roots are incomplete (stopWhenIncomplete=%s)', stopWhenIncomplete => {
  const { root } = fixture();
  writeFileSync(join(root, 'readable.mjs'), 'export {};');
  const options = { root, entries: ['readable.mjs', 'missing.mjs'], byName: () => [], stopWhenIncomplete };
  const closure = collectRunClosure(options);
  expect(closure).toBeNull();
  expect(decideSkipRebuild({ closure, changedFiles: ['scripts/unrelated.mjs'] }).skip).toBe(false);
  expect(decideSkipRebuild({ closure, changedFiles: ['docs/a.md'] }).skip).toBe(true);
  writeFileSync(join(root, 'missing.mjs'), 'export {};');
  expect(collectRunClosure(options).complete).toBe(true);
});

it.each(['js', 'mjs', 'cjs'])('a changed required dependency remains relevant: %s', extension => {
  const f = fixture();
  const { root } = f;
  for (const entry of DAEMON_ENTRY_MODULES) {
    mkdirSync(dirname(join(root, entry)), { recursive: true });
    writeFileSync(join(root, entry), 'export {};');
  }
  for (const source of ["require('./dep.js');", "const load = require; load('./dep.js');",
    "import { createRequire as make } from 'node:module'; const load = make(import.meta.url); load('./dep.js');",
    String.raw`const load = requ\u0069re; load('./dep.js');`]) {
    writeFileSync(join(root, `worker.${extension}`), source);
    writeFileSync(join(root, 'dep.js'), 'module.exports = 1;');
    for (const mode of ['entry', 'imported', 'spawned', ...(extension === 'cjs' ? [] : ['discovered', 'LaunchAgent'])]) {
      writeFileSync(join(root, 'entry.mjs'), mode === 'imported'
        ? `import './worker.${extension}';` : `spawn(process.execPath, ['./worker.${extension}']);`);
      let entries = mode === 'discovered' ? cloneRuntimeEntries({ ...f, entries: [`worker.${extension}`] })
        : [mode === 'entry' ? `worker.${extension}` : 'entry.mjs'];
      if (mode === 'LaunchAgent') {
        const plist = join(f.launchAgentsDir, 'org.example.worker.plist');
        writeFileSync(plist, 'plist');
        entries = cloneRuntimeEntries({ ...f, run: () => ({ status: 0, stdout: plistJSON(f, {
          ProgramArguments: ['node', join(root, `worker.${extension}`)],
        }) }) });
        rmSync(plist);
      }
      const closure = mode === 'spawned' ? collectRunClosure({ root, entries, byName: () => [] })
        : collectImportClosure({ root, entries });
      const hits = closureHits({ closure, changedFiles: ['dep.js'] });
      expect(hits === null || hits.includes('dep.js')).toBe(true);
    }
  }
});

it.each(['boot entry', 'mapped pass'])('refuses CommonJS targets for default boot and manifest-mapped roots: %s', source => {
  const f = fixture();
  const entry = source === 'boot entry' ? DAEMON_ENTRY_MODULES[0] : 'scripts/conveyor/branch-drift.mjs';
  mkdirSync(dirname(join(f.root, entry)), { recursive: true });
  writeFileSync(join(f.root, 'worker.cjs'), "require('./dep.js');");
  symlinkSync(join(f.root, 'worker.cjs'), join(f.root, entry));
  if (source === 'mapped pass') writeFileSync(join(f.launchAgentsDir, 'com.we.pass.plist'), 'plist');
  expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0, stdout: plistJSON(f, {
    ProgramArguments: ['node', join(f.root, 'skills-src/conveyor/pass-daemon.mjs'), '--pass=branch-drift'],
  }) }) })).toThrow('CommonJS runtime entry unsupported');
});

it.each(['absent', 'clone', 'subdirectory', 'external'])(
  'refuses a missing bare Node entry with WorkingDirectory=%s', cwd => {
    const f = fixture();
    writeFileSync(join(f.launchAgentsDir, 'com.we.bare.plist'), 'plist');
    const WorkingDirectory = { clone: f.root, subdirectory: join(f.root, 'scripts'), external: f.dir }[cwd];
    expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0, stdout: JSON.stringify({
      WorkingDirectory, ProgramArguments: ['node', 'runner'],
    }) }) })).toThrow();
  });

it.each([
  [1, false], [1, true], [2, false], [2, true],
])('a tracked-but-deleted spawn target at hop %i is incomplete (stopWhenIncomplete=%s)', (hop, stopWhenIncomplete) => {
  const { root } = fixture();
  mkdirSync(join(root, 'scripts'));
  const spawns = "spawn(process.execPath, ['./child.mjs', './ghost.mjs']);\n";
  writeFileSync(join(root, 'scripts/d.mjs'), hop === 1 ? spawns : "spawn(process.execPath, ['./launcher.mjs']);\n");
  if (hop === 2) writeFileSync(join(root, 'scripts/launcher.mjs'), spawns);
  writeFileSync(join(root, 'scripts/child.mjs'), "import './grand.mjs';\n");
  writeFileSync(join(root, 'scripts/grand.mjs'), 'export {};\n');
  writeFileSync(join(root, 'scripts/ghost.mjs'), 'export {};\n');
  // Model git ls-files retaining a deleted worktree target without writing a Git index.
  const byName = vi.fn(name => name === 'ghost.mjs' ? ['scripts/ghost.mjs'] : []);
  rmSync(join(root, 'scripts/ghost.mjs'));

  const closure = collectRunClosure({ root, entries: ['scripts/d.mjs'], byName, stopWhenIncomplete });
  expect(byName).toHaveBeenCalledWith('ghost.mjs');
  expect(decideSkipRebuild({ closure, changedFiles: ['scripts/grand.mjs'] }).skip).toBe(false);
  expect(closure.complete).toBe(false);
  expect(closure.files).toContain('scripts/d.mjs');
  if (hop === 2) expect(closure.files).toContain('scripts/launcher.mjs');
  expect(closure.spawnedNames).toContain('ghost.mjs');
  expect(decideSkipRebuild({ closure, changedFiles: ['scripts/unrelated.mjs'] }).skip).toBe(false);
  expect(decideSkipRebuild({ closure, changedFiles: ['docs/a.md'] }).skip).toBe(true);

  // A fresh walk after the missing target returns must recover normal filtering.
  writeFileSync(join(root, 'scripts/ghost.mjs'), 'export {};\n');
  const recovered = collectRunClosure({ root, entries: ['scripts/d.mjs'], byName, stopWhenIncomplete });
  expect(recovered.complete).toBe(true);
  expect(recovered.files).toContain('scripts/grand.mjs');
  expect(decideSkipRebuild({ closure: recovered, changedFiles: ['scripts/grand.mjs'] }).skip).toBe(false);
  expect(decideSkipRebuild({ closure: recovered, changedFiles: ['scripts/unrelated.mjs'] }).skip).toBe(true);
});

it.each(['caller', 'LaunchAgent', 'mapped pass', 'boot entry', 'dangling caller symlink'])(
  'keeps the closure consumer conservative for a missing %s alongside readable entries', source => {
    const f = fixture();
    for (const entry of DAEMON_ENTRY_MODULES) {
      mkdirSync(dirname(join(f.root, entry)), { recursive: true });
      writeFileSync(join(f.root, entry), 'export {};');
    }
    const alias = join(f.dir, 'alias');
    symlinkSync(f.root, alias);
    let missing = 'absent/worker.mjs';
    let entries = [];
    let args;
    if (source === 'caller') entries = [join(alias, missing)];
    if (source === 'dangling caller symlink') {
      missing = 'dangling.mjs';
      symlinkSync('absent-target.mjs', join(f.root, missing));
      entries = [missing];
    }
    if (source === 'LaunchAgent') args = ['node', join(alias, missing)];
    if (source === 'mapped pass') {
      missing = 'scripts/conveyor/branch-drift.mjs';
      args = ['node', join(alias, 'skills-src/conveyor/pass-daemon.mjs'), '--pass=branch-drift'];
    }
    if (source === 'boot entry') {
      missing = DAEMON_ENTRY_MODULES[0];
      rmSync(join(f.root, missing));
    }
    if (args) writeFileSync(join(f.launchAgentsDir, 'com.we.missing.plist'), 'plist');
    const runtimeEntries = cloneRuntimeEntries({ ...f, entries,
      run: () => ({ status: 0, stdout: plistJSON(f, { ProgramArguments: args }) }),
    });
    expect(runtimeEntries).toContain(missing);
    const closure = collectImportClosure({ root: f.root, entries: runtimeEntries });
    // A readable sibling must never turn absent runtime evidence into "unrelated".
    expect(closureHits({ closure, changedFiles: ['scripts/changed-dependency.mjs'] })).toBeNull();
    expect(closure).toBeNull();
  });

it('collects a complete clone closure only when every retained runtime entry is readable', () => {
  const f = fixture();
  for (const entry of [...DAEMON_ENTRY_MODULES, 'scripts/caller.mjs']) {
    mkdirSync(dirname(join(f.root, entry)), { recursive: true });
    writeFileSync(join(f.root, entry), 'export {};');
  }
  const entries = cloneRuntimeEntries({ ...f, entries: ['scripts/caller.mjs'] });
  const closure = collectImportClosure({ root: f.root, entries });
  expect(closure.complete).toBe(true);
  expect(closure.files).toEqual(new Set(entries));
  expect(closureHits({ closure, changedFiles: ['scripts/unrelated.mjs'] })).toEqual([]);
  const unreadable = collectImportClosure({ root: f.root, entries,
    readFile() { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
  });
  expect(unreadable.complete).toBe(false);
  expect(closureHits({ closure: unreadable, changedFiles: ['scripts/unrelated.mjs'] })).toBeNull();
});

it('unions clone-realpath LaunchAgents, mapped passes, caller entries and boot entries', () => {
  const f = fixture();
  const real = realpathSync(f.root);
  const alias = join(f.dir, 'alias');
  symlinkSync(f.root, alias);
  const programs = {
    'com.we.drain.plist': ['/usr/bin/node', join(real, 'scripts/drain.mjs')],
    'com.plateau.pass.plist': ['/usr/bin/node', join(real, 'skills-src/conveyor/pass-daemon.mjs'), '--pass=branch-drift'],
    'com.webeverything.other.plist': ['/usr/bin/node', `${real}-other/foreign.mjs`],
    'org.other.plist': ['/usr/bin/node', join(real, 'other-label.mjs')],
  };
  for (const name of Object.keys(programs)) writeFileSync(join(f.launchAgentsDir, name), 'plist');
  const calls = [];
  const result = cloneRuntimeEntries({ ...f, root: alias, entries: ['scripts/caller.mjs', 'scripts/drain.mjs'],
    run(bin, args, opts) {
      calls.push([bin, args, opts]);
      return { status: 0, stdout: plistJSON(f, { ProgramArguments: programs[args.at(-1).split('/').at(-1)] }) };
    },
  });
  expect(new Set(result)).toEqual(new Set([...DAEMON_ENTRY_MODULES, 'scripts/drain.mjs',
    'skills-src/conveyor/pass-daemon.mjs', 'scripts/conveyor/branch-drift.mjs', 'scripts/caller.mjs', 'other-label.mjs']));
  expect(calls).toHaveLength(4);
  expect(calls[0][0]).toBe('plutil');
  expect(calls[0][1].slice(0, 5)).toEqual(['-convert', 'json', '-o', '-', '--']);
  expect(calls[0][2].timeout).toBeGreaterThan(0);
  expect(calls[0][2].maxBuffer).toBeGreaterThan(0);
});

it('throws on unreadable LaunchAgents directory instead of silently narrowing entries', () => {
  const f = fixture();
  expect(() => cloneRuntimeEntries({ ...f, launchAgentsDir: join(f.dir, 'missing') })).toThrow();
});

it('discovers aliased LaunchAgent and caller entries and mapped passes while excluding external paths', () => {
  const f = fixture();
  const alias = join(f.dir, 'alias');
  symlinkSync(f.root, alias);
  mkdirSync(join(f.root, 'scripts'));
  writeFileSync(join(f.root, 'scripts', 'worker.mjs'), 'export {};');
  const external = join(f.dir, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'foreign.mjs'), 'export {};');
  symlinkSync(external, join(f.root, 'external-link'));
  symlinkSync(join(f.root, 'scripts', 'worker.mjs'), join(f.dir, 'worker-alias.mjs'));
  const programs = {
    'com.we.worker.plist': ['node', join(alias, 'scripts/worker.mjs')],
    'com.we.pass.plist': ['node', join(alias, 'skills-src/conveyor/pass-daemon.mjs'), '--pass=branch-drift'],
    'com.we.file-alias.plist': ['node', join(f.dir, 'worker-alias.mjs')],
    'com.we.external.plist': ['node', join(alias, 'external-link/foreign.mjs')],
    'com.we.prefix.plist': ['node', `${realpathSync(f.root)}-other/foreign.mjs`],
  };
  for (const name of Object.keys(programs)) writeFileSync(join(f.launchAgentsDir, name), 'plist');
  const run = (_bin, args) => ({ status: 0,
    stdout: plistJSON(f, { ProgramArguments: programs[args.at(-1).split('/').at(-1)] }) });
  for (const root of [f.root, alias]) {
    expect(new Set(cloneRuntimeEntries({ ...f, root, run })))
      .toEqual(new Set([...DAEMON_ENTRY_MODULES, 'scripts/worker.mjs',
        'skills-src/conveyor/pass-daemon.mjs', 'scripts/conveyor/branch-drift.mjs']));
    expect(cloneRuntimeEntries({ ...f, root, entries: [join(alias, 'scripts/caller.mjs')], run }))
      .toContain('scripts/caller.mjs');
  }
  expect(() => cloneRuntimeEntries({ ...f, entries: [join(alias, 'external-link/foreign.mjs')], run }))
    .toThrow('runtime entry outside clone');
});

it('discovers entries in the supplied environment HOME without changing the process HOME', () => {
  const f = fixture();
  const home = join(f.dir, 'home');
  const agents = join(home, 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'com.we.isolated.plist'), 'plist');
  const ambientHome = process.env.HOME;
  const calls = [];
  const result = cloneRuntimeEntries({ root: f.root, env: { HOME: home },
    run(bin, args) {
      calls.push(args.at(-1));
      return { status: 0, stdout: plistJSON(f, {
        ProgramArguments: ['node', join(realpathSync(f.root), 'isolated.mjs')],
      }) };
    },
  });
  expect(result).toContain('isolated.mjs');
  expect(calls).toEqual([join(agents, 'com.we.isolated.plist')]);
  expect(process.env.HOME).toBe(ambientHome);
});

it('fails closed on a cyclic LaunchAgent path instead of silently omitting it', () => {
  const f = fixture();
  symlinkSync('cycle', join(f.root, 'cycle'));
  writeFileSync(join(f.launchAgentsDir, 'com.we.cycle.plist'), 'plist');
  expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: plistJSON(f, { ProgramArguments: ['node', join(f.root, 'cycle/worker.mjs')] }),
  }) })).toThrow();
});

it('fails closed when the supplied HOME has no readable LaunchAgents directory', () => {
  const f = fixture();
  let spawned = false;
  expect(() => cloneRuntimeEntries({ root: f.root, env: { HOME: join(f.dir, 'missing-home') },
    run() { spawned = true; },
  })).toThrow();
  expect(spawned).toBe(false);
});

it.each([
  { status: 1, stdout: '' }, { status: 0, stdout: '{' },
  { status: 0, stdout: '{}' }, { status: 0, stdout: '{"ProgramArguments":[42]}' },
])('throws on unreadable or malformed plist: %j', response => {
  const f = fixture();
  writeFileSync(join(f.launchAgentsDir, 'com.we.bad.plist'), 'bad');
  expect(() => cloneRuntimeEntries({ ...f, run: () => response })).toThrow();
});

it('refuses an unknown pass for this clone', () => {
  const f = fixture();
  writeFileSync(join(f.launchAgentsDir, 'com.we.pass.plist'), 'plist');
  expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: plistJSON(f, { ProgramArguments: ['node', join(realpathSync(f.root), 'skills-src/conveyor/pass-daemon.mjs'), '--pass=unknown'] }),
  }) })).toThrow();
});

it.each([{ passes: [] }, { passes: ['--pass=branch-drift', '--pass=branch-drift'] },
  { passes: ['--pass=branch-drift', '--pass=review'] }])(
  'refuses pass-daemon with missing or duplicate pass flags: %j', ({ passes }) => {
    const f = fixture();
    writeFileSync(join(f.launchAgentsDir, 'com.we.pass.plist'), 'plist');
    expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
      stdout: plistJSON(f, { ProgramArguments: ['node', join(f.root, 'skills-src/conveyor/pass-daemon.mjs'), ...passes] }),
    }) })).toThrow('LaunchAgents pass unknown');
  });

it('permits Program equal to ProgramArguments[0]', () => {
  const f = fixture();
  writeFileSync(join(f.launchAgentsDir, 'com.we.program.plist'), 'plist');
  expect(cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: plistJSON(f, { Program: '/usr/bin/node', ProgramArguments: ['/usr/bin/node', join(f.root, 'worker.mjs')] }),
  }) })).toContain('worker.mjs');
});

it.each(['--no-warnings', '--enable-source-maps', '--trace-warnings'])(
  'permits script arguments after an entry preceded by safe boolean Node flag %s', flag => {
    const f = fixture();
    writeFileSync(join(f.launchAgentsDir, 'com.we.flags.plist'), 'plist');
    for (const prefix of [['node'], ['/usr/bin/env', 'node']]) {
      for (const argument of ['-e', '-pe', '--eval=1']) {
        expect(cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
          stdout: plistJSON(f, { ProgramArguments: [...prefix, flag, join(f.root, 'worker.mjs'), argument] }),
        }) })).toContain('worker.mjs');
      }
    }
  });

it.each(['caller', 'LaunchAgent', 'relative LaunchAgent', 'aliased caller', 'aliased LaunchAgent', 'cjs alias to ESM'])(
  'refuses a CommonJS runtime root from %s until require graphs are supported', source => {
    const f = fixture();
    writeFileSync(join(f.root, 'worker.cjs'), "require('./dep.js');\n");
    writeFileSync(join(f.root, 'dep.js'), 'module.exports = 1;\n');
    let entry = join(f.root, 'worker.cjs');
    if (source === 'aliased LaunchAgent' || source === 'aliased caller') {
      entry = join(f.root, 'worker.mjs');
      symlinkSync('worker.cjs', entry);
    }
    if (source === 'cjs alias to ESM') {
      writeFileSync(join(f.root, 'esm.mjs'), 'export {};\n');
      rmSync(entry);
      symlinkSync('esm.mjs', entry);
    }
    if (source === 'relative LaunchAgent') entry = 'worker.cjs';
    const caller = source === 'caller' || source === 'aliased caller';
    if (!caller) writeFileSync(join(f.launchAgentsDir, 'com.we.cjs.plist'), 'plist');
    expect(() => cloneRuntimeEntries({ ...f, entries: caller ? [entry] : [],
      run: () => ({ status: 0, stdout: plistJSON(f, { ProgramArguments: ['node', entry] }) }),
    })).toThrow('CommonJS runtime entry unsupported');
  });

it.each(['scripts/daemon.mjs', './daemon.js', 'daemon.ts', 'relative/runner', '.', '..',
  'daemon.mts', 'daemon.py', 'daemon.cts', 'daemon.tsx', '--import=./x', '--import=package',
  '--require=./x', '--loader=./x', '--experimental-loader=./x',
  '--import', '--require', '--loader', '--experimental-loader', '-r./relative-module.cjs', '-rpackage', '-r',
  '--eval=import("./scripts/hidden.mjs")', '--eval', '-e', '-e=1', '--print', '-p', '--print=1', '--input-type=module', '-pe', '-ep', '-pe=1',
  '--experimental_loader=./x.mjs', '--env-file=.env', '--some-future-flag'])(
  'refuses an unsupported LaunchAgent entrypoint/module argument: %s', entry => {
    const f = fixture();
    writeFileSync(join(f.launchAgentsDir, 'com.we.relative.plist'), 'plist');
    expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
      stdout: plistJSON(f, { ProgramArguments: ['/usr/bin/env', 'node', entry] }),
    }) })).toThrow(`LaunchAgents unsupported entrypoint/module argument refused: com.we.relative.plist: ${entry}`);
  });

it.each(['runner', 'daemon.mts', 'daemon.py'])('refuses an existing unsupported clone file: %s', entry => {
  const f = fixture();
  writeFileSync(join(f.root, entry), 'entrypoint');
  writeFileSync(join(f.launchAgentsDir, 'com.we.file.plist'), 'plist');
  const alias = join(f.dir, 'alias');
  symlinkSync(f.root, alias);
  for (const arg of [entry, join(realpathSync(f.root), entry)]) {
    expect(() => cloneRuntimeEntries({ ...f, root: alias, run: () => ({ status: 0,
      stdout: plistJSON(f, { ProgramArguments: ['/usr/bin/env', 'node', arg] }),
    }) })).toThrow(`LaunchAgents unsupported entrypoint/module argument refused: com.we.file.plist: ${arg}`);
  }
});

it.each([
  ['worker.mjs', 'worker.py'],
  ['worker.py', 'worker.mjs'],
])('refuses an absolute clone symlink with an unsupported argument or target extension: %s -> %s', (entry, target) => {
  const f = fixture();
  writeFileSync(join(f.root, target), 'entrypoint');
  const arg = join(f.root, entry);
  symlinkSync(target, arg);
  writeFileSync(join(f.launchAgentsDir, 'com.we.symlink.plist'), 'plist');
  expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: plistJSON(f, { ProgramArguments: ['node', arg] }),
  }) })).toThrow(`LaunchAgents unsupported entrypoint/module argument refused: com.we.symlink.plist: ${arg}`);
});

it('refuses a node flag that takes a script-shaped value (then eval)', () => {
  const f = fixture();
  writeFileSync(join(f.launchAgentsDir, 'com.we.title.plist'), 'plist');
  expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: plistJSON(f, { ProgramArguments: ['/usr/bin/env', 'node', '--title', '/tmp/title.js', '-e', 'console.log(43)'] }),
  }) })).toThrow('LaunchAgents unsupported entrypoint/module argument refused: com.we.title.plist: --title');
});

it.each([
  [{ ProgramArguments: ['node', '/tmp/x.mjs'], Program: '/bin/sh' }, 'Program differs'],
  [{ ProgramArguments: ['node', '/tmp/x.mjs'], EnvironmentVariables: { NODE_OPTIONS: '--import=./x.mjs' } }, 'NODE_*'],
  [{ ProgramArguments: ['/bin/sh', '-c', 'node -e "$CODE"'] }, 'interpreter sh'],
  [{ ProgramArguments: ['/usr/bin/env', 'python3', 'x.py'] }, 'interpreter python3'],
])('refuses launchd inputs that hide executable code: %j', (plist, why) => {
  const f = fixture();
  writeFileSync(join(f.launchAgentsDir, 'com.we.hidden.plist'), 'plist');
  expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0, stdout: plistJSON(f, plist) }) }))
    .toThrow(`LaunchAgents unsupported dynamic execution refused: com.we.hidden.plist: ${why}`);
});

it('refuses --import=./x even when its target exists in the clone', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'x'), 'export {};');
  writeFileSync(join(f.launchAgentsDir, 'com.we.loader.plist'), 'plist');
  expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: plistJSON(f, { ProgramArguments: ['node', '--import=./x'] }),
  }) })).toThrow('LaunchAgents unsupported entrypoint/module argument refused: com.we.loader.plist: --import=./x');
});

it('fails closed on non-ENOENT filesystem errors for a bare argument', () => {
  const f = fixture();
  symlinkSync('runner', join(f.root, 'runner'));
  writeFileSync(join(f.launchAgentsDir, 'com.we.cycle.plist'), 'plist');
  expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: plistJSON(f, { ProgramArguments: ['node', 'runner'] }),
  }) })).toThrow(expect.objectContaining({ code: 'ELOOP' }));
});

it('R230 permits bare interpreters, option flags and numeric argument tokens', () => {
  const f = fixture();
  writeFileSync(join(f.launchAgentsDir, 'com.we.tokens.plist'), 'plist');
  expect(new Set(cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: plistJSON(f, { ProgramArguments: ['/usr/bin/env', 'node', join(f.root, 'worker.mjs'), '--pass=x', '--pass=',
      '--repo=owner/repo', '--path=relative/file.js', '42'] }),
  }) }))).toEqual(new Set([...DAEMON_ENTRY_MODULES, 'worker.mjs']));
});

it('permits --repo=owner/repo on a LaunchAgent with an absolute entrypoint', () => {
  const f = fixture();
  writeFileSync(join(f.launchAgentsDir, 'com.we.postmortem.plist'), 'plist');
  const entry = 'scripts/conveyor/pass-daemons/pr-postmortem-pass.mjs';
  expect(new Set(cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: plistJSON(f, { ProgramArguments: ['node', join(f.root, entry), '--repo=owner/repo', '--watch'] }),
  }) }))).toEqual(new Set([...DAEMON_ENTRY_MODULES, entry]));
});

it('permits node paths, absolute scripts, plain flags, pass names and numeric argument tokens', () => {
  const f = fixture();
  for (const entry of ['worker.mjs', 'worker.js']) writeFileSync(join(f.root, entry), 'export {};');
  writeFileSync(join(f.launchAgentsDir, 'com.we.tokens.plist'), 'plist');
  expect(new Set(cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
    stdout: plistJSON(f, { ProgramArguments: ['/usr/bin/env', 'node', '/usr/bin/node',
      join(f.root, 'worker.mjs'), join(f.root, 'worker.js'), '-e', '--no-warnings', '--pass=NAME', '42'] }),
  }) }))).toEqual(new Set([...DAEMON_ENTRY_MODULES, 'worker.mjs', 'worker.js']));
});

it('refuses an extensionless in-clone LaunchAgent script entry instead of silently omitting it', () => {
  const f = fixture();
  mkdirSync(join(f.root, 'scripts'));
  writeFileSync(join(f.root, 'scripts', 'some-daemon'), 'entrypoint');
  writeFileSync(join(f.launchAgentsDir, 'com.we.ext.plist'), 'plist');
  for (const arg of [join(realpathSync(f.root), 'scripts/some-daemon'), 'scripts/some-daemon']) {
    expect(() => cloneRuntimeEntries({ ...f, run: () => ({ status: 0,
      stdout: plistJSON(f, { ProgramArguments: ['/usr/bin/node', arg] }),
    }) })).toThrow(`LaunchAgents unsupported entrypoint/module argument refused: com.we.ext.plist: ${arg}`);
  }
});
