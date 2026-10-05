/**
 * @file scripts/__tests__/citation-check.test.mjs
 * @description Unit harness for the CITATION-VERIFICATION gate family (backlog #2821 — proven subset).
 *
 * Reproduces the real instances the #957 ratification review bounced on, as fixtures that FAIL today and
 * PASS once the citation is corrected:
 *   • the `#agent-convergence-independent-validation` anchor attributed to `#2439` FAILS (its codifiedIn
 *     ruling is `#2398`); the same attributed to `#2398` PASSES — the 11-vs-1 core (#2821 gate 10).
 *   • a dangling `we:scripts/nope.mjs:999` FAILS; a valid in-repo `we:<path>:<line>` PASSES; a `fui:` /
 *     `plateau:` cross-repo locus is NOT errored (#2821 gate 5).
 *   • a `xNNNNNN` hash-slug in a `reports/` file FAILS; the same in a `backlog/` file PASSES (in-scope,
 *     self-heals at land) (#2821 gate 3).
 *
 * Non-shallow: each case asserts the message/locus of the finding, not just a count. The pure detectors
 * are I/O-free, so filesystem facts are injected — the test never touches the real tree except the one
 * "real data stays warn-clean at ERROR promotion" guard the wiring relies on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildAnchorOwners,
  findAnchorRulingMismatches,
  findDanglingLoci,
  findBlankLineLoci,
  splitSourceLines,
  findOutOfScopeHashSlugs,
  findDanglingMemoryHashSlugs,
  countSourceLines,
  makeMemoizedLineCounter,
  CROSS_REPO_LOCI,
  findUnresolvedIdentifiers,
  buildIdentifierIndex,
  isIndexableSourcePath,
  regionMarkerPayload,
  stripSourceComments,
  splitRepoRef,
  REPO_PREFIXES,
  makeRepoResolver,
  findDanglingSymbolAnchors,
  findDanglingMarkdownLinks,
  findDanglingGraduatedTargets,
  parseIdentifierSpan,
  codeSpans,
  PROVENANCE_ESCAPE_MARKERS,
  findHashPathCiteOutsideBacklog,
  findHashPathCitesInGrepLines,
  classifyHashPathCite,
  HASH_PATH_CITE_SOURCE,
  findDanglingBacklogGlobCite,
  BACKLOG_GLOB_CITE_SOURCE,
  buildBacklogResolvableIds,
  findDanglingBacklogGlobCitesInGrepLines,
} from '../lib/citation-check.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('buildAnchorOwners', () => {
  it('maps an anchor to the SET of backlog items whose codifiedIn owns it', () => {
    const owners = buildAnchorOwners([
      { num: '2398', codifiedIn: 'docs/agent/platform-decisions.md#agent-convergence-independent-validation' },
      { num: '2439', codifiedIn: undefined },
      { num: '020', codifiedIn: '"docs/agent/platform-decisions.md#constellation-placement"' },
    ]);
    expect(owners.get('agent-convergence-independent-validation')).toEqual(new Set(['2398']));
    expect(owners.get('constellation-placement')).toEqual(new Set(['020']));
    expect(owners.has('nonexistent')).toBe(false);
  });

  it('UNIONS every owner of a MULTI-OWNER anchor — the corpus reality (32+ anchors have 2+ owners)', () => {
    // #constellation-placement has 43 codifiedIn owners on the real tree; the single-owner premise kept only
    // whichever readdirSync yielded first and mislabeled the rest. The union keeps them all.
    const owners = buildAnchorOwners([
      { num: '020', codifiedIn: 'docs/agent/platform-decisions.md#constellation-placement' },
      { num: '021', codifiedIn: 'docs/agent/platform-decisions.md#constellation-placement' },
      { num: '022', codifiedIn: 'docs/agent/platform-decisions.md#constellation-placement' },
    ]);
    expect(owners.get('constellation-placement')).toEqual(new Set(['020', '021', '022']));
  });

  it('confers ownership via graduatedTo too (an item that graduated INTO the anchor)', () => {
    // 14 items on the real tree graduate to a platform-decisions anchor; that is just as much an authority
    // for it as codifiedIn. #1832 owns #composition-preserves-a11y-contract via graduatedTo.
    const owners = buildAnchorOwners([
      { num: '1795', codifiedIn: 'docs/agent/platform-decisions.md#composition-preserves-a11y-contract' },
      { num: '1832', graduatedTo: '"docs/agent/platform-decisions.md#composition-preserves-a11y-contract"' },
    ]);
    expect(owners.get('composition-preserves-a11y-contract')).toEqual(new Set(['1795', '1832']));
  });
});

describe('findAnchorRulingMismatches — gate 10 (the 11-vs-1 core)', () => {
  const owners = buildAnchorOwners([
    { num: '2398', codifiedIn: 'docs/agent/platform-decisions.md#agent-convergence-independent-validation' },
  ]);

  it('FAILS when the anchor is attributed to #2439 (its ruling is #2398) — shape A `#anchor (#NNN)`', () => {
    const text = 'a landed PR is accepted by an agent that did not author the fix ' +
      '(`#agent-convergence-independent-validation` (#2439)). No knob relaxes it.';
    const hits = findAnchorRulingMismatches(text, owners);
    expect(hits).toHaveLength(1);
    expect(hits[0].anchor).toBe('agent-convergence-independent-validation');
    expect(hits[0].citedNum).toBe('2439');
    expect(hits[0].owners).toEqual(['2398']);
  });

  it('FAILS on the real #2563 shape — anchor and number in one paren `(`#anchor`, #2439)` (shape B)', () => {
    const text = 'accepted by an agent that did not author the fix ' +
      '(`#agent-convergence-independent-validation`, #2439). No knob relaxes it.';
    const hits = findAnchorRulingMismatches(text, owners);
    expect(hits).toHaveLength(1);
    expect(hits[0].shape).toBe('B');
    expect(hits[0].citedNum).toBe('2439');
    expect(hits[0].owners).toEqual(['2398']);
  });

  it('PASSES when the anchor is attributed to the correct ruling #2398', () => {
    const text = 'did not author the fix (`#agent-convergence-independent-validation` (#2398)).';
    expect(findAnchorRulingMismatches(text, owners)).toHaveLength(0);
  });

  it('#2861 — the reproduced shape-A false positive: a separate ADJACENT paren whose leading number is ' +
    'PROSE, not an attribution', () => {
    // The exact repro from the card: the wrapper class steps over the markdown link's own closing `)`, and
    // a loose tail let `#9999`'s unrelated prose paren read as `#foo-anchor`'s attribution.
    const text = 'see [foo](#foo-anchor) (#9999 tracks the build slice).';
    expect(findAnchorRulingMismatches(text, buildAnchorOwners([
      { num: '100', codifiedIn: 'docs/agent/platform-decisions.md#foo-anchor' },
    ]))).toHaveLength(0);
  });

  it('#2861 — the SAME-paren comma form of that number still fires (shape B, unaffected by the shape-A fix)', () => {
    const text = 'compose (`#foo-anchor`, #9999).';
    const hits = findAnchorRulingMismatches(text, buildAnchorOwners([
      { num: '100', codifiedIn: 'docs/agent/platform-decisions.md#foo-anchor' },
    ]));
    expect(hits).toHaveLength(1);
    expect(hits[0].shape).toBe('B');
    expect(hits[0].citedNum).toBe('9999');
  });

  // ── Shared must-NOT-fire table (#2861 "Approach"): each row states one non-attribution scenario TWICE —
  // once phrased so only shape A's regex could plausibly match (`phraseA`), once phrased so only shape B's
  // could (`phraseB`) — and both phrasings cite a DELIBERATELY WRONG (non-owner) number. That second part is
  // load-bearing: a fixture that cites the anchor's real owner would pass even if a precision guard were
  // deleted, because `record()` short-circuits on ownership before the shape claim is ever exercised (the
  // exact vacuity #2861 found in the old `{#anchor}` test, below). Citing a wrong number means the ONLY way
  // either row can assert 0 findings is the shape stage rejecting the match — so a guard regression on
  // either branch is caught by its own row, and one guard can never silently cover for the other's absence.
  const fooOwners = buildAnchorOwners([{ num: '2398', codifiedIn: 'docs/agent/platform-decisions.md#foo-anchor' }]);
  const MUST_NOT_FIRE_TABLE = [
    {
      name: 'a trailing/co-resident number followed by PROSE, not a comma or immediate close',
      phraseA: 'see [foo](#foo-anchor) (#9999 tracks the build slice).',
      phraseB: 'the note (#9999 introduces the check enforced by `#foo-anchor`) holds.',
    },
    {
      name: 'a bare cross-reference paren with no attributing number at all',
      phraseA: 'Extends [foo](#foo-anchor) (independence rests on a distinct validator, never peer/self agreement).',
      phraseB: '(independence rests on a distinct validator that never numbers `#foo-anchor` at all).',
    },
    {
      name: 'a number that belongs to a DIFFERENT, preceding paren than the anchor',
      phraseA: '**Ratified 2026-07-18 (#9999).** Composes with — does not alter — [foo](#foo-anchor): a care signal.',
      phraseB: 'first (#9999) is ratified; a second, unrelated group (`#foo-anchor` alone) follows.',
    },
    {
      name: 'the heading-definition form `{#anchor}` is never a citation, adjacent number or not',
      // Non-owner #9999 (was #2398, the real owner, in the pre-#2861 test — the fix this table exists for).
      phraseA: '### Heading {#foo-anchor}\n\n**Ratified 2026-07-10 (#9999, graduated to epic #2410).**',
      phraseB: 'a stray same-paren form embedding the heading token directly: (`{#foo-anchor}`, #9999) ' +
        'should not read as an attribution either.',
    },
  ];

  for (const { name, phraseA, phraseB } of MUST_NOT_FIRE_TABLE) {
    it(`does NOT fire (either phrasing) — ${name}`, () => {
      expect(findAnchorRulingMismatches(phraseA, fooOwners)).toHaveLength(0);
      expect(findAnchorRulingMismatches(phraseB, fooOwners)).toHaveLength(0);
    });
  }
});

describe('findAnchorRulingMismatches — MULTI-OWNER authority (32+ anchors have 2+ owners on the corpus)', () => {
  // `#component-dc` is one of the real multi-owner anchors. A citation to ANY of its legitimate owners must
  // PASS; only a number that owns NONE of it is a genuine mis-attribution and FAILS.
  const owners = buildAnchorOwners([
    { num: '043', codifiedIn: 'docs/agent/platform-decisions.md#component-dc' },
    { num: '854', codifiedIn: 'docs/agent/platform-decisions.md#component-dc' },
    { num: '900', codifiedIn: 'docs/agent/platform-decisions.md#component-dc' },
    // graduatedTo also confers ownership — mirror the real #compose-dont-handroll / #933 case.
    { num: '933', graduatedTo: '"docs/agent/platform-decisions.md#compose-dont-handroll"' },
    { num: '1394', codifiedIn: 'docs/agent/platform-decisions.md#compose-dont-handroll' },
  ]);

  it('PASSES when the cited #NNN is ONE of several legitimate owners (not the first-seen)', () => {
    // #854 is not the first owner, yet it genuinely owns #component-dc — the single-owner premise wrongly
    // flagged this as a mismatch (16 of the 17 corpus false positives were exactly this).
    const text = 'the definition-of-component rule (`#component-dc` (#854)) governs here.';
    expect(findAnchorRulingMismatches(text, owners)).toHaveLength(0);
  });

  it('FAILS when the cited #NNN owns NONE of the anchor (a genuinely wrong attribution)', () => {
    const text = 'the definition-of-component rule (`#component-dc` (#2439)) governs here.';
    const hits = findAnchorRulingMismatches(text, owners);
    expect(hits).toHaveLength(1);
    expect(hits[0].citedNum).toBe('2439');
    expect(hits[0].owners).toEqual(['043', '854', '900']); // the full sorted owner set, none of them #2439
  });

  it('PASSES when the cited #NNN owns the anchor via graduatedTo (demo-workflow #compose-dont-handroll #933)', () => {
    // The reviewer's own example: `demo-workflow.md` citing `#compose-dont-handroll (#933)` must PASS, since
    // #933 owns it via graduatedTo even though #1394 owns it via codifiedIn.
    const text = 'compose over hand-rolling (`#compose-dont-handroll` (#933)).';
    expect(findAnchorRulingMismatches(text, owners)).toHaveLength(0);
  });
});

describe('findDanglingLoci — gate 5 (`we:<path>:<line>` must resolve)', () => {
  const tree = { 'scripts/real.mjs': 200 };
  const fileExists = (p) => Object.hasOwn(tree, p);
  const lineCount = (p) => tree[p] ?? null;

  it('FAILS on a dangling path — `we:scripts/nope.mjs:999` (no such file)', () => {
    const hits = findDanglingLoci('see we:scripts/nope.mjs:999 for the call', { fileExists, lineCount });
    expect(hits).toHaveLength(1);
    expect(hits[0].locus).toBe('we:scripts/nope.mjs:999');
    expect(hits[0].reason).toBe('missing-file');
  });

  it('FAILS on an out-of-range line — file exists but line is past EOF', () => {
    const hits = findDanglingLoci('defined at we:scripts/real.mjs:999', { fileExists, lineCount });
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe('line-out-of-range');
    expect(hits[0].path).toBe('scripts/real.mjs');
  });

  it('PASSES on a valid in-repo locus (file exists, line in range), incl. a range on both bounds', () => {
    expect(findDanglingLoci('at we:scripts/real.mjs:144', { fileExists, lineCount })).toHaveLength(0);
    expect(findDanglingLoci('at we:scripts/real.mjs:1-200', { fileExists, lineCount })).toHaveLength(0);
  });

  it('does NOT error a cross-repo `fui:` / `plateau:` locus (target not in this checkout)', () => {
    const text = 'see fui:scripts/gone.mjs:9999 and plateau:src/missing.ts:4242';
    expect(findDanglingLoci(text, { fileExists, lineCount })).toHaveLength(0);
    expect(CROSS_REPO_LOCI.has('fui:')).toBe(true);
    expect(CROSS_REPO_LOCI.has('plateau:')).toBe(true);
  });

  it('does NOT match a symbol-anchor form `we:path#symbol` (no `:line`) — gate 6 is not in this subset', () => {
    expect(findDanglingLoci('we:scripts/real.mjs#applyLedger', { fileExists, lineCount })).toHaveLength(0);
  });

  it('SKIPS a `..`-escaping or absolute path WITHOUT ever calling the fs readers (no traversal read)', () => {
    // A locus whose path climbs out of the repo (or is absolute) must never reach fileExists/lineCount — the
    // caller resolves those against ROOT with readFileSync, so a huge/streaming target would hang the gate.
    const calls = [];
    const spyExists = (p) => { calls.push(p); return true; };
    const spyCount = (p) => { calls.push(p); return 10; };
    const text = 'see we:../../../../dev/urandom:1 and we:/etc/passwd:1 for the call';
    expect(findDanglingLoci(text, { fileExists: spyExists, lineCount: spyCount })).toHaveLength(0);
    expect(calls).toHaveLength(0); // never resolved — the guard skips before any fs read
  });
});

describe('countSourceLines — gate 5 line-count (no trailing-newline overcount)', () => {
  it('does not count the terminator of a newline-terminated file as an extra line', () => {
    expect(countSourceLines('a\nb\n')).toBe(2); // two lines, trailing \n is a terminator not a 3rd line
    expect(countSourceLines('a\nb')).toBe(2);   // no trailing newline — still two lines
    expect(countSourceLines('a')).toBe(1);
    expect(countSourceLines('a\n')).toBe(1);
    expect(countSourceLines('')).toBe(0);       // empty file has no lines
  });

  it('makes a locus one line past the true end read as OUT of range (the off-by-one the naive split missed)', () => {
    const tree = { 'scripts/real.mjs': 'l1\nl2\n' }; // 2 real lines, trailing newline
    const fileExists = (p) => Object.hasOwn(tree, p);
    const lineCount = (p) => countSourceLines(tree[p] ?? '');
    const hits = findDanglingLoci('at we:scripts/real.mjs:3', { fileExists, lineCount });
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe('line-out-of-range');
    expect(findDanglingLoci('at we:scripts/real.mjs:2', { fileExists, lineCount })).toHaveLength(0);
  });
});

describe('findOutOfScopeHashSlugs — gate 3 (hash-slug outside the at-land rewrite scope)', () => {
  it('FAILS on a `#xNNNNNN` hash-ref in a reports/ file (rewriter never touches reports/)', () => {
    const hits = findOutOfScopeHashSlugs('the read slice #xntcdet re-estimates', 'reports/2026-07-20-slice.md');
    expect(hits).toHaveLength(1);
    expect(hits[0].slug).toBe('xntcdet');
    expect(hits[0].form).toBe('hash-ref');
  });

  it('FAILS on a `xNNNNNN-slug.md` file link in a research-descriptions njk', () => {
    const hits = findOutOfScopeHashSlugs('[the item](x9kptqv-ratify-gate.md)',
      'src/_includes/research-descriptions/topic.njk');
    expect(hits).toHaveLength(1);
    expect(hits[0].slug).toBe('x9kptqv');
    expect(hits[0].form).toBe('file-link');
  });

  it('PASSES (empty) for the SAME hash-slug in a backlog/ file — in-scope, self-heals at land', () => {
    expect(findOutOfScopeHashSlugs('cites #xntcdet', 'backlog/2565-epic.md')).toHaveLength(0);
    expect(findOutOfScopeHashSlugs('cites #xntcdet', 'docs/agent/backlog-workflow.md')).toHaveLength(0);
  });

  it('does NOT fire on a word that merely starts with x + letters but is not a hash-slug form', () => {
    // `xoverflow` has 8 chars after x; a real slug is exactly `x`+6 and cited as `#x...` or `x...-slug.md`.
    expect(findOutOfScopeHashSlugs('the xoverflow example and extended prose', 'reports/r.md')).toHaveLength(0);
  });

  // #2863 — dedupe by slug, per file. A slug repeated N times (whatever the mix of forms) is one reader-visible
  // problem, so it must be one finding, not one per occurrence.
  it('DEDUPES: a slug cited 11 times as a hash-ref in one file yields exactly ONE finding', () => {
    const text = Array.from({ length: 11 }, () => '#xntcdet').join(' and ');
    const hits = findOutOfScopeHashSlugs(text, 'reports/repeats.md');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ slug: 'xntcdet', form: 'hash-ref' });
  });

  it('DEDUPES across BOTH cited forms — a hash-ref and a file-link for the same slug collapse to one finding', () => {
    const text = 'first cited as #xntcdet, later linked as [it](xntcdet-ratify-gate.md), and again #xntcdet.';
    const hits = findOutOfScopeHashSlugs(text, 'reports/mixed-forms.md');
    expect(hits).toHaveLength(1);
    // The FIRST-seen form wins (hash-ref is scanned before file-link) — enough for the message to point at a
    // concrete citation; which exact form is reported is not the load-bearing behaviour, dedup-to-one is.
    expect(hits[0].slug).toBe('xntcdet');
    expect(hits[0].form).toBe('hash-ref');
  });

  it('still reports TWO findings for two genuinely DIFFERENT slugs in the same file', () => {
    const hits = findOutOfScopeHashSlugs('cites #xntcdet twice: #xntcdet, and also #x9kptqv once', 'reports/two.md');
    expect(hits.map((h) => h.slug).sort()).toEqual(['x9kptqv', 'xntcdet']);
  });
});

describe('findHashPathCiteOutsideBacklog — #4075 follow-up (xmd4pfa): a hash-named FILE PATH cited outside backlog/', () => {
  // RED: reproduces the exact live incident before the fix — build-dispatch.flow.json cited a card's
  // backlog file by its pre-numbering hash path, and that path 404'd the moment the drain renamed it.
  it('FIRES on a hash-named backlog file path cited from a flow (or any non-backlog) file', () => {
    const hits = findHashPathCiteOutsideBacklog(
      'its own live-caught cost is recorded in backlog/xr05jjl-describe-every-conveyor-flow.md:15',
      'scripts/conveyor/flows/build-dispatch.flow.json',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ path: 'backlog/xr05jjl-describe-every-conveyor-flow.md', hash: 'xr05jjl' });
  });

  // GREEN: citing the SAME card by its stable id (bare hash-ref, no file path) never fires — that shape
  // survives the rename fine (it resolves against `bornAs`, and is the form this rule tells authors to use).
  it('PASSES (empty) for a bare `#hash` cross-ref — not a file path, so nothing to dangle', () => {
    expect(findHashPathCiteOutsideBacklog('build carried by #xr05jjl', 'scripts/conveyor/flows/build-dispatch.flow.json')).toHaveLength(0);
  });

  it('PASSES (empty) for the SAME hash-named path cited from INSIDE backlog/ itself — the ledger\'s own target, always exempt', () => {
    expect(findHashPathCiteOutsideBacklog('see backlog/xr05jjl-describe-every-conveyor-flow.md', 'backlog/2200-other.md')).toHaveLength(0);
  });

  it('exempts captured thread data in both the direct and shared grep scanners', () => {
    const file = 'scripts/conveyor/soak/fixtures/pr-3794-live-thread.json';
    const text = 'backlog/xcs4nce-card.md and backlog/xi8vgqq-card.md';
    expect(findHashPathCiteOutsideBacklog(text, file)).toEqual([]);
    expect(findHashPathCitesInGrepLines([`${file}:1:${text}`])).toEqual([]);
    expect(findHashPathCiteOutsideBacklog(text, 'scripts/conveyor/soak/other.json')).toHaveLength(2);
  });

  it('PASSES (empty) for a numeric backlog path — JIT numbering never renames an already-landed #NNN', () => {
    expect(findHashPathCiteOutsideBacklog('see backlog/4220-describe-every-conveyor-flow.md', 'docs/agent/rule.md')).toHaveLength(0);
  });

  it('dedupes the SAME hash-named path cited twice in one file to one finding', () => {
    const text = 'first: backlog/xr05jjl-a.md, again: backlog/xr05jjl-a.md';
    expect(findHashPathCiteOutsideBacklog(text, 'reports/note.md')).toHaveLength(1);
  });

  it('reports two findings for two genuinely different hash-named paths in the same file', () => {
    const text = 'backlog/xr05jjl-a.md and backlog/x9kptqv-b.md';
    const hits = findHashPathCiteOutsideBacklog(text, 'reports/note.md');
    expect(hits.map((h) => h.hash).sort()).toEqual(['x9kptqv', 'xr05jjl']);
  });

  it('HASH_PATH_CITE_SOURCE is a valid POSIX ERE (git grep -E) and ECMA regex — one pattern, both engines', () => {
    // The drain's own pre-push check (scripts/lane-drain.mjs#numberPendingHashes) feeds this exact string to
    // `git grep -E`; this only proves the ECMA half compiles and matches the same shape.
    expect(new RegExp(HASH_PATH_CITE_SOURCE).test('backlog/xr05jjl-a.md')).toBe(true);
    expect(new RegExp(HASH_PATH_CITE_SOURCE).test('backlog/4220-a.md')).toBe(false);
  });

  it('findHashPathCitesInGrepLines reports EVERY cite on a git-grep line, and keeps the test-file exemption', () => {
    const hits = findHashPathCitesInGrepLines([
      'scripts/mixed.mjs:3:// see backlog/xnotone-other.md and backlog/xhash01-alpha.md',
      'scripts/__tests__/x.test.mjs:9:fixture backlog/xhash02-beta.md',
    ]);
    expect(hits).toEqual([
      { file: 'scripts/mixed.mjs', path: 'backlog/xnotone-other.md', hash: 'xnotone' },
      { file: 'scripts/mixed.mjs', path: 'backlog/xhash01-alpha.md', hash: 'xhash01' },
    ]);
  });
});

describe('findDanglingBacklogGlobCite — gate 6f-ii-d (#4318): the wildcard-glob `backlog/<id>-*.md` convention', () => {
  // Pure-function case: an id absent from the SUPPLIED resolvableIds fires. This is NOT the xrv69j6
  // incident (see the test below and the #4318 card's own correction) — the real resolvableIds construction
  // (num ∪ bornAs-of-hash-items) would include xrv69j6 via #4238's bornAs, so that specific citation was a
  // staleness/hygiene fix, never something this gate flagged. This case is a genuinely unresolvable id, the
  // shape the gate's real corpus hit (a citation with no num AND no bornAs match anywhere) takes.
  it('FIRES on a hash id absent from resolvableIds', () => {
    const hits = findDanglingBacklogGlobCite(
      'own unlocked write of ~/.claude.json. See we:backlog/xnotany-*.md and dispatch-lane-io.mjs#isTrustRefusal.',
      'scripts/conveyor/health-smells/dispatch-trust-refused.mjs',
      { resolvableIds: new Set(['4238']) },
    );
    expect(hits).toEqual([{ id: 'xnotany', path: 'backlog/xnotany-*.md' }]);
  });

  // WIRING case (round-2 independent review: "nothing tests the bornAs union end to end", and — round-3
  // red-team — "the wiring test re-implements the union locally instead of calling the shipped code, so it
  // tests its own copy, not the gate"). Calls the ACTUAL SHARED builder check-standards.mjs's gate calls
  // (buildBacklogResolvableIds), not a local reimplementation, from a synthetic backlog fixture, and proves
  // a hash that graduated to a landed number (num:'4238', bornAs:'xrv69j6') resolves. This is the real-world
  // shape of the xrv69j6→#4238 graduation this item's own build ran into: the gate does NOT flag it, and
  // this test can never silently drift from that guarantee the way a re-implemented copy could.
  it('a graduated hash resolves via buildBacklogResolvableIds (the SAME builder the real gate calls) — never flagged', () => {
    const backlog = [
      { num: '4238', bornAs: 'xrv69j6' },
      { num: 'xqmw8g9' }, // a still-pending item: hash num, no bornAs yet
    ];
    const resolvableIds = buildBacklogResolvableIds(backlog);
    expect(findDanglingBacklogGlobCite('see we:backlog/xrv69j6-*.md', 'docs/agent/rule.md', { resolvableIds })).toHaveLength(0);
  });

  it('buildBacklogResolvableIds: a still-pending item (hash num, no bornAs) resolves via its own num', () => {
    const resolvableIds = buildBacklogResolvableIds([{ num: 'xqmw8g9' }]);
    expect(resolvableIds.has('xqmw8g9')).toBe(true);
  });

  it('buildBacklogResolvableIds: ignores a non-hash-shaped bornAs (never asserts membership it can\'t back)', () => {
    const resolvableIds = buildBacklogResolvableIds([{ num: '10', bornAs: 'not-a-hash' }]);
    expect(resolvableIds.has('not-a-hash')).toBe(false);
    expect(resolvableIds.has('10')).toBe(true);
  });

  it('buildBacklogResolvableIds: tolerates a missing/empty backlog array — never throws', () => {
    expect(buildBacklogResolvableIds([])).toEqual(new Set());
    expect(buildBacklogResolvableIds(undefined)).toEqual(new Set());
  });

  it('FIRES on a numeric id that was renumbered away — not just hash ids', () => {
    const hits = findDanglingBacklogGlobCite('see we:backlog/9999-*.md', 'docs/agent/rule.md', { resolvableIds: new Set(['4238']) });
    expect(hits).toEqual([{ id: '9999', path: 'backlog/9999-*.md' }]);
  });

  // GREEN: once xrv69j6's bornAs (still pending) or #4238 (landed) is in the resolution set, the SAME glob
  // citation passes — this is the after-fix shape for a currently-live citation, not a synthetic case.
  it('PASSES (empty) once the id resolves via a landed item\'s num', () => {
    expect(findDanglingBacklogGlobCite('see we:backlog/4238-*.md', 'docs/agent/rule.md', { resolvableIds: new Set(['4238']) })).toHaveLength(0);
  });

  it('PASSES (empty) once the id resolves via a still-pending item\'s bornAs hash', () => {
    expect(findDanglingBacklogGlobCite('see we:backlog/xrv69j6-*.md', 'docs/agent/rule.md', { resolvableIds: new Set(['xrv69j6']) })).toHaveLength(0);
  });

  it('PASSES (empty) for a REAL slug (no literal `*`) — that is gate 6f-ii-c\'s citation shape, not this one\'s', () => {
    expect(findDanglingBacklogGlobCite('see backlog/xrv69j6-a-real-slug.md', 'docs/agent/rule.md', { resolvableIds: new Set() })).toHaveLength(0);
  });

  it('PASSES (empty) for a synthetic glob-cite string living in a test file\'s own fixture — not a real citation', () => {
    expect(findDanglingBacklogGlobCite('see we:backlog/xnotreal-*.md', 'scripts/__tests__/whatever.test.mjs', { resolvableIds: new Set() })).toHaveLength(0);
  });

  it('dedupes the SAME dangling id cited twice in one file to one finding', () => {
    const text = 'first: backlog/xdupe01-*.md, again: backlog/xdupe01-*.md';
    expect(findDanglingBacklogGlobCite(text, 'reports/note.md', { resolvableIds: new Set() })).toHaveLength(1);
  });

  it('reports two findings for two genuinely different dangling ids in the same file', () => {
    const text = 'backlog/xoneid1-*.md and backlog/xtwoid2-*.md';
    const hits = findDanglingBacklogGlobCite(text, 'reports/note.md', { resolvableIds: new Set() });
    expect(hits.map((h) => h.id).sort()).toEqual(['xoneid1', 'xtwoid2']);
  });

  it('defaults resolvableIds to empty when omitted — every glob cite dangles with no resolution set', () => {
    expect(findDanglingBacklogGlobCite('see backlog/1234-*.md', 'reports/note.md')).toEqual([{ id: '1234', path: 'backlog/1234-*.md' }]);
  });

  it('BACKLOG_GLOB_CITE_SOURCE is a valid POSIX ERE (git grep -E) and ECMA regex — one pattern, both engines', () => {
    expect(new RegExp(BACKLOG_GLOB_CITE_SOURCE).test('backlog/xrv69j6-*.md')).toBe(true);
    expect(new RegExp(BACKLOG_GLOB_CITE_SOURCE).test('backlog/4238-*.md')).toBe(true);
    expect(new RegExp(BACKLOG_GLOB_CITE_SOURCE).test('backlog/xrv69j6-a-real-slug.md')).toBe(false);
  });
});

describe('findDanglingBacklogGlobCitesInGrepLines — gate 6f-ii-d\'s ACTUAL wiring (round-3 red-team, #4318)', () => {
  // The wiring check-standards.mjs's gate calls: raw `git grep -n` lines in, file+line parsing, per-file/id
  // dedup ACROSS the whole hit set (not just within one line) out. Round-3 red-team: every lens converged on
  // "this exact shape is described in a comment but defended by no test" — this closes that gap for real,
  // by testing the function the gate actually calls, not a re-implementation of it.
  it('reports EVERY dangling cite on a git-grep line, and keeps the test-file exemption', () => {
    const hits = findDanglingBacklogGlobCitesInGrepLines([
      'scripts/mixed.mjs:3:// see backlog/xnotone-*.md and backlog/xhash01-*.md',
      'scripts/__tests__/x.test.mjs:9:fixture backlog/xhash02-*.md',
    ], { resolvableIds: new Set() });
    expect(hits).toEqual([
      { file: 'scripts/mixed.mjs', id: 'xnotone', path: 'backlog/xnotone-*.md' },
      { file: 'scripts/mixed.mjs', id: 'xhash01', path: 'backlog/xhash01-*.md' },
    ]);
  });

  it('dedupes the SAME (file, id) pair across MULTIPLE distinct git-grep lines — not just within one line', () => {
    const hits = findDanglingBacklogGlobCitesInGrepLines([
      'scripts/a.mjs:3:first: backlog/xdupe01-*.md',
      'scripts/a.mjs:9:again, same file: backlog/xdupe01-*.md',
    ], { resolvableIds: new Set() });
    expect(hits).toEqual([{ file: 'scripts/a.mjs', id: 'xdupe01', path: 'backlog/xdupe01-*.md' }]);
  });

  it('does NOT dedupe the SAME id cited from two DIFFERENT files', () => {
    const hits = findDanglingBacklogGlobCitesInGrepLines([
      'scripts/a.mjs:1:backlog/xshared-*.md',
      'scripts/b.mjs:1:backlog/xshared-*.md',
    ], { resolvableIds: new Set() });
    expect(hits.map((h) => h.file).sort()).toEqual(['scripts/a.mjs', 'scripts/b.mjs']);
  });

  it('an id present in resolvableIds produces no finding, from real grep-line input', () => {
    const hits = findDanglingBacklogGlobCitesInGrepLines(
      ['docs/agent/rule.md:5:see backlog/4238-*.md'],
      { resolvableIds: new Set(['4238']) },
    );
    expect(hits).toHaveLength(0);
  });

  it('a line with no second colon (no line number) is skipped, never throws', () => {
    expect(findDanglingBacklogGlobCitesInGrepLines(['not-a-grep-line'], { resolvableIds: new Set() })).toEqual([]);
  });

  it('defaults resolvableIds to empty and tolerates an empty lines array', () => {
    expect(findDanglingBacklogGlobCitesInGrepLines([])).toEqual([]);
  });
});

describe('makeMemoizedLineCounter — gate 5\'s line-count reader, memoized per path (#2863)', () => {
  it('reads a given path AT MOST ONCE even when queried many times, INCLUDING interleaved with other paths', () => {
    const tree = { 'docs/agent/platform-decisions.md': 'l1\nl2\nl3\n', 'scripts/merge-ai-prs.mjs': 'a\nb\n' };
    const reads = [];
    const counter = makeMemoizedLineCounter((p) => { reads.push(p); return tree[p]; });
    // Simulate many citing loci hitting the same popular file, interleaved with a second file's citations —
    // the real shape (#2863 measured platform-decisions.md read 145x, merge-ai-prs.mjs 40x in one gate pass).
    for (let i = 0; i < 20; i++) {
      expect(counter('docs/agent/platform-decisions.md')).toBe(3);
      if (i % 5 === 0) expect(counter('scripts/merge-ai-prs.mjs')).toBe(2);
    }
    expect(reads).toEqual(['docs/agent/platform-decisions.md', 'scripts/merge-ai-prs.mjs']); // one read, each, ever
  });

  it('caches a MISSING/unreadable file as null too, so a dangling locus does not re-throw on every occurrence', () => {
    let calls = 0;
    const counter = makeMemoizedLineCounter((p) => { calls++; throw new Error(`ENOENT: ${p}`); });
    expect(counter('scripts/nope.mjs')).toBeNull();
    expect(counter('scripts/nope.mjs')).toBeNull();
    expect(counter('scripts/nope.mjs')).toBeNull();
    expect(calls).toBe(1);
  });

  it('drops in as findDanglingLoci\'s lineCount option and still resolves correctly, just with fewer reads', () => {
    const tree = { 'scripts/real.mjs': 'l1\nl2\n' };
    const fileExists = (p) => Object.hasOwn(tree, p);
    let reads = 0;
    const lineCount = makeMemoizedLineCounter((p) => { reads++; return tree[p]; });
    // Two DIFFERENT loci in the same citing text, both pointing at the same file.
    const hits = findDanglingLoci('at we:scripts/real.mjs:2 and also we:scripts/real.mjs:3', { fileExists, lineCount });
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe('line-out-of-range');
    expect(reads).toBe(1); // one file, one read, despite two distinct loci resolving against it
  });
});

describe('findDanglingMemoryHashSlugs — gate 3b (#3100): resolution, not directory membership', () => {
  it('does NOT fire on a hash-slug that is still PENDING (a tracked backlog/<hash>.md exists) — self-heals at its own land', () => {
    const hits = findDanglingMemoryHashSlugs('this note cites #xpend01, still in flight', {
      pendingHashes: new Set(['xpend01']),
      bornAsHashes: new Set(),
    });
    expect(hits).toHaveLength(0);
  });

  it('FAILS on a hash-slug whose item already LANDED (a `bornAs` match exists) — stale, should read #NNN', () => {
    const hits = findDanglingMemoryHashSlugs('filed #xlanded, 2026-07-26', {
      pendingHashes: new Set(),
      bornAsHashes: new Set(['xlanded']),
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ slug: 'xlanded', form: 'hash-ref', reason: 'dead-landed' });
  });

  it('FAILS on a hash-slug that resolves to NEITHER a pending file NOR a bornAs record — never existed', () => {
    const hits = findDanglingMemoryHashSlugs('see [the item](xghost1-notes.md) for detail', {
      pendingHashes: new Set(),
      bornAsHashes: new Set(),
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ slug: 'xghost1', form: 'file-link', reason: 'unresolved' });
  });

  it('does NOT false-positive on the SAME hash cited in a dir gate 3 (membership) would have flagged — the #3100 interface bug this gate exists to avoid', () => {
    // The card's own independent review found: adding agent-memory-src/ to HASH_SLUG_OUT_OF_SCOPE_DIRS
    // (gate 3's membership test) would WARN on this exact case, because it does not distinguish
    // "mid-flight, will self-heal at its own land" from "already dead". This gate must not repeat that.
    const hits = findDanglingMemoryHashSlugs('cites #xinflight — the item this note is ABOUT is still open', {
      pendingHashes: new Set(['xinflight']),
      bornAsHashes: new Set(),
    });
    expect(hits).toHaveLength(0);
  });

  it('degenerate input never throws', () => {
    expect(findDanglingMemoryHashSlugs('', {})).toEqual([]);
    expect(findDanglingMemoryHashSlugs(null, {})).toEqual([]);
    expect(findDanglingMemoryHashSlugs('no hashes here', {})).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The PROVENANCE gate (#3026) — a backticked identifier in prose must resolve, or be marked
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** A tree that knows only these names. `validateTodoMarker` is real; `validateTodoMarkerBlock` never was —
 *  that pair IS the round-3 regression this gate exists to catch. */
const REAL = new Set(['validateTodoMarker', 'validateContract', 'countSourceLines', 'computeAgreementMetric',
  'resolveLandMode', 'ciStatus', 'POLICY_SPEC_BASENAMES']);
const resolves = (t) => REAL.has(t);
/** Report the whole body (the wired gate always passes a real added-line set; `null` means "all lines"). */
const scan = (text, opts = {}) => findUnresolvedIdentifiers(text, { resolves, addedLines: null, ...opts });
const tokens = (text, opts) => scan(text, opts).filter((f) => f.kind === 'unresolved').map((f) => f.token);

describe('parseIdentifierSpan — what shape reads as an existence claim', () => {
  it('accepts camelCase and SCREAMING_SNAKE, bare', () => {
    expect(parseIdentifierSpan('validateTodoMarker')).toEqual({ token: 'validateTodoMarker', form: 'bare' });
    expect(parseIdentifierSpan('POLICY_SPEC_BASENAMES')).toEqual({ token: 'POLICY_SPEC_BASENAMES', form: 'bare' });
  });

  it('accepts a call WITH ARGUMENTS — the strongest existence claim, and the one #3026 as filed missed', () => {
    // The statute asserts `enforceFlipReady({ ciStatus, reviewShadowLedger })`. #3026's design said only
    // "a trailing `()` tolerated", which does not match that span at all — so the single most-cited false
    // symbol in the briefing would have walked straight through the gate built to its literal spec.
    expect(parseIdentifierSpan('enforceFlipReady({ ciStatus, reviewShadowLedger })'))
      .toEqual({ token: 'enforceFlipReady', form: 'call' });
    expect(parseIdentifierSpan('judgeSpawn()')).toEqual({ token: 'judgeSpawn', form: 'call' });
    expect(parseIdentifierSpan('ns.deep.someHelper(a, b)')).toEqual({ token: 'someHelper', form: 'call' });
  });

  it('rejects the shapes that are ENGLISH, not citations — the false-positive floor', () => {
    for (const notACitation of ['status', 'the walk', 'TODO', 'WE', 'CustomStore', 'kebab-case', 'a.b']) {
      expect(parseIdentifierSpan(notACitation)).toBeNull();
    }
  });
});

describe('findUnresolvedIdentifiers — the regression the gate was built for', () => {
  it('THE REAL ONE: `validateTodoMarkerBlock` fires, `validateTodoMarker` does not', () => {
    // Round 3 of PR #1112, verbatim in shape: a name that ought to have existed, shipped in the past tense.
    const body = 'Where it is today: `validateTodoMarkerBlock` / the reasons walk in `validateContract`.';
    const found = scan(body);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'unresolved', token: 'validateTodoMarkerBlock', form: 'bare', line: 1 });
    expect(scan('the real helper is `validateTodoMarker`')).toHaveLength(0);
  });

  it('catches the statute call-form cite `enforceFlipReady({ … })` that resolves to nothing', () => {
    expect(tokens('gated by a readiness predicate, `enforceFlipReady({ ciStatus, reviewShadowLedger })`, that arms it'))
      .toEqual(['enforceFlipReady']);
  });

  it('stays silent on names that DO resolve, including inside a call', () => {
    expect(scan('the proven `computeAgreementMetric` bar and `resolveLandMode()` path')).toHaveLength(0);
  });

  it('never reads a fenced code block as prose', () => {
    const body = ['prose is checked: `realOne`', '```js', 'const totallyFakeSymbol = 1; // `alsoFake`', '```',
      'and `anotherFake` after the fence'].join('\n');
    expect(tokens(body)).toEqual(['realOne', 'anotherFake']);
  });
});

describe('findUnresolvedIdentifiers — the escapes, and their limits', () => {
  it('the inline marker suppresses, and all three spellings work', () => {
    expect(scan('a new `mountLaneBoard` (proposed) helper')).toHaveLength(0);
    expect(scan('`enforceFlipReady` (does not exist) in the tree')).toHaveLength(0);
    expect(scan('names like `detectAnomalies` (example) illustrate the class')).toHaveLength(0);
    // Emphasis inside the parens is the form actually written in #3013 prep.
    expect(scan('`enforceFlipReady` (**does not exist**) — refuted')).toHaveLength(0);
  });

  it('the escape vocabulary is CLOSED — a near-miss word does not suppress', () => {
    // Greppability is the whole value; an open synonym list would make `grep '(proposed)'` incomplete.
    expect(tokens('a new `mountLaneBoard` (planned) helper')).toEqual(['mountLaneBoard']);
    expect(tokens('a new `mountLaneBoard` (future) helper')).toEqual(['mountLaneBoard']);
    expect(PROVENANCE_ESCAPE_MARKERS).toEqual(['proposed', 'does not exist', 'example']);
  });

  it('the marker binds to the token it FOLLOWS, not to the whole line', () => {
    expect(tokens('`firstFake` and `secondFake` (proposed)')).toEqual(['firstFake']);
  });

  it('a reasoned `provenance-lint: off` region suppresses; `on` re-arms', () => {
    const body = ['<!-- provenance-lint: off — historical citations, these never existed -->',
      '| `collectOpenItemIds` | `validateTodoMarkerBlock` |',
      '<!-- provenance-lint: on -->', 'but `escapedNothing` here fires'].join('\n');
    expect(tokens(body)).toEqual(['escapedNothing']);
  });

  it('a REASONLESS `provenance-lint: off` suppresses NOTHING and is reported itself (fail-closed)', () => {
    const body = ['<!-- provenance-lint: off -->', '`stillFires` must still fire'].join('\n');
    const found = scan(body);
    expect(found.map((f) => f.kind)).toEqual(['escape-no-reason', 'unresolved']);
    expect(found[1].token).toBe('stillFires');
  });

  it('`## Done when` / `## Design` are escape zones, and a SUBSECTION inherits the zone', () => {
    const body = ['# Item', 'lede cites `ledeFake`', '## Done when', '- `doneWhenFake` exists',
      '### sub of done-when', '- `subFake` too', '## Provenance', 'cites `provenanceFake`'].join('\n');
    expect(tokens(body)).toEqual(['ledeFake', 'provenanceFake']);
  });

  it('a marker QUOTED in prose or in an inline code span does NOT open a region (the self-disarm defect)', () => {
    // THE DEFECT. The region regex used to be tested against the RAW line, so any sentence containing the
    // words "provenance-lint: off" opened a region whose "reason" was the rest of the sentence — and nothing
    // ever closed it. A page merely DOCUMENTING the escape therefore switched the gate off for its own
    // remainder. Every one of these shapes must be inert.
    const quoted = ['A bare `provenance-lint: off` suppresses nothing and is reported in its own right.',
      '`stillFiresAfterInlineSpan` must fire'].join('\n');
    expect(tokens(quoted)).toEqual(['stillFiresAfterInlineSpan']);

    const doubled = ['Write `` `provenance-lint: off — some reason` `` to open one.',
      '`stillFiresAfterDoubledSpan` must fire'].join('\n');
    expect(tokens(doubled)).toEqual(['stillFiresAfterDoubledSpan']);

    // Even the whole HTML-comment form, quoted as code, is a marker being DISCUSSED, not issued.
    const quotedComment = ['Open one with `<!-- provenance-lint: off — why -->` and close it after the block.',
      '`stillFiresAfterQuotedComment` must fire'].join('\n');
    expect(tokens(quotedComment)).toEqual(['stillFiresAfterQuotedComment']);

    // Bare prose with no comment opener at all — the exact shape that disarmed conventions.md.
    const barePr0se = ['The provenance-lint: off marker needs a reason to do anything at all.',
      '`stillFiresAfterBareProse` must fire'].join('\n');
    expect(tokens(barePr0se)).toEqual(['stillFiresAfterBareProse']);

    // …and a fenced example, which was already inert, stays inert AND stays non-suppressing.
    const fenced = ['```', '<!-- provenance-lint: off — an example in a fence -->', '```',
      '`stillFiresAfterFence` must fire'].join('\n');
    expect(tokens(fenced)).toEqual(['stillFiresAfterFence']);

    // The REAL marker — an actual HTML comment, unquoted — still works. Not a hollow tightening.
    const real = ['<!-- provenance-lint: off — historical names -->', '`suppressed` here',
      '<!-- provenance-lint: on -->', '`firesAgain` here'].join('\n');
    expect(tokens(real)).toEqual(['firesAgain']);
  });

  it('THE FIXTURE: docs/agent/conventions.md documents the escape without ARMING it (#3026 self-disarm)', () => {
    // This reads the REAL file on purpose. The defect was found by seeding a fake identifier before and after
    // the "Provenance" section of this very page: the one before fired, the one after was silent, because the
    // sentence "A bare `provenance-lint: off` suppresses nothing" opened a region that ran to EOF. Reworded
    // prose can reintroduce that at any time, so the assertion is against the shipped page, not a paraphrase.
    const real = readFileSync(join(REPO_ROOT, 'docs/agent/conventions.md'), 'utf8');
    expect(real).toContain('provenance-lint: off');           // the page really does discuss the marker
    const lines = real.split('\n');
    const sectionAt = lines.findIndex((l) => /^##\s+Provenance:/.test(l));
    expect(sectionAt).toBeGreaterThan(-1);

    // Seed the same probe the reviewer used: one before the section, one at the very END of the file.
    const seeded = [...lines];
    seeded.push('Trailing prose citing `zzSeededAfterProvenanceSection` here.');
    seeded.splice(sectionAt, 0, 'Leading prose citing `zzSeededBeforeProvenanceSection` here.', '');
    const probe = (t) => !t.startsWith('zzSeeded');
    const found = findUnresolvedIdentifiers(seeded.join('\n'), { resolves: probe, addedLines: null });
    const seen = found.map((f) => f.token);
    expect(seen).toContain('zzSeededBeforeProvenanceSection');
    expect(seen).toContain('zzSeededAfterProvenanceSection');  // ← was silent before the fix

    // And the page must open no region at all: nothing on it is left suppressing at EOF.
    expect(found.filter((f) => f.kind === 'escape-unclosed')).toEqual([]);
    expect(found.filter((f) => f.kind === 'escape-no-reason')).toEqual([]);
  });

  it('an `off` region left OPEN at end of file is reported (it suppresses everything after it)', () => {
    // Design-accepted that it suppresses to EOF; NOT accepted that it does so silently.
    const body = ['<!-- provenance-lint: off — historical names, never closed -->', '`quietlySuppressed` here'].join('\n');
    const found = scan(body);
    expect(found.map((f) => f.kind)).toEqual(['escape-unclosed']);
    expect(found[0].line).toBe(1);
    // Closing it clears the report.
    expect(scan([body, '<!-- provenance-lint: on -->'].join('\n'))).toEqual([]);
    // Diff-scoped: an unclosed region whose OPENING line the change did not add is not re-litigated.
    expect(findUnresolvedIdentifiers(body, { resolves, addedLines: new Set([2]) })).toEqual([]);
  });

  it('only ADDED lines are reported, but escape state is read from the WHOLE file', () => {
    // The heading and the fence are untouched context; the added line must still inherit them.
    const body = ['## Done when', '- `underUntouchedHeading`', '## Elsewhere', '- `reportedHere`',
      '- `notAddedSoSilent`'].join('\n');
    const found = findUnresolvedIdentifiers(body, { resolves, addedLines: new Set([2, 4]) });
    expect(found.map((f) => f.token)).toEqual(['reportedHere']);
  });
});

describe('codeSpans — both markdown inline-code forms', () => {
  it('reads the DOUBLE-backtick form, which docs/agent/conventions.md uses throughout', () => {
    // Found by observation, not by design: the first wiring reported CLEAN on a docs page deliberately
    // seeded with two bad names, because every example on it was written `` `x` `` (the wrapper you need
    // when the displayed code contains a backtick). A gate that reads a file and sees nothing is worse
    // than no gate, so both forms are extracted.
    const line = 'bare (`` `countSourceLines` ``) or as a call (`` `enforceFlipReady({ ciStatus })` ``)';
    expect(codeSpans(line).map((s) => s.inner)).toEqual(['countSourceLines', 'enforceFlipReady({ ciStatus })']);
    expect(tokens(line)).toEqual(['enforceFlipReady']);
  });

  it('still reads the plain single-backtick form, and does not double-count a doubled span', () => {
    expect(codeSpans('a `single` span').map((s) => s.inner)).toEqual(['single']);
    expect(codeSpans('`` `wrapped` ``').map((s) => s.inner)).toEqual(['wrapped']);
  });

  it('an escape marker after a DOUBLED span still binds', () => {
    expect(scan('`` `mountLaneBoard` `` (proposed) is unbuilt')).toHaveLength(0);
  });
});

describe('findUnresolvedIdentifiers — comment syntax, for the `leash: spec` surface', () => {
  it('reads JSDoc as prose and IGNORES the code around it', () => {
    // The round-1 miss of PR #1112 lived in exactly this shape: a false symbol asserted in a conformance
    // suite's JSDoc header, where no compiler and no gate could reach it.
    const body = ['/**', ' * `collectOpenItemIds` in we:scripts/lib/validate-rules-anchors.cjs', ' */',
      'const someLocalThing = 1;', 'export function anotherCodeSymbol() {}'].join('\n');
    expect(tokens(body, { syntax: 'comment' })).toEqual(['collectOpenItemIds']);
  });

  it('reads a `//` line comment as prose too', () => {
    expect(tokens('// the helper `lineCommentFake` does the walk', { syntax: 'comment' })).toEqual(['lineCommentFake']);
  });

  it('a comment resolves against its OWN file\'s code — the local index that stops the over-correction', () => {
    // Test files are excluded from the tree-wide index (their fixtures name things that must not exist).
    // Excluding them wholesale over-corrected: a conformance suite's JSDoc legitimately names helpers
    // defined right below it, and 6 such names went red on PR #1112's diff. The wiring therefore resolves
    // a comment against the tree PLUS this file's own CODE — reproduced here with the same composition.
    const body = ['/**', ' * `definedRightBelow` walks it; `neverDefinedAnywhere` does not exist.', ' */',
      'export function definedRightBelow() { return 1; }'].join('\n');
    const local = buildIdentifierIndex([body]);
    const composed = (t) => REAL.has(t) || local.has(t);
    const found = findUnresolvedIdentifiers(body, { resolves: composed, addedLines: null, syntax: 'comment' });
    expect(found.map((f) => f.token)).toEqual(['neverDefinedAnywhere']);
  });
});

describe('regionMarkerPayload — where a `provenance-lint:` directive may legitimately live', () => {
  it('markdown: only inside an HTML comment, and never inside a code span', () => {
    expect(regionMarkerPayload('<!-- provenance-lint: off — why -->')).toBe(' provenance-lint: off — why ');
    expect(regionMarkerPayload('prose saying provenance-lint: off out loud')).toBeNull();
    expect(regionMarkerPayload('a `provenance-lint: off` quoted marker')).toBeNull();
    expect(regionMarkerPayload('a `` `<!-- provenance-lint: off — x -->` `` quoted comment')).toBeNull();
  });

  it('comment syntax: the whole comment line qualifies, punctuation stripped', () => {
    expect(regionMarkerPayload(' * provenance-lint: off — historical names', 'comment').trim())
      .toBe('provenance-lint: off — historical names');
    expect(regionMarkerPayload('// provenance-lint: on', 'comment').trim()).toBe('provenance-lint: on');
    expect(regionMarkerPayload('/* provenance-lint: off — why */', 'comment').trim())
      .toBe('provenance-lint: off — why');
    expect(regionMarkerPayload('// a `provenance-lint: off` quoted marker', 'comment'))
      .not.toMatch(/provenance-lint/);
  });

  it('the region escape works end-to-end in a `leash: spec` source comment', () => {
    const body = ['/**', ' * provenance-lint: off — historical misses, none of these ever existed',
      ' * `collectOpenItemIds` and `validateTodoMarkerBlock`', ' * provenance-lint: on',
      ' * but `stillFiresHere` does', ' */'].join('\n');
    expect(tokens(body, { syntax: 'comment' })).toEqual(['stillFiresHere']);
  });

  it('a marker on a CODE line in comment mode is inert — a directive must live in a comment', () => {
    const body = ['const s = "provenance-lint: off — not a directive, just a string";',
      '// cites `fakeAfterStringLiteral`'].join('\n');
    expect(tokens(body, { syntax: 'comment' })).toEqual(['fakeAfterStringLiteral']);
  });
});

describe('isIndexableSourcePath — the resolution index\'s vocabulary, and what is kept OUT of it', () => {
  it('indexes ordinary source, in any indexable extension', () => {
    for (const p of ['scripts/lib/citation-check.mjs', 'src/index.ts', 'src/x.njk', 'scripts/tool.cjs',
      'src/css/style.css', 'config/thing.yml']) {
      expect(isIndexableSourcePath(p)).toBe(true);
    }
  });

  it('indexes `.mts` / `.cts` — omitting an ordinary source extension silently manufactures false positives', () => {
    // Omitted on first wiring. A name defined ONLY in such a file contributed no vocabulary, so citing it
    // reported "resolves to NO source file in this checkout" — a false positive with no way for an author to
    // tell it apart from a real miss. One tracked file was affected when this was fixed: `vite.config.mts`.
    for (const p of ['vite.config.mts', 'scripts/tool.cts', 'src/lib/thing.mts']) {
      expect(isIndexableSourcePath(p)).toBe(true);
    }
    // The two exclusions still apply ON TOP of the new extensions — adding an extension must not open a hole.
    expect(isIndexableSourcePath('src/thing.test.mts')).toBe(false);
    expect(isIndexableSourcePath('docs/agent/thing.cts')).toBe(false);
  });

  it('EXCLUDES test files — the mutation-fragile line the gate depends on', () => {
    // Delete this exclusion and this very file's string literals ('enforceFlipReady', 'collectOpenItemIds',
    // 'validateTodoMarkerBlock') enter the index, so all three historical regressions start "resolving" and
    // the gate reports clean on the defects it exists to catch. It was previously covered only by an
    // end-to-end probe, i.e. not covered.
    for (const p of ['scripts/__tests__/citation-check.test.mjs', 'src/lib/__mocks__/thing.mjs',
      'src/lib/__fixtures__/data.json', 'src/thing.test.ts', 'src/thing.spec.js']) {
      expect(isIndexableSourcePath(p)).toBe(false);
    }
  });

  it('EXCLUDES prose dirs — else a false citation resolves against the sentence that invented it', () => {
    for (const p of ['backlog/3026-x.md', 'docs/agent/conventions.md', 'reports/r.md', 'plans/p.md',
      'research/t.md']) {
      expect(isIndexableSourcePath(p)).toBe(false);
    }
  });

  it('EXCLUDES non-source and degenerate paths', () => {
    for (const p of ['src/assets/icons/a.svg', 'README', 'bin/tool', '', null, 42]) {
      expect(isIndexableSourcePath(p)).toBe(false);
    }
  });
});

describe('buildIdentifierIndex / stripSourceComments — what "resolves" means', () => {
  it('indexes identifier-shaped tokens from code', () => {
    const idx = buildIdentifierIndex(['export function realHelper() { const MY_CONST = 1; return MY_CONST; }']);
    expect(idx.has('realHelper')).toBe(true);
    expect(idx.has('MY_CONST')).toBe(true);
    expect(idx.has('export')).toBe(false); // not identifier-SHAPED (no interior capital)
  });

  it('EXCLUDES comment text — the miss that a naive index caused on replay', () => {
    // Replaying PR #1112 round 1 with comments indexed, `collectOpenItemIds` did NOT fire: the token
    // resolved against the very JSDoc line that invented it. A citation asserts something about the CODE.
    const src = ['/** the helper `inventedInJsdoc` walks the tree */', 'export function realCode() {}'].join('\n');
    const idx = buildIdentifierIndex([src]);
    expect(idx.has('realCode')).toBe(true);
    expect(idx.has('inventedInJsdoc')).toBe(false);
  });

  it('does NOT strip a trailing `//` — it would eat every https:// URL and delete real code tokens', () => {
    const kept = stripSourceComments('const u = "https://example.com/someRealPath";');
    expect(kept).toContain('someRealPath');
    expect(buildIdentifierIndex(['const homeUrl = "https://x.dev/api";']).has('homeUrl')).toBe(true);
  });

  it('handles a NUL-sentinel file without choking — plain grep silently reports nothing on these', () => {
    // guard-bash.mjs, renumber-collisions.mjs and component-render-build-hook.cjs carry deliberate NUL
    // bytes. readFileSync+regex treat \0 as an ordinary character, so they must index normally.
    // Written as an ESCAPE, never a literal NUL byte in this file — a committed raw NUL is the very
    // footgun under test (plain `grep` reports nothing on such a file; `grep -a` is needed to see it).
    const NUL = '\0';
    const nulSrc = `const before = 1;${NUL}${NUL} export function afterTheNul() {}`;
    const idx = buildIdentifierIndex([nulSrc]);
    expect(idx.has('afterTheNul')).toBe(true);
    // and the prose scanner must not throw or mis-scan on one either
    const nulProse = `prose with ${NUL} a NUL and \`someFakeName\` after`;
    expect(() => scan(nulProse)).not.toThrow();
    expect(tokens(nulProse)).toEqual(['someFakeName']);
  });
});

describe('findUnresolvedIdentifiers — degenerate input never throws', () => {
  it('tolerates empty / non-string / missing resolver', () => {
    expect(findUnresolvedIdentifiers('', { resolves })).toEqual([]);
    expect(findUnresolvedIdentifiers(null, { resolves })).toEqual([]);
    expect(findUnresolvedIdentifiers('`someFake`', {})).toEqual([]);
  });

  it('tolerates an unterminated fence and an unterminated escape region', () => {
    expect(() => scan('```\nunclosed fence with `fakeOne`')).not.toThrow();
    expect(scan('```\nunclosed fence with `fakeOne`')).toHaveLength(0);
    // The unclosed region still suppresses the token (design-accepted) — but now says so out loud.
    const unclosed = scan('<!-- provenance-lint: off — never closed -->\n`fakeTwo`');
    expect(unclosed.map((f) => f.kind)).toEqual(['escape-unclosed']);
    expect(unclosed.filter((f) => f.kind === 'unresolved')).toEqual([]);
  });
});

// ── Reference RESOLUTION gates (#2821 gate 5 widened — 2026-09-06 staleness audit) ────────────────
describe('splitRepoRef', () => {
  it('splits every recognised prefix, longest-first so plateau-app: beats plateau:', () => {
    expect(splitRepoRef('we:scripts/a.mjs')).toEqual({ prefix: 'we:', path: 'scripts/a.mjs' });
    expect(splitRepoRef('plateau-app:src/a.ts')).toEqual({ prefix: 'plateau-app:', path: 'src/a.ts' });
    expect(splitRepoRef('plateau:src/a.ts')).toEqual({ prefix: 'plateau:', path: 'src/a.ts' });
    expect(splitRepoRef('frontierui:blocks/b.ts')).toEqual({ prefix: 'frontierui:', path: 'blocks/b.ts' });
  });

  it('returns null for an UNPREFIXED path — guessing a repo is the mis-resolution this gate exists to avoid', () => {
    expect(splitRepoRef('scripts/a.mjs')).toBeNull();
    expect(splitRepoRef('conformanceVectors.ts')).toBeNull();
  });

  it('refuses an absolute or `..`-escaping path so no traversal reaches an fs reader', () => {
    expect(splitRepoRef('we:/etc/passwd')).toBeNull();
    expect(splitRepoRef('we:../../../dev/urandom')).toBeNull();
  });

  it('strips trailing punctuation a prose sentence leaves on the ref', () => {
    expect(splitRepoRef('we:scripts/a.mjs.')?.path).toBe('scripts/a.mjs');
    expect(splitRepoRef('we:scripts/a.mjs,')?.path).toBe('scripts/a.mjs');
  });
});

describe('makeRepoResolver', () => {
  const mk = (present, repos = ['.', '../frontierui', '../plateau-app']) => makeRepoResolver({
    join: (...p) => join(...p),
    exists: (p) => repos.some((r) => p === join('.', r)) || present.has(p),
    read: (p) => (present.has(p) ? present.get(p) : (() => { throw new Error('ENOENT'); })()),
    root: '.',
  });

  it('resolves present and missing paths in each checkout', () => {
    const { resolvePath } = mk(new Map([[join('.', '.', 'scripts/a.mjs'), 'x'], [join('.', '../frontierui', 'blocks/b.ts'), 'y']]));
    expect(resolvePath('we:', 'scripts/a.mjs')).toBe('present');
    expect(resolvePath('frontierui:', 'blocks/b.ts')).toBe('present');
    expect(resolvePath('we:', 'scripts/gone.mjs')).toBe('missing');
  });

  it('reports no-repo — NOT present — when the sibling checkout is absent (fail-closed, #3502 Done-when 2)', () => {
    const { resolvePath } = mk(new Map(), ['.']); // only WE checked out
    expect(resolvePath('plateau:', 'src/anything.ts')).toBe('no-repo');
    expect(resolvePath('frontierui:', 'blocks/b.ts')).toBe('no-repo');
  });
});

describe('findDanglingSymbolAnchors (gate 5b — the drift-immune form, finally validated)', () => {
  const reader = (files, repos = new Set(['we:', 'frontierui:'])) => (prefix, path) => {
    if (!repos.has(prefix)) return { status: 'no-repo' };
    return files.has(path) ? { status: 'ok', text: files.get(path) } : { status: 'missing' };
  };

  it('passes an anchor whose symbol is present', () => {
    const files = new Map([['scripts/a.mjs', 'export function doThing() {}']]);
    expect(findDanglingSymbolAnchors('see we:scripts/a.mjs#doThing', { readRepoFile: reader(files) })).toEqual([]);
  });

  it('flags an anchor naming a symbol the file does not contain', () => {
    const files = new Map([['scripts/a.mjs', 'export function doThing() {}']]);
    const out = findDanglingSymbolAnchors('see we:scripts/a.mjs#doOtherThing', { readRepoFile: reader(files) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: 'doOtherThing', reason: 'symbol-not-found' });
  });

  it('does not accept a PARTIAL identifier match (`foo` must not satisfy a file holding only `fooBar`)', () => {
    const files = new Map([['scripts/a.mjs', 'const fooBar = 1;']]);
    const out = findDanglingSymbolAnchors('we:scripts/a.mjs#foo', { readRepoFile: reader(files) });
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('symbol-not-found');
  });

  it('flags a missing file, and SKIPS an absent checkout rather than passing it', () => {
    const r = reader(new Map());
    expect(findDanglingSymbolAnchors('we:scripts/gone.mjs#x', { readRepoFile: r })[0].reason).toBe('missing-file');
    expect(findDanglingSymbolAnchors('plateau:src/gone.ts#x', { readRepoFile: r })).toEqual([]);
  });

  it('scans EVERY prefix splitRepoRef accepts — the alternation is derived, not hand-listed', () => {
    // The first cut spelled the alternation out and omitted `webeverything:`, so an anchor using it
    // resolved fine through splitRepoRef/makeRepoResolver and was silently never scanned here.
    const files = new Map([['scripts/foo.mjs', 'export const other = 1;']]);
    for (const prefix of REPO_PREFIXES) {
      const out = findDanglingSymbolAnchors(`see ${prefix}scripts/foo.mjs#bar`, {
        readRepoFile: () => ({ status: 'ok', text: files.get('scripts/foo.mjs') }),
      });
      expect(out, `${prefix} must be scanned`).toHaveLength(1);
      expect(out[0].reason).toBe('symbol-not-found');
    }
  });

  it('ignores a GitHub-style `#L123` line anchor — a line ref, not a symbol assertion', () => {
    const files = new Map([['blocks/Nav.ts', 'export class Nav {}']]);
    expect(findDanglingSymbolAnchors('we:blocks/Nav.ts#L47', { readRepoFile: reader(files) })).toEqual([]);
  });

  it('ignores a hyphenated markdown heading anchor (not an identifier)', () => {
    const files = new Map([['docs/agent/x.md', '# Some Heading']]);
    expect(findDanglingSymbolAnchors('we:docs/agent/x.md#some-heading', { readRepoFile: reader(files) })).toEqual([]);
  });
});

describe('findDanglingGraduatedTargets (gate 5c — the #2756 class)', () => {
  const resolvePath = (prefix, path) => {
    if (prefix === 'plateau:') return 'no-repo';
    return path === 'plugs/webdirectives/ssr/net/' ? 'present' : 'missing';
  };

  it('flags a resolved item whose graduatedTo target does not exist (the #2756 reproduction)', () => {
    const out = findDanglingGraduatedTargets(
      [{ num: '2756', status: 'resolved', graduatedTo: 'frontierui:plugs/webdirectives/ssr/rust/' }],
      { resolvePath });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ num: '2756', path: 'plugs/webdirectives/ssr/rust/' });
  });

  it('passes once the target is present', () => {
    expect(findDanglingGraduatedTargets(
      [{ num: '2383', status: 'resolved', graduatedTo: 'frontierui:plugs/webdirectives/ssr/net/ (foundation)' }],
      { resolvePath })).toEqual([]);
  });

  it('skips `none`, including a `none (… deleted by #NNNN …)` record naming a real-looking path', () => {
    expect(findDanglingGraduatedTargets(
      [{ num: '1010', status: 'resolved', graduatedTo: 'none (landed in we:plugs/__tests__/e2e/, deleted by #1047)' }],
      { resolvePath })).toEqual([]);
  });

  it('resolves EACH member of a comma-joined multi-artifact graduation (#2210 names three files)', () => {
    const out = findDanglingGraduatedTargets(
      [{ num: '2210', status: 'resolved', graduatedTo: 'frontierui:plugs/webdirectives/ssr/net/,frontierui:gone/a.js' }],
      { resolvePath });
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('gone/a.js');
  });

  it('skips a `{a,b}` brace expansion — a family shorthand no fs call can resolve (#1954)', () => {
    expect(findDanglingGraduatedTargets(
      [{ num: '1954', status: 'resolved', graduatedTo: 'we:src/_includes/project-{webtheme,weblayout}.njk' }],
      { resolvePath })).toEqual([]);
  });

  it('strips a trailing #fragment — a doc anchor is not part of the path (#1932)', () => {
    const withDoc = (prefix, path) => (path === 'docs/agent/backlog-workflow.md' ? 'present' : 'missing');
    expect(findDanglingGraduatedTargets(
      [{ num: '1932', status: 'resolved', graduatedTo: 'we:docs/agent/backlog-workflow.md#red-team-the-default' }],
      { resolvePath: withDoc })).toEqual([]);
  });

  it('ignores non-resolved items and an absent checkout', () => {
    expect(findDanglingGraduatedTargets(
      [{ num: '1', status: 'open', graduatedTo: 'frontierui:nope/' },
       { num: '2', status: 'resolved', graduatedTo: 'plateau:src/nope.ts' }],
      { resolvePath })).toEqual([]);
  });
});


describe('findDanglingMarkdownLinks (gate 5e — relative markdown links must resolve)', () => {
  const run = (text, present = [], fromDir = 'backlog') => {
    const calls = [];
    const out = findDanglingMarkdownLinks(text, { fromDir, exists: (p) => (calls.push(p), present.includes(p)) });
    return { out, calls };
  };

  it('flags a relative link to a missing file', () => {
    const { out } = run('[x](platform-decisions.md#a)');
    expect(out).toEqual([{ link: 'platform-decisions.md#a', resolved: 'backlog/platform-decisions.md', reason: 'missing-file' }]);
  });
  it('passes a resolving link, incl. ../ traversal', () => {
    expect(run('[x](../docs/agent/platform-decisions.md#a)', ['docs/agent/platform-decisions.md']).out).toEqual([]);
  });
  it('ignores non-relative targets', () => {
    const text = '[a](https://x.y/z) [b](mailto:a@b.c) [c](/site/path/) [d](#frag) [e](we:x/y.md)';
    const { out, calls } = run(text);
    expect(out).toEqual([]);
    expect(calls).toEqual([]);
  });
  it('ignores code', () => {
    expect(run('```\n[x](gone.md)\n```\nand `[y](gone2.md)`').out).toEqual([]);
  });
  it('treats one .. from backlog as the repo root, two as an escape (exists never called)', () => {
    expect(run('[x](../README.md)').out[0].resolved).toBe('README.md');
    const { out, calls } = run('[x](../../etc/passwd)');
    expect(out).toHaveLength(1);
    expect(calls).toEqual([]);
  });
  it('dedupes the same link', () => {
    expect(run('[a](gone.md) and [b](gone.md)').out).toHaveLength(1);
  });
  it('is wired into scanAnchors via emit2', () => {
    const src = readFileSync('scripts/check-standards.mjs', 'utf8');
    expect(src).toMatch(/import \{[^}]*findDanglingMarkdownLinks[^}]*\}/);
    expect(src).toContain("kind: 'citation-markdown-link'");
  });
});

describe('findBlankLineLoci — gate 6f-ii-e (cited start line is blank)', () => {
  const files = {
    'scripts/a.mjs': 'one\n\nthree\n   \nfive\n',
    'scripts/b.mjs': 'x\ny\n',
  };
  const fileExists = (p) => Object.hasOwn(files, p);
  const run = (text, spy = []) =>
    findBlankLineLoci(text, { fileExists, readLines: (p) => { spy.push(p); return splitSourceLines(files[p]); } });

  it('flags an empty cited line', () => {
    expect(run('see we:scripts/a.mjs:2')).toEqual([{ locus: 'we:scripts/a.mjs:2', path: 'scripts/a.mjs', line: 2 }]);
  });
  it('flags a whitespace-only cited line', () => {
    expect(run('see we:scripts/a.mjs:4')).toEqual([{ locus: 'we:scripts/a.mjs:4', path: 'scripts/a.mjs', line: 4 }]);
  });
  it('passes a cite on a non-blank line', () => {
    expect(run('see we:scripts/a.mjs:3')).toHaveLength(0);
  });
  it('range: blank start flags; blank end alone passes', () => {
    expect(run('we:scripts/a.mjs:2-3')).toHaveLength(1);
    expect(run('we:scripts/a.mjs:3-4')).toHaveLength(0);
  });
  it('skips cross-repo, absolute, `..` and missing files without reading', () => {
    const spy = [];
    const text = 'fui:scripts/a.mjs:2 plateau:scripts/a.mjs:2 we:/etc/x/y:2 we:../a/b.mjs:2 we:scripts/nope.mjs:2';
    expect(run(text, spy)).toHaveLength(0);
    expect(spy).toHaveLength(0);
  });
  it('dedupes a locus cited twice', () => {
    expect(run('we:scripts/a.mjs:2 and again we:scripts/a.mjs:2')).toHaveLength(1);
  });
  it('does not read the trailing terminator as a blank line; far past EOF also yields nothing', () => {
    expect(run('we:scripts/b.mjs:3')).toHaveLength(0);
    expect(run('we:scripts/b.mjs:999')).toHaveLength(0);
  });
});

describe('classifyHashPathCite', () => {
  const real = 'backlog/xhash01-real-slug.md';
  const exists = (path) => path === real;
  const citingFile = 'docs/agent/rule.md';
  it.each([[new Set([citingFile])], [[citingFile]]])('classifies an owned exact existing path as resolving (%s)', (changedFiles) => {
    expect(classifyHashPathCite({ cited: real, exists, citingFile, changedFiles })).toBe('resolving');
  });
  it.each([[new Set(['other.md'])], [['other.md']], [null], [undefined]])('keeps unowned or unknown changes non-resolving (%s)', (changedFiles) => {
    expect(classifyHashPathCite({ cited: real, exists, citingFile, changedFiles })).toBe('unowned');
  });
  it('classifies a different slug with the same hash as dangling', () => {
    expect(classifyHashPathCite({ cited: 'backlog/xhash01-fixture-slug.md', exists, citingFile, changedFiles: [citingFile] })).toBe('dangling');
  });
  it('classifies a missing card as dangling', () => {
    expect(classifyHashPathCite({ cited: real, exists: () => false, citingFile, changedFiles: [citingFile] })).toBe('dangling');
  });
});
