/**
 * @file scripts/__tests__/citation-gate-dedup.test.mjs
 * @description The durable guard #2863 asks for: a `check:standards` self-test asserting no two emitted
 *   findings share an identical `(message, descriptor.file)` pair. Not scoped to the citation gates —
 *   mechanically enforcing the #1389 per-file convention for EVERY rule, present and future, is the whole
 *   point (relying on each new rule's author recalling the convention is exactly what #1389 and this card
 *   both exist to stop having to do).
 *
 * Grounded in a real measurement, not a synthetic fixture: before the #2863 dedupe fix, running this exact
 * assertion against the live corpus found 54 duplicate `(message, file)` pairs, ALL of them
 * `citation-hash-slug-scope` findings (the per-occurrence emission #2863 fixes) — every other rule in the
 * gate was already clean. So this spawns the REAL `check-standards.mjs --json` over the real tree, the same
 * pattern scripts/__tests__/stdout-flush.test.mjs uses to read the gate's machine feed, rather than a fixture
 * that could drift from what the gate actually emits.
 *
 * `captureViaExecFileSync` is single-sourced (#xwt6ola) — was a local copy here (and a separate one in
 * stdout-flush.test.mjs) that silently trusted a truncated capture as if it were a complete result, which is
 * exactly what reproduced THIS file's own intermittent "SyntaxError: Unexpected end of JSON input" under
 * real full-suite contention. Passing `validate: isParseableJson` retries once on an invalid/incomplete
 * capture (any mechanism — a crash, a kill, plain truncation) instead of trusting it; see
 * capture-via-exec-file-sync.mjs's header for why signal-based detection alone was tried and disproven.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureViaExecFileSync, isParseableJson } from '../lib/capture-via-exec-file-sync.mjs';
import { makeGitOverlay } from '../lib/hermetic-git-overlay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CHECK_STANDARDS = join(ROOT, 'scripts', 'check-standards.mjs');

describe('check:standards — no duplicate (message, descriptor.file) finding pairs (#2863 durable guard)', () => {
  let findings;
  // Hermetic (card xcu4cqf): the gate reads `origin/main`; it runs over the real tree through a git overlay whose
  // `origin/main` is pinned to HEAD, so the result never drifts with what was pushed upstream.
  let overlay;
  afterAll(() => overlay?.cleanup());
  beforeAll(() => {
    overlay = makeGitOverlay(ROOT);
    const out = captureViaExecFileSync(CHECK_STANDARDS, ['--json'], { validate: isParseableJson, env: { ...process.env, ...overlay.env } });
    const parsed = JSON.parse(out);
    findings = [...parsed.errors, ...parsed.warnings];
  }, 120_000);

  it('produced findings to check (the guard is not vacuously passing on an empty run)', () => {
    expect(findings.length).toBeGreaterThan(0);
  });

  it('emits at most ONE finding per (message, descriptor.file) pair, across every rule in the gate', () => {
    const seen = new Map(); // key → first finding's descriptor.kind, for a legible failure message
    const dupes = [];
    for (const f of findings) {
      const key = JSON.stringify([f.message, f.descriptor?.file ?? '']);
      if (seen.has(key)) dupes.push({ kind: f.descriptor?.kind, file: f.descriptor?.file, message: f.message.slice(0, 120) });
      else seen.set(key, f.descriptor?.kind);
    }
    expect(dupes).toEqual([]);
  });
});
