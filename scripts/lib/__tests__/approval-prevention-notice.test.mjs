import { describe, it, expect } from 'vitest';
import {
  parseOwedPreventionFindings, isPreventionOutstandingVerdictText, hasRenderedVerdictLine,
  buildApprovalPreventionMarker, hasApprovalPreventionMarkerForHead, selectApprovalPreventionFindings,
  buildApprovalPreventionFilingInput, buildApprovalPreventionKey,
} from '../approval-prevention-notice.mjs';

// A comment as `gh pr view --json comments` returns it, posted by the conveyor automation's own login — the only
// shape (with the operator's login) the marker and advisory readers trust (PR #2805 review, security finding).
const trusted = (body, extra = {}) => ({ body, author: { login: 'web-everything' }, ...extra });

// A real rendered shape (`renderFindingLine`, `we:scripts/lib/review-render.mjs`) — one OWED finding, one
// CAPTURED finding, one plain finding with no prevention at all, to prove the parser is selective.
const MIXED_FINDINGS_BLOCK = [
  '### Findings (3)',
  '',
  '- `scripts/a.mjs:10` — first summary _[CONFIRMED]_',
  '  - _Prevention (OWED — file it):_ add a regression test for the first thing',
  '- `scripts/b.mjs:20` — second summary already guarded',
  '  - _Prevention (captured):_ already covered by scripts/b.test.mjs',
  '- plain finding with no file and no prevention at all',
].join('\n');

describe('parseOwedPreventionFindings — text-scans a rendered comment for renderFindingLine\'s OWED shape', () => {
  it('extracts file, line, and prevention text for an OWED finding', () => {
    const findings = parseOwedPreventionFindings(MIXED_FINDINGS_BLOCK);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'scripts/a.mjs', line: 10,
      prevention: 'add a regression test for the first thing',
      preventionCaptured: false,
    });
  });

  it('never matches a CAPTURED prevention line, or a finding with none at all', () => {
    const findings = parseOwedPreventionFindings(MIXED_FINDINGS_BLOCK);
    expect(findings.some((f) => /captured/.test(f.prevention))).toBe(false);
    expect(findings).toHaveLength(1);
  });

  it('handles a finding with no file:line anchor at all (a bare summary line)', () => {
    const text = [
      '- a finding with no file cited',
      '  - _Prevention (OWED — file it):_ do the thing',
    ].join('\n');
    const findings = parseOwedPreventionFindings(text);
    expect(findings).toEqual([{ prevention: 'do the thing', preventionCaptured: false }]);
  });

  it('handles a file anchor with no line number', () => {
    const text = [
      '- `scripts/x.mjs` — a summary',
      '  - _Prevention (OWED — file it):_ guard it',
    ].join('\n');
    const findings = parseOwedPreventionFindings(text);
    expect(findings).toEqual([{ file: 'scripts/x.mjs', prevention: 'guard it', preventionCaptured: false }]);
  });

  it('returns an empty array for text with no OWED marker at all', () => {
    expect(parseOwedPreventionFindings('nothing to see here')).toEqual([]);
    expect(parseOwedPreventionFindings('')).toEqual([]);
    expect(parseOwedPreventionFindings(undefined)).toEqual([]);
  });

  it('picks up more than one OWED finding in the same comment', () => {
    const text = [
      '- `a.mjs:1` — x',
      '  - _Prevention (OWED — file it):_ guard a',
      '- `b.mjs:2` — y',
      '  - _Prevention (OWED — file it):_ guard b',
    ].join('\n');
    const findings = parseOwedPreventionFindings(text);
    expect(findings.map((f) => f.prevention)).toEqual(['guard a', 'guard b']);
  });
});

describe('isPreventionOutstandingVerdictText / hasRenderedVerdictLine', () => {
  it('recognizes the exact prevention-outstanding verdict label renderPanelComment emits', () => {
    expect(isPreventionOutstandingVerdictText('**Verdict:** 🚩 prevention outstanding — file the guard before accept'))
      .toBe(true);
  });

  it('does not mistake an ordinary accept or a human-required verdict for prevention-outstanding', () => {
    expect(isPreventionOutstandingVerdictText('**Verdict:** ✅ pass — no blocking findings')).toBe(false);
    expect(isPreventionOutstandingVerdictText('**Verdict:** 🚦 human review required')).toBe(false);
    expect(isPreventionOutstandingVerdictText('')).toBe(false);
    expect(isPreventionOutstandingVerdictText(undefined)).toBe(false);
  });

  it('hasRenderedVerdictLine tells a full panel write-up apart from a bare ceremony comment', () => {
    expect(hasRenderedVerdictLine('**Verdict:** ✅ pass — no blocking findings')).toBe(true);
    expect(hasRenderedVerdictLine('**Human clearance recorded** by the operator.')).toBe(false);
  });
});

describe('buildApprovalPreventionMarker / hasApprovalPreventionMarkerForHead — the idempotency marker', () => {
  it('round-trips: a comment carrying the marker for a head is found by that same head', () => {
    const marker = buildApprovalPreventionMarker({ headSha: 'ABCDEF0123456789abcdef0123456789abcdef01' });
    const comments = [trusted(`${marker}\nsome note`)];
    expect(hasApprovalPreventionMarkerForHead(comments, 'abcdef0123456789abcdef0123456789abcdef01')).toBe(true);
  });

  it('is false when no comment carries the marker, or the head does not match', () => {
    const marker = buildApprovalPreventionMarker({ headSha: 'a'.repeat(40) });
    expect(hasApprovalPreventionMarkerForHead([], 'a'.repeat(40))).toBe(false);
    expect(hasApprovalPreventionMarkerForHead([trusted('unrelated comment')], 'a'.repeat(40))).toBe(false);
    expect(hasApprovalPreventionMarkerForHead([trusted(marker)], 'b'.repeat(40))).toBe(false);
  });

  it('tolerates a short-SHA marker matching a full head (either direction), like advisoryCoversHead does', () => {
    const shortMarker = buildApprovalPreventionMarker({ headSha: 'abc1234' });
    expect(hasApprovalPreventionMarkerForHead([trusted(shortMarker)], `abc1234${'0'.repeat(33)}`)).toBe(true);
  });

  it('returns false for a blank head', () => {
    expect(hasApprovalPreventionMarkerForHead([trusted(buildApprovalPreventionMarker({ headSha: 'a'.repeat(40) }))], ''))
      .toBe(false);
  });

  // PR #2805 review (security) — WE's PRs are public; a marker posted by anyone else must never suppress filing.
  it('ignores an approval-prevention-filed marker posted by an untrusted author', () => {
    const body = buildApprovalPreventionMarker({ headSha: 'a'.repeat(40) });
    expect(hasApprovalPreventionMarkerForHead([{ body, author: { login: 'random-external-user' } }], 'a'.repeat(40)))
      .toBe(false);
    expect(hasApprovalPreventionMarkerForHead([{ body }], 'a'.repeat(40))).toBe(false);
    expect(hasApprovalPreventionMarkerForHead([body], 'a'.repeat(40))).toBe(false);
  });

  it('honours the marker from the automation or the operator login', () => {
    const body = buildApprovalPreventionMarker({ headSha: 'a'.repeat(40) });
    expect(hasApprovalPreventionMarkerForHead([{ body, author: { login: 'web-everything' } }], 'a'.repeat(40))).toBe(true);
    expect(hasApprovalPreventionMarkerForHead([{ body, author: { login: 'chalbert' } }], 'a'.repeat(40))).toBe(true);
  });
});

describe('selectApprovalPreventionFindings — the decision', () => {
  const OWED_ACCEPT_COMMENT = [
    '**Verdict:** ✅ pass — no blocking findings',
    '',
    '### Findings (1)',
    '- `scripts/a.mjs:10` — a non-blocking issue',
    '  - _Prevention (OWED — file it):_ add the guard',
  ].join('\n');

  const PREVENTION_OUTSTANDING_COMMENT = [
    '**Verdict:** 🚩 prevention outstanding — file the guard before accept',
    '',
    '### Findings (1)',
    '- `scripts/a.mjs:10` — a resolved finding',
    '  - _Prevention (OWED — file it):_ add the guard',
  ].join('\n');

  it('returns null for any target other than accepted/clear-human', () => {
    for (const to of ['changes', 'rearm', 'restamp']) {
      expect(selectApprovalPreventionFindings({ to, commentBody: OWED_ACCEPT_COMMENT })).toBeNull();
    }
  });

  it('reads owed findings straight off an accept verdict comment carrying non-blocking OWED items', () => {
    const result = selectApprovalPreventionFindings({ to: 'accepted', commentBody: OWED_ACCEPT_COMMENT });
    expect(result).toMatchObject({ source: 'verdict-comment' });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].prevention).toBe('add the guard');
  });

  it('defers to #2766 (returns null) when the comment\'s own verdict is prevention-outstanding', () => {
    expect(selectApprovalPreventionFindings({ to: 'accepted', commentBody: PREVENTION_OUTSTANDING_COMMENT }))
      .toBeNull();
  });

  it('returns null when the verdict comment has no owed findings at all', () => {
    expect(selectApprovalPreventionFindings({
      to: 'accepted', commentBody: '**Verdict:** ✅ pass — no blocking findings',
    })).toBeNull();
  });

  it('falls back to the latest advisory covering the head when the comment carries no verdict line '
    + '(the clear-human ceremony\'s own bare comment)', () => {
    const advisory = [
      '**Verdict:** 🚦 human review required',
      'Net basis: `aaaa0000..deadbeef`',
      '- `scripts/a.mjs:10` — an advisory finding',
      '  - _Prevention (OWED — file it):_ add the guard',
      '**Advisory outcome:** `accept`',
    ].join('\n');
    const result = selectApprovalPreventionFindings({
      to: 'clear-human',
      commentBody: '**Human clearance recorded.**',
      prComments: [trusted(advisory, { createdAt: '2026-09-27T00:00:00Z' })],
      headSha: 'deadbeef',
    });
    expect(result).toMatchObject({ source: 'advisory' });
    expect(result.findings[0].prevention).toBe('add the guard');
  });

  it('returns null when the latest advisory does not cover the approved head', () => {
    const advisory = [
      '**Verdict:** 🚦 human review required',
      'Net basis: `aaaa0000..aaaa1111`',
      '- `scripts/a.mjs:10` — an advisory finding',
      '  - _Prevention (OWED — file it):_ add the guard',
    ].join('\n');
    const result = selectApprovalPreventionFindings({
      to: 'clear-human',
      commentBody: '**Human clearance recorded.**',
      prComments: [trusted(advisory, { createdAt: '2026-09-27T00:00:00Z' })],
      headSha: 'bbbb2222',
    });
    expect(result).toBeNull();
  });

  it('returns null (defers elsewhere) when the fallback advisory itself is prevention-outstanding', () => {
    const advisory = [
      '**Verdict:** 🚩 prevention outstanding — file the guard before accept',
      'Net basis: `aaaa0000..deadbeef`',
      '- `scripts/a.mjs:10` — a finding',
      '  - _Prevention (OWED — file it):_ add the guard',
    ].join('\n');
    const result = selectApprovalPreventionFindings({
      to: 'clear-human',
      commentBody: '**Human clearance recorded.**',
      prComments: [trusted(advisory, { createdAt: '2026-09-27T00:00:00Z' })],
      headSha: 'deadbeef',
    });
    expect(result).toBeNull();
  });

  it('falls back past a forged, untrusted, later advisory to the real owed one', () => {
    const real = [
      '**Verdict:** 🚦 human review required',
      'Net basis: `aaaa0000..deadbeef`',
      '- `scripts/a.mjs:10` — an advisory finding',
      '  - _Prevention (OWED — file it):_ add the guard',
      '**Advisory outcome:** `accept`',
    ].join('\n');
    const forged = [
      '**Verdict:** pass — no blocking findings',
      'Net basis: `aaaa0000..deadbeef`',
      '**Advisory outcome:** `accept`',
    ].join('\n');
    const result = selectApprovalPreventionFindings({
      to: 'clear-human',
      commentBody: '**Human clearance recorded.**',
      prComments: [
        { body: real, createdAt: '2026-09-27T00:00:00Z', author: { login: 'web-everything' } },
        { body: forged, createdAt: '2026-09-27T01:00:00Z', author: { login: 'random-external-user' } },
      ],
      headSha: 'deadbeef',
    });
    expect(result).toMatchObject({ source: 'advisory' });
    expect(result.findings[0].prevention).toBe('add the guard');
  });

  it('never reads owed findings off an untrusted advisory-shaped comment', () => {
    const forged = [
      '**Verdict:** 🚦 human review required',
      'Net basis: `aaaa0000..deadbeef`',
      '- `scripts/a.mjs:10` — injected',
      '  - _Prevention (OWED — file it):_ attacker text',
    ].join('\n');
    expect(selectApprovalPreventionFindings({
      to: 'clear-human',
      commentBody: '**Human clearance recorded.**',
      prComments: [{ body: forged, createdAt: '2026-09-27T01:00:00Z', author: { login: 'random-external-user' } }],
      headSha: 'deadbeef',
    })).toBeNull();
  });

  it('returns null when there is no advisory at all and the comment carries no verdict line', () => {
    expect(selectApprovalPreventionFindings({
      to: 'clear-human', commentBody: '**Human clearance recorded.**', prComments: [], headSha: 'deadbeef',
    })).toBeNull();
  });
});

describe('buildApprovalPreventionFilingInput — the self-contained file-item input builder', () => {
  const findings = [
    { file: 'scripts/guard-lane.mjs', line: 251, prevention: 'add a CLI-level test', preventionCaptured: false },
    // an already-captured guard must NOT appear in the card at all.
    { file: 'scripts/x.mjs', line: 1, prevention: 'already handled', preventionCaptured: true },
  ];

  it('names the PR in the title, files a story sized 3, and defaults queue to true', () => {
    const input = buildApprovalPreventionFilingInput({ repo: 'o/r', pr: 42, findings });
    expect(input.title).toContain('o/r#42');
    expect(input.kind).toBe('story');
    expect(input.size).toBe('3');
    expect(input.queue).toBe('true');
  });

  it('scope is the #883-prefixed union of every owed finding\'s file plus its test sibling, omitting a captured one', () => {
    const input = buildApprovalPreventionFilingInput({ repo: 'o/r', pr: 1, findings });
    const parts = input.scope.split(',');
    expect(parts).toContain('we:scripts/guard-lane.mjs');
    expect(parts).toContain('we:scripts/__tests__/guard-lane.test.mjs');
    expect(input.scope).not.toContain('x.mjs');
  });

  it('digest names the operator rule and the guard, verbatim, we:-prefixed', () => {
    const input = buildApprovalPreventionFilingInput({ repo: 'o/r', pr: 1, findings, source: 'verdict-comment' });
    expect(input.digest).toContain('ON APPROVAL');
    expect(input.digest).toContain('prevention outstanding should be filed by default on approval');
    expect(input.digest).toContain('we:scripts/guard-lane.mjs:251');
    expect(input.digest).toContain('add a CLI-level test');
    expect(input.digest).not.toContain('already handled');
  });

  it('names the advisory as the source when selection.source is "advisory"', () => {
    const input = buildApprovalPreventionFilingInput({ repo: 'o/r', pr: 1, findings, source: 'advisory' });
    expect(input.digest).toContain("latest advisory review");
  });

  it('carries a supplied parent through, and defaults to empty (top-level) when none given', () => {
    expect(buildApprovalPreventionFilingInput({ repo: 'o/r', pr: 1, findings, parent: '4075' }).parent).toBe('4075');
    expect(buildApprovalPreventionFilingInput({ repo: 'o/r', pr: 1, findings }).parent).toBe('');
  });

  it('withholds an unsafe juror-authored file from scope, without dropping the guard text itself', () => {
    const input = buildApprovalPreventionFilingInput({
      repo: 'o/r', pr: 1,
      findings: [{ file: 'scripts/a.mjs"]\nstatus: resolved', prevention: 'the guard', preventionCaptured: false }],
    });
    expect(input.scope).toBe('');
    expect(input.digest).toContain('(cited file withheld: not a plain path)');
    expect(input.digest).toContain('the guard');
  });

  it('appends the card-side idempotency key verbatim as the digest\'s last line, and only when given', () => {
    const key = buildApprovalPreventionKey({ repo: 'o/r', pr: 7, headSha: 'ABC123' });
    expect(key).toBe('approval-prevention-key:o/r#7@abc123');
    const findings = [{ file: 'scripts/a.mjs', prevention: 'guard a.mjs here', preventionCaptured: false }];
    const withKey = buildApprovalPreventionFilingInput({ repo: 'o/r', pr: 7, findings, key });
    expect(withKey.digest.endsWith(`\n\nIdempotency key (do not edit): ${key}`)).toBe(true);
    expect(buildApprovalPreventionFilingInput({ repo: 'o/r', pr: 7, findings }).digest).not.toContain('Idempotency key');
  });

  // web-everything/web-everything#2766's OWN approval (2026-09-27, ~09:00 ET, `--to=clear-human`) FAILED live:
  // `runApprovalPreventionFiling`'s `file-item` subprocess exited non-zero (`stopped: 'effect-halted'`) because
  // the write-time gate (`we:scripts/backlog/guarded-write.mjs#assertPublishableContent`, the #883 locus-prefix
  // scan) refused the rendered card — reproduced read-only against the PR's real 12:45Z advisory finding text,
  // which named its own guard's fix as "Add a regression test in scripts/lib/__tests__/review-loop-policy.test.mjs
  // that asserts…", a FULL bare path (this card's own test-sibling scope entry) with no `we:` prefix at all. The
  // basename-only safety net above deliberately leaves a name already part of a longer `dir/basename` path alone,
  // so this exact bare path survived into the digest untouched.
  it('#2766 live repro: a bare FULL PATH in prose (not just a basename) — here, the guard\'s own test-sibling '
    + 'path, named verbatim by the real 12:45Z advisory finding — is still `we:`-prefixed, not just a basename', () => {
    const findings = [
      {
        file: 'scripts/lib/review-loop-policy.mjs',
        line: 454,
        prevention: 'Add a regression test in scripts/lib/__tests__/review-loop-policy.test.mjs that asserts '
          + 'cardCoversGuard returns false for two findings sharing a file:line but with unrelated '
          + '`prevention`/`summary` text (e.g. requiring the anchor to also fold in a short content fingerprint '
          + 'of the guard text when a file:line collision occurs), captured as a deterministic unit test rather '
          + 'than left as a documented-only trade-off.',
        preventionCaptured: false,
      },
      {
        file: 'scripts/operations/review-loop-cli.mjs',
        line: 368,
        prevention: 'Add a deterministic integration test requiring a distinct same-location guard to be filed '
          + 'before acceptance; when guard equivalence cannot be established, retain the new filing rather than '
          + 'suppressing it.',
        preventionCaptured: false,
      },
    ];
    const key = buildApprovalPreventionKey({
      repo: 'web-everything/web-everything', pr: 2766, headSha: 'd2453a58216d6cc4b14a4e1f30c673451ca93485',
    });
    const input = buildApprovalPreventionFilingInput({
      repo: 'web-everything/web-everything', pr: 2766, findings, parent: '4075', source: 'advisory', key,
    });
    // RED before the fix: the bare full-path mention survived verbatim, no `we:` prefix.
    expect(input.digest).not.toContain('in scripts/lib/__tests__/review-loop-policy.test.mjs that asserts');
    // GREEN: the same mention, now `we:`-prefixed — exactly what the write-time gate requires (#883).
    expect(input.digest).toContain('in we:scripts/lib/__tests__/review-loop-policy.test.mjs that asserts');
    // The guard's own explicit file:line anchors (already prefixed by the first pass) are untouched.
    expect(input.digest).toContain('`we:scripts/lib/review-loop-policy.mjs:454`');
    expect(input.digest).toContain('`we:scripts/operations/review-loop-cli.mjs:368`');
    // The idempotency key, appended after both passes, is byte-for-byte intact.
    expect(input.digest.endsWith(`\n\nIdempotency key (do not edit): ${key}`)).toBe(true);
  });
});
