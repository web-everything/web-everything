import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(scriptsDir, 'codemap.mjs');
const TIMEOUT = 9 * 60 * 1000;
const MAX_BUFFER = 32 * 1024 * 1024;
const entryName = path => `${path.replaceAll('/', '__')}.md`;

function command(bin, args, cwd) {
  const result = spawnSync(bin, args, {
    cwd, encoding: 'utf8', timeout: TIMEOUT, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${bin} failed (${result.error?.code ?? result.signal ?? result.status}); fix the command and rerun`);
  }
  return result.stdout;
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
    command('git', ['init', '--quiet'], root);
    command('git', ['add', '--', path], root);
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
      cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home },
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
