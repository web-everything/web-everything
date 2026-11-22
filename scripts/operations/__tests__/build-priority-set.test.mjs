import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { importGraph } from './import-graph.mjs';
import { createBuildPrioritySet, readPriorityCards, readPriorityPrs } from '../build-priority-set-io.mjs';
import { resolveOperation } from '../run.mjs';
import { hasJsonFlag, runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { createRegistry } from '../registry.mjs';
import { decideRuntimeAdmission, readBuildPrioritySettings } from '../../lib/build-queue.mjs';
import { TRUST_CHAIN } from '../../lib/gate-config.mjs';

const dirs = [];
const at = '2026-11-20T12:00:00.000Z';
const flags = ['--ids=42,43', '--mode=only', '--ttl-hours=2', '--actor=operator', '--reason=priority call'];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture({ allowedFiles = ['scripts/conveyor/a.mjs', 'scripts/conveyor/a.test.mjs', 'scripts/conveyor/pr-stall-sweep.mjs', 'scripts/conveyor/renamed.mjs'], ...overrides } = {}, createOperation = createBuildPrioritySet) {
  const dir = fs.mkdtempSync(join(process.env.TMPDIR, 'build-priority-set-')); dirs.push(dir);
  const path = join(dir, 'build-priority.runtime.json');
  const settingsDir = fs.mkdtempSync(join(process.env.TMPDIR, 'priority-scope-')); dirs.push(settingsDir);
  const scopeSettingsPath = join(settingsDir, 'scope.json');
  fs.writeFileSync(scopeSettingsPath, JSON.stringify({ allowedFiles: allowedFiles.filter(file => /\.(mjs|js|ts|json|md|sh|yml|yaml|css|html)$/i.test(file)).concat('scripts/conveyor/a.mjs') }));
  const readCard = vi.fn(() => ({ scope: ['we:scripts/conveyor/a.mjs', 'we:scripts/conveyor/a.test.mjs'] }));
  const readPrs = vi.fn(() => []);
  const options = { env: { WE_BUILD_PRIORITY_RUNTIME_FILE: path }, readCard, readPrs, pathType: () => 'file', readContent: () => 'export {};\n', scopeSettingsPath, now: () => new Date(at), ...overrides };
  const command = async (argv = flags) => {
    const operation = createOperation(options);
    const registry = createRegistry(); registry.register(operation.declaration);
    const outcome = await runOperationCli({ ...operation, registry, argv,
      store: createMemoryRunStore(), newRunId: () => 'priority-test' });
    return { ...outcome, ...operation.finish({ ...outcome, json: hasJsonFlag(argv) }) };
  };
  return { dir, path, options, command, readCard, readPrs };
}
const changed = (flag, value) => [...flags.filter(s => !s.startsWith(`--${flag}=`)), ...(value === undefined ? [] : [`--${flag}=${value}`])];
function untouched(f, names = []) { expect(fs.readdirSync(f.dir).sort()).toEqual(names.sort()); }

// Use the existing test-only graph witness; production admission never scans imports.
const guardDependencies = importGraph(resolve('scripts/operations/build-priority-set-io.mjs')).files
  .map(file => relative(process.cwd(), file));
it.each(guardDependencies)(
  'refuses guard dependency %s and relocated basenames without writing a runtime file', async dependency => {
    for (const path of new Set([dependency, `scripts/lib/${basename(dependency)}`, `scripts/conveyor/${basename(dependency)}`])) {
      for (const prefix of ['we:', 'fui:']) {
        const scope = `${prefix}${path}`;
        for (const preview of [false, true]) {
          const f = fixture({ allowedFiles: [scope.replace(/^[^:]+:/, '')], readCard: () => ({ scope: [scope] }) });
          const result = await f.command([...flags, ...(preview ? ['--preview'] : [])]);
          expect(result.code, scope).not.toBe(0);
          expect(result.lines.join('\n')).toContain(`card 42 scope entry ${JSON.stringify(scope)}`);
          if (prefix === 'we:' && /\.(?:mjs|js|ts|json|md|sh|yml|yaml|css|html)$/.test(path)) {
            expect(result.lines.join('\n')).toMatch(/overlaps gate file/);
          }
          expect(f.readPrs).not.toHaveBeenCalled();
          untouched(f);
        }
      }
    }
  });

it.each(['runtime-admission.mjs', 'audit-settings.mjs', 'audit-path.mjs', 'build-policy.mjs', 'build-queue.mjs']
  .flatMap(name => ['scripts/lib/', 'scripts/conveyor/', 'scripts/conveyor/nested/']
    .flatMap(dir => [`we:${dir}${name}`, `WE:${dir.toUpperCase()}${name.toUpperCase()}`])))(
  'refuses execution control path and relocated basename %s in preview and install', async scope => {
    for (const preview of [false, true]) {
      const f = fixture({ allowedFiles: [scope.replace(/^[^:]+:/, '')], readCard: () => ({ scope: [scope] }) });
      const result = await f.command([...flags, ...(preview ? ['--preview'] : [])]);
      expect(result.code).not.toBe(0);
      expect(result.lines.join('\n')).toContain(`card 42 scope entry ${JSON.stringify(scope)} overlaps gate file`);
      expect(f.readPrs).not.toHaveBeenCalled();
      untouched(f);
    }
  });

const protectedScopes = [
  ...TRUST_CHAIN.flatMap(member => [...member.homes, `scripts/lib/${member.file}`]),
  'scripts/lib/GATE-config.mjs', 'SCRIPTS/LIB/gate-config.mjs',
  ...['package.json', 'vitest.config.ts', 'vitest.unit.config.mjs', 'vitest.config.unit.ts', 'setup.mjs',
    'test-setup.ts', 'vitest.setup.json', 'cli-adapter.mjs', 'engine.mjs', 'effect-executor.mjs',
    'build-priority-set-io.mjs', 'build-priority-set.mjs', 'build-priority-set.test.mjs',
    'build-priority-set-io-real.test.mjs'].map(name => `scripts/lib/${name}`),
  'scripts/operations/build-priority-set-io.mjs', 'scripts/operations/build-priority-set.mjs',
  'scripts/operations/__tests__/build-priority-set.test.mjs',
  'scripts/operations/__tests__/build-priority-set-io-real.test.mjs',
];
it.each(['we:', 'fui:'].flatMap(prefix => protectedScopes.map(path => `${prefix}${path}`)))(
  'refuses protected scope %s in preview and install', async scope => {
    for (const preview of [false, true]) {
      const f = fixture({ allowedFiles: ['scripts/conveyor/a.mjs', scope.replace(/^[^:]+:/, '')], readCard: id => ({ scope: id === '43' ? [scope] : ['we:scripts/conveyor/a.mjs'] }) });
      const result = await f.command([...flags, ...(preview ? ['--preview'] : [])]);
      expect(result.code).not.toBe(0);
      expect(result.lines.join('\n')).toContain(`card 43 scope entry ${JSON.stringify(scope)}`);
      expect(result.lines.join('\n')).toMatch(scope.startsWith('we:') ? /overlaps gate file/ : /must be an exact file path/);
      expect(f.readPrs).not.toHaveBeenCalled();
      untouched(f);
    }
  });

it.each(['we:', 'fui:'].flatMap(prefix => ['scripts/conveyor/unlisted.mjs', 'scripts/operations/x.mjs', 'backlog/1.md',
  'scripts/library/a.mjs', 'scripts/lib/anything.mjs'].map(path => `${prefix}${path}`)))(
  'refuses scope outside named-file allowlist %s', async scope => {
    const f = fixture({ readCard: () => ({ scope: [scope] }) });
    const result = await f.command();
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain(`card 42 scope entry ${JSON.stringify(scope)}`);
    expect(result.lines.join('\n')).toMatch(scope.startsWith('we:') ? /outside allowedFiles/ : /must be an exact file path/);
    untouched(f);
  });

it.each(['directory', 'missing', 'symlink', undefined, 'unreadable'].flatMap(type =>
  ['we:', 'fui:'].map(prefix => [type, `${prefix}scripts/conveyor/relocated.mjs`])))(
  'refuses %s tree evidence for %s', async (type, scope) => {
    const f = fixture({ allowedFiles: ['scripts/conveyor/relocated.mjs'], readCard: () => ({ scope: [scope] }), pathType: () => {
      if (type === 'unreadable') throw new Error('git unavailable');
      return type;
    } });
    const result = await f.command();
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain(`card 42 scope entry ${JSON.stringify(scope)}`);
    expect(result.lines.join('\n')).toMatch(scope.startsWith('we:') ? /not a readable regular file on origin\/main/ : /must be an exact file path/);
    untouched(f);
  });

it('refuses a root directory named relocated.mjs outside the allowlist', async () => {
  const f = fixture({ readCard: () => ({ scope: ['we:relocated.mjs'] }), pathType: () => 'directory' });
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(result.lines.join('\n')).toContain('card 42 scope entry "we:relocated.mjs" outside allowedFiles');
  untouched(f);
});

it.each(['missing', 'unreadable', '', '{', '{}', 'null', '{"allowedDirs":["scripts/conveyor/"]}',
  '{"allowedFiles":[]}', '{"allowedFiles":"scripts/a.mjs"}',
  '{"allowedDirs":[],"allowedFiles":["scripts/a.mjs"]}',
  ...[null, 42, '', 'scripts/conveyor/', 'scripts/lib', '/scripts/a.mjs', 'scripts//a.mjs',
    'scripts/../a.mjs', 'scripts/./a.mjs', 'scripts/.hidden/a.mjs', 'scripts/lib.v2/a.mjs',
    'scripts/*.mjs', 'scripts/a?.mjs', 'scripts/[a].mjs', 'scripts/{a,b}.mjs',
    'scripts/a.mjs ', 'scripts/a.mjs\\x', 'we:scripts/a.mjs', 'scripts/a.exe', 'scripts/.a.mjs',
    'scripts/a.mjs\n'].map(file => JSON.stringify({ allowedFiles: [file] })),
])('refuses missing, unreadable or malformed scope settings %j', async contents => {
  const f = fixture();
  const settingsPath = join(f.dir, 'scope.json');
  f.options.scopeSettingsPath = settingsPath;
  if (contents === 'unreadable') fs.mkdirSync(settingsPath);
  else if (contents !== 'missing') fs.writeFileSync(settingsPath, contents);
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(result.lines.join('\n')).toMatch(/scope settings.*repair evidence.*retry/);
  expect(f.readPrs).not.toHaveBeenCalled();
  untouched(f, contents === 'missing' ? [] : ['scope.json']);
});

it.each(['we:', 'plateau:', 'fui:', 'frontierui:', 'webeverything:', 'plateau-app:', 'pa:'].flatMap(prefix =>
  [
    ['directory with trailing slash', 'scripts/'], ['bare repo prefix', ''],
    ['star glob', 'scripts/*.mjs'], ['recursive glob', 'scripts/**'],
    ['question glob', 'scripts/a?.mjs'], ['bracket glob', 'scripts/[a].mjs'],
    ['brace glob', 'scripts/{a,b}.mjs'],
    ['dotted directory without extension', 'relocated.v2'],
    ['dotted directory with source extension', 'relocated.mjs/x.mjs'],
    ['dotted directory with version', 'relocated.v2/x.mjs'],
    ['dot-directory segment', 'scripts/.hidden/x.mjs'], ['hidden final segment', 'scripts/.x.mjs'],
    ['no extension', 'scripts/Makefile'], ['unknown extension', 'scripts/a.exe'],
    ['parent segment', 'scripts/../a.mjs'], ['current segment', 'scripts/./a.mjs'],
    ['empty segment', 'scripts//a.mjs'], ['absolute path', '/scripts/a.mjs'],
    ['whitespace and comma mixed', 'scripts/a.mjs, we:scripts/b.mjs'],
    ['whitespace', 'scripts/a.mjs scripts/b.mjs'], ['trailing whitespace', 'scripts/a.mjs '], ['newline', 'scripts/a.mjs\n'],
    ['backslash', 'scripts/\\a.mjs'],
  ].map(([shape, path]) => [shape, `${prefix}${path}`]),
))('refuses %s: %s in preview and install', async (_shape, scope) => {
  for (const preview of [false, true]) {
    const f = fixture({ readCard: id => ({ scope: id === '43' ? [scope] : ['we:scripts/conveyor/a.mjs'] }) });
    const result = await f.command([...flags, ...(preview ? ['--preview'] : [])]);
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain(`card 43 scope entry ${JSON.stringify(scope)} must be an exact file path`);
    expect(f.readPrs).not.toHaveBeenCalled();
    untouched(f);
  }
});

it.each(['scripts/a.mjs', 'unknown:scripts/a.mjs'])(
  'refuses an invalid or protected literal %s', async scope => {
    const f = fixture({ readCard: () => ({ scope: [scope] }) });
    const result = await f.command();
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain(`card 42 scope entry ${JSON.stringify(scope)}`);
    untouched(f);
  });

it.each(['we:'])(
  'refuses a non-gate literal scope overlapping an open PR directory in %s', async prefix => {
    const repo = { 'we:': 'web-everything/web-everything', 'fui:': 'frontier-ui/frontierui' }[prefix];
    const f = fixture({ gateFiles: ['scripts/unrelated.mjs'],
      readCard: () => ({ scope: [`${prefix}scripts/conveyor/a.mjs`] }),
      readPrs: vi.fn(() => [{ repo, number: 1, files: ['scripts/conveyor/'] }]) });
    const result = await f.command();
    expect(result.code).not.toBe(0);
    expect(f.options.readPrs).toHaveBeenCalled();
    expect(result.lines.join('\n')).toContain(`scope overlaps open PR ${repo}#1`);
    untouched(f);
  });

it.each([
  ['unreadable', () => { throw new Error('cannot read gates'); }],
  ['empty', []], ['missing', () => undefined], ['malformed', [null]], ['blank', [' ']],
])('refuses %s gate evidence without writing a runtime file', async (_name, gateFiles) => {
  const f = fixture({ gateFiles });
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(result.lines.join('\n')).toMatch(/gate.*repair evidence.*retry/);
  untouched(f);
});

it.each([undefined, [], [42]])('refuses incomplete TRUST_CHAIN homes %j', async homes => {
  const member = TRUST_CHAIN[0], previous = member.homes;
  try {
    member.homes = homes;
    const f = fixture();
    const result = await f.command();
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toMatch(/gate.*repair evidence.*retry/);
    untouched(f);
  } finally { member.homes = previous; }
});

it.each(['we:', 'plateau:', 'fui:'].flatMap(prefix =>
  ['scripts/lib/custom-gate.mjs', 'scripts/conveyor/custom-gate.mjs'].map(path => `${prefix}${path}`),
))('refuses injected gate path or basename %s', async scope => {
  for (const gateFiles of [['scripts/lib/custom-gate.mjs'], () => ['scripts/lib/custom-gate.mjs']]) {
    const f = fixture({ allowedFiles: [scope.replace(/^[^:]+:/, '')], gateFiles, readCard: () => ({ scope: [scope] }) });
    const result = await f.command();
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain(`card 42 scope entry ${JSON.stringify(scope)}`);
    expect(result.lines.join('\n')).toMatch(scope.startsWith('we:') ? /overlaps gate file/ : /must be an exact file path/);
    untouched(f);
  }
});

it('refuses gate evidence that becomes unreadable under the writer lock', async () => {
  const gateFiles = vi.fn().mockReturnValueOnce(['scripts/lib/gate-config.mjs'])
    .mockImplementationOnce(() => { throw new Error('gate list unreadable'); });
  const f = fixture({ gateFiles });
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(gateFiles).toHaveBeenCalledTimes(2);
  expect(result.lines.join('\n')).toContain('unreadable or incomplete gate files');
  untouched(f);
});

it.each([{ gateFiles: ['scripts/unrelated.mjs'] }, { gateFiles: () => ['scripts/unrelated.mjs'] }])(
  'keeps canonical gate protection with unrelated override %j', async ({ gateFiles }) => {
    const f = fixture({ allowedFiles: ['scripts/lib/gate-config.mjs'], gateFiles, readCard: () => ({ scope: ['we:scripts/lib/gate-config.mjs'] }) });
    const result = await f.command();
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toMatch(/scope entry .* overlaps gate file/);
    expect(f.readPrs).not.toHaveBeenCalled();
    untouched(f);
  });

it('rechecks regular-file evidence under the writer lock', async () => {
  const pathType = vi.fn().mockReturnValueOnce('file').mockReturnValueOnce('file').mockReturnValue('directory');
  const f = fixture({ readCard: () => ({ scope: ['we:scripts/conveyor/a.mjs'] }), pathType });
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(pathType).toHaveBeenCalledTimes(3);
  expect(result.lines.join('\n')).toMatch(/card 42 scope entry .* not a readable regular file/);
  untouched(f);
});

it('rechecks scope settings under the writer lock', async () => {
  const f = fixture();
  const path = join(f.dir, 'scope.json');
  fs.writeFileSync(path, '{"allowedFiles":["scripts/conveyor/a.mjs","scripts/conveyor/a.test.mjs"]}');
  f.options.scopeSettingsPath = path;
  f.options.readPrs = () => { fs.unlinkSync(path); return []; };
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(result.lines.join('\n')).toMatch(/scope settings/);
  untouched(f);
});

it.each(['', `100644 blob ${'a'.repeat(40)}\tscripts/conveyor/wrong.mjs\0`,
  `120000 blob ${'a'.repeat(40)}\tscripts/conveyor/a.mjs\0`,
  `100644 blob ${'a'.repeat(40)}\tscripts/conveyor/a.mjs\0`.repeat(2), 'malformed',
])('refuses incomplete or nonregular Git tree evidence %j', evidence => {
  const read = readPriorityCards({ git: args => args[0] === 'rev-parse' ? 'a'.repeat(40) : evidence });
  expect(read.pathType('scripts/conveyor/a.mjs')).not.toBe('file');
});

it('normalizes scope, allowed file and PR paths case-insensitively', async () => {
  const pathType = vi.fn(() => 'file');
  const f = fixture({ readCard: () => ({ scope: ['WE:SCRIPTS/CONVEYOR/A.MJS'] }), pathType,
    readPrs: () => [{ repo: 'web-everything/web-everything', number: 1, files: ['SCRIPTS/CONVEYOR/A.MJS'] }] });
  const path = join(f.dir, 'scope.json');
  fs.writeFileSync(path, '{"allowedFiles":["SCRIPTS/CONVEYOR/A.MJS"]}');
  f.options.scopeSettingsPath = path;
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(pathType).toHaveBeenCalledWith('scripts/conveyor/a.mjs');
  expect(result.lines.join('\n')).toMatch(/scope overlaps open PR/);
  untouched(f, ['scope.json']);
});

it('installs the listed pr-stall-sweep scope with injected content', async () => {
  const f = fixture({ scopeSettingsPath: undefined, readCard: () => ({ scope: ['we:scripts/conveyor/pr-stall-sweep.mjs'] }) });
  expect((await f.command()).code).toBe(0);
  expect(JSON.parse(fs.readFileSync(f.path, 'utf8')).ids).toEqual(['42', '43']);
});

it.each(['guard-1c-mutation-check.mjs', 'build-dispatch-policy.mjs', 'x-gate.mjs', 'merge-gate-y.mjs',
  'review-gate-x.mjs', 'x-gate-y.mjs', 'x-guardrail.mjs', 'GUARD-UPPER.MJS'])(
  'refuses listed guard basename %s', async name => {
    const path = `scripts/conveyor/${name}`;
    const f = fixture({ allowedFiles: [path], readCard: () => ({ scope: [`we:${path}`] }) });
    const result = await f.command();
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toMatch(/guard name/);
    expect(f.readPrs).not.toHaveBeenCalled();
    untouched(f);
  });

it.each(['TRUST_CHAIN', 'isTrustChainPath', '@guard', 'gate-config', 'trust_chain'])(
  'refuses listed file with guard marker %s', async marker => {
    const f = fixture({ readContent: () => `export {};\n// ${marker}\n` });
    const result = await f.command();
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toMatch(/guard marker/);
    untouched(f);
  });

it.each([['missing', undefined], ['null', null], ['buffer', Buffer.from('export {};')],
  ['oversized ASCII', 'x'.repeat(65537)], ['oversized UTF-8', 'é'.repeat(32769)],
  ['unreadable', () => { throw new Error('unreadable'); }]])(
  'refuses %s content with an operator fallback', async (_name, evidence) => {
    const f = fixture({ readContent: typeof evidence === 'function' ? evidence : () => evidence });
    const result = await f.command();
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toMatch(/content.*64 KB.*human review/);
    untouched(f);
  });

it('admits clean content at the 64-KiB byte boundary', async () => {
  const f = fixture({ readContent: () => 'é'.repeat(32768) });
  expect((await f.command([...flags, '--preview'])).code).toBe(0);
  untouched(f);
});

it('rechecks guard-marker content under the writer lock', async () => {
  const readContent = vi.fn().mockReturnValueOnce('').mockReturnValueOnce('').mockReturnValue('@guard');
  const f = fixture({ readContent });
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(readContent).toHaveBeenCalledTimes(3);
  expect(result.lines.join('\n')).toMatch(/guard marker/);
  untouched(f);
});

it.each(['fui:', 'plateau-app:', 'plateau:'])('refuses other-repo gate paths under %s', async prefix => {
  const f = fixture({ readCard: () => ({ scope: [`${prefix}scripts/lib/gate-config.mjs`] }) });
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(result.lines.join('\n')).toMatch(/scope entry .* must be an exact file path/);
  expect(f.readPrs).not.toHaveBeenCalled();
  untouched(f);
});

it('refuses the real cross-repo trust-chain daemon basename', async () => {
  expect(TRUST_CHAIN.some(member => member.file === 'daemon.mjs')).toBe(true);
  const f = fixture({ readCard: () => ({ scope: ['plateau:tools/drain-daemon/daemon.mjs'] }) });
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(result.lines.join('\n')).toMatch(/scope entry .* must be an exact file path/);
  expect(f.readPrs).not.toHaveBeenCalled();
  untouched(f);
});

it('runtime list install validates and writes atomically with mode 0600 and exact reader fields', async () => {
  const f = fixture();
  fs.writeFileSync(f.path, 'old');
  const inode = fs.statSync(f.path).ino;
  const fsync = vi.fn(fd => fs.fsyncSync(fd));
  f.options.fsync = fsync;
  const rename = vi.fn((src, dest) => {
    expect(fsync).toHaveBeenCalledOnce();
    expect(fs.readFileSync(dest, 'utf8')).toBe('old');
    expect(fs.statSync(src).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(join(f.dir, 'build-priority.audit.jsonl'), 'utf8')).phase).toBe('install-attempt');
    fs.renameSync(src, dest);
  });
  f.options.rename = rename;
  expect((await f.command()).code).toBe(0);
  expect(rename).toHaveBeenCalledOnce();
  expect(fs.statSync(f.path).ino).not.toBe(inode);
  expect(fs.statSync(f.path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(f.path, 'utf8'))).toEqual({ ids: ['42', '43'], mode: 'only', setBy: 'operator', at, ttlHours: 2 });
  expect(fs.readFileSync(join(f.dir, 'build-priority.audit.jsonl'), 'utf8')).toBe(`${JSON.stringify({ actor: 'operator', reason: 'priority call', ids: ['42', '43'], mode: 'only', ttlHours: 2, at, phase: 'install-attempt' })}\n`);
  untouched(f, ['build-priority.runtime.json', 'build-priority.audit.jsonl']);
});

it('round-trips the installed list through readBuildPrioritySettings', async () => {
  const f = fixture();
  expect((await f.command()).code).toBe(0);
  expect(readBuildPrioritySettings({ runtimePath: f.path, env: {}, now: Date.parse(at) })).toMatchObject({
    ids: ['42', '43'], source: 'runtime', mode: 'only', only: true, runtime: { expired: false, setBy: 'operator' },
  });
});

it.each(['only', 'lift'])('refuses padded IDs before installation or preview in %s mode', async mode => {
  for (const ids of ['042', '00042', '00', '42,043', '42,042', ' 042 ']) {
    for (const preview of [false, true]) {
      const f = fixture();
      const previous = JSON.stringify({ ids: ['42'], mode: 'only', setBy: 'operator', at, ttlHours: 2 });
      fs.writeFileSync(f.path, previous);
      const result = await f.command([
        ...flags.filter(s => !s.startsWith('--ids=') && !s.startsWith('--mode=')),
        `--ids=${ids}`, `--mode=${mode}`, ...(preview ? ['--preview'] : []),
      ]);
      expect(result.code).not.toBe(0);
      expect(result.lines.join('\n')).toContain('without leading zeroes');
      expect(f.readCard).not.toHaveBeenCalled();
      expect(f.readPrs).not.toHaveBeenCalled();
      expect(fs.readFileSync(f.path, 'utf8')).toBe(previous);
      untouched(f, ['build-priority.runtime.json']);
    }
  }
});

it('keeps a canonical installed card admitted when intersecting the environment priority', async () => {
  const f = fixture();
  expect((await f.command(changed('ids', ' 42 '))).code).toBe(0);
  const settings = readBuildPrioritySettings({ runtimePath: f.path,
    env: { WE_BUILD_PRIORITY: '42' }, now: Date.parse(at) });
  expect(settings.ids).toEqual(['42']);
  expect(decideRuntimeAdmission({ num: 42 }, 'build', settings).admitted).toBe(true);
});

it('registers the operation in run.mjs', () => { expect(resolveOperation('build-priority-set').declaration.name).toBe('build-priority-set'); });

it.each([false, true])('reaches exact PR-overlap refusal (preview: %s)', async preview => {
  const f = fixture({ readPrs: () => [{ repo: 'web-everything/web-everything', number: 1, files: ['scripts/conveyor/a.mjs'] }] });
  fs.writeFileSync(f.path, 'old');
  const result = await f.command([...flags, ...(preview ? ['--preview'] : [])]);
  expect(result.code).not.toBe(0);
  expect(result.lines.join('\n')).toMatch(/scope overlaps open PR/);
  expect(fs.readFileSync(f.path, 'utf8')).toBe('old');
  untouched(f, ['build-priority.runtime.json']);
});

it.each([false, true])('emits one JSON envelope with the priority record (preview: %s)', async preview => {
  const f = fixture();
  const result = await f.command([...flags, ...(preview ? ['--preview'] : []), '--json']);
  expect(result.code).toBe(0);
  const payload = JSON.parse(result.lines.join('\n'));
  expect(payload.verdict.record).toEqual({ ids: ['42', '43'], mode: 'only', setBy: 'operator', at, ttlHours: 2 });
  if (preview) untouched(f);
  else expect(JSON.parse(fs.readFileSync(f.path, 'utf8'))).toEqual(payload.verdict.record);
});

it('keeps JSON refusals parseable without writing anything', async () => {
  const f = fixture({ readCard: () => null });
  const result = await f.command([...flags, '--preview', '--json']);
  expect(result.code).not.toBe(0);
  expect(JSON.parse(result.lines.join('\n')).error).toContain('card 42');
  untouched(f);
});

it.each([
  ['unknown mode', 'mode', 'other'], ['ttl zero', 'ttl-hours', '0'], ['ttl negative', 'ttl-hours', '-1'],
  ['ttl oversized', 'ttl-hours', '169'], ['ttl NaN', 'ttl-hours', 'NaN'], ['ttl infinite', 'ttl-hours', 'Infinity'],
  ['missing actor', 'actor', undefined], ['blank actor', 'actor', '  '], ['missing reason', 'reason', undefined],
  ['blank reason', 'reason', '  '], ['empty ids', 'ids', ''], ['duplicate ids', 'ids', '42,42'],
  ['duplicate trimmed ids', 'ids', '42, 42'], ['non-numeric ids', 'ids', '42,xabc123'],
  ['invalid ids', 'ids', '42,1e2'], ['empty id member', 'ids', '42,'],
])('refuses %s without writing anything', async (_name, flag, value) => {
  const f = fixture();
  expect((await f.command(changed(flag, value))).code).not.toBe(0);
  untouched(f);
});

it.each([
  ['unknown card', { readCard: () => null }],
  ['unreadable card source', { readCard: () => { throw new Error('unreadable origin/main'); } }],
  ['unreadable PR source', { readPrs: () => { throw new Error('unreadable PRs'); } }],
  ['incomplete PR source', { readPrs: () => null }],
  ['malformed PR files', { readPrs: () => [{ repo: 'web-everything/web-everything', number: 1 }] }],
  ['unrepresentable PR filenames', { readPrs: () => [{ repo: 'web-everything/web-everything', number: 1, files: ['scripts/a b.mjs'] }] }],
  ['missing card scope', { readCard: () => ({}) }],
  ['open PR overlap', { readPrs: () => [{ repo: 'web-everything/web-everything', number: 1, files: ['scripts/conveyor/a.test.mjs'] }] }],
  ['directory gate coverage', { readCard: () => ({ scope: ['we:scripts/example/'] }), readPrs: () => [{ repo: 'web-everything/web-everything', number: 1, files: ['scripts/example/a.mjs'] }] }],
])('refuses %s and preserves the old runtime file', async (_name, overrides) => {
  const f = fixture(overrides);
  fs.writeFileSync(f.path, 'old');
  const result = await f.command();
  expect(result.code).not.toBe(0);
  if (_name === 'directory gate coverage') expect(result.lines.join('\n')).toMatch(/card 42 scope entry .* must be an exact file path/);
  expect(fs.readFileSync(f.path, 'utf8')).toBe('old');
  untouched(f, ['build-priority.runtime.json']);
});

it('refuses an existing exclusive lock without removing it or writing anything', async () => {
  const f = fixture();
  fs.writeFileSync(`${f.path}.lock`, 'another writer');
  expect((await f.command()).code).not.toBe(0);
  expect(fs.readFileSync(`${f.path}.lock`, 'utf8')).toBe('another writer');
  untouched(f, ['build-priority.runtime.json.lock']);
});

it('preview validates and prints the proposed record but writes nothing', async () => {
  const f = fixture();
  const result = await f.command([...flags, '--preview']);
  expect(result.code).toBe(0);
  expect(result.lines.join('\n')).toContain('"setBy": "operator"');
  expect(f.readCard).toHaveBeenCalledWith('42');
  expect(f.readPrs).toHaveBeenCalled();
  untouched(f);
  f.options.readPrs = () => { throw new Error('unreadable PRs'); };
  expect((await f.command([...flags, '--preview'])).code).not.toBe(0);
  untouched(f);
});

it('rename failure leaves the old file intact with an install-attempt audit and no temporary file', async () => {
  const f = fixture({ rename: () => { throw new Error('rename refused'); } });
  fs.writeFileSync(f.path, 'old');
  expect((await f.command()).code).not.toBe(0);
  expect(fs.readFileSync(f.path, 'utf8')).toBe('old');
  expect(JSON.parse(fs.readFileSync(join(f.dir, 'build-priority.audit.jsonl'), 'utf8')).phase).toBe('install-attempt');
  untouched(f, ['build-priority.runtime.json', 'build-priority.audit.jsonl']);
});

it('fsync failure leaves the old file intact and cleans up the temporary file and lock', async () => {
  const f = fixture({ fsync: () => { throw new Error('fsync refused'); } });
  fs.writeFileSync(f.path, 'old');
  expect((await f.command()).code).not.toBe(0);
  expect(fs.readFileSync(f.path, 'utf8')).toBe('old');
  untouched(f, ['build-priority.runtime.json']);
});

it('O_EXCL refuses a writer that acquires the lock after initial validation', async () => {
  const f = fixture();
  f.options.readPrs = () => { fs.writeFileSync(`${f.path}.lock`, 'other writer'); return []; };
  expect((await f.command()).code).not.toBe(0);
  expect(fs.readFileSync(`${f.path}.lock`, 'utf8')).toBe('other writer');
  untouched(f, ['build-priority.runtime.json.lock']);
});

it('accepts lift and the maximum TTL and appends rather than replaces audit history', async () => {
  const f = fixture();
  expect((await f.command()).code).toBe(0);
  expect((await f.command([...changed('mode', 'lift').filter(s => !s.startsWith('--ttl-hours=')), '--ttl-hours=168'])).code).toBe(0);
  expect(JSON.parse(fs.readFileSync(f.path, 'utf8'))).toMatchObject({ mode: 'lift', ttlHours: 168 });
  expect(fs.readFileSync(join(f.dir, 'build-priority.audit.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
});

it('uses the coordination-root default when no runtime override is supplied', async () => {
  const f = fixture();
  f.options.env = { WE_COORDINATION_ROOT: f.dir };
  expect((await f.command()).code).toBe(0);
  expect(fs.existsSync(f.path)).toBe(true);
});

it('reads cards from a pinned origin/main using bounded git reads, refusing unknown or ambiguous cards', () => {
  const git = vi.fn(args => args[0] === 'rev-parse' ? 'a'.repeat(40) : args[0] === 'ls-tree'
    ? 'backlog/042-card.md\0backlog/43-card.md\0' : '---\nscope: ["we:scripts/conveyor/a.mjs"]\n---\n');
  const read = readPriorityCards({ git });
  expect(read('42')).toEqual({ scope: ['we:scripts/conveyor/a.mjs'] });
  expect(git.mock.calls[0][0]).toEqual(['rev-parse', '--verify', 'refs/remotes/origin/main']);
  expect(git.mock.calls.some(([args]) => args.includes(`${'a'.repeat(40)}:backlog/042-card.md`))).toBe(true);
  expect(() => read('99')).toThrow(/card/);
  expect(() => readPriorityCards({ git: args => args[0] === 'rev-parse' ? 'a'.repeat(40)
    : 'backlog/042-card.md\0backlog/42-other.md\0' })('42')).toThrow(/ambiguous/);
  expect(() => readPriorityCards({ git: () => { throw new Error('unreadable'); } })('42')).toThrow();
});

it('PR reader uses bounded gh list and refuses truncated or malformed evidence with an operator fallback', () => {
  const gh = vi.fn(() => '[]');
  expect(readPriorityPrs({ gh })).toEqual([]);
  expect(gh.mock.calls[0][0]).toEqual(expect.arrayContaining(['pr', 'list', '--state', 'open', '--limit']));
  for (const value of [null, [{}], Array.from({ length: 200 }, () => ({})), [{ number: 1, files: Array.from({ length: 100 }, () => ({ path: 'a' })) }]]) {
    expect(() => readPriorityPrs({ gh: () => JSON.stringify(value) })).toThrow(/repair|drain|retry/i);
  }
  expect(() => readPriorityPrs({ gh: () => { throw new Error('unreadable'); } })).toThrow();
});


it.each([false, true])('audit append failure refuses activation (existing runtime: %s)', async existing => {
  const f = fixture();
  if (existing) fs.writeFileSync(f.path, 'old');
  fs.mkdirSync(join(f.dir, 'build-priority.audit.jsonl'));
  const rename = vi.fn(fs.renameSync);
  f.options.rename = rename;
  expect((await f.command()).code).not.toBe(0);
  expect(rename).not.toHaveBeenCalled();
  if (existing) expect(fs.readFileSync(f.path, 'utf8')).toBe('old');
  else expect(fs.existsSync(f.path)).toBe(false);
  untouched(f, ['build-priority.audit.jsonl', ...(existing ? ['build-priority.runtime.json'] : [])]);
});

it.each(['scripts/conveyor/a.mjs', 'scripts/conveyor/renamed.mjs'])('PR rename evidence blocks overlap with %s', async path => {
  const gh = () => JSON.stringify([{ number: 1, files: [{ path: 'scripts/conveyor/renamed.mjs', previousFilename: 'scripts/conveyor/a.mjs' }] }]);
  const prs = readPriorityPrs({ gh });
  expect(prs[0].files).toEqual(['scripts/conveyor/renamed.mjs', 'scripts/conveyor/a.mjs']);
  const f = fixture({ readCard: () => ({ scope: [`we:${path}`] }), readPrs: () => prs });
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(result.lines.join('\n')).toMatch(/scope overlaps open PR/);
  untouched(f);
});

it.each(['we:scripts/conveyor/a.mjs', 'fui:scripts/a.mjs'])(
  'keeps PR filename %s literal without treating its colon as a repo prefix', async path => {
    const readPrs = vi.fn(() => [{ repo: 'web-everything/web-everything', number: 1, files: [path] }]);
    const f = fixture({ readCard: () => ({ scope: ['we:scripts/conveyor/a.mjs'] }), readPrs });
    const result = await f.command([...flags, '--preview']);
    expect(result.code).toBe(0);
    expect(readPrs).toHaveBeenCalledOnce();
    untouched(f);
  });

it('refuses a delimiter-only scope member alongside a valid member', async () => {
  const f = fixture({ readCard: () => ({ scope: ['we:scripts/conveyor/a.mjs', ',,,'] }) });
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(result.lines.join('\n')).toMatch(/repair evidence.*retry/);
  untouched(f);
});

it.each([false, true])('fsyncs and closes the parent directory after rename (sync failure: %s)', async fail => {
  const f = fixture();
  const events = [];
  let directoryFd;
  const closeSync = fs.closeSync;
  const close = vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
    closeSync(fd);
    if (fd === directoryFd) {
      // A successful real close proves cleanup; fstat could observe a reused fd number.
      events.push('directory-close');
      directoryFd = undefined;
    }
  });
  f.options.rename = (src, dest) => { events.push('rename'); fs.renameSync(src, dest); };
  f.options.fsync = fd => {
    if (fs.fstatSync(fd).isDirectory()) {
      directoryFd = fd;
      events.push('directory-fsync');
      if (fail) throw new Error('directory fsync refused');
    } else events.push('file-fsync');
    fs.fsyncSync(fd);
  };
  let result;
  try { result = await f.command(); }
  finally { close.mockRestore(); }
  expect(events).toEqual(['file-fsync', 'rename', 'directory-fsync', 'directory-close']);
  if (fail) {
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('directory fsync refused');
  } else expect(result.code).toBe(0);
  untouched(f, ['build-priority.runtime.json', 'build-priority.audit.jsonl']);
});
