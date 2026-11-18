/**
 * @file scripts/__tests__/rust-scan-citation-check-parity.test.mjs
 * @description Cross-language differential proof for #3417's fourth and final planned port: `scripts/rust-scan`'s
 *   `citation-check` subcommand must report the EXACT same findings as check-standards.mjs's "6f-ii
 *   CITATION-VERIFICATION gate family" — buildAnchorOwners/findAnchorRulingMismatches (gate 10),
 *   findDanglingLoci (gate 5), findOutOfScopeHashSlugs (gate 3), findDanglingMemoryHashSlugs (gate 3b), all
 *   from scripts/lib/citation-check.mjs — over the same real file tree. A real build, a real spawned binary
 *   (#3264 mechanics qualifier). Requires `cargo` on PATH; skips (not silently passes) if absent.
 *
 * NOT covered (by design, not oversight): the PROVENANCE gate (findUnresolvedIdentifiers). It depends on a
 * live `git diff`/merge-base computation that lives in check-standards.mjs itself, not citation-check.mjs —
 * architecturally separate from the four LOCUS-shaped gates this port and this test cover. See
 * scripts/rust-scan/src/citation_check.rs's module doc.
 *
 * Also pins the one mechanically-interesting part of this port: JS's anchor-authority shape-A regex carries
 * a negative lookbehind (`(?<!\{)#`, so a `{#anchor}` heading DEFINITION is never read as a citation) that
 * the plain `regex` crate can't express, so the Rust side uses `fancy_regex` for just that pattern — same
 * shape as `locus_prefix.rs`'s lookahead. The fixture below exercises it directly (shape A AND B anchor
 * mismatches, a correct citation that must NOT fire, and a `{#anchor}` heading that must NOT fire either).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAnchorOwners, findAnchorRulingMismatches, findDanglingLoci, findOutOfScopeHashSlugs,
  findDanglingMemoryHashSlugs, makeMemoizedLineCounter, LOCUS_PREFIX_NAMES,
} from '../lib/citation-check.mjs';
import { isHash } from '../backlog/id.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CRATE = join(ROOT, 'scripts', 'rust-scan');
const BIN = join(CRATE, 'target', 'release', 'we-scan');

const hasCargo = spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0;

const ID_TOKEN_RE = /^(\d{1,5}|x[0-9a-z]{6})-/;
const SCAN_DIRS = [
  ['backlog/', ['.md']],
  ['docs/agent/', ['.md']],
  ['agent-memory-src/', ['.md']],
  ['reports/', ['.md']],
  ['src/_data/researchTopics/', ['.json']],
  ['src/_includes/research-descriptions/', ['.njk']],
];

function normalize(findings) {
  return findings
    .map((f) => JSON.stringify(Object.keys(f).sort().reduce((o, k) => { o[k] = f[k]; return o; }, {})))
    .sort();
}

function runRust(root, extraArgs = []) {
  const out = execFileSync(BIN, ['citation-check', `--root=${root}`, ...extraArgs], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** The exact JS reference this port replaces, driven the same way check-standards.mjs drives it — building
 *  the `backlog` array's `num`/`codifiedIn`/`graduatedTo`/`bornAs` from the real files, the same fields
 *  `src/_data/backlog.js` derives (this helper does NOT reimplement the full loader — tier/digest/etc. are
 *  irrelevant to these four gates — only the four fields they actually read). */
async function runJs(root) {
  const matter = (await import('gray-matter')).default;
  const backlog = [];
  const backlogDir = join(root, 'backlog');
  for (const file of readdirSync(backlogDir).filter((f) => f.endsWith('.md'))) {
    const id = file.replace(/\.md$/, '');
    const m = id.match(ID_TOKEN_RE);
    if (!m) continue;
    let data;
    try { ({ data } = matter(readFileSync(join(backlogDir, file), 'utf8'))); } catch { continue; }
    backlog.push({ num: m[1], codifiedIn: data.codifiedIn, graduatedTo: data.graduatedTo, bornAs: data.bornAs });
  }

  const anchorOwners = buildAnchorOwners(backlog);
  const { existsSync } = await import('node:fs');
  const relExists = (p) => existsSync(join(root, p));
  const relLineCount = makeMemoizedLineCounter((p) => readFileSync(join(root, p), 'utf8'));
  const pendingHashes = new Set(backlog.filter((b) => isHash(b.num)).map((b) => b.num));
  const bornAsHashes = new Set(backlog.filter((b) => isHash(b.bornAs)).map((b) => b.bornAs));

  const findings = [];
  const scanFile = (rel, content) => {
    for (const f of findAnchorRulingMismatches(content, anchorOwners))
      findings.push({ kind: 'anchor', file: rel, anchor: f.anchor, citedNum: f.citedNum, owners: f.owners, shape: f.shape, context: f.context });
    for (const f of findDanglingLoci(content, { fileExists: relExists, lineCount: relLineCount }))
      findings.push({ kind: 'locus', file: rel, locus: f.locus, path: f.path, line: f.line, reason: f.reason });
    for (const f of findOutOfScopeHashSlugs(content, rel))
      findings.push({ kind: 'hashslug', file: rel, slug: f.slug, form: f.form });
    if (rel.startsWith('agent-memory-src/'))
      for (const f of findDanglingMemoryHashSlugs(content, { pendingHashes, bornAsHashes }))
        findings.push({ kind: 'memoryhash', file: rel, slug: f.slug, form: f.form, reason: f.reason });
  };
  for (const [dir, exts] of SCAN_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) if (exts.some((e) => f.endsWith(e)))
      scanFile(`${dir}${f}`, readFileSync(join(abs, f), 'utf8'));
  }
  return findings;
}

describe.skipIf(!hasCargo)('we-scan citation-check — cross-language parity with the JS reference (#3417)', () => {
  beforeAll(() => {
    execFileSync('cargo', ['build', '--release'], { cwd: CRATE, stdio: 'inherit' });
  }, 180_000);

  it('matches over this real repo tree (all six scanned directories)', async () => {
    const js = normalize(await runJs(ROOT));
    const rust = normalize(runRust(ROOT));
    expect(rust).toEqual(js);
  });

  it('matches over a synthetic fixture covering all four gates, both anchor shapes, and the negative cases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-scan-citation-parity-'));
    for (const sub of ['backlog', 'docs/agent', 'agent-memory-src', 'reports']) mkdirSync(join(dir, sub), { recursive: true });

    const files = {
      // 042 owns #some-rule via codifiedIn; 100 owns #other-rule via graduatedTo.
      'backlog/042-owns-anchor.md': '---\ncodifiedIn: "docs/agent/platform-decisions.md#some-rule"\n---\nbody\n',
      'backlog/100-graduated.md': '---\ngraduatedTo: "docs/agent/platform-decisions.md#other-rule"\n---\nbody\n',
      // 200 is a LANDED item recording the hash it was born as.
      'backlog/200-landed.md': '---\nbornAs: xland01\n---\nbody\n',
      // A still-PENDING (hash-named) item on disk — citing it must NOT flag (self-heals at its own land).
      'backlog/xpend01-pending.md': '---\n---\nbody\n',
      // Shape A: `#anchor (#NNN, …)` — wrong attribution.
      'backlog/300-wrong-anchor-shapeA.md': 'Per #some-rule (#999, elsewhere) this must hold.\n',
      // Shape B: `(#NNN, #anchor)` — wrong attribution.
      'backlog/301-wrong-anchor-shapeB.md': 'See the ruling (#999, #other-rule) for context.\n',
      // Correct citation of the REAL owner — must NOT flag.
      'backlog/302-correct-anchor.md': 'Per #some-rule (#042, correct) this holds.\n',
      // `{#anchor}` is a heading DEFINITION, never a citation — the negative-lookbehind case.
      'backlog/303-heading-definition-passes.md': '## Some heading {#some-rule} (#999, elsewhere)\n',
      // Dangling locus: missing file.
      'backlog/400-dangling-locus.md': 'See we:scripts/does-not-exist.mjs:10 for details.\n',
      ...Object.fromEntries(LOCUS_PREFIX_NAMES.map((prefix) => [
        `backlog/prefix-${prefix}.md`, `Fix ${prefix}:scripts/does-not-exist.mjs:12\n`,
      ])),
      // Out-of-scope hash slug (reports/ is out of the at-land rewrite scope).
      'reports/2026-01-01-report.md': 'Filed as #xoutscp earlier.\n',
      // Memory hash slugs: one dead-landed (cites 200's bornAs), one unresolved, one pending (must pass).
      'agent-memory-src/mem-001.md':
        'See #xland01 (should be #200 now) and #xnowhr1 (never existed).\nPending #xpend01 is fine, self-heals at land.\n',
    };
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);

    try {
      const js = normalize(await runJs(dir));
      const rust = normalize(runRust(dir));
      expect(js.length).toBeGreaterThan(0); // guard against a vacuous fixture
      expect(rust).toEqual(js);
      // Pin the specific negatives: neither the correct citation nor the heading-definition form fires.
      expect(js.some((f) => f.includes('"302-correct-anchor'))).toBe(false);
      expect(js.some((f) => f.includes('"303-heading-definition'))).toBe(false);
      expect(rust.some((f) => f.includes('"302-correct-anchor'))).toBe(false);
      expect(rust.some((f) => f.includes('"303-heading-definition'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the parallel scan (multiple --max-workers) still matches the JS reference', async () => {
    const js = normalize(await runJs(ROOT));
    for (const n of [1, 2, 4]) {
      const rust = normalize(runRust(ROOT, [`--max-workers=${n}`]));
      expect(rust).toEqual(js);
    }
  });
});
