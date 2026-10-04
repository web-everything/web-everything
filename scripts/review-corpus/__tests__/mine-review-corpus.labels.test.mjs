import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git as fixtureGit, writeLocalIdentity } from '../../operations/__tests__/helpers/real-repo.mjs';
import { withGitReplay } from './helpers/git-replay.mjs';
import {
  PROVENANCE,
  buildCases,
  parseFindings,
  parseVerdict,
  pathUnchangedBetween,
  verdictComments,
} from '../mine-review-corpus.mjs';

// ── WHY THIS FILE EXISTS (#1571 review, `test-coverage` — the OWED prevention) ─────────────────────────────
// `__tests__/mine-review-corpus.test.mjs` covers the read-only guard and nothing else. The five functions
// that turn recorded review comments into the corpus's GROUND-TRUTH LABELS — verdictComments, parseVerdict,
// parseFindings, pathUnchangedBetween, buildCases — had zero coverage, while the PR claimed the mining was
// idempotent and the fixtures reproducible. The reviewer ran the mutation and it landed: changing
// `parseFindings`' bullet separator from the em-dash to a plain hyphen made the parser return ZERO findings
// from every verdict comment — the whole 39-label corpus collapses — and all 54 tests still passed.
//
// So the bar for this file is not "the functions are called". It is: BREAK THE TEMPLATE, REDDEN A TEST.
// Every shape of the `review-pr` comment the parser depends on is pinned below by a named assertion, and
// the golden at the bottom re-mines a committed set of real comment bodies and demands the cases come back
// BYTE-FOR-BYTE — the idempotency the description claims, now actually tested.
//
// ── AND IT OWNS ITS GIT (#1571 CI heal) ─────────────────────────────────────────────────────────────────
// The first cut of this file asked THE AMBIENT CHECKOUT for history: `git rev-parse HEAD~1` for the
// `pathUnchangedBetween` proofs, and real reachability for the golden's shas. CI checks this repo out at
// `fetch-depth: 1` — ONE commit — so `HEAD~1` died at collection and took all 30 tests in the file with it,
// and behind that failure the golden would have mined ZERO cases, because every recorded sha reads as
// unreachable in a depth-1 clone. Both were tests of the checkout, not of the code. Neither is now: the
// git-truth tests build their own two-commit repo, and the golden replays a recorded git. Deepening the CI
// checkout would have hidden the same dependency rather than removed it.

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(HERE, '..');
const ROOT = resolve(CORPUS, '..', '..');
const FIXTURES = join(HERE, 'fixtures', 'comments');

/* ------------------------------------------------------------------ template fixtures */

/** The `review-pr` verdict comment, in the exact shape the operation renders it. */
const verdict = ({
  headline = '🔁 review — changes requested',
  basis = `${'a'.repeat(40)}..${'b'.repeat(40)}`,
  findings = '',
  count = 1,
  decision = 'changes',
  lensNote = 'a SINGLE-LENS run',
} = {}) => `${headline}

Recorded by operator via the declared \`review-pr\` operation (#3035).

## Human review verdict — web-everything/web-everything#1559

**Verdict:** ✅ pass — no blocking findings

### Panel verdicts

| lens | weight | verdict |
| --- | --- | --- |
| correctness | mandatory | accept |
| security | advisory | abstain |

### Findings (${count})

${findings}

---

**Decision:** \`${decision}\` — recorded by operator.
**Lens:** \`correctness\` — ${lensNote}.
Net basis: \`${basis}\` (rev \`origin/lane/x\` at review time).
`;

/** One located finding bullet, em-dash separated, exactly as the template renders it. */
const bullet = (locus, marker = '_[CONFIRMED]_', impact = 'broken') =>
  `**broken-reference** (1)\n- \`${locus}\` — The closing cross-reference does not resolve. — An agent gets a hard miss. ${marker} _[impact if unfixed: ${impact}]_`;

/* ------------------------------------------------------------------ a real two-commit repo */

/**
 * A REAL repo with two real commits — `untouched.md` written in the first and never again, `edited.md`
 * rewritten in the second. That is the whole geometry the `missedHere` proof needs: one path that changed
 * between two heads and one that did not.
 *
 * Real git on purpose. A stub returning `''` would make `pathUnchangedBetween` answer "unchanged" for
 * everything, and every assertion below would pass against a function that does nothing. The identity
 * handling is imported from `we:scripts/operations/__tests__/helpers/real-repo.mjs` rather than rewritten
 * here — see that file's detail (1) for why a fixture repo needs `commit.gpgsign=false` in its own config.
 */
function twoCommitRepo() {
  // `realpathSync` because git reports resolved paths and macOS's `/tmp` is a symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-corpus-git-')));
  fixtureGit(['init', '--quiet', '-b', 'main', '.'], { cwd: root });
  writeLocalIdentity(root);
  writeFileSync(join(root, 'untouched.md'), 'written once, never edited\n');
  writeFileSync(join(root, 'edited.md'), 'before\n');
  fixtureGit(['add', '--', 'untouched.md', 'edited.md'], { cwd: root });
  fixtureGit(['commit', '--quiet', '-m', 'fixture: round 1'], { cwd: root });
  const parent = fixtureGit(['rev-parse', 'HEAD'], { cwd: root }).trim();
  writeFileSync(join(root, 'edited.md'), 'after\n');
  fixtureGit(['add', '--', 'edited.md'], { cwd: root });
  fixtureGit(['commit', '--quiet', '-m', 'fixture: round 2'], { cwd: root });
  const head = fixtureGit(['rev-parse', 'HEAD'], { cwd: root }).trim();
  // ASSERT THE GEOMETRY rather than trust it: if a future git staged these differently the tests below
  // would still pass while proving nothing, and this line is what stops that.
  const changed = fixtureGit(['diff', '--name-only', parent, head], { cwd: root }).trim();
  if (changed !== 'edited.md') throw new Error(`twoCommitRepo: expected only edited.md to change, got \`${changed}\``);
  return { root, parent, head };
}

/** Built once for the whole file — the two suites that need real history share it, and neither mutates it. */
let repo;
beforeAll(() => { repo = twoCommitRepo(); });
afterAll(() => { if (repo) rmSync(repo.root, { recursive: true, force: true }); });

/* ------------------------------------------------------------------ verdictComments */

describe('verdictComments — which comments are verdicts at all', () => {
  it('keeps both headlines and drops everything else', () => {
    const bodies = [
      '✅ review — accepted\n\nNet basis: nope',
      '🔁 review — changes requested\n\nbody',
      'a plain operator comment about the diff',
      '### Independent review round — findings not carried by the juror',
    ];
    expect(verdictComments(bodies)).toHaveLength(2);
  });

  it('drops non-strings rather than throwing on them', () => {
    // The GitHub API returns `body: null` for some comment kinds; a throw here would drop a whole PR.
    expect(verdictComments([null, undefined, 42, { body: 'x' }, '✅ review — accepted'])).toEqual(['✅ review — accepted']);
  });

  it('matches the headline EXACTLY — the em-dash is load-bearing', () => {
    // THE FRAGILITY THIS PINS. The match is an exact `includes` on a string containing an em-dash. A
    // template that switched to a hyphen would silently drop every verdict on every PR, and the miner
    // would report a smaller corpus rather than an error. If the template ever moves, this reddens.
    expect(verdictComments(['🔁 review - changes requested'])).toEqual([]);
    expect(verdictComments(['review — changes requested'])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ parseVerdict */

describe('parseVerdict — the structured facts', () => {
  it('reads the whole happy path', () => {
    const v = parseVerdict(verdict({ findings: bullet('scripts/a/b.mjs:37') }));
    expect(v).toMatchObject({
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      headline: 'changes',
      decision: 'changes',
      declaredFindings: 1,
      singleLens: true,
    });
    expect(v.lensRows).toEqual([
      { lens: 'correctness', weight: 'mandatory', verdict: 'accept' },
      { lens: 'security', weight: 'advisory', verdict: 'abstain' },
    ]);
    expect(v.findings).toHaveLength(1);
  });

  it('reads the accepted headline as `accepted`', () => {
    expect(parseVerdict(verdict({ headline: '✅ review — accepted', decision: 'accept' })).headline).toBe('accepted');
  });

  it('returns null when there is no `Net basis` line — unreplayable, so deliberately not guessed at', () => {
    // These are the 62 older unstructured verdicts the index counts as `skippedUnstructured`. Returning
    // null (not throwing, not inventing a range) is what keeps them out of the corpus.
    expect(parseVerdict('🔁 review — changes requested\n\nno basis line here')).toBeNull();
  });

  it('returns null on a MALFORMED basis rather than mining a bad range', () => {
    // Abbreviated shas, a single sha, or a `...` three-dot range are all rejected: the corpus replays
    // `base..head` against real commits, so a half-parsed range would produce silently wrong cases.
    expect(parseVerdict(verdict({ basis: 'abc1234..def5678' }))).toBeNull();
    expect(parseVerdict(verdict({ basis: `${'a'.repeat(40)}...${'b'.repeat(40)}` }))).toBeNull();
    expect(parseVerdict(verdict({ basis: 'a'.repeat(40) }))).toBeNull();
  });

  it('records a MULTI-lens run as singleLens false', () => {
    expect(parseVerdict(verdict({ lensNote: 'a full panel run' })).singleLens).toBe(false);
  });

  it('leaves declaredFindings null when the Findings heading is absent', () => {
    const body = verdict().replace(/### Findings \(\d+\)/, '### Notes');
    expect(parseVerdict(body).declaredFindings).toBeNull();
  });
});

/* ------------------------------------------------------------------ parseFindings */

describe('parseFindings — the labels themselves', () => {
  it('parses a located CONFIRMED bullet into a label', () => {
    const [f] = parseFindings(verdict({ findings: bullet('agent-memory-src/full-concurrency.md:37') }));
    expect(f).toMatchObject({
      path: 'agent-memory-src/full-concurrency.md',
      line: 37,
      category: 'broken-reference',
      verdict: 'CONFIRMED',
      impact: 'broken',
    });
    expect(f.summary).toBe('The closing cross-reference does not resolve.');
  });

  it('THE MUTATION THE #1571 REVIEW RAN — a hyphen where the template writes an em-dash parses nothing', () => {
    // `parseFindings`' bullet regex requires ` — `. The reviewer changed it to a plain hyphen and every
    // verdict comment yielded zero findings, collapsing the whole corpus, with all 54 tests still green.
    // This is the named red that mutation now produces. Both directions are pinned: the real separator
    // parses, the near-miss does not.
    const real = bullet('scripts/a/b.mjs:37');
    expect(parseFindings(verdict({ findings: real }))).toHaveLength(1);
    expect(parseFindings(verdict({ findings: real.replace(/ — /g, ' - ') }))).toHaveLength(0);
  });

  it('reads a PLAUSIBLE marker as a PLAUSIBLE label, not a CONFIRMED one', () => {
    // The scorer counts only CONFIRMED labels. Mis-reading this inflates the denominator every rate uses.
    const [f] = parseFindings(verdict({ findings: bullet('scripts/a/b.mjs:37', '_[PLAUSIBLE]_') }));
    expect(f.verdict).toBe('PLAUSIBLE');
  });

  it('drops a bullet carrying NEITHER marker — unverified narration is not a label', () => {
    expect(parseFindings(verdict({ findings: bullet('scripts/a/b.mjs:37', '') }))).toEqual([]);
  });

  it('drops a bullet whose locus is prose rather than a place', () => {
    // The scorer can only check a gate against a file, so an unlocated finding is not a usable label.
    for (const locus of ['npm run check:standards', '#3233', 'the conveyor', 'README']) {
      expect(parseFindings(verdict({ findings: bullet(locus) }))).toEqual([]);
    }
  });

  it('accepts a locus with no line number, and records line as null', () => {
    const [f] = parseFindings(verdict({ findings: bullet('scripts/a/b.mjs') }));
    expect(f).toMatchObject({ path: 'scripts/a/b.mjs', line: null });
  });

  it('strips the `we:` locus prefix so labels and gate hits share one path spelling', () => {
    // A gate hit's `path` is always repo-relative. A label spelled `we:scripts/…` would never match one.
    const [f] = parseFindings(verdict({ findings: bullet('we:scripts/a/b.mjs:12') }));
    expect(f.path).toBe('scripts/a/b.mjs');
  });

  it('carries the CATEGORY heading down onto the bullets beneath it', () => {
    const findings = [
      '**broken-reference** (1)',
      '- `scripts/a.mjs:1` — first — why _[CONFIRMED]_ _[impact if unfixed: broken]_',
      '',
      '**claim-accuracy** (1)',
      '- `scripts/b.mjs:2` — second — why _[CONFIRMED]_ _[impact if unfixed: degraded]_',
    ].join('\n');
    expect(parseFindings(verdict({ findings, count: 2 })).map((f) => f.category))
      .toEqual(['broken-reference', 'claim-accuracy']);
  });

  it('leaves category null when the heading line is MISSING, rather than dropping the finding', () => {
    // A label with an unknown category is still a label — losing it would shrink the corpus silently.
    const findings = '- `scripts/a.mjs:1` — orphan bullet — why _[CONFIRMED]_ _[impact if unfixed: broken]_';
    const [f] = parseFindings(verdict({ findings }));
    expect(f).toMatchObject({ path: 'scripts/a.mjs', category: null });
  });

  it('stops at the `---` rule, so the Decision block below is never mined as findings', () => {
    const body = verdict({ findings: bullet('scripts/a/b.mjs:37') })
      + '\n- `scripts/after-the-rule.mjs:9` — must not be mined — why _[CONFIRMED]_ _[impact if unfixed: broken]_\n';
    expect(parseFindings(body).map((f) => f.path)).toEqual(['scripts/a/b.mjs']);
  });

  it('returns [] when there is no Findings section at all', () => {
    expect(parseFindings('🔁 review — changes requested\n\nnothing structured here')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ pathUnchangedBetween */

describe('pathUnchangedBetween — the proof behind every `missedHere` label', () => {
  // Real git, real commits — in the fixture repo above, not in whatever checkout happens to run the suite.
  // The whole point of the label is that it is PROVEN per finding rather than assumed, so stubbing git here
  // would test nothing; asking the AMBIENT repo for `HEAD~1` tested the checkout's depth instead.

  it('is trivially true at an identical head', () => {
    expect(pathUnchangedBetween(repo.head, repo.head, 'anything/at/all.md', { cwd: repo.root })).toBe(true);
  });

  it('is FALSE for a file this commit actually changed', () => {
    expect(pathUnchangedBetween(repo.parent, repo.head, 'edited.md', { cwd: repo.root })).toBe(false);
  });

  it('is TRUE for a file this commit did not touch', () => {
    expect(pathUnchangedBetween(repo.parent, repo.head, 'untouched.md', { cwd: repo.root })).toBe(true);
  });

  it('fails CLOSED on an unreachable sha — an unprovable claim is not a proven one', () => {
    // If git errors, the answer must be "not proven", never "unchanged". The inverse would manufacture
    // `missedHere` labels out of unresolvable revisions.
    expect(pathUnchangedBetween('0'.repeat(40), repo.head, 'untouched.md', { cwd: repo.root })).toBe(false);
  });
});

/* ------------------------------------------------------------------ buildCases */

describe('buildCases — rounds, and what was findable but not found', () => {
  const sha = (c) => c.repeat(40);
  const v = (head, findings = []) => ({
    base: sha('0'), head, headline: 'changes', decision: 'changes', singleLens: true,
    lensRows: [], declaredFindings: findings.length, findings,
  });

  it('numbers rounds 1-based in recorded order and stamps totalRounds on every case', () => {
    const cases = buildCases(1559, [v(sha('a')), v(sha('b')), v(sha('c'))]);
    expect(cases.map((c) => c.round)).toEqual([1, 2, 3]);
    expect(cases.every((c) => c.totalRounds === 3)).toBe(true);
    expect(cases.every((c) => c.pr === 1559)).toBe(true);
  });

  it('marks a LATER finding as missed here when its file did not change in between', () => {
    const later = { path: 'untouched.md', line: 3, category: 'x', impact: 'broken', verdict: 'CONFIRMED', summary: 's' };
    const [r1, r2] = buildCases(1, [v(repo.parent), v(repo.head, [later])], { cwd: repo.root });
    expect(r1.missedHere).toHaveLength(1);
    expect(r1.missedHere[0]).toMatchObject({ path: 'untouched.md', foundAtRound: 2 });
    expect(r1.missedHere[0].provenBy).toMatch(/^git diff [0-9a-f]{8} [0-9a-f]{8} -- untouched\.md is empty$/);
    // The LAST round has no later round to be measured against, so it can never carry a missed label.
    expect(r2.missedHere).toEqual([]);
  });

  it('does NOT mark a finding as missed when the file changed in between', () => {
    const later = { path: 'edited.md', line: 1, category: 'x', impact: 'broken', verdict: 'CONFIRMED', summary: 's' };
    const [r1] = buildCases(1, [v(repo.parent), v(repo.head, [later])], { cwd: repo.root });
    expect(r1.missedHere).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the golden */

describe('GOLDEN — re-mining fixed comment bodies reproduces the committed cases byte-for-byte', () => {
  // THE CLAIM THIS TESTS. The PR says the fixtures are "mined idempotently" and need no network. That was
  // asserted, never checked. `fixtures/comments/<pr>.json` holds the REAL recorded comment bodies for
  // three PRs (trimmed to `body` only, which is all the miner reads, and 1561 truncated to the four
  // verdicts the committed corpus was mined from). Re-running the miner over them must reproduce
  // `cases/1506-r1.json`, `1559-r1..r2`, `1561-r1..r4` exactly — same bytes, no network, no `gh`.
  //
  // AND IT REPLAYS GIT (#1571 CI heal). The miner asks real git which of the recorded shas are reachable,
  // what changed between them, and when each was committed. In CI's `fetch-depth: 1` checkout every one of
  // those misses, every verdict is dropped as unreachable, and the miner writes zero cases — so the golden
  // was reading the checkout's depth, not the miner. `withGitReplay` puts a RECORDED `git` first on the
  // child's PATH instead, so the mining under test is the parse it claims to be. See `helpers/git-replay.mjs`.
  const replay = withGitReplay();
  afterAll(() => replay.cleanup());
  const out = mkdtempSync(join(tmpdir(), 'review-corpus-golden-'));
  const run = (dest) => execFileSync('node', [
    join(CORPUS, 'mine-review-corpus.mjs'),
    `--comments-dir=${FIXTURES}`,
    `--out=${dest}`,
  ], { cwd: ROOT, encoding: 'utf8', env: replay.env });

  const mined = (() => { run(out); return out; })();
  const caseFiles = readdirSync(mined).filter((f) => /^\d+-r\d+\.json$/.test(f)).sort();

  it('mines the seven cases the fixtures cover, and no others', () => {
    expect(caseFiles).toEqual([
      '1506-r1.json', '1559-r1.json', '1559-r2.json',
      '1561-r1.json', '1561-r2.json', '1561-r3.json', '1561-r4.json',
    ]);
  });

  it.each([
    '1506-r1.json', '1559-r1.json', '1559-r2.json',
    '1561-r1.json', '1561-r2.json', '1561-r3.json', '1561-r4.json',
  ])('%s is byte-identical to the committed case', (f) => {
    expect(readFileSync(join(mined, f), 'utf8')).toBe(readFileSync(join(CORPUS, 'cases', f), 'utf8'));
  });

  it('is IDEMPOTENT — a second run over the same bodies writes the same bytes again', () => {
    const second = mkdtempSync(join(tmpdir(), 'review-corpus-golden-'));
    try {
      run(second);
      for (const f of caseFiles) {
        expect(readFileSync(join(second, f), 'utf8')).toBe(readFileSync(join(mined, f), 'utf8'));
      }
      // `corpusAsOf` is taken from the newest mined COMMIT date, never a wall clock — so even the index
      // is stable across runs. A `new Date()` creeping in here would redden this and nothing else.
      expect(readFileSync(join(second, 'index.json'), 'utf8')).toBe(readFileSync(join(mined, 'index.json'), 'utf8'));
    } finally { rmSync(second, { recursive: true, force: true }); }
  });

  it('asked NO ambient git — every question went through the recording', () => {
    // Both paths pass in a full checkout, so without this the PATH override could silently stop taking
    // effect and the golden would stay green here while CI went red again. `calls()` is what the shim
    // actually fielded, so an empty log means the miner reached the machine's own git.
    const asked = replay.calls();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.some((q) => q.startsWith('cat-file -e '))).toBe(true);
  });

  it('the fixtures carry a PLAUSIBLE label, a CONFIRMED one, and a proven-missed one', () => {
    // Not decoration: the three label kinds every downstream number is built from are each exercised by
    // the golden, so a parser change that mangles one of them cannot pass on the strength of the others.
    const index = JSON.parse(readFileSync(join(mined, 'index.json'), 'utf8'));
    const all = caseFiles.flatMap((f) => JSON.parse(readFileSync(join(mined, f), 'utf8')).findings);
    expect(all.some((f) => f.verdict === 'CONFIRMED')).toBe(true);
    expect(all.some((f) => f.verdict === 'PLAUSIBLE')).toBe(true);
    expect(index.totals.provenMissed).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ provenance */

describe('the label caveat travels WITH the corpus', () => {
  it('`cases/index.json` carries the miner\'s own PROVENANCE string, verbatim', () => {
    // #1569 r3 f9 asked for one sentence of label provenance in the CODE, not only on the PR page. It
    // reached the description and never the tree. Pinning the two together is what stops the next drift:
    // a consumer who only ever reads `cases/` must still learn that a CONFIRMED label is unadjudicated.
    const index = JSON.parse(readFileSync(join(CORPUS, 'cases', 'index.json'), 'utf8'));
    expect(index.provenance).toBe(PROVENANCE);
    expect(PROVENANCE).toMatch(/unadjudicated self-assessment/);
    expect(PROVENANCE).toMatch(/never as an absolute catch rate/);
  });
});
