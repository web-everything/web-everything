/**
 * @file open-pr-items.test.mjs — proof of the active-PR exclusion source. The `gh` call is the I/O boundary
 *   (injected `run`); the head-ref/title → item-number EXTRACTION and the fail-soft behaviour are decided here
 *   and unit-tested without a real `gh`.
 */
import { describe, it, expect } from 'vitest';
import { itemNumsFromPr, extractItemNums, openPrItemNums, openPrsByItem, deliveredItemNumsFromPr, deliveredHashFromPr, declaredResolvedIdsFromPr, resolvedStatusIdsFromDiff } from '../open-pr-items.mjs';

describe('itemNumsFromPr', () => {
  it('a batch lane ref → the item numbers, with the YYYY-MM-DD date prefix NOT read as items', () => {
    expect(itemNumsFromPr('lane/batch-2026-07-08-2245-2281', '')).toEqual(['2245', '2281']);
  });
  it('a batch ref whose first post-date item looks like a time (2336) still counts as an item', () => {
    expect(itemNumsFromPr('lane/batch-2026-07-08-2336-2245-2326', '')).toEqual(['2336', '2245', '2326']);
  });
  it('a /pr lane ref (leading lane/NNN-slug) → the item number', () => {
    expect(itemNumsFromPr('lane/2315-frontierui-ci-test-check', '')).toEqual(['2315']);
  });
  it('falls back to a #NNN in the title', () => {
    expect(itemNumsFromPr('some-feature-branch', 'Fix the drain (#2330)')).toEqual(['2330']);
  });
  it('a non-lane ref alone contributes nothing (no false positives from a random branch)', () => {
    expect(itemNumsFromPr('release-2026', '')).toEqual([]);
  });
  it('a hash-id (pre-number, born-active) ref matches nothing — it is not in the numbered surface yet', () => {
    expect(itemNumsFromPr('lane/x5gougw-selector-fetch-and-exclude', '')).toEqual([]);
  });
  it('dedupes ref + title naming the same item', () => {
    expect(itemNumsFromPr('lane/foo-2281', 'PR for #2281')).toEqual(['2281']);
  });
});

describe('deliveredItemNumsFromPr (#3441 — the STRICT extractor feeding an auto-committed resolve, not the readiness-ranking exclusion above)', () => {
  it('a plain lane/<NNN>-<slug> ref → the item number, same as the loose extractor', () => {
    expect(deliveredItemNumsFromPr('lane/3412-resolve-fix', '')).toEqual(['3412']);
  });

  it('a batch ref credits ONLY its trailing segment — every other segment just names a batch sibling, not this PR\'s own delivery', () => {
    expect(deliveredItemNumsFromPr('lane/batch-2026-07-08-2245-2281', '')).toEqual(['2281']);
  });

  it('a batch ref with more siblings — still only the last', () => {
    expect(deliveredItemNumsFromPr('lane/batch-2026-07-08-2336-2245-2326', '')).toEqual(['2326']);
  });

  it('a YYYY-MM-DD run in a NON-batch ref is a date, never an id', () => {
    expect(deliveredItemNumsFromPr('lane/calibrate-2026-08-02', '')).toEqual([]);
  });

  it('a bare #NNN in the title is a CITATION, not a delivery marker — NOT matched', () => {
    expect(deliveredItemNumsFromPr('some-feature-branch', 'Fix the drain (see #2330 for background)')).toEqual([]);
  });

  it('an explicit "<id>:" subject-line marker in the title IS matched', () => {
    expect(deliveredItemNumsFromPr('some-feature-branch', 'WE #2330: fix the drain')).toEqual(['2330']);
  });

  it('an explicit "resolve(s|d) #NNN" in the title IS matched', () => {
    expect(deliveredItemNumsFromPr('some-feature-branch', 'Fix the drain — resolves #2330')).toEqual(['2330']);
    expect(deliveredItemNumsFromPr('some-feature-branch', 'resolved #2330')).toEqual(['2330']);
  });

  it('ref match and a bare title citation together — only the ref-matched id, the citation stays uncredited', () => {
    expect(deliveredItemNumsFromPr('lane/3412-resolve-fix', 'WE #3412: resolve fix (root cause also affects #2330)')).toEqual(['3412']);
  });

  it('a non-lane ref alone contributes nothing', () => {
    expect(deliveredItemNumsFromPr('release-2026', '')).toEqual([]);
  });

  it('a hash-id (pre-number) ref matches nothing', () => {
    expect(deliveredItemNumsFromPr('lane/x5gougw-selector-fetch-and-exclude', '')).toEqual([]);
  });

  it('a scope-authoring PR (the #2613 dispatcher pass) is an ANNOTATION, not a delivery — never credited', () => {
    // #3441 round 2 — a scope-authoring PR is a real, merged, non-manifest WE PR naming the item in both
    // ref and title (prepare-scope-agent-brief.md's own convention), but it never builds the item.
    expect(deliveredItemNumsFromPr('lane/1234-scope', 'WE #1234: author scope: for #1234')).toEqual([]);
  });

  it('a prepare-decision PR is also an ANNOTATION — never credited', () => {
    expect(deliveredItemNumsFromPr('lane/1234-prepare-decision', 'WE #1234: prepare decision forks for #1234')).toEqual([]);
  });

  it('a retry ref (lane/<NNN><letter>-<slug>, #3110) still names its item', () => {
    expect(deliveredItemNumsFromPr('lane/3441b-fix-something', '')).toEqual(['3441']);
    expect(deliveredItemNumsFromPr('lane/3441c-fix-something', 'WE #3441: resolve-on-land fix')).toEqual(['3441']);
  });

  it('#3441 round 3 — the retry-letter tolerance is ANCHORED to the leading segment, not any segment: an ordinary tech-slug fragment (a decade, a scale multiplier, a size unit) is never misread as a second id', () => {
    expect(deliveredItemNumsFromPr('lane/2412-retro-80s-revival', '')).toEqual(['2412']);
    expect(deliveredItemNumsFromPr('lane/2412-css-1980s-retro-theme', '')).toEqual(['2412']);
    expect(deliveredItemNumsFromPr('lane/2412-add-90s-easter-egg', '')).toEqual(['2412']);
    expect(deliveredItemNumsFromPr('lane/2412-add-50k-users-milestone', '')).toEqual(['2412']);
    expect(deliveredItemNumsFromPr('lane/2412-support-100x-scale', '')).toEqual(['2412']);
  });

  it('#3441 round 3 — "batch" as an ordinary slug word (not the batch-chain convention) does not suppress the real leading id', () => {
    expect(deliveredItemNumsFromPr('lane/2415-batch-job-scheduler', '')).toEqual(['2415']);
    expect(deliveredItemNumsFromPr('lane/2415-nightly-batch', '')).toEqual(['2415']);
  });

  it('#3441 round 4 — a real verb-led, id-LAST ref convention this repo\'s own maintenance tooling mints (no leading id, no "batch") still names its item', () => {
    expect(deliveredItemNumsFromPr('lane/build-3067', '')).toEqual(['3067']);
    expect(deliveredItemNumsFromPr('lane/resolve-2712', '')).toEqual(['2712']);
    expect(deliveredItemNumsFromPr('lane/heal-stranded-2319', '')).toEqual(['2319']);
    expect(deliveredItemNumsFromPr('lane/fix-stranded-backlog-id-3392', '')).toEqual(['3392']);
  });

  it('#3441 round 4 — the trailing-fallback still excludes a date run (the regression round 4 caught: a plain date-suffixed ref must not credit its day-of-month as an id)', () => {
    expect(deliveredItemNumsFromPr('lane/calibrate-2026-08-02', '')).toEqual([]);
  });

  it('#3441 round 4 — "resolve: #NNN — subject" (colon right after "resolve", a real repeated commit-title shape) is matched, same as the colon-less form', () => {
    expect(deliveredItemNumsFromPr('some-feature-branch', 'resolve: #2712 — console board cross-lane span bars')).toEqual(['2712']);
    expect(deliveredItemNumsFromPr('some-feature-branch', 'resolved: #2554 — ratify all 8')).toEqual(['2554']);
  });

  it('#3441 round 4 — "unresolved #NNN" is NOT "resolve #NNN" (word-boundary check, not a substring match)', () => {
    expect(deliveredItemNumsFromPr('some-feature-branch', 'unresolved issue #2330 mentioned')).toEqual([]);
  });

  it('#3441 round 5 — a real verb-led ref with the id NOT last (id right after the verb, more words after it) is NOT guessed at via the trailing segment — a coincidental trailing number must never be credited', () => {
    // scripts/pr-land.mjs cites a real merged PR at exactly this ref shape: lane/fix-2165-ci-fui-checkout.
    expect(deliveredItemNumsFromPr('lane/fix-2165-ci-fui-checkout', '')).toEqual([]);
    expect(deliveredItemNumsFromPr('lane/fix-2165-legacy-24', '')).toEqual([]);
    expect(deliveredItemNumsFromPr('lane/deploy-3067-24', '')).toEqual([]);
  });

  it('#3441 round 5 — the id-last verb allowlist is closed: an unlisted verb phrase never triggers the trailing fallback, even with a trailing digit run', () => {
    expect(deliveredItemNumsFromPr('lane/deploy-3067', '')).toEqual([]);
  });

  it('#3441 round 5 — a date-only batch ref (no items named) must not credit its day-of-month either (the batch branch was missing round 4\'s date-span guard)', () => {
    expect(deliveredItemNumsFromPr('lane/batch-2026-08-02', '')).toEqual([]);
    expect(deliveredItemNumsFromPr('lane/batch-2026-08-02-02', '')).toEqual([]);
  });

  it('#3441 round 5 — a normal batch chain right after a date is unaffected by the date-span guard', () => {
    expect(deliveredItemNumsFromPr('lane/batch-2026-08-02-3067-3068', '')).toEqual(['3068']);
  });

  it('#3441 round 6 — a <id>-<verb>-<id> ref is AMBIGUOUS (real example: lane/3383-resolve-3412, this very item\'s own parent epic\'s git history) — emit neither id rather than guess the lead', () => {
    expect(deliveredItemNumsFromPr('lane/3383-resolve-3412', 'backlog/3412: resolve -- built and merged via PR #1765, the dispatched build agent never closed it out')).toEqual([]);
  });

  it('#3441 round 6 — a lead id with an UNLISTED mid-segment verb is not treated as ambiguous — the lead still counts', () => {
    expect(deliveredItemNumsFromPr('lane/3383-notaverb-3412', '')).toEqual(['3383']);
  });

  it('#3441 round 7 — the collision guard detects the SHAPE, not an exact segment count: an extra word anywhere around the embedded verb/id still triggers the ambiguity back-off', () => {
    expect(deliveredItemNumsFromPr('lane/3383-resolve-3412-cleanup', '')).toEqual([]);
    expect(deliveredItemNumsFromPr('lane/3383-resolve-cleanup-3412', '')).toEqual([]);
    expect(deliveredItemNumsFromPr('lane/3383-please-resolve-3412', '')).toEqual([]);
    expect(deliveredItemNumsFromPr('lane/3383-resolve-3412a', '')).toEqual([]);
  });

  it('#3441 round 7 — a date-adjacent lead (no full YYYY-MM-DD span, so not date-excluded) colliding with an embedded verb+id is still caught', () => {
    expect(deliveredItemNumsFromPr('lane/2026-08-resolve-3412', '')).toEqual([]);
  });

  it('PR #1851 review round 1 (human) — a mid-title "NNN:" that is NOT the leading subject marker is a citation, not a second delivery — the marker regex is anchored to the subject position', () => {
    expect(deliveredItemNumsFromPr('lane/3441-fix-parser', 'WE #3441: cap batch size at 500: avoid OOM')).toEqual(['3441']);
    expect(deliveredItemNumsFromPr('lane/3441-fix-parser', 'WE #3441: fix parser (design mirrors 2787: the config loader shape)')).toEqual(['3441']);
  });

  it('PR #1851 review round 1 (human) — an ordinary mundane "NNN:" title with no lane-id lead is never mistaken for a subject marker (HTTP codes, ports, rate limits)', () => {
    expect(deliveredItemNumsFromPr('some-feature-branch', 'Handle HTTP 404: return friendly error page')).toEqual([]);
    expect(deliveredItemNumsFromPr('some-feature-branch', 'Add rate limiting (max 100: requests per min)')).toEqual([]);
  });

  it('PR #1851 review round 1 (human) — a real multi-id verb-led ref (lane/reconcile-<id>-<id>-<id>, the actually-merged lane/reconcile-3147-3096-3239, PR #1599) credits ONLY the trailing/final item, the same as a batch chain', () => {
    expect(deliveredItemNumsFromPr('lane/reconcile-3147-3096-3239', '')).toEqual(['3239']);
    expect(deliveredItemNumsFromPr('lane/reconcile-2716', '')).toEqual(['2716']);
  });

  it('#3473 — a multi-PR/graduation-tracked item\'s title-anchor vector (PR #1866\'s exact ref/title) is NOT credited when the PR body discloses it does not resolve the item', () => {
    expect(deliveredItemNumsFromPr(
      'lane/3443-computefreeslots-excludes-dirty-lanes',
      'WE #3443: readiness/computeFreeSlots excludes dirty (orphaned) unleased lanes',
      { body: 'Graduates origin/lane/mechanical-dispatcher onto main, as one small piece of the ongoing graduation tracked by #3443 — this PR does not resolve #3443, it lands one increment of it.' },
    )).toEqual([]);
  });

  it('#3473 — the ref-lead-segment vector (the reopen PR\'s exact ref/title) is NOT credited when the PR\'s changed files are all markdown (pure backlog housekeeping)', () => {
    expect(deliveredItemNumsFromPr(
      'lane/3443-reopen-and-3441-gap-followup',
      'backlog/3443: reopen (false auto-resolve) + file the extractor gap it exposed',
      { changedFiles: ['backlog/3443-graduate-origin-lane-mechanical-dispatcher-to-main-in-small.md', 'backlog/3473-resolve-on-land-extractor-mis-credited-3443-a-multi-pr-gradu.md'] },
    )).toEqual([]);
  });

  it('#3473 guard 7 regression proof — a real single-PR delivery whose changed-file list is NOT all-.md (a genuine code PR that happens to also touch one doc file) is still credited normally', () => {
    expect(deliveredItemNumsFromPr(
      'lane/3412-resolve-fix',
      'WE #3412: resolve fix',
      { changedFiles: ['scripts/lib/open-pr-items.mjs', 'backlog/3412-resolve-fix.md'] },
    )).toEqual(['3412']);
  });

  it('#3473 guard 6 is SCOPED to the specific disclaimed id — an unrelated #NNN mention plus a "does not resolve #MMM" disclaimer for a DIFFERENT id still credits NNN', () => {
    expect(deliveredItemNumsFromPr(
      'lane/3412-resolve-fix',
      'WE #3412: resolve fix (root cause also affects #2330)',
      { body: 'this PR does not resolve #2330, that is tracked separately' },
    )).toEqual(['3412']);
  });

  it('#3473 — PR #1599\'s exact ref/title/files reproduced directly against deliveredItemNumsFromPr: WITHOUT guard 7 this ref/title combination would wrongly credit BOTH #3096 (title-anchor) and #3239 (ref trailing-segment) — worse than the single false credit dispatch-lane-io\'s sibling checker hit live; guard 7\'s all-.md short-circuit (the real merge diff is 4 files, all .md/one comment-marker repoint — actually all .md per PR #1599\'s own body: "No code behaviour changes") suppresses both', () => {
    expect(deliveredItemNumsFromPr(
      'lane/reconcile-3147-3096-3239',
      '#3096: reconcile the three-way dispatch duplicate — #3096 survives, #3147 + #3239 collapse',
      {},
    )).toEqual(['3239', '3096']); // confirms the UNGUARDED read: both ids wrongly credited from ref+title alone (ref-derived id first, then title-derived)
    expect(deliveredItemNumsFromPr(
      'lane/reconcile-3147-3096-3239',
      '#3096: reconcile the three-way dispatch duplicate — #3096 survives, #3147 + #3239 collapse',
      { changedFiles: ['backlog/3096-route-the-conveyor-s-build-dispatch-through-the-declared-dis.md', 'backlog/3147-x.md', 'backlog/3239-x.md', 'skills-src/conveyor/SKILL.md'] },
    )).toEqual([]); // guard 7 (all-.md diff) suppresses both once the real changed-file shape is supplied
  });

  it('#3473 guard 8 — PR #1599\'s REAL (stale) gh changedFiles list (17 files, 3 real .mjs) defeats guard 7, but the blanket "no code changes" body disclaimer (guard 8) still excludes it', () => {
    // Live-verified 2026-09-04: `gh pr view 1599 --json files` returns 17 files including
    // scripts/lib/jury-core.mjs, scripts/lib/jury-ledger.mjs, scripts/workflows/review-parked-prs.mjs — NOT
    // all-.md — even though the PR's true merge-commit diff (`git show 90fe066f6 --stat`) is 4 files, all
    // markdown. Guard 7 alone cannot exclude this PR from that real (stale) gh data; guard 8 (the PR's own
    // "No code behaviour changes" opening line) does.
    expect(deliveredItemNumsFromPr(
      'lane/reconcile-3147-3096-3239',
      '#3096: reconcile the three-way dispatch duplicate — #3096 survives, #3147 + #3239 collapse',
      {
        body: 'No code behaviour changes — this is a backlog reconciliation plus one in-code comment repoint.',
        changedFiles: [
          'backlog/3096-route-the-conveyor-s-build-dispatch-through-the-declared-dis.md',
          'backlog/3147-wire-the-conveyor-s-build-prepare-dispatch-onto-the-dispatch.md',
          'backlog/3239-the-conveyor-tick-executes-spawnbuilds-by-hand-instead-of-th.md',
          'backlog/3314-should-claim-accuracy-be-a-mandatory-lens.md',
          'docs/agent/platform-decisions.md',
          'scripts/lib/jury-core.mjs',
          'scripts/lib/jury-ledger.mjs',
          'scripts/workflows/review-parked-prs.mjs',
          'skills-src/conveyor/SKILL.md',
        ],
      },
    )).toEqual([]);
  });

  it('#3473 guard 8 — PR #1613\'s real body ("No code changes — two backlog files.") also matches the blanket disclaimer', () => {
    expect(deliveredItemNumsFromPr(
      'lane/split-3096',
      'WE #3096: split along its two scope entries — skill rewiring vs liveness hardening',
      { body: 'Splits #3096 along its two scope: entries. No code changes — two backlog files.' },
    )).toEqual([]);
  });

  it('#3473 guard 8 does not over-fire on a real delivery body that happens to mention "no code" in an unrelated sense', () => {
    expect(deliveredItemNumsFromPr(
      'lane/3412-resolve-fix',
      'WE #3412: resolve fix',
      { body: 'This fix requires no code review sign-off beyond CI, and lands the feature end to end.' },
    )).toEqual(['3412']);
  });

  it('#3916 (live case) — guard 8 must not fire on a QUOTED citation of another item\'s "no code change" precedent; PR #2594 was a real, large multi-.mjs-file port whose body cited #3894/#3482\'s own already-landed characterization of a DIFFERENT, narrower deviation, and the unguarded quote match wiped its credited id entirely — the exact silent skip resolve-on-land\'s totality report (#2899 J2/J3) cannot see, because it never reaches `landedThisPass` in the first place', () => {
    const body = 'matching the `#3894`/`#3482` "already landed, no code change" precedent in #3443\'s own Progress log. Likewise the branch\'s test coverage is already superseded.';
    expect(deliveredItemNumsFromPr(
      'lane/3916-graduate-test-setup-heavy-command-admission-and-file-locks-c',
      'Graduate test setup, heavy-command admission and file-locks from lane/mechanical-dispatcher (#3916)',
      { body },
    )).toEqual(['3916']);
  });

  it('#3916 — guard 8 still fires when the SAME phrase describes THIS PR unquoted, even alongside an unrelated quoted mention', () => {
    expect(deliveredItemNumsFromPr(
      'lane/split-3096',
      'WE #3096: split along its two scope entries — skill rewiring vs liveness hardening',
      { body: 'Splits #3096 along its two scope: entries. No code changes — two backlog files. (cf. "some other quoted note")' },
    )).toEqual([]);
  });

  // #3916 review round 1 — the quote-strip must remove only an ATTRIBUTED citation (a citation cue word AND a
  // `#NNN` reference to the cited item, outside the quote, on the same line), never any double-quoted text: a
  // PR stating its OWN disclaimer inside quotation marks must still trip guard 8. Four-quadrant matrix.
  describe('#3916 review round 1 — guard 8 quote-handling matrix', () => {
    const ref = 'lane/4200-some-real-change';
    const title = 'Ship the real thing (#4200)';
    it.each([
      ['quoted citation of another item (the live #2594 shape)', 'Follows the "already landed, no code change" precedent in #3443\'s own Progress log.', ['4200']],
      ['unquoted own disclaimer', 'No code changes — this PR only touches docs.', []],
      ['fully self-quoted own disclaimer', '"No code changes — this PR only touches docs."', []],
      ['self-quoted own disclaimer mid-body', 'Summary: refactor. "No code changes here" - just cleanup.', []],
      ['curly-quoted own disclaimer', '“No code changes here.”', []],
      ['self-quoted disclaimer next to an item ref but no citation cue', '"No code changes" — see #4200 for details.', []],
      ['self-quoted disclaimer next to a citation cue but no item ref', '"No code changes", as cited above.', []],
      ['self-quoted disclaimer next to a citation cue and only THIS PR\'s own ref', 'Closes #4200. "No code changes" as cited in the card.', []],
      ['mixed: quoted citation AND an unquoted own disclaimer', 'Per the "no code change" precedent cited in #3443: No code changes — two backlog files.', []],
    ])('%s', (_label, body, expected) => {
      expect(deliveredItemNumsFromPr(ref, title, { body })).toEqual(expected);
    });
  });

  // Incident 2026-09-26 03:14Z — PR #2785, branch `lane/2779-session-token-fresh` (a worker named their own
  // branch after PR #2779, an unrelated open bg-isolation fix, never a backlog card). RED before the
  // `openPrNums` guard: the lead-segment rule (round 3 above) matched `segs[0] === '2779'` with no manifest, no
  // title corroboration, no diff evidence — exactly this shape — and the caller auto-committed `drain: resolve
  // #2779 on land`, wrongly resolving unrelated card #2779 AND (closing-keyword side effect) closing the real
  // PR #2779. GREEN after the guard: passing the real open-PR set (#2779 was open at land time) refuses the
  // credit entirely, the safe direction.
  describe('#2779-incident — a branch-name digit run that collides with a real open PR number', () => {
    it('RED (pre-fix) shape reproduced: with no openPrNums the bare lead segment is still credited', () => {
      expect(deliveredItemNumsFromPr('lane/2779-session-token-fresh', '')).toEqual(['2779']);
    });
    it('GREEN: passing the real open-PR set (2779 was an open PR at land time) refuses the credit', () => {
      expect(deliveredItemNumsFromPr('lane/2779-session-token-fresh', '', { openPrNums: ['2779'] })).toEqual([]);
    });
    it('a non-colliding lead segment (2779 is NOT an open PR) is still credited normally', () => {
      expect(deliveredItemNumsFromPr('lane/2779-session-token-fresh', '', { openPrNums: ['3001', '3002'] })).toEqual(['2779']);
    });
    it('the exclusion is leading-zero/type tolerant (a number or a zero-padded string both match)', () => {
      expect(deliveredItemNumsFromPr('lane/2779-session-token-fresh', '', { openPrNums: [2779] })).toEqual([]);
      expect(deliveredItemNumsFromPr('lane/2779-session-token-fresh', '', { openPrNums: ['02779'] })).toEqual([]);
    });
    it('the same collision on a trailing (batch) segment is refused too', () => {
      expect(deliveredItemNumsFromPr('lane/batch-2026-07-08-2245-2779', '', { openPrNums: ['2779'] })).toEqual([]);
    });
    it('an explicit title marker for a DIFFERENT id is unaffected by an unrelated open-PR collision on the ref id', () => {
      expect(deliveredItemNumsFromPr('lane/2779-session-token-fresh', 'WE #3441: unrelated subject', { openPrNums: ['2779'] })).toEqual(['3441']);
    });
  });
});

describe('extractItemNums', () => {
  it('dedupes across many PRs', () => {
    const prs = [
      { headRefName: 'lane/a-2281', title: '' },
      { headRefName: 'lane/b-2315', title: 'thing #2281' },
      { headRefName: 'main', title: '' },
    ];
    expect(new Set(extractItemNums(prs))).toEqual(new Set(['2281', '2315']));
  });
  it('empty / nullish input → []', () => {
    expect(extractItemNums(null)).toEqual([]);
    expect(extractItemNums([])).toEqual([]);
  });
});

describe('openPrItemNums (fail-soft IO)', () => {
  it('gh missing / non-zero → unavailable, never throws, nums empty', () => {
    const run = () => ({ status: 1, stdout: '', stderr: 'command not found: gh\n' });
    const r = openPrItemNums({ run });
    expect(r.nums).toEqual([]);
    expect(r.unavailable).toBe(true);
  });
  it('unparseable gh output → unavailable', () => {
    const run = () => ({ status: 0, stdout: 'not json' });
    expect(openPrItemNums({ run }).unavailable).toBe(true);
  });
  it('valid gh output → extracted item numbers', () => {
    const run = () => ({ status: 0, stdout: JSON.stringify([
      { headRefName: 'lane/batch-2245-2281', title: '' },
      { headRefName: 'feature', title: 'Land #2330' },
    ]) });
    expect(new Set(openPrItemNums({ run }).nums)).toEqual(new Set(['2245', '2281', '2330']));
  });
});

describe('openPrItemNums (multi-repo)', () => {
  it('reads every constellation repo with an explicit --repo and unions the item numbers', () => {
    const calls = [];
    const byRepo = {
      'web-everything/web-everything': [{ headRefName: 'lane/2100-spec', title: '' }],
      'frontier-ui/frontierui': [],
      'plateauapp/plateau-app': [{ headRefName: 'lane/2072-impl', title: '' }],
    };
    const run = (args) => { calls.push(args); return { status: 0, stdout: JSON.stringify(byRepo[args[args.indexOf('--repo') + 1]]) }; };
    const r = openPrItemNums({ run });
    expect(calls.map((a) => a[a.indexOf('--repo') + 1])).toEqual(['web-everything/web-everything', 'frontier-ui/frontierui', 'plateauapp/plateau-app']);
    expect(new Set(r.nums)).toEqual(new Set(['2100', '2072']));
    expect(r.partial).toBeUndefined();
  });
  it('a failing SIBLING repo keeps the other numbers and is reported under partial', () => {
    const run = (args) => (args.includes('plateauapp/plateau-app')
      ? { status: 1, stdout: '', stderr: 'HTTP 404\n' }
      : { status: 0, stdout: JSON.stringify([{ headRefName: 'lane/2100-x', title: '' }]) });
    const r = openPrItemNums({ run });
    expect(r.nums).toEqual(['2100']);
    expect(r.partial).toEqual([{ repo: 'plateauapp/plateau-app', reason: 'HTTP 404' }]);
    expect(r.unavailable).toBeUndefined();
  });
  it('the WE read failing is unavailable, as before', () => {
    const run = (args) => (args.includes('web-everything/web-everything') ? { status: 1, stdout: '', stderr: 'boom' } : { status: 0, stdout: '[]' });
    expect(openPrItemNums({ run })).toEqual({ nums: [], unavailable: true, reason: 'boom' });
  });
});

describe('openPrsByItem (the PR identity the Decision Docket lists under each item)', () => {
  const prs = [
    { number: 2376, headRefName: 'lane/ratify-3375', title: 'ratify #3375: proof', url: 'https://github.com/o/we/pull/2376' },
    { number: 12, headRefName: 'lane/3375-impl', title: 'impl', url: 'https://github.com/o/fui/pull/12' },
  ];

  it('keeps every PR under each item it lands, with its repo, number, title and url — from ONE gh call per repo', () => {
    const calls = [];
    const run = (args) => { calls.push(args); const repo = args[args.indexOf('--repo') + 1]; return { status: 0, stdout: JSON.stringify(repo === 'o/we' ? [prs[0]] : [prs[1]]) }; };
    const r = openPrsByItem({ run, repos: ['o/we', 'o/fui'] });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('headRefName,title,number,url');
    expect(r.nums).toEqual(['3375']);
    expect(r.byItem['3375']).toEqual([
      { repo: 'o/we', number: 2376, title: 'ratify #3375: proof', url: 'https://github.com/o/we/pull/2376', headRefName: 'lane/ratify-3375' },
      { repo: 'o/fui', number: 12, title: 'impl', url: 'https://github.com/o/fui/pull/12', headRefName: 'lane/3375-impl' },
    ]);
  });

  it('fails soft like openPrItemNums: a failing primary repo is unavailable, and openPrItemNums drops byItem', () => {
    expect(openPrsByItem({ run: () => ({ status: 1, stdout: '', stderr: 'no gh\n' }), repos: ['o/we'] })).toEqual({ nums: [], byItem: {}, unavailable: true, reason: 'no gh' });
    const r = openPrItemNums({ run: () => ({ status: 0, stdout: JSON.stringify([prs[0]]) }), repos: ['o/we'] });
    expect(r).toEqual({ nums: ['3375'] });
  });
});

describe('deliveredHashFromPr (#3914 — a card filed AND delivered in the same hash-led lane PR)', () => {
  describe('title-lead hash fallback (#4477)', () => {
    it('credits the title-lead hash with a descriptive lane ref (PR #2924)', () => {
      expect(deliveredHashFromPr('lane/builder-cap-own-builds', 'WE #x3vs6tu: builder cap counts only its own builds')).toBe('x3vs6tu');
    });

    it('keeps the ref-lead hash when the title names a different hash', () => {
      expect(deliveredHashFromPr('lane/xaaaaaa-slug', 'WE #xbbbbbb: subject')).toBe('xaaaaaa');
    });

    it('resolves the title-lead hash through landedNumberFor (PR #2924)', () => {
      const landedNumberFor = (h) => (h === 'x3vs6tu' ? '4464' : null);
      expect(deliveredHashFromPr('lane/builder-cap-own-builds', 'WE #x3vs6tu: builder cap counts only its own builds',
        { landedNumberFor })).toBe('4464');
    });

    it('never credits a hash merely cited later in the title', () => {
      expect(deliveredHashFromPr('lane/builder-cap-own-builds', 'WE #4200: fix, related to x3vs6tu')).toBeNull();
    });

    // #4477 round-1 correctness finding — the prior negative test above never actually exercised the `^`
    // anchor (its hash has no leading `#`, so it would return null with or without the anchor). This one
    // puts a hash-shaped `#<hash>:` token in a NON-lead position, which the anchor must reject.
    it('never credits a hash-shaped "#<hash>:" token that is not in the lead position', () => {
      expect(deliveredHashFromPr('lane/builder-cap-own-builds', 'fix: see #x3vs6tu: more context')).toBeNull();
    });

    // #4477 round-1 red-team finding — the whole-PR guards (`isNonDeliveryPr`) must still apply on the
    // title-lead path exactly as they already do on the ref-lead path; nothing exempted this new branch.
    it('still refuses a non-delivery PR (all-.md diff) even with a title-lead hash', () => {
      expect(deliveredHashFromPr('lane/builder-cap-own-builds', 'WE #x3vs6tu: builder cap counts only its own builds',
        { changedFiles: ['backlog/4464-builder-cap.md'] })).toBeNull();
    });
  });

  it('credits the lane-ref LEAD hash (the real #3459/#3492/#3638 refs)', () => {
    expect(deliveredHashFromPr('lane/xaa7r2n-itemnumfromref-attempt-tag', '')).toBe('xaa7r2n');
    expect(deliveredHashFromPr('lane/x3jmao3-review-dispatch-wait-ms', 'WE #x3jmao3: bounded retry')).toBe('x3jmao3');
  });

  it('a hash NOT in the lead position (a spin-off named later in the slug) is never credited', () => {
    expect(deliveredHashFromPr('lane/3412-fix-and-file-xspin01', '')).toBeNull();
    expect(deliveredHashFromPr('lane/fix-xspin01', '')).toBeNull();
  });

  it('non-lane refs and numeric leads return null (the numeric path is deliveredItemNumsFromPr)', () => {
    expect(deliveredHashFromPr('xaa7r2n-feature', '')).toBeNull();
    expect(deliveredHashFromPr('lane/3412-resolve-fix', '')).toBeNull();
  });

  it('requires the PR to have FILED the card when the changed-file list is known', () => {
    expect(deliveredHashFromPr('lane/xaa7r2n-x', '', { changedFiles: ['backlog/xaa7r2n-card.md', 'scripts/a.mjs'] })).toBe('xaa7r2n');
    expect(deliveredHashFromPr('lane/xaa7r2n-x', '', { changedFiles: ['backlog/xother1-card.md', 'scripts/a.mjs'] })).toBeNull();
  });

  it('shares the whole-PR guards: annotation, all-.md housekeeping, "no code changes"', () => {
    expect(deliveredHashFromPr('lane/xaa7r2n-scope', 'WE #xaa7r2n: author scope: for #xaa7r2n')).toBeNull();
    expect(deliveredHashFromPr('lane/xaa7r2n-x', '', { changedFiles: ['backlog/xaa7r2n-card.md'] })).toBeNull();
    expect(deliveredHashFromPr('lane/xaa7r2n-x', '', { body: 'No code changes — backlog only.' })).toBeNull();
  });

  // #xqpqyr2 — RED before this fix: a card cut from a bornAs hash that is ALREADY numbered on main by merge
  // time (a JIT-numbering pass renamed backlog/<hash>-*.md → backlog/<NNN>-*.md before this PR's own diff was
  // computed) used to return null forever — the merged PR's diff never touches the renamed file, so the
  // scaffold-refile check above always failed. Real, live shape: PR #2691 (ref-led `xp4lw2v`, card #4175) —
  // its own changed-file list names NO backlog file at all (the card was scaffolded/numbered earlier).
  describe('landedNumberFor short-circuit (#xqpqyr2 — a hash already numbered on main by merge time)', () => {
    it('resolves via landedNumberFor even when changedFiles has NO matching hash-named scaffold at all (PR #2691\'s real shape)', () => {
      const landedNumberFor = (h) => (h === 'xp4lw2v' ? '4175' : null);
      expect(deliveredHashFromPr('lane/xp4lw2v-stronger-live-smoke', 'xp4lw2v: live smoke dry-runs every dispatch kind (#4075)',
        { changedFiles: ['scripts/lib/daemon-live-smoke.mjs'], landedNumberFor })).toBe('4175');
    });

    it('resolves via landedNumberFor even when the PR\'s diff touches the file under its NEW (numbered) name (PR #2668\'s real shape)', () => {
      const landedNumberFor = (h) => (h === 'xn6n5gp' ? '4127' : null);
      expect(deliveredHashFromPr('lane/xn6n5gp-numbering-linear-lock-safety', 'drain numbering: linear applyLedger (xn6n5gp)',
        { changedFiles: ['backlog/4127-drain-numbering-make-applyledger-linear-one-hash-regex-not-o.md', 'scripts/backlog/id.mjs'], landedNumberFor })).toBe('4127');
    });

    it('falls back to the pre-existing scaffold-refile check when landedNumberFor is inert (not yet numbered on main)', () => {
      const neverLanded = () => null;
      expect(deliveredHashFromPr('lane/xaa7r2n-x', '', { changedFiles: ['backlog/xaa7r2n-card.md', 'scripts/a.mjs'], landedNumberFor: neverLanded })).toBe('xaa7r2n');
      expect(deliveredHashFromPr('lane/xaa7r2n-x', '', { changedFiles: ['backlog/xother1-card.md', 'scripts/a.mjs'], landedNumberFor: neverLanded })).toBeNull();
    });

    it('omitting landedNumberFor entirely is IDENTICAL to before this fix (default is inert)', () => {
      expect(deliveredHashFromPr('lane/xaa7r2n-x', '', { changedFiles: ['backlog/xother1-card.md'] })).toBeNull();
    });

    it('still respects the whole-PR guards even when landedNumberFor WOULD resolve — never overrides "stay conservative"', () => {
      const landedNumberFor = () => '4127';
      expect(deliveredHashFromPr('lane/xn6n5gp-scope', 'WE #xn6n5gp: author scope: for #xn6n5gp', { landedNumberFor })).toBeNull();
      expect(deliveredHashFromPr('lane/xn6n5gp-x', '', { body: 'No code changes — backlog only.', landedNumberFor })).toBeNull();
    });
  });
});

/**
 * A one-file unified diff moving a backlog card's frontmatter `status:` — the delivery evidence signals 1/2
 * now require (PR #2724 review round 2). `from: null` files the card new in this PR (the real #2689 shape);
 * otherwise the card already existed and the PR claimed it (`open → active`, the real #2668 shape).
 */
function statusDiff(path, from, to) {
  const isNew = from == null;
  return [
    `diff --git a/${path} b/${path}`,
    ...(isNew ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${path}`]),
    `+++ b/${path}`,
    isNew ? '@@ -0,0 +1,4 @@' : '@@ -1,4 +1,4 @@',
    `${isNew ? '+' : ' '}---`,
    `${isNew ? '+' : ' '}kind: story`,
    ...(isNew ? [] : [`-status: ${from}`]),
    `+status: ${to}`,
    `${isNew ? '+' : ' '}---`,
  ].join('\n');
}
const diffOf = (...parts) => parts.join('\n');

describe('declaredResolvedIdsFromPr (#xqpqyr2 — ride-along cards a PR declares/resolves besides its own single ref-led id)', () => {
  describe('signal 1 — explicit "resolves #N" / "Resolves: …" LINE markers', () => {
    // Signal 1 is corroborated: the PR's own diff must move the named card's frontmatter status to
    // active/resolved (it claimed or delivered it) — a touched file alone is not delivery evidence.
    const touching4121 = ['scripts/a.mjs', 'backlog/4121-ride-along.md'];
    const claims4121 = statusDiff('backlog/4121-ride-along.md', 'open', 'active');

    it('credits a line-anchored "Resolves #N" / "resolves: #N, #M" marker whose card the PR claimed', () => {
      expect(declaredResolvedIdsFromPr('lane/4200-fix', 'a fix', { body: 'Some context.\nResolves #4121\nMore text.', changedFiles: touching4121, diff: claims4121 })).toEqual(['4121']);
      expect(declaredResolvedIdsFromPr('lane/4200-fix', 'a fix', { body: 'resolves: #4121, #4134', changedFiles: [...touching4121, 'backlog/4134-other.md'], diff: diffOf(claims4121, statusDiff('backlog/4134-other.md', 'open', 'active')) })).toEqual(expect.arrayContaining(['4121', '4134']));
    });

    // PR #2724 review round 2 (antigravity) — trailing sentence punctuation is still a line marker.
    it('tolerates trailing punctuation on the marker line ("Resolves #4121.")', () => {
      expect(declaredResolvedIdsFromPr('lane/4200-fix', 'a fix', { body: 'Resolves #4121.', changedFiles: touching4121, diff: claims4121 })).toEqual(['4121']);
    });

    // PR #2724 review round 2 (correctness + security) — touching the card's file is not delivering it: a
    // typo/scope edit leaves the status alone, a card filed `open` is deferred work, and a re-open is the
    // opposite of delivery.
    it('is NOT credited when the PR touched the card file without moving its status to active/resolved', () => {
      const typoOnly = [
        'diff --git a/backlog/4121-ride-along.md b/backlog/4121-ride-along.md',
        '--- a/backlog/4121-ride-along.md',
        '+++ b/backlog/4121-ride-along.md',
        '@@ -12,3 +12,3 @@',
        ' ## Why',
        '-Teh drain misses it.',
        '+The drain misses it.',
      ].join('\n');
      for (const diff of [typoOnly, statusDiff('backlog/4121-ride-along.md', null, 'open'), statusDiff('backlog/4121-ride-along.md', 'resolved', 'active')]) {
        expect(declaredResolvedIdsFromPr('lane/4200-fix', 'a fix', { body: 'Resolves #4121', changedFiles: touching4121, diff })).toEqual([]);
      }
      expect(declaredResolvedIdsFromPr('lane/4200-fix', 'a fix', { body: 'Resolves #4121', changedFiles: touching4121 })).toEqual([]); // no diff → fail closed
    });

    it('a bare mention mid-sentence is NOT credited — the exact "looks delivered" false positive this must avoid', () => {
      expect(declaredResolvedIdsFromPr('lane/4200-fix', 'a fix', { body: 'This eventually resolves #4121 once the sibling lands.', changedFiles: touching4121, diff: claims4121 })).toEqual([]);
      expect(declaredResolvedIdsFromPr('lane/4200-fix', 'a fix', { body: 'See how #4121 was resolved previously.', changedFiles: touching4121, diff: claims4121 })).toEqual([]);
    });

    // PR #2724 review (security/unverified-trust) — the marker text alone is a CLAIM, not evidence: a template,
    // a copy-paste, or an over-claiming body must never flip a card the PR's own diff never touched.
    it('an uncorroborated marker (the PR never touched backlog/<N>-*.md) is NEVER credited', () => {
      expect(declaredResolvedIdsFromPr('lane/4200-fix', 'a fix', { body: 'Resolves #9999', changedFiles: ['scripts/a.mjs', 'backlog/4200-fix.md'] })).toEqual([]);
      expect(declaredResolvedIdsFromPr('lane/4200-fix', 'a fix', { body: 'Resolves #9999' })).toEqual([]); // changed files unknown → fail closed
    });

    it('credits only the corroborated ids of a multi-id marker', () => {
      expect(declaredResolvedIdsFromPr('lane/4200-fix', 'a fix', { body: 'resolves: #4121, #9999', changedFiles: touching4121, diff: claims4121 })).toEqual(['4121']);
    });

    it('accepts gh\'s {path} changed-file objects for the whole-PR guards', () => {
      expect(declaredResolvedIdsFromPr('lane/4200-fix', 'a fix', { body: 'Resolves #4121', changedFiles: touching4121.map((path) => ({ path })), diff: claims4121 })).toEqual(['4121']);
    });
  });

  describe('signal 2 — structured bornAs-hash card markers, cross-verified against landedNumberFor', () => {
    // #xqpqyr2 — PR #2668's real title: ref led `xn6n5gp` (→ #4127, handled by deliveredHashFromPr above);
    // its title ALSO parenthesizes `xuqk1vp` (→ #4134) and `xb94mt5` (→ #4121) — two real cards this PR
    // delivered that its ref/single-id extractor structurally could never see.
    const realTitle = 'drain numbering: linear applyLedger (xn6n5gp), pid-aware lock reclaim + never-run-unlocked (xuqk1vp), number-on-any-pass sweep (xb94mt5)';
    const landedNumberFor = (h) => ({ xn6n5gp: '4127', xuqk1vp: '4134', xb94mt5: '4121' }[h] ?? null);

    // PR #2668's real changed files: it touched all three cards' (already numbered) backlog files.
    const realFiles = ['backlog/4121-drain-number-pending.md', 'backlog/4127-drain-numbering-linear.md', 'backlog/4134-numbering-lock-reclaim.md', 'scripts/backlog/id.mjs'];
    // PR #2689's real changed files: it filed both cards under their bornAs hashes.
    const soakFiles = ['backlog/x0zg44l-daemon-soak-harness.md', 'backlog/xg6m4i5-rule-every-daemon-bug-fix.md', 'scripts/conveyor/soak/invariants.mjs'];
    // …and their real status moves: #2668 claimed each numbered card `open → active`; #2689 filed its two
    // delivered cards new as `active` (and its two follow-ups as `open` — see the deferred test below).
    const realDiff = diffOf(...realFiles.slice(0, 3).map((f) => statusDiff(f, 'open', 'active')));
    const soakDiff = diffOf(...soakFiles.slice(0, 2).map((f) => statusDiff(f, null, 'active')));

    it('extracts every parenthesized hash in the TITLE and cross-verifies each against landedNumberFor (PR #2668\'s real shape)', () => {
      expect(declaredResolvedIdsFromPr('lane/xn6n5gp-numbering-linear-lock-safety', realTitle, { changedFiles: realFiles, diff: realDiff, landedNumberFor }).sort())
        .toEqual(['4121', '4127', '4134'].sort());
    });

    // PR #2724 review round 2 (antigravity) — several hashes grouped in ONE pair of title parens.
    it('extracts every hash of a grouped title paren ("(xuqk1vp, xb94mt5)")', () => {
      expect(declaredResolvedIdsFromPr('lane/xn6n5gp-x', 'drain numbering (xuqk1vp, xb94mt5)', { changedFiles: realFiles, diff: realDiff, landedNumberFor }).sort())
        .toEqual(['4121', '4134']);
      expect(declaredResolvedIdsFromPr('lane/xn6n5gp-x', 'drain numbering (see xuqk1vp for context)', { changedFiles: realFiles, diff: realDiff, landedNumberFor })).toEqual([]);
    });

    it('a hash the registry does NOT recognize is silently dropped — text alone is never trusted', () => {
      expect(declaredResolvedIdsFromPr('lane/xn6n5gp-x', 'fix (xdecoy1)', { landedNumberFor: () => null })).toEqual([]);
    });

    // PR #2724 review round 2 (antigravity) — a ride-along card filed under its hash in THIS PR is not numbered
    // yet when the merge is read (numbering runs in the same land); credit the bare hash, which
    // `planResolveOnLand` re-keys to the NNN minted this land.
    it('credits the bare hash of a ride-along card the PR filed active under its hash, before it is numbered', () => {
      const body = '**Rule (xg6m4i5):** every daemon bug fix adds its real-world case to the soak harness.';
      expect(declaredResolvedIdsFromPr('lane/x0zg44l-daemon-soak-harness', 'x0zg44l: daemon soak harness', { body, changedFiles: soakFiles, diff: soakDiff, landedNumberFor: () => null })).toEqual(['xg6m4i5']);
      expect(declaredResolvedIdsFromPr('lane/x0zg44l-daemon-soak-harness', 'x0zg44l: daemon soak harness', { body, changedFiles: soakFiles, diff: statusDiff(soakFiles[1], null, 'open'), landedNumberFor: () => null })).toEqual([]);
    });

    // #xqpqyr2 — PR #2689's real body: a `## heading` line naming "cards x0zg44l + xg6m4i5" (ref-led x0zg44l →
    // #4169 already handled elsewhere; the ride-along xg6m4i5 → #4172 is invisible without this), plus a
    // separate bold `**Rule (xg6m4i5):**` line later in the same body.
    it('extracts a hash inside a body HEADING line ("## … cards x0zg44l + xg6m4i5") (PR #2689\'s real shape)', () => {
      const body = '## Daemon soak harness (#4075, cards x0zg44l + xg6m4i5)\n\nSome prose that also happens to mention xdecoy9 in passing, which must NOT be credited.\n';
      const ln = (h) => ({ x0zg44l: '4169', xg6m4i5: '4172' }[h] ?? null);
      expect(declaredResolvedIdsFromPr('lane/x0zg44l-daemon-soak-harness', 'x0zg44l: daemon soak harness (#4075)', { body, changedFiles: soakFiles, diff: soakDiff, landedNumberFor: ln }).sort())
        .toEqual(['4169', '4172'].sort());
    });

    it('extracts a hash inside a body BOLD-span line ("**Rule (xg6m4i5):** …") (PR #2689\'s real shape)', () => {
      const body = '**Rule (xg6m4i5):** the fix-agent brief and conveyor SKILL.md now say every daemon bug fix adds its real-world case to the soak harness.';
      const ln = (h) => (h === 'xg6m4i5' ? '4172' : null);
      expect(declaredResolvedIdsFromPr('lane/x0zg44l-daemon-soak-harness', 'x0zg44l: daemon soak harness', { body, changedFiles: soakFiles, diff: soakDiff, landedNumberFor: ln })).toEqual(['4172']);
    });

    // PR #2724 review follow-up — the marker is a claim, as for signal 1: a bold/heading/title citation of a
    // real card the PR never touched ("not fixed", "skipped", "still open") must not resolve it.
    it('a verified hash is NOT credited when the PR never touched that card\'s file (under its hash or its number)', () => {
      const ln = (h) => (h === 'xg6m4i5' ? '4172' : null);
      for (const body of ['- **Not fixed (xg6m4i5):** deferred', '## Follow-up still open: xg6m4i5']) {
        expect(declaredResolvedIdsFromPr('lane/x0zg44l-x', 'x0zg44l: unrelated', { body, changedFiles: ['scripts/a.mjs'], landedNumberFor: ln })).toEqual([]);
      }
      expect(declaredResolvedIdsFromPr('lane/x0zg44l-x', 'fix (xg6m4i5)', { landedNumberFor: ln })).toEqual([]); // changed files unknown → fail closed
      expect(declaredResolvedIdsFromPr('lane/x0zg44l-x', 'fix (xg6m4i5)', { changedFiles: ['scripts/a.mjs', 'backlog/4172-rule.md'], diff: statusDiff('backlog/4172-rule.md', 'open', 'active'), landedNumberFor: ln })).toEqual(['4172']);
    });

    // PR #2724 review round 2 (correctness + security + codex) — a title/heading citation of a card whose file
    // the PR DID touch, but only to update it or to file it as a deferred follow-up, is not delivery.
    it('does not credit an explicitly deferred hash even when its card file is touched', () => {
      const ln = (h) => (h === 'xg6m4i5' ? '4172' : null);
      const scopeEdit = [
        'diff --git a/backlog/4172-rule.md b/backlog/4172-rule.md',
        '--- a/backlog/4172-rule.md',
        '+++ b/backlog/4172-rule.md',
        '@@ -6,3 +6,3 @@',
        ' status: open',
        '-scope: ["we:a.mjs"]',
        '+scope: ["we:a.mjs", "we:b.mjs"]',
      ].join('\n');
      for (const [title, body, diff] of [
        ['fix (xg6m4i5)', '', scopeEdit],
        ['x0zg44l: soak', '## Follow-up still open: xg6m4i5', scopeEdit],
        ['x0zg44l: soak', '## Follow-up still open: xg6m4i5', statusDiff('backlog/xg6m4i5-rule.md', null, 'open')],
      ]) {
        expect(declaredResolvedIdsFromPr('lane/x0zg44l-x', title, { body, changedFiles: ['scripts/a.mjs', 'backlog/4172-rule.md', 'backlog/xg6m4i5-rule.md'], diff, landedNumberFor: ln })).toEqual([]);
      }
    });

    it('a bare hash mention in ordinary prose (no bold span, no heading) is NEVER credited, even if it would verify', () => {
      const body = 'This builds on the approach xg6m4i5 took earlier, applied to a different daemon.';
      const ln = (h) => (h === 'xg6m4i5' ? '4172' : null);
      expect(declaredResolvedIdsFromPr('lane/x0zg44l-x', 'x0zg44l: unrelated', { body, landedNumberFor: ln })).toEqual([]);
    });

    // PR #2724 review (correctness, 3 lenses) — a line that merely STARTS with a bold span must not turn the
    // rest of its prose into a marker: only the hash INSIDE the leading bold span counts.
    it('does not credit a hash outside a bold span, even on a bold-led line', () => {
      const ln = (h) => (h === 'xg6m4i5' ? '4172' : null);
      for (const body of [
        '**Note:** this mirrors the fix already shipped for xg6m4i5 in a different daemon.',
        '**Warning:** this does NOT fix xg6m4i5',
        '- **Context:** follow-up work remains in xg6m4i5',
      ]) expect(declaredResolvedIdsFromPr('lane/x0zg44l-x', 'x0zg44l: unrelated', { body, landedNumberFor: ln })).toEqual([]);
    });
  });

  describe('signal 3 — a backlog file the PR\'s OWN diff flips to status: resolved', () => {
    it('credits the id when resolvedStatusIdsFromDiff finds a real flip', () => {
      const diff = [
        'diff --git a/backlog/4200-example.md b/backlog/4200-example.md',
        'index abc123..def456 100644',
        '--- a/backlog/4200-example.md',
        '+++ b/backlog/4200-example.md',
        '@@ -2,3 +2,3 @@',
        '-status: active',
        '+status: resolved',
      ].join('\n');
      expect(declaredResolvedIdsFromPr('lane/4300-carrier', 'carrier PR', { diff })).toEqual(['4200']);
    });
  });

  describe('whole-PR guards apply to ride-along credit too', () => {
    it('an all-.md changed-file set never ride-along-credits, however the title/body reads', () => {
      expect(declaredResolvedIdsFromPr('lane/4200-x', 'fix (xn6n5gp)', {
        body: 'Resolves #4121',
        changedFiles: ['backlog/4200-x.md'],
        landedNumberFor: () => '4127',
      })).toEqual([]);
    });

    it('a "no code changes" disclaimer never ride-along-credits', () => {
      expect(declaredResolvedIdsFromPr('lane/4200-x', 'fix (xn6n5gp)', {
        body: 'No code changes — backlog only. Resolves #4121',
        landedNumberFor: () => '4127',
      })).toEqual([]);
    });
  });
});

describe('resolvedStatusIdsFromDiff (#xqpqyr2 — the ground-truth half of declaredResolvedIdsFromPr\'s signal 3)', () => {
  it('credits a numbered backlog file the diff flips TO status: resolved', () => {
    const diff = [
      'diff --git a/backlog/4200-example.md b/backlog/4200-example.md',
      '--- a/backlog/4200-example.md',
      '+++ b/backlog/4200-example.md',
      '@@ -2,3 +2,3 @@',
      '-status: active',
      '+status: resolved',
    ].join('\n');
    expect(resolvedStatusIdsFromDiff(diff)).toEqual(['4200']);
  });

  it('a file already resolved before this diff (both +/- lines present) is NOT a real flip', () => {
    const diff = [
      'diff --git a/backlog/4200-example.md b/backlog/4200-example.md',
      '--- a/backlog/4200-example.md',
      '+++ b/backlog/4200-example.md',
      '@@ -2,4 +2,4 @@',
      '-status: resolved',
      '-dateStarted: "2026-01-01"',
      '+status: resolved',
      '+dateFinished: "2026-01-02"',
    ].join('\n');
    expect(resolvedStatusIdsFromDiff(diff)).toEqual([]);
  });

  it('a hash-named (not-yet-numbered) backlog file is never matched — only a real NNN path counts', () => {
    const diff = [
      'diff --git a/backlog/xaa7r2n-example.md b/backlog/xaa7r2n-example.md',
      '--- a/backlog/xaa7r2n-example.md',
      '+++ b/backlog/xaa7r2n-example.md',
      '@@ -2,3 +2,3 @@',
      '-status: active',
      '+status: resolved',
    ].join('\n');
    expect(resolvedStatusIdsFromDiff(diff)).toEqual([]);
  });

  it('a non-backlog file flipping some unrelated "status:" line is never matched', () => {
    const diff = [
      'diff --git a/scripts/config.mjs b/scripts/config.mjs',
      '--- a/scripts/config.mjs',
      '+++ b/scripts/config.mjs',
      '@@ -1,2 +1,2 @@',
      '-status: active',
      '+status: resolved',
    ].join('\n');
    expect(resolvedStatusIdsFromDiff(diff)).toEqual([]);
  });

  // PR #2724 review round 2 (codex) — only a FRONTMATTER transition counts; a status line in the card's body
  // (a fenced example, a quoted old card) is prose.
  it('ignores status examples outside backlog frontmatter', () => {
    const fencedExample = [
      'diff --git a/backlog/4200-example.md b/backlog/4200-example.md',
      '--- a/backlog/4200-example.md',
      '+++ b/backlog/4200-example.md',
      '@@ -14,2 +14,6 @@',
      ' ## Example',
      ' ',
      '+```yaml',
      '+status: resolved',
      '+```',
    ].join('\n');
    const afterClosingDelimiter = [
      'diff --git a/backlog/4200-example.md b/backlog/4200-example.md',
      '--- a/backlog/4200-example.md',
      '+++ b/backlog/4200-example.md',
      '@@ -1,5 +1,6 @@',
      ' ---',
      ' status: active',
      ' ---',
      '-status: open',
      '+status: resolved',
    ].join('\n');
    // A hunk deep in the body whose context happens to look like YAML never shows where the frontmatter ended.
    const deepBodyHunk = [
      'diff --git a/backlog/4200-example.md b/backlog/4200-example.md',
      '--- a/backlog/4200-example.md',
      '+++ b/backlog/4200-example.md',
      '@@ -40,5 +40,5 @@',
      ' owner: nic',
      ' priority: high',
      ' area: drain',
      '-status: open',
      '+status: resolved',
    ].join('\n');
    for (const diff of [fencedExample, afterClosingDelimiter, deepBodyHunk]) expect(resolvedStatusIdsFromDiff(diff)).toEqual([]);
  });

  it('unquotes status values, so a quoted re-open is still a re-open', () => {
    const quoted = (from, to) => statusDiff('backlog/4121-ride-along.md', from, to);
    expect(declaredResolvedIdsFromPr('lane/4200-fix', 'a fix', { body: 'Resolves #4121', changedFiles: ['scripts/a.mjs'], diff: quoted('"open"', '"active"') })).toEqual(['4121']);
    expect(declaredResolvedIdsFromPr('lane/4200-fix', 'a fix', { body: 'Resolves #4121', changedFiles: ['scripts/a.mjs'], diff: quoted("'resolved'", 'active') })).toEqual([]);
  });

  it('a modified card must REMOVE its prior status — an added status line alone is not a transition', () => {
    const addedOnly = [
      'diff --git a/backlog/4200-example.md b/backlog/4200-example.md',
      '--- a/backlog/4200-example.md',
      '+++ b/backlog/4200-example.md',
      '@@ -1,3 +1,4 @@',
      ' ---',
      ' kind: story',
      '+status: resolved',
      ' ---',
    ].join('\n');
    expect(resolvedStatusIdsFromDiff(addedOnly)).toEqual([]);
    expect(resolvedStatusIdsFromDiff(statusDiff('backlog/4200-example.md', null, 'resolved'))).toEqual(['4200']); // a NEW card filed resolved is a real one
  });

  it('empty/absent diff is a safe no-op', () => {
    expect(resolvedStatusIdsFromDiff('')).toEqual([]);
    expect(resolvedStatusIdsFromDiff()).toEqual([]);
  });
});
