import { expect, it, vi } from 'vitest';
import { resolve, relative } from 'node:path';
import { computeClosureScope, fixpointExtend, isExcludable } from '../daemon-rebuild/closure-scope.mjs';
import { collectRunClosure, smokeSurfaceEntries } from '../daemon-rebuild/skip-unrelated.mjs';
import { collectImportClosure } from '../import-closure.mjs';
import * as runClosure from '../daemon-rebuild/skip-unrelated.mjs';

function reader(files = {}) {
  const root = resolve('virtual-scope');
  const contents = new Map(Object.entries(files));
  return { root, listFiles: () => [...contents.keys()],
    exists: p => contents.has(relative(root, resolve(root, p))),
    readFile(p) {
      const key = relative(root, resolve(root, p));
      if (!contents.has(key)) throw new Error('missing file');
      return contents.get(key);
    },
  };
}
function compute(files = {}, options = {}) {
  const surface = Object.fromEntries(smokeSurfaceEntries({}).map(p => [p, 'export {};']));
  return computeClosureScope({ reader: reader({ ...surface, 'entry.mjs': '', ...files }),
    entries: ['entry.mjs'], env: {}, ...options });
}

it.each(['off', 'shadow', 'on'])('scope computation uses supplied entries without host LaunchAgents in %s mode', mode => {
  const result = compute({ 'entry.mjs': "import './runtime.mjs';", 'runtime.mjs': '' }, {
    env: { HOME: '/nonexistent-closure-scope-home', WE_SMOKE_LIVE_CLONE: '/nonexistent-live-clone',
      WE_DAEMON_CLOSURE_SCOPE: mode },
  });
  expect(result.ok).toBe(true);
  expect(result.scope.has('runtime.mjs')).toBe(true);
});

const workerLaunches = [
  ...['spawn', 'spawnSync', 'execFile', 'execFileSync'].map(name =>
    options => `${name}('node', ['worker.mjs']${options});`),
  options => `fork('worker.mjs', []${options});`,
  options => `import { spawn as launch } from 'node:child_process';
    launch('node', ['worker.mjs']${options});`,
  options => `import * as child from 'node:child_process';
    child.spawn('node', ['worker.mjs']${options});`,
  options => `import child from 'node:child_process';
    child['spawn'](process.execPath, ['worker.mjs']${options});`,
];

it.each([
  '{ cwd: process.env.RUN_DIR }',
  "{ cwd: '../external' }",
  "{ cwd: '.' }",
  "{ 'cwd': process.env.RUN_DIR }",
  '{ "c\\u0077d": process.env.RUN_DIR }',
  '{ c\\u0077d: process.env.RUN_DIR }',
  "{ ['cwd']: process.env.RUN_DIR }",
  "{ ['c' + 'wd']: process.env.RUN_DIR }",
  '{ cwd }',
  '{ ...options }',
  '{ get cwd() { return process.env.RUN_DIR; } }',
  '{ __proto__: options }',
  'options',
])('refuses launches with unproven working directories: %s', options => {
  for (const launch of workerLaunches) {
    const source = launch(`, ${options}`);
    // The snapshot worker is a decoy: cwd can select an external worker whose
    // dependencies include repository files absent from this static closure.
    const files = { 'entry.mjs': "import './launcher.mjs';", 'launcher.mjs': source,
      'worker.mjs': '', 'tests/runtime-dependency.mjs': '' };
    expect(collectImportClosure({ ...reader(files), entries: ['entry.mjs'], strict: true }).complete, source)
      .toBe(false);
    expect(compute(files), source).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  }
});

it.each(['', ', {}', ', { shell: false, stdio: "pipe" }'])(
  'still admits modeled worker launches without a cwd override: %s', options => {
    for (const launch of workerLaunches) {
      const source = launch(options);
      const result = compute({ 'entry.mjs': source, 'worker.mjs': "import './dependency.mjs';",
        'dependency.mjs': '', 'tests/unrelated.mjs': '' });
      expect(result.ok, source).toBe(true);
      expect(isExcludable('dependency.mjs', result.scope), source).toBe(false);
      expect(isExcludable('tests/unrelated.mjs', result.scope), source).toBe(true);
    }
  });

it.each([
  ['string-keyed module destructuring', "const {'require':load}=module; load.call(module,process.argv[2]);"],
  ['package dot main', "require('.');", { 'package.json': '{"main":"./tests/payload"}',
    'tests/payload.js': '', 'tests/payload.cjs': '' }, ['tests/payload.mjs', 'tests/payload.js', 'tests/payload.cjs']],
  ['package parent exports', "import './child/start.mjs';", {
    'child/start.mjs': "require('..');", 'package.json': '{"exports":"./tests/payload"}',
  }, ['tests/payload.mjs']],
  ['nested package exports', "import 'outer';", {
    'node_modules/outer/package.json': '{"exports":"./lib/start.mjs"}',
    'node_modules/outer/lib/start.mjs': "import 'inner';",
    'node_modules/outer/node_modules/inner/package.json': '{"exports":{".":{"import":"./tests/payload"}}}',
    'node_modules/outer/node_modules/inner/tests/payload.js': '',
    'node_modules/outer/node_modules/inner/tests/payload.cjs': '',
  }, ['node_modules/outer/node_modules/inner/tests/payload.js', 'node_modules/outer/node_modules/inner/tests/payload.cjs']],
  ['tracked bare package entry', "require('local-fixture');", {
    'node_modules/local-fixture/index.js': "import './tests/dependency.mjs';",
    'node_modules/local-fixture/tests/dependency.mjs': '',
  }, ['node_modules/local-fixture/index.js', 'node_modules/local-fixture/tests/dependency.mjs']],
  ['inherited fork execArgv', "process.execArgv.push(process.argv[2]); fork('./worker.mjs');", { 'worker.mjs': '' }],
  ['inherited spawn NODE_OPTIONS', "process.env.NODE_OPTIONS=process.argv[2]; spawnSync('node', ['./worker.mjs']);", { 'worker.mjs': '' }],
  ['escaped file URL', "import 'file:///x/tests/%70ayload.mjs';"],
  ['base64 data import', `import 'data:text/javascript;base64,${Buffer.from("import 'node:fs';").toString('base64')}';`],
  ['node:test runner', "import {run} from 'node:test'; run({files:[process.argv[2]]});"],
  ['environment file loader', 'process.loadEnvFile(process.argv[2]);'],
  ['eval loader', 'eval(process.argv[2]);'],
  ['Function loader', 'new Function(process.argv[2]);'],
  ['module bracket member', "consume(module['require']);"],
  ['resolver factory reference', 'consume(createRequire);'],
  ['vm namespace', "import * as vm from 'node:vm'; consume(vm);"],
  ['module namespace', "import * as mod from 'node:module'; consume(mod);"],
  ['preload strings', "const flags=['--require','--import','--loader','--experimental-loader'];"],
  ['remote import', "import 'https://example.invalid/loader.mjs';"],
])('opaque loaders and tracked resolution protect runtime files: %s', (_label, source, files = {}, targets) => {
  const result = compute({ 'entry.mjs': "import './loader.mjs';", 'loader.mjs': source,
    'tests/payload.mjs': '', 'tests/unmentioned.mjs': '', ...files });
  for (const target of targets || ['tests/payload.mjs', 'tests/unmentioned.mjs']) {
    expect(result.ok ? isExcludable(target, result.scope) : false, target).toBe(false);
  }
});

it.each([
  "await Function('return import(process.argv[2])')();",
  "await Function.prototype.constructor('return import(process.argv[2])')();",
  "await (0, Function)('return import(process.argv[2])')();",
  "await globalThis.Function('return import(process.argv[2])')();",
  "const {'Function': compile} = globalThis; compile(process.argv[2])();",
  'consume(process.mainModule);',
  "consume(process['mainModule']);",
  "const {'mainModule': entry} = process; consume(entry);",
  'consume(require.main);', 'consume(module.parent);', 'consume(module.children);',
  'consume(require.cache);', 'consume(Module._load);', 'consume(Module._resolveFilename);',
  "const {'_load': load} = Module; consume(load);",
  "const {'_resolveFilename': locate} = Module; consume(locate);",
  "consume(process.getBuiltinModule);", 'consume(process.binding);',
  'consume(process._linkedBinding);', 'consume(process.dlopen);',
])('R210 final round retains the full conflict for opaque loader references: %s', source => {
  expect(compute({ 'entry.mjs': "import './loader.mjs';", 'loader.mjs': source,
    'tests/unmentioned.mjs': '' })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it.each([
  "(()=>{}).constructor('return import(process.argv[2])')();",
  "(()=>{})['constructor']('return import(process.argv[2])')();",
  "const {constructor: compile} = ()=>{}; compile('return import(process.argv[2])')();",
  "(async()=>{}).constructor('return import(process.argv[2])')();",
  "(function*(){}).constructor('return import(process.argv[2])')().next();",
])('indirect function constructors make strict closure incomplete and refuse scope admission: %s', source => {
  const files = { 'entry.mjs': source, 'tests/unmentioned.mjs': '' };
  expect(collectImportClosure({ ...reader(files), entries: ['entry.mjs'], strict: true }).complete).toBe(false);
  const result = compute(files);
  expect(result).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  expect(isExcludable('tests/unmentioned.mjs', result.scope)).toBe(false);
});

it.each([
  './%70ayload.mjs', './%70%61yload.mjs', './caf%C3%A9.mjs', './%2570ayload.mjs',
  './%2e%2e/outside.mjs', './%2Foutside.mjs', './%5Coutside.mjs',
  './payload%23part.mjs', './payload%3Fpart.mjs', './%ZZ.mjs', './%E0%A4.mjs',
  './payload.mjs?decoy.mjs', './payload.mjs#decoy.mjs', './dir\\payload.mjs',
  './pay\tload.mjs', './pay\rload.mjs', './pay\nload.mjs',
])('retains the full conflict for URL-sensitive relative targets despite a raw-path decoy: %s', spec => {
  const quoted = JSON.stringify(spec);
  for (const source of [`import ${quoted};`, `export * from ${quoted};`,
    `import(${quoted});`, `require(${quoted});`]) {
    const files = { 'entry.mjs': "import './loader.mjs';", 'loader.mjs': source,
      [spec.slice(2)]: '', 'payload.mjs': "import './runtime-dependency.mjs';",
      'runtime-dependency.mjs': '', 'tests/unmentioned.mjs': '' };
    const snapshot = reader(files);
    const closure = collectImportClosure({ ...snapshot, entries: ['entry.mjs'], strict: true });
    expect(closure.complete, source).toBe(false);
    expect(compute(files), source).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  }
});

it('retains the full conflict for JavaScript-escaped percent signs in relative imports', () => {
  expect(compute({ 'entry.mjs': "import './\\u002570ayload.mjs';",
    '%70ayload.mjs': '', 'payload.mjs': '' }))
    .toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it.each(['local/%70ayload.mjs', 'local/payload.mjs?decoy.mjs', 'local/payload.mjs#decoy.mjs'])(
  'retains the full conflict for URL-sensitive bare package subpaths: %s', spec => {
    expect(compute({ 'entry.mjs': `import '${spec}';`,
      'node_modules/local/index.js': '', [`node_modules/${spec}`]: '',
      'node_modules/local/payload.mjs': '' }))
      .toMatchObject({ ok: false, reason: 'closure-incomplete' });
  });

it.each(['main', 'exports'])('R210 final round protects raw and URL-decoded package %s targets', field => {
  const files = { 'entry.mjs': "require('./pkg');", 'pkg/index.js': '',
    'pkg/package.json': JSON.stringify({ [field]: './%70ayload.mjs' }),
    'pkg/%70ayload.mjs': "import './raw-dependency.mjs';",
    'pkg/payload.mjs': "import './decoded-dependency.mjs';",
    'pkg/raw-dependency.mjs': '', 'pkg/decoded-dependency.mjs': '' };
  const result = compute(files);
  expect(result.ok).toBe(true);
  for (const path of ['pkg/%70ayload.mjs', 'pkg/payload.mjs',
    'pkg/raw-dependency.mjs', 'pkg/decoded-dependency.mjs']) {
    expect(result.closure.files.has(path), path).toBe(true);
    expect(isExcludable(path, result.scope), path).toBe(false);
  }
});

it.each(['main', 'exports'])('R210 final round refuses unproven URL-decoded package %s targets', field => {
  for (const target of ['./%ZZ.mjs', './%2e%2e/%2e%2e/outside.mjs', './%2Foutside.mjs', './%2a.mjs']) {
    expect(compute({ 'entry.mjs': "require('./pkg');", 'pkg/index.js': '',
      'pkg/package.json': JSON.stringify({ [field]: target }),
      [`pkg/${target.slice(2)}`]: '' }), target).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  }
});

it.each(['main', 'exports'])('refuses URL-normalized package %s targets despite raw and decoded decoys', field => {
  for (const target of ['./pay\tload.mjs', './pay\nload.mjs', './pay\rload.mjs', './dir\\payload.mjs',
    './pay%09load.mjs', './pay%0Aload.mjs', './pay%0Dload.mjs', './dir%5Cpayload.mjs']) {
    expect(compute({ 'entry.mjs': "require('./pkg');", 'pkg/index.js': '',
      'pkg/package.json': JSON.stringify({ [field]: target }),
      [`pkg/${target.slice(2)}`]: '', [`pkg/${decodeURIComponent(target.slice(2))}`]: '',
    }), target).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  }
});

it('only excludes allowed files outside the run closure and protects smoke and mechanism paths', () => {
  const result = compute({ 'entry.mjs': "import './used.mjs';", 'used.mjs': '',
    'unused.mjs': '', 'data.bin': '' }, { mechanismPaths: ['mechanism/'] });
  expect(result.ok).toBe(true);
  expect(isExcludable('unused.mjs', result.scope)).toBe(true);
  expect(isExcludable('used.mjs', result.scope)).toBe(false);
  expect(isExcludable('backlog/card.md', result.scope)).toBe(false);
  expect(isExcludable('docs/note.md', result.scope)).toBe(false);
  expect(isExcludable('tests/thing.spec.mjs', result.scope)).toBe(false); // Absent from the scanned snapshot.
  expect(isExcludable('data.bin', result.scope)).toBe(false);
  expect(isExcludable('unnamed.json', result.scope)).toBe(false);
  expect(isExcludable('mechanism/new.mjs', result.scope)).toBe(false);
  for (const p of smokeSurfaceEntries({})) expect(result.scope.has(p)).toBe(true);
});

it('walks overlay changes on top of main including newly imported and spawned files', () => {
  const result = compute({}, { overlayChangedFiles: new Map([
    ['entry.mjs', "import './new.mjs';"], ['new.mjs', "spawn('node', ['./child.mjs']);"], ['child.mjs', ''],
  ]) });
  expect(result.ok).toBe(true);
  for (const p of ['entry.mjs', 'new.mjs', 'child.mjs']) expect(result.scope.has(p)).toBe(true);
});

it.each([
  ['spawn', next => `spawn('node', ['./${next}']);`],
  ['basename-reference', next => `// Worker name: ${next}`],
  ['string path', next => `const target = './${next}';`],
  ['require', next => `require('./${next.slice(0, -4)}');`],
])('retains the full conflict beyond 64 non-import hops: 66-link %s chain', (_mechanism, source) => {
  const files = { 'entry.mjs': source('bounded-00.mjs') };
  for (let i = 0; i < 66; i++) {
    files[`bounded-${String(i).padStart(2, '0')}.mjs`] = i === 65 ? ''
      : source(`bounded-${String(i + 1).padStart(2, '0')}.mjs`);
  }
  expect(compute(files)).toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it('retains the full conflict when a comment shortcut completes a strict 66-file spawn chain within 64 generations', () => {
  const files = { 'entry.mjs': "import './chain-00.mjs';" };
  for (let i = 0; i < 66; i++) {
    files[`chain-${String(i).padStart(2, '0')}.mjs`] = i === 65 ? ''
      : `spawn('node', ['./chain-${String(i + 1).padStart(2, '0')}.mjs']);`;
  }
  files['chain-00.mjs'] += '\n// Later worker: chain-65.mjs';
  const snapshot = reader(files);
  const options = { root: snapshot.root, reader: snapshot, entries: ['entry.mjs'],
    strict: true, stopWhenIncomplete: true, byName: () => [] };
  const strict = collectRunClosure(options);
  expect(strict.complete).toBe(true);
  expect(strict.files.size).toBe(67);
  expect(collectRunClosure({ ...options, strictExtensions: false }).complete).toBe(false);
  expect(compute(files)).toEqual({ ok: false, reason: 'closure-incomplete' });
});

it('retains the legacy refusal for a 66-link extensionless require chain with a candidate shortcut', () => {
  const files = { 'entry.mjs': "require('./chain-00');",
    'chain-00.js': "require('./chain-32');" };
  for (let i = 0; i < 66; i++) {
    files[`chain-${String(i).padStart(2, '0')}.mjs`] = i === 65 ? ''
      : `require('./chain-${String(i + 1).padStart(2, '0')}');`;
  }
  const snapshot = reader(files);
  const options = { root: snapshot.root, reader: snapshot, entries: ['entry.mjs'],
    strict: true, stopWhenIncomplete: true, byName: () => [] };
  const expanded = collectRunClosure(options);
  expect(expanded.complete).toBe(true);
  expect(expanded.files.size).toBe(68);
  const legacy = collectRunClosure({ ...options, strictExtensions: false, legacyRequires: true });
  expect(legacy.complete).toBe(false);
  expect(legacy.files.has('chain-00.js')).toBe(false);
  expect(compute(files)).toEqual({ ok: false, reason: 'closure-incomplete' });
});

it('single-target require compatibility bypasses strict launch, basename, comment and read-capability traversal', () => {
  const snapshot = reader({ 'entry.mjs': `import fs from 'node:fs';
    require('./required');
    fork('./launch\\u002emjs');
    const note = 'basename.mjs';
    // comment.mjs
    fs.readFileSync(process.argv[2]);`,
  'required.mjs': '', 'required.js': 'import(target);', 'launch.mjs': 'import(target);',
  'hidden/basename.mjs': 'import(target);', 'comment.mjs': 'import(target);', 'opaque.mjs': 'import(target);' });
  const byName = vi.fn(() => []);
  const options = { root: snapshot.root, reader: snapshot, entries: ['entry.mjs'], strict: true,
    strictExtensions: false, legacyRequires: true, stopWhenIncomplete: true, byName };
  const legacy = collectRunClosure(options);
  expect(legacy.complete).toBe(true);
  expect(legacy.files).toEqual(new Set(['entry.mjs', 'required.mjs']));
  expect(legacy.opaqueReads).toBeUndefined();
  // The old string-path scanner's fallback is preserved; the new basename index is unused.
  expect(byName).toHaveBeenCalledTimes(1);
  expect(byName).toHaveBeenCalledWith('basename.mjs');
});

it('legacy compatibility preserves strict import checks without new launch or reference parsing', () => {
  const snapshot = reader({ 'entry.mjs': `// comment-worker.mjs
    require('./required');
    exec(command);
    const child = './child.mjs';`,
  'comment-worker.mjs': '', 'required.mjs': '', 'child.mjs': "import './dependency.mjs';",
  'dependency.mjs': '' });
  const options = { root: snapshot.root, reader: snapshot, entries: ['entry.mjs'],
    strict: true, strictExtensions: false, stopWhenIncomplete: true, byName: () => [] };
  const legacy = collectRunClosure(options);
  expect(legacy.complete).toBe(true);
  expect(legacy.files).toEqual(new Set(['entry.mjs', 'child.mjs', 'dependency.mjs']));
  expect(collectRunClosure({ ...options, strictExtensions: true }).complete).toBe(false);
  for (const source of ["import './missing.mjs';", "import '#private';", "import(target);"]) {
    expect(collectImportClosure({ ...options, readFile: () => source, exists: snapshot.exists }).complete).toBe(false);
  }
});

it.each([
  ['incomplete', () => ({ complete: false }), 'closure-incomplete'],
  ['oversized', () => ({ complete: true, files: new Set(Array.from({ length: 4001 }, (_, i) => `f${i}.mjs`)) }), 'closure-too-large'],
  ['unreadable', () => { throw new Error('legacy read failed'); }, 'scope-unreadable'],
  ['file-bound exception', () => { throw Object.assign(new Error('bound'), { code: 'CLOSURE_TOO_LARGE' }); }, 'closure-too-large'],
])('retains the full conflict before strict traversal when legacy evidence is %s', (_label, legacy, reason) => {
  const spy = vi.spyOn(runClosure, 'collectRunClosure').mockImplementationOnce(legacy);
  try {
    expect(compute()).toEqual({ ok: false, reason });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ strict: true, strictExtensions: false,
      maxFiles: 4000, stopWhenIncomplete: true });
  } finally { spy.mockRestore(); }
});

it('returns single-target require incompleteness before strict traversal', () => {
  const spy = vi.spyOn(runClosure, 'collectRunClosure')
    .mockReturnValueOnce({ complete: true, files: new Set(['entry.mjs']) })
    .mockReturnValueOnce({ complete: false });
  try {
    expect(compute()).toEqual({ ok: false, reason: 'closure-incomplete' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0]).toMatchObject({ strict: true, strictExtensions: false,
      legacyRequires: true, maxFiles: 4000, stopWhenIncomplete: true });
  } finally { spy.mockRestore(); }
});

it('protects all independent closures and retains every file when reference evidence is absent', () => {
  const evidence = name => ({ complete: true, files: new Set(['entry.mjs', `${name}.mjs`]),
    bareDeps: name === 'legacy', jsonNames: new Set([`${name}.json`]), spawnedNames: new Set([`${name}.mjs`]) });
  const spy = vi.spyOn(runClosure, 'collectRunClosure')
    .mockReturnValueOnce(evidence('legacy')).mockReturnValueOnce(evidence('required'))
    .mockReturnValueOnce(evidence('strict'));
  try {
    const result = compute({ 'strict.mjs': '', 'legacy.mjs': '', 'unrelated.mjs': '' });
    expect(result.ok).toBe(true);
    expect(result.closure.files).toEqual(new Set(['entry.mjs', 'strict.mjs', 'legacy.mjs', 'required.mjs']));
    expect(result.closure.bareDeps).toBe(true);
    expect(result.closure.jsonNames).toEqual(new Set(['strict.json', 'legacy.json', 'required.json']));
    expect(result.closure.spawnedNames).toEqual(new Set(['strict.mjs', 'legacy.mjs', 'required.mjs']));
    for (const call of spy.mock.calls) {
      expect(call[0].reader).toBe(spy.mock.calls[0][0].reader);
      expect(call[0].entries).toEqual(spy.mock.calls[0][0].entries);
    }
    for (const file of ['strict.mjs', 'legacy.mjs', 'required.mjs']) expect(isExcludable(file, result.scope)).toBe(false);
    expect(result.reason).toBe('closure-opaque');
    expect(isExcludable('unrelated.mjs', result.scope)).toBe(false);
  } finally { spy.mockRestore(); }
});

it.each([64, 65, 66])('preserves the 64-hop spawn bound for a %i-link chain with a conflict-retaining fallback', links => {
  const files = { 'entry.mjs': "spawn('node', ['./worker-0.mjs']);" };
  for (let i = 0; i < links; i++) {
    files[`worker-${i}.mjs`] = i + 1 < links ? `spawn('node', ['./worker-${i + 1}.mjs']);` : '';
  }
  const result = compute(files);
  if (links > 64) {
    expect(result).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  } else {
    expect(result.ok).toBe(true);
    expect(result.closure.files.has(`worker-${links - 1}.mjs`)).toBe(true);
  }
});

it.each([64, 65, 66])('shares the aggregate 64-hop bound across a %i-link mixed launch/reference chain', links => {
  const files = {};
  for (let i = 0; i <= links; i++) {
    const file = i === 0 ? 'entry.mjs' : `mixed-worker-${i}.mjs`;
    const next = `mixed-worker-${i + 1}.mjs`;
    files[file] = i === links ? '' : i % 2 === 0
      ? `spawn('node', ['./${next}']);` : `const next = '${next}';`;
  }
  const result = compute(files);
  if (links > 64) expect(result).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  else {
    expect(result.ok).toBe(true);
    expect(result.closure.files.has(`mixed-worker-${links}.mjs`)).toBe(true);
  }
});

it.each([64, 66])('counts only launches in a %i-link spawn chain separated by imports', links => {
  const files = { 'entry.mjs': "import './launcher-0.mjs';" };
  for (let i = 0; i < links; i++) {
    files[`launcher-${i}.mjs`] = `spawn('node', ['./worker-${i}.mjs']);`;
    files[`worker-${i}.mjs`] = i + 1 < links ? `import './launcher-${i + 1}.mjs';` : '';
  }
  const result = compute(files);
  if (links > 64) expect(result).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  else {
    expect(result.ok).toBe(true);
    expect(result.closure.files.has(`worker-${links - 1}.mjs`)).toBe(true);
  }
});

it('does not apply the spawn-hop bound to a 66-link import chain', () => {
  const files = { 'entry.mjs': "import './module-0.mjs';" };
  for (let i = 0; i < 66; i++) {
    files[`module-${i}.mjs`] = i + 1 < 66 ? `import './module-${i + 1}.mjs';` : '';
  }
  const result = compute(files);
  expect(result.ok).toBe(true);
  expect(result.closure.files.has('module-65.mjs')).toBe(true);
});

it('uses the shortest launch depth for shared targets and terminates spawn cycles', () => {
  const files = { 'entry.mjs': "import './worker-32.mjs'; spawn('node', ['./worker-0.mjs']);" };
  for (let i = 0; i < 66; i++) {
    files[`worker-${i}.mjs`] = `spawn('node', ['./worker-${(i + 1) % 66}.mjs']);`;
  }
  const result = compute(files);
  expect(result.ok).toBe(true);
  expect(result.closure.files.has('worker-65.mjs')).toBe(true);
});

it('keeps the launch-depth refusal when continuing to scan heuristic spawn targets', () => {
  const files = { 'entry.mjs': "spawn('node', ['./worker-0.mjs']);" };
  for (let i = 0; i < 66; i++) {
    files[`worker-${i}.mjs`] = i + 1 < 66 ? `spawn('node', ['./worker-${i + 1}.mjs']);` : '';
  }
  const snapshot = reader(files);
  const closure = collectRunClosure({ root: snapshot.root, reader: snapshot,
    entries: ['entry.mjs'], strict: true, byName: () => [] });
  expect(closure.complete).toBe(false);
});

it('protects manifests, lockfiles, configs, named JSON, runtime reads and executables unconditionally', () => {
  const result = compute({ 'entry.mjs': "const config = 'policy.json';", 'data/policy.json': '{}' });
  expect(result.ok).toBe(true);
  expect(result.scope.has('data/policy.json')).toBe(true);
  for (const p of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', '.npmrc',
    'daemon-rebuild-settings.json', 'nested/package.json', 'skills-src/readme.md', '.claude/prompt.md',
    'run.sh', 'config.toml', 'unused.ts']) expect(isExcludable(p, result.scope), p).toBe(false);
  expect(isExcludable('other/policy.json', result.scope)).toBe(false);
});

it('fails closed on non-literal dynamic imports with a conflict-retaining fallback', () => {
  expect(compute({ 'entry.mjs': 'import(target);' })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it.each([
  'import /* load selected worker */ (process.env.TARGET)',
  'import // load selected worker\n (process.env.TARGET)',
  'import /* first */ /* second */ (process.env.TARGET)',
  'import // worker\u2028 (process.env.TARGET)',
  'import // worker\u2029 (process.env.TARGET)',
  'import\r\n(process.env.TARGET)',
  'import( /* load selected worker */ process.env.TARGET)',
  'import(\n process.env.TARGET\n)',
  'import("./" + process.env.TARGET)',
  'import(`./${process.env.TARGET}`)',
])('fails closed on unresolved dynamic import syntax: %s', expression => {
  expect(compute({ 'entry.mjs': `export async function tick(){ return ${expression}; }`,
    'worker.mjs': 'export function runOverlay() {}' }))
    .toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it.each(["'./prompt.md'", '"./prompt.md"', '`./prompt.md`'])('retains runtime Markdown read via URL literal %s', literal => {
  const result = compute({ 'entry.mjs': `import { readFileSync } from 'node:fs';
    export function tick(){return readFileSync(new URL(${literal}, import.meta.url), 'utf8');}`,
    'prompt.md': 'overlay prompt', 'docs/unrelated.md': 'unrelated' });
  expect(result.ok).toBe(true);
  expect(isExcludable('prompt.md', result.scope)).toBe(false);
});

it('retains Markdown even when runtime paths are computed or hidden in test/backlog directories', () => {
  const result = compute({ 'entry.mjs': "export function tick(){ return readFileSync(process.env.PROMPT, 'utf8'); }" });
  expect(result.ok).toBe(true);
  for (const path of ['prompt.md', 'docs/Prompt.MD', 'tests/prompt.md', 'backlog/prompt.md']) {
    expect(isExcludable(path, result.scope), path).toBe(false);
  }
});

it('retains JSON read through computed runtime paths, including test and backlog data', () => {
  const result = compute({ 'entry.mjs': 'export function tick(dir, name){ return readFileSync(`${dir}/${name}.json`, "utf8"); }',
    'data/foo.json': '{"value":"overlay"}' });
  expect(result.ok).toBe(true);
  for (const path of ['data/foo.json', 'data/FOO.JSON', 'tests/fixture.json', 'backlog/state.json']) {
    expect(isExcludable(path, result.scope), path).toBe(false);
  }
});

it.each([
  "import /* worker */ ('./worker.mjs')",
  "import( /* worker */ './worker.mjs')",
  'import(`./worker.mjs`)',
  "import('./work\\u0065r.mjs')",
])('walks literal dynamic imports without losing their dependencies: %s', expression => {
  const result = compute({ 'entry.mjs': `export const tick = () => ${expression};`,
    'worker.mjs': 'export function runOverlay() {}' });
  expect(result.ok).toBe(true);
  expect(isExcludable('worker.mjs', result.scope)).toBe(false);
});

it('ignores import-like prose in comments, strings and regular expressions', () => {
  const result = compute({ 'entry.mjs': `// import(target)
    /* import /* selected worker */
    const text = 'import /* selected worker */ (target)';
    const pattern = /import\\s*\\(target\\)/;
    export {};` });
  expect(result.ok).toBe(true);
});

it('fails closed when import syntax cannot be parsed', () => {
  expect(compute({ 'entry.mjs': 'export const tick = () => import /* worker */ (' }))
    .toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it('fails closed when any requested entry is unreadable, even if other entries exist', () => {
  expect(compute({}, { entries: ['entry.mjs', 'missing.mjs'] })).toMatchObject({ ok: false, reason: 'entries-unreadable' });
});

it('fails closed on a missing relative dependency or an overlay deleting a reachable file', () => {
  expect(compute({ 'entry.mjs': "import './missing.mjs';" })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  expect(compute({ 'entry.mjs': "import './used.mjs';", 'used.mjs': '' }, {
    overlayChangedFiles: new Map([['used.mjs', null]]),
  })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it('protects default rebuild mechanism directory entries', () => {
  const result = compute();
  expect(isExcludable('scripts/lib/daemon-rebuild/new.mjs', result.scope)).toBe(false);
});

it('fails closed when the reader cannot list the snapshot', () => {
  expect(compute({}, { reader: { listFiles() { throw new Error('EIO'); } } }))
    .toMatchObject({ ok: false, reason: 'scope-unreadable' });
});

it('fails closed above 4000 closure files', () => {
  const files = { 'entry.mjs': Array.from({ length: 4000 }, (_, i) => `import './f${i}.mjs';`).join('\n') };
  for (let i = 0; i < 4000; i++) files[`f${i}.mjs`] = '';
  expect(compute(files)).toMatchObject({ ok: false, reason: 'closure-too-large' });
});

it('extends the fixpoint only by reachable excluded paths and never mutates its inputs', () => {
  const scope = new Set(['entry.mjs']);
  const add = fixpointExtend({ scope, excluded: ['a.mjs', 'b.mjs'],
    finalClosure: { complete: true, files: new Set(['entry.mjs', 'a.mjs', 'other.mjs']) } });
  expect(add).toEqual(['a.mjs']);
  expect([...scope]).toEqual(['entry.mjs']);
  expect(() => fixpointExtend({ scope, excluded: [], finalClosure: { complete: false, files: new Set() } })).toThrow();
});

it('R210 protects existing Markdown read through an unresolvable runtime path', () => {
  const result = compute({ 'entry.mjs': 'export const tick = name => readFileSync(name);',
    'tests/runtime-prompt.md': 'runtime data' });
  expect(result.ok).toBe(true);
  expect(isExcludable('tests/runtime-prompt.md', result.scope)).toBe(false);
});

it('R210 protects files named only in comments and walks their dependencies', () => {
  const result = compute({ 'entry.mjs': '// import ./comment-worker.mjs\nexport {};',
    'comment-worker.mjs': "import './comment-dependency.mjs';", 'comment-dependency.mjs': '' });
  expect(result.ok).toBe(true);
  for (const path of ['comment-worker.mjs', 'comment-dependency.mjs']) {
    expect(isExcludable(path, result.scope), path).toBe(false);
  }
});

it('R210 refuses a tree containing a symlinked LaunchAgent and protects its target', () => {
  const files = { ...Object.fromEntries(smokeSurfaceEntries({}).map(p => [p, ''])),
    'entry.mjs': "const agent = '~/Library/LaunchAgents/agent.mjs';",
    'Library/LaunchAgents/agent.mjs': '../../target.mjs', 'target.mjs': '' };
  const blobs = new Map(Object.entries(files).map(([path, source], i) =>
    [String(i + 1).padStart(40, '0'), { path, source }]));
  const git = (args, options = {}) => ({ status: 0, stdout: args[0] === 'ls-tree'
    ? [...blobs].map(([oid, { path }]) =>
      `${path === 'Library/LaunchAgents/agent.mjs' ? '120000' : '100644'} blob ${oid}\t${path}\0`).join('')
    : Buffer.concat(options.input.trim().split('\n').map(oid => {
      const source = blobs.get(oid).source;
      return Buffer.from(`${oid} blob ${Buffer.byteLength(source)}\n${source}\n`);
    })) });
  const result = computeClosureScope({ git, mainSha: 'fixture', entries: ['entry.mjs'], env: {} });
  for (const path of ['Library/LaunchAgents/agent.mjs', 'target.mjs']) {
    expect(result.ok ? isExcludable(path, result.scope) : false, path).toBe(false);
  }
});

it('R210 walks literal CommonJS require and its transitive imports', () => {
  const result = compute({ 'entry.mjs': "require('./required');",
    'required.cjs': "require('./dependency');", 'dependency.cjs': '' });
  expect(result.ok).toBe(true);
  expect(result.closure.files.has('required.cjs')).toBe(true);
  expect(isExcludable('dependency.cjs', result.scope)).toBe(false);
});

it.each([
  'require(process.env.MODULE)',
  "import { createRequire as makeRequire } from 'node:module'; const load = makeRequire(import.meta.url); load(target);",
  "const load = module.createRequire(import.meta.url); load(target);",
  'const { createRequire: make } = module; const load = make(import.meta.url); load(target);',
])('R210 refuses unresolved CommonJS loading: %s', source => {
  expect(compute({ 'entry.mjs': source })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it('R210 protects explicitly spawned tests and their dependencies', () => {
  const result = compute({ 'entry.mjs': "spawn('node', ['scripts/__tests__/worker.test.mjs']);",
    'scripts/__tests__/worker.test.mjs': "import './test-helper.mjs';", 'scripts/__tests__/test-helper.mjs': '' });
  expect(result.ok).toBe(true);
  for (const path of ['scripts/__tests__/worker.test.mjs', 'scripts/__tests__/test-helper.mjs']) {
    expect(isExcludable(path, result.scope), path).toBe(false);
  }
});

it.each(["'worker.test.mjs'", '`prefix/${name}/worker.test.mjs`', "'worker\\u002etest.mjs'"])(
  'R210 protects every existing file named by a string or template basename: %s', literal => {
    const result = compute({ 'entry.mjs': `const name = ${literal};`,
      'tests/worker.test.mjs': '', 'other/worker.test.mjs': '' });
    expect(result.ok).toBe(true);
    for (const path of ['tests/worker.test.mjs', 'other/worker.test.mjs']) {
      expect(isExcludable(path, result.scope), path).toBe(false);
    }
  });

it('R210 protects unknown extensions even in test and backlog directories', () => {
  const result = compute();
  expect(result.ok).toBe(true);
  for (const path of ['tests/runtime.wasm', '__tests__/fixture.bin', 'backlog/worker.custom', 'tests/worker.mjsx']) {
    expect(isExcludable(path, result.scope), path).toBe(false);
  }
});

it.each(["spawn('node', [target])", 'child_process.exec(command)', 'fork(target)',
  "spawn('unknown-runner', ['worker'])", "spawn('node', ['${worker}.mjs'])",
  "import { spawn as launch } from 'node:child_process'; launch('node', [target]);",
  "const launch = spawn; launch('node', [target]);",
  "import * as cp from 'node:child_process'; cp[method]('node', [target]);",
  "spawn('node', ['missing-worker.mjs'])", "fork('./missing-worker.mjs')",
  "spawnSync(process.execPath, ['missing-worker.mjs'])", "exec('node missing-worker.mjs --flag')",
  "execFile('node', ['missing-worker.mjs'])",
  "spawn('node', ['~/Library/LaunchAgents/alias.mjs'])"])(
  'R210 refuses unresolved process launch patterns: %s', source => {
    expect(compute({ 'entry.mjs': source })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  });

it.each([
  'const launch = cp.spawn;',
  "const launch = cp['spawn'];",
  'const launch = cp[`spawn`];',
  "const launch = cp['sp\\u0061wn'];",
  'const { spawn: launch } = cp;',
])('R210 refuses escaped launch capabilities through aliases: %s', alias => {
  expect(compute({
    'entry.mjs': `import * as cp from 'node:child_process'; ${alias}
      const target = process.env.WORKER; launch('node', [target]);`,
    'unreferenced-worker.mjs': 'export {};',
  })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it('R210 refuses unresolved launch paths even when their basenames exist in the snapshot', () => {
  for (const target of ['missing/worker.mjs', '~/Library/LaunchAgents/worker.mjs']) {
    expect(compute({ 'entry.mjs': `spawn('node', ['${target}']);`, 'worker.mjs': '' }))
      .toMatchObject({ ok: false, reason: 'closure-incomplete' });
  }
});

it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync'])(
  'R210 refuses shell-enabled launches with wildcard targets: %s', launch => {
    expect(compute({
      'entry.mjs': `${launch}('node', ['worker.mjs', ';', 'node', 'hidden-*.mjs'], { shell: true });`,
      'worker.mjs': '', 'hidden-a.mjs': "import './hidden-dependency.mjs';", 'hidden-dependency.mjs': '',
    })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  });

it.each([
  "{ shell: '/bin/sh' }", '{ shell: enabled }', '{ shell }', 'options',
  '{ ...options }', '{ shell: false, ...options }', "{ ['she' + 'll']: true }",
  '{ get shell() { return true; } }', '{ __proto__: options }',
])('R210 refuses launch options whose shell behavior is unproven: %s', options => {
  expect(compute({
    'entry.mjs': `spawn('node', ['worker.mjs', ';', 'node', 'hidden-*.mjs'], ${options});`,
    'worker.mjs': '', 'hidden-a.mjs': '',
  })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it.each(['exec', 'execSync'])('R210 refuses implicit shell execution: %s', launch => {
  expect(compute({ 'entry.mjs': `${launch}('node worker.mjs --flag');`, 'worker.mjs': '' }))
    .toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it.each(['{}', '{ shell: false }', "{ 'shell': false, stdio: 'inherit' }"])(
  'R210 walks literal argv when launch options prove the shell disabled: %s', options => {
    const result = compute({
      'entry.mjs': `spawn('node', ['worker.mjs', ';', 'node', 'hidden-*.mjs'], ${options});`,
      'worker.mjs': "import './dependency.mjs';", 'dependency.mjs': '', 'hidden-a.mjs': '',
    });
    expect(result.ok).toBe(true);
    for (const path of ['worker.mjs', 'dependency.mjs']) expect(result.closure.files.has(path), path).toBe(true);
  });

it.each(["fork('./worker.mjs')", "spawnSync(process.execPath, ['./worker.mjs'])",
  "import * as cp from 'node:child_process'; cp['spawn']('node', ['./worker.mjs'])",
  "execFile('node', ['./worker.mjs'])"])(
  'R210 walks resolved launch targets and their transitive imports: %s', source => {
    const result = compute({ 'entry.mjs': source, 'worker.mjs': "import './dependency.mjs';", 'dependency.mjs': '' });
    expect(result.ok).toBe(true);
    for (const path of ['worker.mjs', 'dependency.mjs']) expect(result.closure.files.has(path), path).toBe(true);
  });

it.each(['export const tick = name => readFileSync(name);',
  'const read = fs.readFileSync; export const tick = name => read(name);',
  "const read = fs['readFileSync']; export const tick = name => read(name);",
  'const { readFileSync: read } = fs; export const tick = name => read(name);',
  "import { readFileSync as read } from 'node:fs'; export const tick = name => read(name);"])(
  'R210 protects code when a runtime read can select any existing file: %s', source => {
  const result = compute({ 'entry.mjs': source, 'runtime.js': '' });
  expect(result.ok).toBe(true);
  expect(isExcludable('runtime.js', result.scope)).toBe(false);
});

it('R210 refuses an imported file type whose dependencies it cannot parse', () => {
  expect(compute({ 'entry.mjs': "import './worker.custom';", 'worker.custom': '' }))
    .toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it('R210 red-team 1 protects computed reads through every filesystem module binding', () => {
  for (const module of ['node:fs', 'node:fs/promises', 'fs', 'fs/promises']) {
    for (const name of ['createReadStream', 'readlink', 'opendir', 'cp', 'glob', 'futureExport']) {
      const result = compute({ 'entry.mjs': `import { ${name} as capability } from '${module}';
        capability(new URL(process.argv[2], import.meta.url));`, 'tests/selected.test.mjs': '' });
      expect(result.ok ? isExcludable('tests/selected.test.mjs', result.scope) : false, `${module}:${name}`).toBe(false);
    }
  }
});

it('R210 red-team 2 protects string-keyed filesystem destructuring and escaped namespace capabilities', () => {
  for (const use of ["const {'readFileSync': read} = fs; read(path);",
    'const { [key]: read } = fs; read(path);', 'const copy = { ...fs }; copy[key](path);',
    'const alias = fs; callbacks.map(alias[key]);', 'consume(fs.futureExport);']) {
    const result = compute({ 'entry.mjs': `import fs from 'node:fs'; ${use}`, 'tests/selected.test.mjs': '' });
    expect(result.ok ? isExcludable('tests/selected.test.mjs', result.scope) : false, use).toBe(false);
  }
  for (const source of ["const {'readFileSync': read} = require('node:fs'); read(path);",
    "const fs = await import('node:fs/promises'); consume(fs[key]);",
    "export * from 'node:fs';", "import fs = require('node:fs'); consume(fs);"]) {
    const result = compute({ 'entry.mjs': source, 'tests/selected.test.mjs': '' });
    expect(result.ok ? isExcludable('tests/selected.test.mjs', result.scope) : false, source).toBe(false);
  }
});

it('R210 red-team 3 refuses string-keyed child-process destructuring with a computed test target', () => {
  expect(compute({ 'entry.mjs': `import * as cp from 'node:child_process';
    const {'execFileSync': run} = cp; run(process.execPath, [process.argv[2]]);`,
  'tests/selected.test.mjs': '' })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it('R210 red-team 4 refuses computed worker targets through module binding provenance', () => {
  for (const source of ["import { Worker } from 'node:worker_threads'; new Worker(new URL(process.argv[2], import.meta.url));",
    "import * as workers from 'node:worker_threads'; const Alias = workers.Worker; new Alias(target);",
    "const { 'Worker': Run } = require('node:worker_threads'); new Run(target);",
    "import { Script as Run } from 'node:vm'; callbacks.map(Run);",
    "import * as mod from 'node:module'; const { [key]: run } = mod; run(target);",
    "import { futureExport as run } from 'node:child_process'; run(target);",
    "export * from 'node:vm';",
    "const cp = await import('node:child_process'); cp[key](target);",
    "import cp from 'node:child_process'; const copy = { ...cp }; copy[key](target);"]) {
    expect(compute({ 'entry.mjs': source, 'tests/selected.test.mjs': '' }), source)
      .toMatchObject({ ok: false, reason: 'closure-incomplete' });
  }
});

it('R210 red-team 5 refuses unproven launch preloads in execArgv and environment options', () => {
  for (const options of ["{execArgv:['--require', process.env.PRELOAD]}",
    "{execArgv:['--import', target]}", "{execArgv:['--loader', target]}",
    '{env: {NODE_OPTIONS: process.env.PRELOAD}}', '{env: process.env}', '{execPath: process.env.RUNNER}',
    "{execArgv:['--require', './preload.mjs']}"]) {
    expect(compute({ 'entry.mjs': `fork('./worker.mjs', [], ${options});`, 'worker.mjs': '',
      'tests/preload.test.mjs': '' }), options).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  }
});

it('R210 package resolution retains the conflict on missing, cyclic, wildcard and unreadable evidence', () => {
  for (const manifest of ['not json', 'null', '{"main": 42}', '{"main":"."}',
    '{"main":"./missing"}', '{"exports":"./*.mjs"}', '{"exports":"../../outside.mjs"}']) {
    expect(compute({ 'entry.mjs': "require('./pkg');", 'pkg/package.json': manifest, 'pkg/index.js': '' }), manifest)
      .toMatchObject({ ok: false, reason: 'closure-incomplete' });
  }
  const snapshot = reader({ ...Object.fromEntries(smokeSurfaceEntries({}).map(p => [p, ''])),
    'entry.mjs': "require('./pkg');", 'pkg/package.json': '{}', 'pkg/index.js': '' });
  const read = snapshot.readFile;
  snapshot.readFile = path => {
    if (path.endsWith('/pkg/package.json')) throw new Error('EACCES');
    return read(path);
  };
  expect(compute({}, { reader: snapshot })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it('R210 admits main pointing to an existing index candidate and protects its dependencies', () => {
  const result = compute({ 'entry.mjs': "require('./pkg');",
    'pkg/package.json': JSON.stringify({ main: './index.js' }),
    'pkg/index.js': "require('./dependency');", 'pkg/dependency.js': '', 'unrelated.js': '' });
  expect(result.ok).toBe(true);
  for (const path of ['pkg/index.js', 'pkg/dependency.js']) {
    expect(result.closure.files.has(path), path).toBe(true);
    expect(isExcludable(path, result.scope), path).toBe(false);
  }
  expect(isExcludable('unrelated.js', result.scope)).toBe(true);
});

it('R210 admits main and exports sharing a resolved target and protects its dependencies', () => {
  const result = compute({ 'entry.mjs': "require('./pkg');",
    'pkg/package.json': JSON.stringify({ main: './entry.js',
      exports: { '.': { import: './entry.js', require: './entry.js' } } }),
    'pkg/index.js': '', 'pkg/entry.js': "require('./dependency');",
    'pkg/dependency.js': '', 'unrelated.js': '' });
  expect(result.ok).toBe(true);
  for (const path of ['pkg/index.js', 'pkg/entry.js', 'pkg/dependency.js']) {
    expect(result.closure.files.has(path), path).toBe(true);
    expect(isExcludable(path, result.scope), path).toBe(false);
  }
  expect(isExcludable('unrelated.js', result.scope)).toBe(true);
});

it('R210 package resolution retains the conflict above the existing 4000-file closure bound', () => {
  const files = { 'entry.mjs': "require('./pkg');", 'pkg/index.js': '' };
  const exports = {};
  for (let i = 0; i < 4000; i++) {
    exports[`condition${i}`] = `./target-${i}.mjs`;
    files[`pkg/target-${i}.mjs`] = '';
  }
  files['pkg/package.json'] = JSON.stringify({ exports });
  expect(compute(files)).toMatchObject({ ok: false, reason: 'closure-too-large' });
});

it('R210 red-team 6 walks every extension, index and package manifest resolution candidate', () => {
  const files = { 'entry.mjs': "require('./chosen'); require('./pkg');",
    'chosen.mjs': "import './mjs-dependency.mjs';", 'chosen.js': "import './js-dependency.mjs';",
    'chosen.cjs': '', 'chosen/index.js': '', 'chosen/index.cjs': '', 'chosen/index.mjs': '',
    'mjs-dependency.mjs': '', 'js-dependency.mjs': '',
    'pkg/package.json': JSON.stringify({ main: './main', exports: { '.': { import: './esm.mjs', require: './cjs.cjs' } } }),
    'pkg/main.js': "import './main-dependency.mjs';", 'pkg/esm.mjs': '', 'pkg/cjs.cjs': '',
    'pkg/main-dependency.mjs': '', 'pkg/index.js': '', 'pkg/index.cjs': '' };
  const result = compute(files);
  expect(result.ok).toBe(true);
  for (const path of Object.keys(files)) {
    expect(isExcludable(path, result.scope), path).toBe(false);
    if (!path.endsWith('.json')) expect(result.closure.files.has(path), path).toBe(true);
  }
});

it('R210 walks every exports array target and its transitive dependencies', () => {
  const targets = ['first.mjs', 'second.cjs', 'third.mjs', 'fourth.cjs'];
  const files = { 'entry.mjs': "require('./pkg');", 'pkg/index.js': '',
    'pkg/package.json': JSON.stringify({ exports: { '.': [
      './first.mjs', './second.cjs', { default: ['./third.mjs', './fourth.cjs'] },
    ] } }) };
  for (const target of targets) {
    files[`pkg/${target}`] = `import './${target}-dependency.mjs';`;
    files[`pkg/${target}-dependency.mjs`] = '';
  }
  const result = compute(files);
  expect(result.ok).toBe(true);
  for (const target of targets) {
    for (const path of [`pkg/${target}`, `pkg/${target}-dependency.mjs`]) {
      expect(result.closure.files.has(path), path).toBe(true);
      expect(isExcludable(path, result.scope), path).toBe(false);
    }
  }
});
