import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSharedWeScan, gitBlobSha, resolveSharedWeScan, rustSrcEntries, rustSrcKey } from '../we-scan-cache.mjs';

let root, cache, env, ref, source, autoBuild;
const refRel = 'scripts/lib/ref.mjs';
const git = (...args) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
});
const key = () => rustSrcKey(rustSrcEntries(root));
const resolve = (overrides = {}) => resolveSharedWeScan({ root, env, referenceFiles: [ref], autoBuild, ...overrides });
function fakeBinary() {
  const bin = join(cache, key(), 'we-scan');
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, '#!/bin/sh\necho "[]"\n');
  chmodSync(bin, 0o755);
  return bin;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'we-scan-cache-repo-'));
  cache = mkdtempSync(join(tmpdir(), 'we-scan-cache-store-'));
  env = { WE_SCAN_CACHE_DIR: cache };
  autoBuild = vi.fn();
  source = join(root, 'scripts/rust-scan/src/main.rs');
  ref = join(root, refRel);
  mkdirSync(dirname(source), { recursive: true });
  mkdirSync(dirname(ref), { recursive: true });
  writeFileSync(join(root, 'scripts/rust-scan/Cargo.toml'), '[package]\nname = "we-scan"\nversion = "0.1.0"\n');
  writeFileSync(join(root, 'scripts/rust-scan/Cargo.lock'), 'version = 3\n');
  writeFileSync(source, 'fn main() {}\n');
  writeFileSync(ref, 'export const version = 1;\n');
  git('init', '-q', '--object-format=sha1');
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
});

afterEach(() => {
  for (const dir of [root, cache]) if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('we-scan content cache', () => {
  it('hashes file contents exactly like git hash-object', () => {
    writeFileSync(ref, Buffer.from([0, 255, 10, 65, 195, 169]));
    expect(gitBlobSha(readFileSync(ref))).toBe(git('hash-object', ref).trim());
  });

  it('keeps the Rust key stable for unrelated changes and changes it for Rust source edits', () => {
    const original = key();
    expect(key()).toBe(original);
    writeFileSync(ref, '// unrelated edit\n');
    expect(key()).toBe(original);
    writeFileSync(source, 'fn main() { println!("changed"); }\n');
    expect(key()).not.toBe(original);
  });

  it('skips the cache and autobuild in CI even when a binary exists', () => {
    fakeBinary();
    expect(resolve({ env: { ...env, CI: '1' } })).toBeNull();
    expect(autoBuild).not.toHaveBeenCalled();
  });

  it('requests one injected autobuild on a cache miss', () => {
    expect(resolve()).toBeNull();
    expect(autoBuild).toHaveBeenCalledTimes(1);
    expect(autoBuild).toHaveBeenCalledWith(root, env);
  });

  it('does not autobuild when explicitly disabled', () => {
    expect(resolve({ env: { ...env, WE_SCAN_AUTOBUILD: '0' } })).toBeNull();
    expect(autoBuild).not.toHaveBeenCalled();
  });

  it('stamps a main-matching tree and reuses the stamp after origin/main moves on', () => {
    const bin = fakeBinary();
    const originalRef = readFileSync(ref);
    expect(resolve()).toBe(bin);
    const stampPath = join(dirname(bin), 'stamps.json');
    const stamps = JSON.parse(readFileSync(stampPath, 'utf8'));
    expect(stamps).toEqual([{ at: expect.any(String), refs: { [refRel]: gitBlobSha(originalRef) } }]);
    writeFileSync(ref, 'export const version = 2;\n');
    git('add', refRel);
    git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'new reference');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(ref, originalRef);
    expect(git('show', `origin/main:${refRel}`)).not.toBe(originalRef.toString());
    expect(resolve()).toBe(bin);
    expect(JSON.parse(readFileSync(stampPath, 'utf8'))).toEqual(stamps);
    expect(autoBuild).not.toHaveBeenCalled();
  });

  it('rejects an unstamped working-tree reference edit', () => {
    const bin = fakeBinary();
    writeFileSync(ref, '// uncommitted reference edit\n');
    expect(resolve()).toBeNull();
    expect(existsSync(join(dirname(bin), 'stamps.json'))).toBe(false);
  });

  it('misses the cached binary when working-tree Rust source changes the key', () => {
    const bin = fakeBinary();
    writeFileSync(source, 'fn main() { println!("local"); }\n');
    expect(join(cache, key(), 'we-scan')).not.toBe(bin);
    expect(resolve()).toBeNull();
    expect(existsSync(join(cache, key(), 'we-scan'))).toBe(false);
  });

  it('refuses to build Rust source that differs from origin/main', () => {
    writeFileSync(source, 'fn main() { println!("local"); }\n');
    const runCargo = vi.fn();
    expect(buildSharedWeScan({ root, env, runCargo })).toEqual({
      ok: false, reason: expect.stringContaining('working-tree Rust source differs from origin/main'),
    });
    expect(runCargo).not.toHaveBeenCalled();
  });

  it('publishes an injected build, cleans up target and lock, and reuses the binary', () => {
    const cacheDir = join(cache, key());
    const bin = join(cacheDir, 'we-scan');
    const contents = '#!/bin/sh\necho "[]"\n';
    const runCargo = vi.fn((args) => {
      expect(existsSync(join(cacheDir, '.lock'))).toBe(true);
      const targetDir = args[args.indexOf('--target-dir') + 1];
      mkdirSync(join(targetDir, 'release'), { recursive: true });
      writeFileSync(join(targetDir, 'release/we-scan'), contents, { mode: 0o755 });
    });
    expect(buildSharedWeScan({ root, env, runCargo })).toEqual({ ok: true, bin });
    expect(runCargo).toHaveBeenCalledTimes(1);
    expect(runCargo).toHaveBeenCalledWith([
      'build', '--release', '--manifest-path', join(root, 'scripts/rust-scan/Cargo.toml'),
      '--target-dir', join(cacheDir, 'target'),
    ]);
    expect(readFileSync(bin, 'utf8')).toBe(contents);
    expect(statSync(bin).mode & 0o777).toBe(0o755);
    expect(existsSync(join(cacheDir, 'target'))).toBe(false);
    expect(existsSync(join(cacheDir, '.lock'))).toBe(false);
    runCargo.mockClear();
    expect(buildSharedWeScan({ root, env, runCargo })).toEqual({ ok: true, bin, reason: 'already built' });
    expect(runCargo).not.toHaveBeenCalled();
  });
});
