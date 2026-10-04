import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_GH_COMMANDS,
  ALLOWED_READ_ENDPOINTS,
  assertReadOnlyEndpoint,
  assertReadOnlyGh,
  WRITE_FLAG_PATTERNS,
} from '../mine-review-corpus.mjs';

// ── WHY THIS FILE EXISTS (#1569 review, `coverage`) ───────────────────────────────────────────────────────
// The miner's whole safety story is one sentence — "read-only by construction" — and it rested on one
// unexercised function. Nothing stopped a later edit from adding a `/comments` POST or widening the
// allowlist to `repos/:o/:r/*`: the guard would have kept its name and stopped guarding. These tests pin
// BOTH halves of the refusal (write flags, endpoint shape) and the SIZE of the allowlist, because the
// second defect that round was prose claiming a different number of shapes than the code allowlists.

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(HERE, '..', 'mine-review-corpus.mjs'), 'utf8');
/** The same file with comments stripped — so counting CALL SITES counts code, not prose about code. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ALLOWED = [
  'repos/web-everything/web-everything/issues/1569/comments',
  'repos/web-everything/web-everything/pulls/1569',
  'repos/web-everything/web-everything/pulls/1569/files',
];

describe('assertReadOnlyEndpoint — the allowed reads', () => {
  it.each(ALLOWED)('accepts %s', (endpoint) => {
    expect(assertReadOnlyEndpoint(endpoint, ['api', endpoint])).toBe(true);
  });

  it('accepts `--paginate`, which is still a GET', () => {
    expect(assertReadOnlyEndpoint(ALLOWED[0], ['api', ALLOWED[0], '--paginate'])).toBe(true);
  });
});

describe('assertReadOnlyEndpoint — refuses a write flag whatever the endpoint', () => {
  // RETRACTED — this list used to be introduced as *"Every shape `gh` accepts for 'this is not a plain
  // GET'"*, and it was six space-separated or `=`-joined spellings. That sentence was false, and falsely
  // reassuring: `gh` is cobra/pflag-based, so a shorthand flag carries its value CONCATENATED with no
  // separator (`-XPOST`, `-fbody=…`, the same mechanism as `docker -p8080:80`) and shorthands cluster
  // (`-qXPOST`). Against the pre-fix guard, which tested `/^-X$/` and `/^-f$/`, every concatenated form
  // passed with no throw on an allowlisted endpoint — a real, working write the guard was supposed to
  // refuse. `-F`/`--raw-field` and `--input`, two further ways to put a body on the request, were absent
  // from the list in every spelling. All of them are below now, and the guard matches on a leading dash
  // plus a run of letters ending in X/f/F rather than on token equality (#1571 review, f6).
  const WRITE_ARGV = [
    // long forms, both spellings
    ['--method', 'POST'],
    ['--method=POST'],
    ['--field', 'body=nope'],
    ['--field=body=nope'],
    ['--raw-field', 'body=nope'],
    ['--raw-field=body=nope'],
    ['--input', 'body.json'],
    ['--input=body.json'],
    // shorthand, space-separated
    ['-X', 'PATCH'],
    ['-f', 'body=nope'],
    ['-F', 'body=nope'],
    // THE SHAPE THE PRE-FIX GUARD WAVED THROUGH: shorthand concatenated with its value, and clustered.
    ['-XPOST'],
    ['-fbody=nope'],
    ['-Fbody=nope'],
    ['-qXPOST'],
  ];

  it.each(WRITE_ARGV)('throws on %s even on an allowlisted endpoint', (...flags) => {
    expect(() => assertReadOnlyEndpoint(ALLOWED[0], ['api', ALLOWED[0], ...flags]))
      .toThrow(/read-only; argv carries a write flag/);
  });

  it('still accepts the read-only flags the miner actually passes', () => {
    // The other half of a prefix-matching guard: it must not start refusing GETs. `--jq` is `-q`, which
    // contains no X/f/F, and `--paginate` is a long flag that matches no write pattern.
    expect(assertReadOnlyEndpoint(ALLOWED[0], ['api', ALLOWED[0], '--paginate'])).toBe(true);
    expect(assertReadOnlyEndpoint(ALLOWED[0], ['api', ALLOWED[0], '--jq', '.[].body'])).toBe(true);
    expect(assertReadOnlyEndpoint(ALLOWED[0], ['api', ALLOWED[0], '-q', '.[].body'])).toBe(true);
  });

  it('states the write set as DATA, so the header describing it can be checked rather than trusted', () => {
    expect(Object.isFrozen(WRITE_FLAG_PATTERNS)).toBe(true);
    // Each pattern below is named in the file header. If one is dropped, the header's claim that the guard
    // refuses a write flag "in ANY spelling `gh` accepts" goes back to being false.
    expect(WRITE_FLAG_PATTERNS.map(String)).toEqual([
      '/^--method(=|$)/', '/^--field(=|$)/', '/^--raw-field(=|$)/', '/^--input(=|$)/', '/^-[a-zA-Z]*[XfF]/',
    ]);
    for (const spelling of ['--method', '--field', '--raw-field', '--input', '-X', '-f', '-F']) {
      expect(SOURCE).toContain(`\`${spelling}\``);
    }
  });
});

describe('assertReadOnlyEndpoint — refuses anything off the allowlist', () => {
  const REFUSED = [
    // The mutating endpoints this corpus must never touch, even as a bare GET-shaped path.
    'repos/web-everything/web-everything/issues/1569/labels',
    'repos/web-everything/web-everything/pulls/1569/merge',
    'repos/web-everything/web-everything/pulls/1569/reviews',
    // Widening by wildcard or prefix — the shape a later "just let it read anything" edit would take.
    'repos/web-everything/web-everything',
    'repos/web-everything/web-everything/issues/1569',
    // Anchoring: a path that merely CONTAINS an allowed shape must not pass at either end.
    'repos/web-everything/web-everything/pulls/1569/files/extra',
    'x/repos/web-everything/web-everything/pulls/1569',
    'repos/web-everything/web-everything/issues/1569/comments/42',
  ];

  it.each(REFUSED)('throws on %s', (endpoint) => {
    expect(() => assertReadOnlyEndpoint(endpoint, ['api', endpoint]))
      .toThrow(/endpoint is not an allowed read/);
  });
});

describe('the allowlist and the prose that describes it agree', () => {
  it('allowlists exactly THREE read shapes', () => {
    // The claim-accuracy half of the #1569 review: the header said "those two shapes" while the code
    // allowlisted three. Pin the number so prose and code cannot drift apart again silently.
    expect(ALLOWED_READ_ENDPOINTS).toHaveLength(3);
  });

  it('says THREE in the header too, and no longer says two', () => {
    expect(SOURCE).toMatch(/THREE-shape read allowlist/);
    // The retracted sentence must not reappear anywhere outside the retraction that quotes it.
    const live = SOURCE.replace(/^ \* RETRACTED[\s\S]*?(?=^ \*$)/m, '');
    expect(live).not.toMatch(/those two shapes/);
  });

  it('is frozen, so a caller cannot push a fourth shape onto it at runtime', () => {
    expect(Object.isFrozen(ALLOWED_READ_ENDPOINTS)).toBe(true);
  });
});

describe('the miner calls exactly one of the three shapes', () => {
  it('has a single `ghJson` call site, and it is the comments read', () => {
    // The other half of the same false sentence: it claimed two call sites. Counting them here means the
    // header's "calls exactly ONE" cannot rot the next time a caller is added without updating the prose.
    const callSites = CODE.match(/ghJson\(`[^`]+`/g) ?? [];
    expect(callSites).toHaveLength(1);
    expect(callSites[0]).toContain('/issues/${n}/comments');
  });

  it('shells `gh` from exactly ONE place, and that place asserts first', () => {
    // THE BYPASS THIS PINS. `mineRepo` used to call execFileSync('gh', ['pr','list',…]) directly — a second
    // route to GitHub that never met a guard. Counting the call sites is the only check that catches the
    // next one, because a new direct call reads perfectly well in review.
    const ghShells = CODE.match(/execFileSync\(\s*'gh'/g) ?? [];
    expect(ghShells).toHaveLength(1);
    expect(CODE).toMatch(/assertReadOnlyGh\(argv\);\s*return execFileSync\('gh', argv/);
  });
});

describe('assertReadOnlyGh — the second guard, over the `gh` subcommand', () => {
  it('allows exactly TWO subcommands', () => {
    expect(ALLOWED_GH_COMMANDS).toHaveLength(2);
    expect(ALLOWED_GH_COMMANDS.map((c) => c.join(' '))).toEqual(['api', 'pr list']);
  });

  it('accepts the PR listing the miner actually runs', () => {
    expect(assertReadOnlyGh(['pr', 'list', '--repo', 'o/n', '--state', 'all', '--limit', '200', '--json', 'number'])).toBe(true);
  });

  it('accepts `gh api` on an allowed endpoint, and hands the endpoint on to the endpoint guard', () => {
    expect(assertReadOnlyGh(['api', ALLOWED[0], '--paginate'])).toBe(true);
    expect(() => assertReadOnlyGh(['api', 'repos/o/n/issues/1/labels'])).toThrow(/endpoint is not an allowed read/);
    expect(() => assertReadOnlyGh(['api', ALLOWED[0], '--method', 'POST'])).toThrow(/argv carries a write flag/);
  });

  it.each([
    ['pr', 'edit', '1', '--body', 'nope'],
    ['pr', 'close', '1'],
    ['pr', 'comment', '1', '--body', 'nope'],
    ['pr', 'merge', '1'],
    ['issue', 'edit', '1'],
    ['label', 'create', 'x'],
  ])('refuses `gh %s %s`', (...argv) => {
    expect(() => assertReadOnlyGh(argv)).toThrow(/is not one of its allowed reads/);
  });

  it('refuses an empty argv rather than defaulting to permitted', () => {
    expect(() => assertReadOnlyGh([])).toThrow(/is not one of its allowed reads/);
    expect(() => assertReadOnlyGh()).toThrow(/is not one of its allowed reads/);
  });

  it('is not fooled by an allowed word appearing later in the argv', () => {
    // `['pr','edit','--json','api']` contains 'api', but the guard matches on POSITION, not membership.
    expect(() => assertReadOnlyGh(['pr', 'edit', '--json', 'api'])).toThrow(/is not one of its allowed reads/);
  });
});
