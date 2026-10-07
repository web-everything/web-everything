/**
 * @file scripts/__tests__/capability-search.test.mjs
 * @description Proof of the capability-search core (#3559): the pure matching primitives, the SKILL.md
 *   frontmatter fallback that avoids the js-yaml crash real descriptions trigger, the backlog loader against
 *   a throwaway fixture corpus, AND two REAL regression fixtures — the exact misses the item was filed to
 *   close (#3277's search, and `we:scripts/conveyor/reconcile-finding.mjs`'s search) — run against the live
 *   repo, plus a real CLI subprocess proving the wiring end-to-end, not just the isolated functions.
 */
import { describe, it, test, expect, beforeAll, afterAll } from 'bun:test';
const __ORIG_URL = new URL('../../../scripts/__tests__/capability-search.test.mjs', import.meta.url).href;
const __ORIG_FILE = new URL(__ORIG_URL).pathname;
const __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\/$/, '');
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stemLike,
  overlapScore,
  classifyVerdict,
  extractHeaderText,
  parseSkillFrontmatter,
  loadBacklogCandidates,
  searchCapabilities,
  EXACT_THRESHOLD,
  PARTIAL_THRESHOLD,
} from '../../../scripts/capability-search.mjs';

const WE_SCRIPTS_DIR = dirname(dirname(fileURLToPath(__ORIG_URL))); // .../scripts
const WE_ROOT = dirname(WE_SCRIPTS_DIR);
const CLI = join(WE_SCRIPTS_DIR, 'capability-search.mjs');

// ---- pure matching core -----------------------------------------------------

describe('stemLike', () => {
  it('matches identical tokens', () => expect(stemLike('decision', 'decision')).toBe(true));
  it('matches a plural/tense variant via prefix (publish ~ publishes)', () => {
    expect(stemLike('publish', 'publishes')).toBe(true);
    expect(stemLike('refresh', 'refreshes')).toBe(true);
  });
  it('does not match unrelated tokens, even similar-length ones', () => {
    expect(stemLike('agent', 'artifact')).toBe(false);
  });
  it('never fires on short tokens (avoids cheap false positives like "pr" ~ "print")', () => {
    expect(stemLike('pr', 'print')).toBe(false);
  });
});

describe('overlapScore', () => {
  it('scores 1 when every query token is covered', () => {
    const { score, matched } = overlapScore(['publish', 'decision'], ['declare', 'publishes', 'a', 'decision']);
    expect(score).toBe(1);
    expect(matched.sort()).toEqual(['decision', 'publish']);
  });
  it('scores as a fraction of the QUERY length, not the doc length (a long doc is not penalized)', () => {
    const longDoc = ['x', 'y', 'z', 'w', 'v', 'decision'];
    const { score } = overlapScore(['decision'], longDoc);
    expect(score).toBe(1); // 1/1 query tokens covered, regardless of doc size
  });
  it('scores 0 for an empty query', () => {
    expect(overlapScore([], ['anything']).score).toBe(0);
  });
});

describe('classifyVerdict', () => {
  it('classifies exact / partial / none at the documented thresholds', () => {
    expect(classifyVerdict(EXACT_THRESHOLD)).toBe('exact');
    expect(classifyVerdict(PARTIAL_THRESHOLD)).toBe('partial');
    expect(classifyVerdict(PARTIAL_THRESHOLD - 0.01)).toBe('none');
  });
});

// ---- header / frontmatter extraction ----------------------------------------

describe('extractHeaderText', () => {
  it('strips comment syntax and @tags, keeping the prose', () => {
    const src = '/**\n * @file foo.mjs\n * @description Does the thing, well.\n */\nexport const x = 1;\n';
    expect(extractHeaderText(src)).toBe('foo.mjs Does the thing, well.');
  });
  it("returns '' when the file has no leading block comment", () => {
    expect(extractHeaderText('export const x = 1;\n')).toBe('');
  });
  it('still finds the header behind a leading shebang — a third of the scanned scripts open with one', () => {
    const src = '#!/usr/bin/env node\n/**\n * @file bar.mjs\n * @description Does another thing.\n */\n';
    expect(extractHeaderText(src)).toBe('bar.mjs Does another thing.');
  });
  it('still finds the header past a blank line between the shebang and the JSDoc block', () => {
    const src = '#!/usr/bin/env node\n\n/**\n * @description Does a third thing.\n */\n';
    expect(extractHeaderText(src)).toBe('Does a third thing.');
  });
});

describe('parseSkillFrontmatter', () => {
  it('extracts name + description from ordinary frontmatter', () => {
    const raw = '---\nname: foo\ndescription: Does the thing.\n---\n\n# Foo\n';
    expect(parseSkillFrontmatter(raw)).toEqual({ name: 'foo', description: 'Does the thing.' });
  });
  it('survives an UNQUOTED colon in the description — the exact shape that crashes full YAML parsing ' +
     '(js-yaml, under gray-matter) on real files like we:skills-src/closing-session/SKILL.md', () => {
    const raw = '---\nname: closer\ndescription: Collects but never adjudicates: every lesson goes to the pool.\n---\n';
    expect(parseSkillFrontmatter(raw)).toEqual({
      name: 'closer',
      description: 'Collects but never adjudicates: every lesson goes to the pool.',
    });
  });
  it('joins a YAML block-scalar description (`>`) instead of truncating it at the first line', () => {
    const raw = '---\nname: folded\ndescription: >\n  Does the thing, across\n  more than one line.\n---\n';
    expect(parseSkillFrontmatter(raw)).toEqual({
      name: 'folded',
      description: 'Does the thing, across more than one line.',
    });
  });
});

// ---- backlog loader, against a throwaway fixture corpus ---------------------

describe('loadBacklogCandidates — fixture corpus', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'we-capability-search-backlog-'));
    writeFileSync(join(dir, '9001-a-fixture-item.md'),
      '---\nstatus: open\ntags: [alpha, beta]\n---\n\n# A fixture item about widgets\n\nThis item is about widgets and gears.\n');
    writeFileSync(join(dir, 'README.md'), '# not a backlog item\n'); // no leading id — must be skipped
    // Genuinely malformed YAML (an unclosed flow sequence) — matter() throws on this. One bad file must
    // never take the whole scan down with it (the same skip-and-report discipline src/_data/backlog.js's
    // own loader uses).
    writeFileSync(join(dir, '9002-a-malformed-fixture-item.md'), '---\ntags: [unclosed\n---\n\n# broken\n');
    writeFileSync(join(dir, '9003-another-fixture-item.md'),
      '---\nstatus: open\n---\n\n# A second fixture item about gadgets\n\nSomething else entirely.\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // ONE call, asserted twice over, not two separate `it`s each calling `loadBacklogCandidates` against the
  // same fixture dir. Observed directly against gray-matter (not asserted here, and not this loader's own
  // behavior): a SECOND `matter()` call on content identical to a string that failed to parse the first
  // time does not reliably re-throw the same way. Two separate `it`s would each re-parse #9002's content in
  // the same process, risking exactly that non-determinism and hiding the very regression this pins.
  it('derives title/summary/tags via the site loader, skips non-item files, skips a malformed item ' +
     'instead of aborting the whole scan, and REPORTS the skip rather than doing it silently', () => {
    const { candidates, malformed } = loadBacklogCandidates(WE_ROOT, { backlogDir: dir });
    expect(candidates.map((c) => c.id).sort()).toEqual(['#9001', '#9003']);
    const item = candidates.find((c) => c.id === '#9001');
    expect(item).toMatchObject({ status: 'open', title: 'A fixture item about widgets' });
    expect(item.text).toContain('widgets');
    expect(item.text).toContain('alpha');
    expect(malformed).toEqual([{ file: 'we:backlog/9002-a-malformed-fixture-item.md', reason: expect.any(String) }]);
  });
});

// ---- regression fixtures — the two REAL misses this item was filed to close --------

describe('searchCapabilities — real-repo regression fixtures (#3559)', () => {
  it('surfaces #3277 for the decision/architecture-artifact search (the second 2026-09-06 miss)', () => {
    const report = searchCapabilities('publish and refresh a decision or architecture artifact', { root: WE_ROOT });
    expect(report.verdict).toBe('exact');
    expect(report.backlog.map((r) => r.id)).toContain('#3277');
  });

  it('a --limit of 0 trims every displayed row but never the verdict', () => {
    const query = 'publish and refresh a decision or architecture artifact';
    const report = searchCapabilities(query, { root: WE_ROOT, limit: 0 });
    expect(report.verdict).toBe('exact'); // #3277 is still an exact match even with nothing displayed
    expect(report.backlog).toHaveLength(0);
  });

  it('a non-numeric --limit is ignored (falls back to the default of 5), not treated as a trim to 0', () => {
    const query = 'publish and refresh a decision or architecture artifact';
    const report = searchCapabilities(query, { root: WE_ROOT, limit: NaN });
    expect(report.verdict).toBe('exact');
    expect(report.backlog).toHaveLength(5);
  });

  it('surfaces reconcile-finding.mjs for the sequencing-finding search (the first 2026-09-06 miss)', () => {
    const report = searchCapabilities('post a blocking sequencing finding on a PR from a rebase agent', { root: WE_ROOT });
    expect(report.verdict).toBe('exact');
    expect(report.operations.map((r) => r.id)).toContain('we:scripts/conveyor/reconcile-finding.mjs');
  });
});

// ---- CLI wiring — the real subprocess, not just the exported functions ------

describe('capability-search CLI — real subprocess', () => {
  it('prints the fixture regression as machine-readable JSON with an exact verdict', () => {
    const out = execFileSync('node', [CLI, 'publish and refresh a decision or architecture artifact', '--json'],
      { cwd: WE_ROOT, encoding: 'utf8' });
    const report = JSON.parse(out);
    expect(report.verdict).toBe('exact');
    expect(report.backlog.some((r) => r.id === '#3277')).toBe(true);
  });

  it('exits 1 with a usage line on stderr when called with no query', () => {
    let caught;
    try {
      execFileSync('node', [CLI], { cwd: WE_ROOT, encoding: 'utf8' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(1);
    expect(caught.stderr).toContain('usage: node scripts/capability-search.mjs');
  });

  it('prints the human-readable (non --json) verdict line and hit rows', () => {
    const out = execFileSync('node', [CLI, 'publish and refresh a decision or architecture artifact'],
      { cwd: WE_ROOT, encoding: 'utf8' });
    expect(out).toContain('EXACT MATCH');
    expect(out).toContain('#3277');
    expect(out).toContain('backlog surface');
  });

  it('the real --limit=N argv flag trims each surface to N rows, not just the parsed option value', () => {
    const out = execFileSync('node', [CLI, 'publish and refresh a decision or architecture artifact', '--json', '--limit=1'],
      { cwd: WE_ROOT, encoding: 'utf8' });
    const report = JSON.parse(out);
    expect(report.backlog).toHaveLength(1);
    expect(report.operations).toHaveLength(1);
  });
});
