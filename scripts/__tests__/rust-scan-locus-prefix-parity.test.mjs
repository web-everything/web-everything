/**
 * @file scripts/__tests__/rust-scan-locus-prefix-parity.test.mjs
 * @description Cross-language differential proof for #3417's third Rust port: `scripts/rust-scan`'s
 *   `locus-prefix` subcommand must report the EXACT same findings as `scanRepoLocusPrefixes`
 *   (`scripts/check-standards-rules.mjs`) over the same real file tree — a real `cargo build` and a real
 *   spawned binary (#3264 mechanics qualifier). Requires `cargo` on PATH; skips (not silently passes) if
 *   absent.
 *
 * Also pins the one mechanically-interesting part of this port: JS's `PATHLIKE_RE` carries a negative
 * lookahead (`(?![a-z])`) the plain `regex` crate can't express, so the Rust side uses `fancy_regex` for
 * just that pattern (`scripts/rust-scan/src/locus_prefix.rs`). The `.jsonlines`-shaped fixture below proves
 * that lookahead survives through the real spawned binary, not just the Rust crate's own unit test.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepoLocusPrefixes } from '../check-standards-rules.mjs';
import { LOCUS_PREFIX_NAMES } from '../lib/citation-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CRATE = join(ROOT, 'scripts', 'rust-scan');
const BIN = join(CRATE, 'target', 'release', 'we-scan');

const hasCargo = spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0;

// This contract runs even without cargo. Removing a prefix from Rust must fail,
// including cross-repo prefixes whose omission in citation-check otherwise yields no finding.
it('Rust mirrors every JS locus prefix, including aliases', () => {
  const source = readFileSync(join(CRATE, 'src/locus_prefix.rs'), 'utf8');
  const names = source.match(/pub const LOCUS_PREFIX_NAMES:[\s\S]*?= &\[([\s\S]*?)\];/);
  expect(names).not.toBeNull();
  expect([...names[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(LOCUS_PREFIX_NAMES);
});

function normalize(findings) {
  return findings.map((f) => `${f.file}::${f.count}::${f.sample}`).sort();
}

function runRust(root, extraArgs = []) {
  const out = execFileSync(BIN, ['locus-prefix', `--root=${root}`, ...extraArgs], { encoding: 'utf8' });
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

describe.skipIf(!hasCargo)('we-scan locus-prefix — cross-language parity with the JS reference (#3417)', () => {
  beforeAll(() => {
    execFileSync('cargo', ['build', '--release'], { cwd: CRATE, stdio: 'inherit' });
  }, 180_000);

  it('matches over this real repo tree (backlog/ + reports/)', () => {
    const js = normalize(scanRepoLocusPrefixes(readDocs(ROOT, ['backlog', 'reports'])));
    const rust = normalize(runRust(ROOT));
    expect(rust).toEqual(js);
  });

  it('matches over a synthetic fixture covering every carve-out plus the lookahead edge case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-scan-locus-parity-'));
    const backlog = join(dir, 'backlog');
    const reports = join(dir, 'reports');
    mkdirSync(backlog, { recursive: true });
    mkdirSync(reports, { recursive: true });

    const files = {
      'backlog/001-bare.md': 'See scripts/check-standards.mjs for details, and scripts/other.mjs too.\n',
      'backlog/002-prefixed-passes.md': 'See we:scripts/check-standards.mjs for details.\n',
      'backlog/003-fenced-passes.md': '```\nscripts/inside-fence.mjs\n```\n',
      'backlog/004-link-passes.md': '[we:scripts/x.ts](scripts/x.ts)\n',
      'backlog/005-npm-scope-passes.md': 'install @scope/pkg.json today\n',
      'backlog/006-url-passes.md': 'see https://example.com/foo.js for docs\n',
      'backlog/007-glob-passes.md': 'matches *.test.ts everywhere\n',
      'backlog/008-product-js-passes.md': 'built with Node.js and Next.js\n',
      'backlog/009-type-fragment-passes.md': 'ships a .d.ts and a .spec.ts\n',
      'backlog/010-frontmatter-exempt-passes.md': '---\nrelatedReport: reports/2026-01-01-foo.md\n---\nbody\n',
      'backlog/011-line-range.md': 'bug at scripts/check-standards.mjs:120-140 today\n',
      // The `(?![a-z])` lookahead case: `.json` must NOT match inside a `.jsonlines`-shaped token.
      'backlog/012-jsonlines-passes.md': 'data.jsonlines has no repo path here\n',
      'reports/2026-01-01-report.md': 'Bare ref in a report: scripts/report-bare.mjs\n',
      ...Object.fromEntries(LOCUS_PREFIX_NAMES.map((prefix) => [
        `backlog/prefix-${prefix}.md`, `Fix ${prefix}:scripts/check-cards.mjs:12\n`,
      ])),
    };
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);

    try {
      const js = normalize(scanRepoLocusPrefixes(readDocs(dir, ['backlog', 'reports'])));
      const rust = normalize(runRust(dir));
      expect(js.length).toBeGreaterThan(0); // guard against a vacuous fixture
      expect(rust).toEqual(js);
      expect(js.some((f) => f.startsWith('backlog/012'))).toBe(false);
      expect(rust.some((f) => f.startsWith('backlog/012'))).toBe(false);
      expect(js.some((f) => f.startsWith('backlog/prefix-'))).toBe(false);
      expect(rust.some((f) => f.startsWith('backlog/prefix-'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the parallel scan (multiple --max-workers) still matches the JS reference', () => {
    const js = normalize(scanRepoLocusPrefixes(readDocs(ROOT, ['backlog', 'reports'])));
    for (const n of [1, 2, 4]) {
      const rust = normalize(runRust(ROOT, [`--max-workers=${n}`]));
      expect(rust).toEqual(js);
    }
  });
});
