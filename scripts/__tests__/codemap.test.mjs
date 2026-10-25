import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_MODEL, buildCodexDirectTaskArgv, buildCodexPrompt } from '../codex-direct-task.mjs';
import { FENCED_DATA_RULE, fenceUntrusted } from '../lib/mandate-fence.mjs';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(scriptsDir, 'codemap.mjs');
const TIMEOUT = 9 * 60 * 1000;
const MAX_BUFFER = 32 * 1024 * 1024;
const entryName = path => `${path.replaceAll('/', '__')}.md`;

function command(bin, args, cwd) {
  const result = spawnSync(bin, args, {
    cwd, env: fixtureEnv(cwd), encoding: 'utf8', timeout: TIMEOUT, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${bin} failed (${result.error?.code ?? result.signal ?? result.status}); fix the command and rerun`);
  }
  return result.stdout;
}

function fixtureEnv(root, home) {
  return { ...process.env, PATH: `${join(dirname(root), 'bin')}${delimiter}${process.env.PATH}`,
    ...(home ? { HOME: home, USERPROFILE: home } : {}) };
}

// Model Git's read-only queries without creating or writing any .git directory.
// Source bytes are hashed by the real git hash-object (without -w).
function installGitStandIn(root, paths) {
  const fixture = dirname(root);
  const bin = join(fixture, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(fixture, 'tracked.json'), JSON.stringify(paths));
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const paths = JSON.parse(fs.readFileSync(${JSON.stringify(join(fixture, 'tracked.json'))}, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'rev-parse') console.log(${JSON.stringify(root)});
else if (args[0] === 'ls-files') process.stdout.write(paths.join('\\0') + '\\0');
else if (args[0] === 'hash-object') {
  const result = cp.spawnSync('git', args, {
    env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH)} }, encoding: 'utf8',
  });
  process.stdout.write(result.stdout); process.exit(result.status ?? 1);
} else if (args[0] === 'grep') {
  const found = paths.filter(path => fs.existsSync(path) && fs.readFileSync(path, 'utf8').includes(args.at(-1)));
  process.stdout.write(found.length ? found.join('\\0') + '\\0' : '');
  process.exit(found.length ? 0 : 1);
} else { console.error('Unexpected git operation'); process.exit(2); }
`, { mode: 0o755 });
}

const subject = 'scripts/subject.mjs';
const bodyLines = ['Purpose: Describe the module.', 'A concrete second purpose line.',
  'Exports: subject()', 'CLI: none', 'Settings: none', 'Lines: subject:1'];
const block = (path = subject, lines = bodyLines) => `=== ${path} ===\n${lines.join('\n')}\n=== END ===`;
const report = (lastMessage = block(), extra = {}) => ({ exitCode: 0, timedOut: false, lastMessage,
  events: { usage: { input_tokens: 10, cached_input_tokens: 8, output_tokens: 2 } }, ...extra });

function snapshot(dir) {
  if (!existsSync(dir)) return null;
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => [entry.name, entry.isDirectory() ? snapshot(join(dir, entry.name))
      : readFileSync(join(dir, entry.name), 'utf8')]));
}

function withFixture(fn, files = { [subject]: 'export function subject() {}\n' }) {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'codemap-contract-')));
  const root = join(fixture, 'repo');
  const home = join(fixture, 'home');
  const out = join(home, 'workspace', '.operations', 'codemap');
  mkdirSync(root); mkdirSync(home);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  installGitStandIn(root, Object.keys(files));
  const stub = (stdout = JSON.stringify(report()), code = 0) => {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts/codex-direct-task.mjs'), `
import { appendFileSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const task = readFileSync(argv.find(arg => arg.startsWith('--task-file=')).slice(12), 'utf8');
appendFileSync(${JSON.stringify(join(fixture, 'calls.jsonl'))}, JSON.stringify({ argv, task, cwd: process.cwd() }) + '\\n');
process.stdout.write(${JSON.stringify(stdout)});
process.exit(${code});
`);
  };
  stub();
  const run = (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root, env: fixtureEnv(root, home), encoding: 'utf8', timeout: 30_000,
      killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER,
    });
    assert.ifError(result.error);
    return result;
  };
  const calls = () => existsSync(join(fixture, 'calls.jsonl'))
    ? readFileSync(join(fixture, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const manifest = () => JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  const seed = (paths = Object.keys(files)) => {
    mkdirSync(out, { recursive: true });
    const entries = Object.fromEntries(paths.map(path => {
      writeFileSync(join(out, entryName(path)), 'Purpose: OLD summary\n');
      return [path, hash(root, path)];
    }));
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(entries));
    writeFileSync(join(out, 'index.md'), 'OLD index\n');
  };
  try { return fn({ root, home, out, stub, run, calls, manifest, seed }); }
  finally { rmSync(fixture, { recursive: true, force: true }); }
}

function hash(root, path) {
  return command('git', ['hash-object', '--', path], root).trim();
}

function verifyRetry(executable) {
  const fixture = mkdtempSync(join(tmpdir(), 'codemap-regression-'));
  try {
    const root = join(fixture, 'repo');
    const home = join(fixture, 'home');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(home);
    const path = 'scripts/subject.mjs';
    const before = 'export function before() {}\n';
    const after = 'export function after() {}\n';
    writeFileSync(join(root, path), before);
    installGitStandIn(root, [path]);
    const initialHash = hash(root, path);
    const body = [
      `=== ${path} ===`, 'Purpose: Summarize the original source.',
      'This answer predates a concurrent edit.', 'Exports: before()',
      'CLI: none', 'Settings: none', 'Lines: before:1', '=== END ===',
    ].join('\n');
    // A local stand-in mutates the source only after the production initial hash,
    // at the precise point where the real read-only summarizer would return.
    writeFileSync(join(root, 'scripts/codex-direct-task.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(after)});
console.log(JSON.stringify(${JSON.stringify({
  exitCode: 0, timedOut: false, lastMessage: body,
  events: { usage: { input_tokens: 1, output_tokens: 1 } },
})}));
`);
    const result = spawnSync(process.execPath, [executable, `--root=${root}`], {
      cwd: root, env: fixtureEnv(root, home),
      encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER,
    });
    assert.ifError(result.error);
    assert.equal(readFileSync(join(root, path), 'utf8'), after, 'fixture must change the source');
    assert.notEqual(hash(root, path), initialHash, 'fixture must change the initial hash');
    const out = join(home, 'workspace', '.operations', 'codemap');
    assert.equal(existsSync(join(out, entryName(path))), false, 'changed source must not have a summary');
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.equal(Object.hasOwn(manifest, path), false, 'changed source hash must not be checkpointed');
    assert.equal(readFileSync(join(out, 'index.md'), 'utf8'), '', 'pending source must not be indexed');
    assert.equal(result.status, 1, 'pending source must report an incomplete run');
    assert.match(result.stdout, /Source changed during generation, will retry:/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test('source changed after initial hashing is neither written nor checkpointed', () => {
  verifyRetry(script);
});
test('source-change regression test rejects removal of the hash guard', () => {
  // Node resolves module symlinks; match argv[1] to import.meta.url for the entry-point check.
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'codemap-mutation-')));
  try {
    const source = readFileSync(script, 'utf8');
    const guard = 'if (hash(root, path) !== hashes[path]) {';
    assert.ok(source.includes(guard), 'mutation must target the production guard');
    const mutant = join(fixture, 'codemap.mjs');
    mkdirSync(join(fixture, 'lib'));
    writeFileSync(join(fixture, 'lib/mandate-fence.mjs'),
      readFileSync(join(scriptsDir, 'lib/mandate-fence.mjs')));
    writeFileSync(mutant, source.replace(guard, 'if (false) {'));
    assert.throws(() => verifyRetry(mutant), /changed source must not have a summary/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('unchanged default invocation skips Codex and preserves the checkpoint', () => withFixture(f => {
  assert.equal(f.run().status, 0);
  const before = snapshot(f.out);
  const result = f.run();
  assert.equal(result.status, 0);
  assert.equal(f.calls().length, 1, 'second unchanged run must not invoke Codex');
  assert.match(result.stdout, /0 changed\/new, 1 skipped/);
  assert.deepEqual(snapshot(f.out), before);
}));

test('tracked script and skill modules receive summaries only outside the repository', () => withFixture(f => {
  const paths = [subject, 'skills-src/example/helper.mjs'];
  f.stub(JSON.stringify(report(paths.map(path => block(path)).join('\n'))));
  writeFileSync(join(f.root, 'scripts/untracked.mjs'), 'export const untracked = true;');
  const before = snapshot(f.root);
  assert.equal(f.run().status, 0);
  assert.deepEqual(snapshot(f.root), before, 'generation must not write repository files');
  assert.deepEqual(f.manifest(), Object.fromEntries(paths.map(path => [path, hash(f.root, path)])));
  assert.deepEqual(readdirSync(f.out).sort(), [...paths.map(entryName), 'index.md', 'manifest.json'].sort());
  for (const path of paths) assert.match(readFileSync(join(f.out, entryName(path)), 'utf8'), /Lines: subject:1/);
}, { [subject]: 'export function subject() {}', 'skills-src/example/helper.mjs': 'export const helper = 1;' }));

test('deleted source removes its summary and manifest and index entries', () => withFixture(f => {
  f.seed();
  rmSync(join(f.root, subject));
  assert.equal(f.run().status, 0);
  assert.equal(existsSync(join(f.out, entryName(subject))), false);
  assert.deepEqual(f.manifest(), {});
  assert.equal(readFileSync(join(f.out, 'index.md'), 'utf8'), '');
  assert.equal(f.calls().length, 0);
}));

test.each(['missing block', 'failed process', 'timeout report', 'concurrent edit'])(
  'changed source loses its directly addressable stale summary after %s', kind => withFixture(f => {
    f.seed();
    writeFileSync(join(f.root, subject), 'export const changed = 1;');
    if (kind === 'missing block') f.stub(JSON.stringify(report('')));
    if (kind === 'failed process') f.stub('', 1);
    if (kind === 'timeout report') f.stub(JSON.stringify(report(block(), { timedOut: true })));
    if (kind === 'concurrent edit') writeFileSync(join(f.root, 'scripts/codex-direct-task.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(f.root, subject))}, 'export const concurrent = 2;');
console.log(${JSON.stringify(JSON.stringify(report()))});
`);
    assert.equal(f.run().status, 1);
    assert.equal(existsSync(join(f.out, entryName(subject))), false, 'stale summary must be removed');
    assert.deepEqual(f.manifest(), {});
    assert.equal(readFileSync(join(f.out, 'index.md'), 'utf8'), '');
  }));

test('limit defers changed entries while removing their stale summaries and checkpoint entries', () => withFixture(f => {
  f.seed(['scripts/z-deferred.mjs']);
  const deferred = 'scripts/z-deferred.mjs';
  writeFileSync(join(f.root, deferred), 'export const changed = 2;');
  f.stub(JSON.stringify(report(block('scripts/a-new.mjs'))));
  assert.equal(f.run('--batch=1', '--limit=1').status, 0);
  assert.equal(f.calls().length, 1);
  assert.equal(existsSync(join(f.out, entryName(deferred))), false, 'deferred stale summary must be removed');
  assert.deepEqual(Object.keys(f.manifest()), ['scripts/a-new.mjs']);
  assert.doesNotMatch(readFileSync(join(f.out, 'index.md'), 'utf8'), /z-deferred/);
  f.stub(JSON.stringify(report(block(deferred))));
  assert.equal(f.run().status, 0, 'default rerun must recover deferred entries');
  assert.deepEqual(Object.keys(f.manifest()).sort(), ['scripts/a-new.mjs', deferred]);
}, { 'scripts/a-new.mjs': 'export const a = 1;', 'scripts/z-deferred.mjs': 'export const z = 1;' }));

test('missing summary is regenerated even when the manifest hash is unchanged', () => withFixture(f => {
  f.seed(); rmSync(join(f.out, entryName(subject)));
  assert.equal(f.run().status, 0);
  assert.equal(f.calls().length, 1);
  assert.match(readFileSync(join(f.out, entryName(subject)), 'utf8'), /Lines:/);
}));

test('summarizer receives read-only invocation and fenced untrusted source paths', () => withFixture(f => {
  assert.equal(f.run().status, 0);
  const [{ argv, task, cwd }] = f.calls();
  for (const flag of ['--review', '--task-kind=review', '--json', '--no-stream']) assert.ok(argv.includes(flag), flag);
  assert.ok(argv.includes(`--dir=${f.root}`));
  assert.ok(argv.includes(`--timeout-ms=${TIMEOUT}`));
  assert.equal(cwd, f.root);
  assert.ok(task.includes(FENCED_DATA_RULE));
  assert.ok(task.includes(fenceUntrusted('material', JSON.stringify([subject], null, 2))));
  assert.match(task, /do not edit files, run tests, spawn agents, or perform a review loop/);
  // Exercise the real runner's permission builder using the invocation captured at the boundary.
  const enforced = buildCodexDirectTaskArgv({ cwd, review: argv.includes('--review'),
    taskKind: argv.find(arg => arg.startsWith('--task-kind=')).slice(12),
    route: { model: CODEX_MODEL, effort: 'low' }, writableRoots: [f.root] });
  assert.equal(enforced[enforced.indexOf('-s') + 1], 'read-only');
  assert.equal(enforced.some(arg => arg.includes('sandbox_workspace_write')), false);
  const prompt = buildCodexPrompt(task, { review: true, policy: {} });
  assert.ok(prompt.includes(task.trim()), 'the runner must preserve the summarizer mandate and fence');
  assert.match(prompt, /This is a READ-ONLY review/);
}));

test.each(['duplicate', 'missing', 'missing CLI', 'missing Settings', 'missing Lines', 'wrong path'])(
  '%s blocks are discarded and retried on the next run', kind => withFixture(f => {
    let message = block();
    if (kind === 'duplicate') message += `\n${block()}`;
    if (kind === 'missing') message = '';
    if (kind.startsWith('missing ')) message = block(subject, bodyLines.filter(line => !line.startsWith(`${kind.slice(8)}:`)));
    if (kind === 'wrong path') message = block('scripts/other.mjs');
    f.stub(JSON.stringify(report(message)));
    assert.equal(f.run().status, 1);
    assert.deepEqual(f.manifest(), {});
    assert.equal(existsSync(join(f.out, entryName(subject))), false);
    f.stub();
    assert.equal(f.run().status, 0);
    assert.equal(f.calls().length, 2);
    assert.equal(f.manifest()[subject], hash(f.root, subject));
  }));

test.each([15, 20])('oversized %i-line summary is rejected before checkpointing mandatory fields', count => withFixture(f => {
  const longLines = [...bodyLines.slice(0, 2), ...Array.from({ length: count - 5 }, (_, i) => `Exports: f${i}()`),
    ...bodyLines.slice(3)];
  f.stub(JSON.stringify(report(block(subject, longLines))));
  const result = f.run();
  const persisted = join(f.out, entryName(subject));
  assert.equal(existsSync(persisted), false, 'oversized summary must not be persisted');
  assert.equal(result.status, 1);
  assert.deepEqual(f.manifest(), {});
  assert.equal(readFileSync(join(f.out, 'index.md'), 'utf8'), '');
  f.stub();
  assert.equal(f.run().status, 0, 'oversized answer must be retryable');
}));

test('14-line summary retains mandatory fields and computed importers', () => withFixture(f => {
  const lines = [...bodyLines.slice(0, 2), ...Array.from({ length: 9 }, (_, i) => `Exports: f${i}()`), ...bodyLines.slice(3)];
  assert.equal(lines.length, 14);
  f.stub(JSON.stringify(report(block(subject, lines))));
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(join(f.out, entryName(subject)), 'utf8'), `${lines.join('\n')}\nImporters: none\n`);
}));

test('diagnostics cannot supply an accepted answer', () => withFixture(f => {
  f.stub(JSON.stringify({ diagnostic: block(), usage: { input_tokens: 1, output_tokens: 1 } }));
  assert.equal(f.run().status, 1);
  assert.deepEqual(f.manifest(), {});
  assert.equal(existsSync(join(f.out, entryName(subject))), false);
  f.stub(`${JSON.stringify({ diagnostic: block() })}\nwarning: unrelated output\n${JSON.stringify(report(), null, 2)}`);
  assert.equal(f.run().status, 0, 'a real report after diagnostics must still be accepted');
  assert.equal(f.manifest()[subject], hash(f.root, subject));
}));

test.each([{ exitCode: 1 }, { timedOut: true }, { lastMessage: null }])(
  'incomplete report %j cannot checkpoint an answer', extra => withFixture(f => {
    f.stub(JSON.stringify(report(block(), extra)));
    assert.equal(f.run().status, 1);
    assert.deepEqual(f.manifest(), {});
    assert.equal(existsSync(join(f.out, entryName(subject))), false);
  }));

test.each(['events', 'top-level'])('cached input tokens are counted once from %s usage', location => withFixture(f => {
  const answer = report();
  if (location === 'top-level') { answer.usage = answer.events.usage; delete answer.events; }
  f.stub(JSON.stringify(answer));
  assert.match(f.run().stdout, /12 tokens; 0 pending/);
}));

test('unavailable usage is reported without inventing a token count', () => withFixture(f => {
  f.stub(JSON.stringify(report(block(), { events: {} })));
  const result = f.run();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /0 tokens \(\+ 1 batches unavailable\)/);
}));

test('output basename collision aborts before writes or generation', () => withFixture(f => {
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Output filename collision/);
  assert.equal(existsSync(f.out), false);
  assert.equal(f.calls().length, 0);
}, { 'scripts/a__b.mjs': '', 'scripts/a/b.mjs': '' }));

test.each(['--batch=0', '--batch=-1', '--batch=1.5', '--batch=abc', '--batch=9007199254740992',
  '--limit=0', '--limit=-1', '--limit=1.5', '--limit=', '--limit=Infinity'])(
  'invalid numeric option %s is rejected before writes', option => withFixture(f => {
    const result = f.run(option);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be a positive safe integer/);
    assert.equal(existsSync(f.out), false);
    assert.equal(f.calls().length, 0);
  }));

const badManifests = ['{', 'null', '[]', '"text"', ...[
  '../x', '/tmp/x', 'scripts/../../x.mjs', 'scripts/./x.mjs', 'scripts/a\\b.mjs',
  'scripts/a\nb.mjs', 'scripts/a\rb.mjs', 'scripts/a\u200bb.mjs', 'other/x.mjs', 'scripts/x.test.mjs',
].map(key => JSON.stringify({ [key]: 'a'.repeat(40) })),
JSON.stringify({ [subject]: 'bad hash' }), JSON.stringify({ [subject]: 123 })];
test.each(badManifests)('invalid manifest %s is rejected without deleting or writing', raw => withFixture(f => {
  f.seed();
  writeFileSync(join(f.out, 'manifest.json'), raw);
  const before = snapshot(f.home);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.deepEqual(snapshot(f.home), before);
  assert.equal(f.calls().length, 0);
}));

test('test and spec modules and test directories are excluded from source selection', () => withFixture(f => {
  assert.equal(f.run().status, 0);
  assert.deepEqual(f.manifest(), { [subject]: hash(f.root, subject) });
  const [call] = f.calls();
  assert.ok(call.task.includes(fenceUntrusted('material', JSON.stringify([subject], null, 2))));
}, Object.fromEntries([subject, 'scripts/x.test.mjs', 'scripts/x.spec.mjs', 'scripts/__tests__/x.mjs',
  'scripts/test/x.mjs', 'scripts/tests/x.mjs', 'skills-src/a/tests/x.mjs', 'scripts/readme.md']
  .map(path => [path, 'export const fixture = true;']))));

test.each([false, true])('dry-run leaves output untouched (existing output: %s)', existing => withFixture(f => {
  if (existing) {
    f.seed();
    writeFileSync(join(f.root, subject), 'export const changed = true;');
  }
  const before = snapshot(f.home);
  assert.equal(f.run('--dry-run').status, 0);
  assert.deepEqual(snapshot(f.home), before);
  assert.equal(f.calls().length, 0);
}));
