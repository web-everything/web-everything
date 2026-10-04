/**
 * @file scripts/__tests__/rust-scan-secret-scrub-parity.test.mjs
 * @description Cross-language differential proof for #3417's second Rust port: `scripts/rust-scan`'s
 *   `secret-scrub` subcommand must report the EXACT same findings as `scanPublishSecrets`
 *   (`scripts/check-standards-rules.mjs`, wrapping `scrubPublish` from `scripts/lib/secret-scrub.mjs`) over
 *   the same real file tree — a real `cargo build` and a real spawned binary (#3264 mechanics qualifier).
 *   Requires `cargo` on PATH; skips (not silently passes) if absent.
 *
 * Also pins the one deliberate semantic gap: JS's `CRED_LABEL` regex ends with a backreference (`\1`,
 * requiring the value be followed by the SAME quote that opened it) that the Rust `regex` crate cannot
 * express, so the port replicates it with a manual post-match check (`scripts/rust-scan/src/secret_scrub.rs`).
 * The mismatched-quote fixture below proves that replication holds through the real spawned binary, not just
 * the Rust crate's own unit test.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPublishSecrets } from '../check-standards-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CRATE = join(ROOT, 'scripts', 'rust-scan');
const BIN = join(CRATE, 'target', 'release', 'we-scan');

const hasCargo = spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0;

function normalize(findings) {
  return findings
    .map((f) => `${f.file}::${[...f.reasons].sort().join('|')}`)
    .sort();
}

function runRust(root, extraArgs = [], env = undefined) {
  const out = execFileSync(BIN, ['secret-scrub', `--root=${root}`, ...extraArgs], {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : undefined,
  });
  return JSON.parse(out);
}

function readDocs(root, labels) {
  const docs = [];
  for (const label of labels) {
    const dir = join(root, label);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.md')))
      docs.push({ file: `${label}/${f}`, content: readFileSync(join(dir, f), 'utf8') });
  }
  return docs;
}

describe.skipIf(!hasCargo)('we-scan secret-scrub — cross-language parity with the JS reference (#3417)', () => {
  beforeAll(() => {
    execFileSync('cargo', ['build', '--release'], { cwd: CRATE, stdio: 'inherit' });
  }, 180_000);

  it('matches over this real repo tree (backlog/ + agent-memory-src/)', () => {
    const js = normalize(scanPublishSecrets(readDocs(ROOT, ['backlog', 'agent-memory-src'])));
    const rust = normalize(runRust(ROOT));
    expect(rust).toEqual(js);
  });

  it('matches over a synthetic fixture covering every detector plus the should-pass cases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-scan-secret-parity-'));
    const backlog = join(dir, 'backlog');
    const memory = join(dir, 'agent-memory-src');
    mkdirSync(backlog, { recursive: true });
    mkdirSync(memory, { recursive: true });

    const files = {
      'backlog/001-pem.md': 'Found a leaked key: -----BEGIN RSA PRIVATE KEY-----\n',
      'backlog/002-ghtoken.md': 'Rotate this: ghp_1234567890ABCDEFabcdef1234567890AB\n',
      'backlog/003-labeled-quoted.md': 'password: "hunter2Trombone"\n',
      // Mismatched quote — must NOT flag (the manual \1 replication, the whole point of this fixture).
      'backlog/004-labeled-mismatched-quote.md': "password: \"hunter2Trombone'\n",
      'backlog/005-blob.md': 'Payload: Qx7mK2pL9vN4wR8tY3sJ6hG1fD5bC0eA9zX2qW7mN4v\n',
      'backlog/006-personal-email.md': 'Contact nic.g.gilbert@gmail.com for follow-up.\n',
      'backlog/007-service-email-passes.md': 'origin is git@github.com:web-everything/web-everything.git\n',
      'backlog/008-public-ip.md': 'server at 8.8.8.8 handles DNS.\n',
      'backlog/009-private-ip-passes.md': 'bridge at 127.0.0.1:8080 and 192.168.1.1.\n',
      'backlog/010-ipv6.md': 'Address: 2001:0db8:85a3:0000:8a2e\n',
      'backlog/011-git-sha-passes.md': 'commit 2acf9e283e0eb72837964d9c58d049789a19dde3 landed\n',
      'backlog/012-hyphen-prose-passes.md': 'the UTF-16-code-unit boundary and JS-first-vs-CSS-first debate\n',
      'agent-memory-src/mem-001.md': 'AWS key AKIA1234567890ABCDEF leaked in logs.\n',
    };
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);

    try {
      const js = normalize(scanPublishSecrets(readDocs(dir, ['backlog', 'agent-memory-src'])));
      const rust = normalize(runRust(dir));
      expect(js.length).toBeGreaterThan(0); // guard against a vacuous fixture
      expect(rust).toEqual(js);
      // Pin the specific negative: the mismatched-quote file must carry no finding at all, in EITHER output.
      expect(js.some((f) => f.startsWith('backlog/004'))).toBe(false);
      expect(rust.some((f) => f.startsWith('backlog/004'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the parallel scan (multiple --max-workers) still matches the JS reference', () => {
    const js = normalize(scanPublishSecrets(readDocs(ROOT, ['backlog', 'agent-memory-src'])));
    for (const n of [1, 2, 4]) {
      const rust = normalize(runRust(ROOT, [`--max-workers=${n}`]));
      expect(rust).toEqual(js);
    }
  });

  it('the DEFAULT worker count (no flag/env) and the WE_SCAN_MAX_WORKERS env override both match', () => {
    // Locks in the fixed stopgap default (3, until the operation manager can set this per-run) AND the env
    // var the future manager will use to set it without a flag at every call site.
    const js = normalize(scanPublishSecrets(readDocs(ROOT, ['backlog', 'agent-memory-src'])));
    expect(normalize(runRust(ROOT))).toEqual(js);
    expect(normalize(runRust(ROOT, [], { WE_SCAN_MAX_WORKERS: '2' }))).toEqual(js);
  });
});
