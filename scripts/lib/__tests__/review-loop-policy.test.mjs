import { describe, expect, it } from 'vitest';
import {
  reviewLoopAutoConfirm, buildAcceptQueueEntry, acceptResumeCommand, isQueuedAcceptStop, ACCEPT_QUEUE_AREA,
  buildPreventionQueueEntry, isPreventionOutstandingClear, PREVENTION_QUEUE_AREA,
  isPreventionOutstandingParked, buildPreventionFilingInput, preventionHeadMarker, preventionGuardAnchor,
  cleanFindingFile, cardCoversGuard,
} from '../review-loop-policy.mjs';
import { CONFIRM_ACTORS } from '../../operations/review-pr.mjs';
import { VERDICTS } from '../jury-core.mjs';
import { FIELD_CAPS, KINDS, validateEntry } from '../../conveyor/learnings-drop.mjs';
import { findUnmarkedLocusRefs } from '../../check-standards-rules.mjs';
import { assertPublishableContent } from '../../backlog/guarded-write.mjs';

const humanPending = { of: CONFIRM_ACTORS.HUMAN };
const agentPending = { of: CONFIRM_ACTORS.AGENT };

describe('reviewLoopAutoConfirm — the #3072/#3383/#3434 ruling, in code', () => {
  it('declines a HUMAN-addressed confirm no matter what the verdict is — UNCHANGED by #3434/#3442', () => {
    expect(reviewLoopAutoConfirm(humanPending, { verdict: { verdict: VERDICTS.CHANGES } })).toBeNull();
    expect(reviewLoopAutoConfirm(humanPending, { verdict: { verdict: VERDICTS.ACCEPT } })).toBeNull();
    expect(reviewLoopAutoConfirm(humanPending, { verdict: { verdict: VERDICTS.PREVENTION_OUTSTANDING } })).toBeNull();
  });

  it('answers accept unattended for an agent-addressed clean verdict — #3434, mechanical acceptance', () => {
    expect(reviewLoopAutoConfirm(agentPending, { verdict: { verdict: VERDICTS.ACCEPT } }))
      .toEqual({ value: 'accept' });
  });

  it('DECLINES (does not auto-answer accept) for an agent-addressed prevention-outstanding verdict — #3442 '
    + 'REVERSED live on web-everything/web-everything#2749: the rendered verdict text itself says "file the guard '
    + 'before accept", and jury-core.mjs\'s own VERDICTS doc says this verdict "never silently lands" — an '
    + 'unattended loop answering `accept` over it contradicts both. The run stays parked, exactly like a '
    + 'human-addressed confirm, until an operator files the guard and resumes with --answer=accept themselves.', () => {
    expect(reviewLoopAutoConfirm(agentPending, { verdict: { verdict: VERDICTS.PREVENTION_OUTSTANDING } }))
      .toBeNull();
  });

  it('answers `changes` unattended for an agent-addressed non-accept, non-prevention verdict', () => {
    expect(reviewLoopAutoConfirm(agentPending, { verdict: { verdict: VERDICTS.CHANGES } }))
      .toEqual({ value: 'changes' });
  });

  it('declines with no pending at all (defensive — driveRun never calls it this way today)', () => {
    expect(reviewLoopAutoConfirm(null, { verdict: { verdict: VERDICTS.CHANGES } })).toBeNull();
  });

  it('declines a missing/garbage verdict rather than answering blind', () => {
    expect(reviewLoopAutoConfirm(agentPending, {})).toEqual({ value: 'changes' });
    // No verdict at all is not `accept`, so this still answers `changes` — a run with no verdict object could
    // not have reached a `confirm` suspend for review-pr in practice (reduce always sets one), but the policy
    // does not need to assume that to stay safe: the only value it may never answer is `accept`, and `undefined
    // !== 'accept'` holds either way.
  });
});

describe('#x100grep — literal grep proof `value: \'accept\'` appears EXACTLY where #3434 put it, and NEVER on '
  + 'prevention-outstanding (#2749 fix)', () => {
  it('the source returns accept from exactly the one reviewed, ratified branch (VERDICTS.ACCEPT), never from '
    + 'VERDICTS.PREVENTION_OUTSTANDING', async () => {
    // #3434's FIRST ratified item narrowed this canary to exactly one occurrence. #3442 widened it to two
    // (`prevention-outstanding` also auto-cleared); the #2749 live incident (web-everything/web-everything#2749, a
    // `prevention-outstanding` verdict — both mandatory lenses CONFIRMED real, unfixed defects — mechanically
    // recorded as `review:accepted` and merged) reversed that second branch. This canary now pins the count
    // back to ONE, and ADDS a permanent negative assertion: a future edit can re-add mechanical accept to some
    // OTHER function without this test noticing, but cannot silently reintroduce a
    // `VERDICTS.PREVENTION_OUTSTANDING → accept` branch inside `reviewLoopAutoConfirm` without this test
    // catching it by name.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'review-loop-policy.mjs'), 'utf8');
    const matches = src.match(/value:\s*['"]accept['"]/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(src).toMatch(/VERDICTS\.ACCEPT\)\s*return\s*\{\s*value:\s*['"]accept['"]\s*\}/);
    expect(src).not.toMatch(/VERDICTS\.PREVENTION_OUTSTANDING\)\s*return\s*\{\s*value:\s*['"]accept['"]\s*\}/);
    // The verdict must instead DECLINE (return null) — the run stays parked, never silently recorded.
    expect(src).toMatch(/VERDICTS\.PREVENTION_OUTSTANDING\)\s*return\s*null/);
  });
});

describe('buildAcceptQueueEntry — the notification filed for a queued accept', () => {
  const entry = buildAcceptQueueEntry({ repo: 'web-everything/web-everything', pr: 1234, runId: 'r-abc123' });

  it('produces a kind learnings-drop still recognizes', () => {
    expect(KINDS).toContain(entry.kind);
  });

  it('validates clean against the live learnings-drop schema — not merely a shape this file invented', () => {
    const { ok, errors } = validateEntry(entry);
    expect(ok, errors?.join('; ')).toBe(true);
  });

  it('names the PR and carries a working resume command in `suggestion`', () => {
    expect(entry.summary).toContain('web-everything/web-everything#1234');
    expect(entry.suggestion).toContain('--resume=r-abc123');
    expect(entry.suggestion).toContain('--answer=accept');
  });

  it('stays within every field cap, for a realistic repo/pr/runId', () => {
    for (const [field, cap] of Object.entries(FIELD_CAPS)) {
      expect(entry[field].length).toBeLessThanOrEqual(cap);
    }
  });

  it('area names the operation, for a reader of the pool with no other context', () => {
    expect(entry.area).toBe(ACCEPT_QUEUE_AREA);
  });

  it('refuses rather than truncates when an input is too long to fit', () => {
    const hugeRepo = 'x'.repeat(500);
    expect(() => buildAcceptQueueEntry({ repo: hugeRepo, pr: 1, runId: 'r' })).toThrow(/over the pool's/);
  });
});

describe('acceptResumeCommand', () => {
  it('is the documented --resume=<id> --answer=accept shape, naming the PR', () => {
    const cmd = acceptResumeCommand({ runId: 'r-1', repo: 'o/r', pr: 42 });
    expect(cmd).toBe(
      'node scripts/operations/run.mjs review-pr --resume=r-1 --answer=accept # o/r#42 — clears it; '
      + '--answer=changes bounces it instead',
    );
  });
});

describe('isQueuedAcceptStop', () => {
  it('true only for an agent-addressed confirm stop whose verdict is accept', () => {
    expect(isQueuedAcceptStop({
      stopped: 'confirm',
      run: { pending: { of: CONFIRM_ACTORS.AGENT }, verdict: { verdict: VERDICTS.ACCEPT } },
    })).toBe(true);
  });

  it('false for a human-addressed confirm stop, even on accept', () => {
    expect(isQueuedAcceptStop({
      stopped: 'confirm',
      run: { pending: { of: CONFIRM_ACTORS.HUMAN }, verdict: { verdict: VERDICTS.ACCEPT } },
    })).toBe(false);
  });

  it('false for an agent-addressed confirm stop whose verdict is not accept', () => {
    expect(isQueuedAcceptStop({
      stopped: 'confirm',
      run: { pending: { of: CONFIRM_ACTORS.AGENT }, verdict: { verdict: VERDICTS.CHANGES } },
    })).toBe(false);
  });

  it('false for an agent-addressed confirm stop whose verdict is prevention-outstanding — #2749: that verdict '
    + 'is handled mechanically (file-item + auto-resume), never queued for a human; see isPreventionOutstandingParked', () => {
    expect(isQueuedAcceptStop({
      stopped: 'confirm',
      run: { pending: { of: CONFIRM_ACTORS.AGENT }, verdict: { verdict: VERDICTS.PREVENTION_OUTSTANDING } },
    })).toBe(false);
  });

  it('false for a non-confirm stop entirely', () => {
    expect(isQueuedAcceptStop({ stopped: 'complete', run: { verdict: { verdict: VERDICTS.ACCEPT } } })).toBe(false);
  });

  it('false for a missing outcome', () => {
    expect(isQueuedAcceptStop(null)).toBe(false);
    expect(isQueuedAcceptStop(undefined)).toBe(false);
  });
});

describe('isPreventionOutstandingParked — the #2749 mechanical-filing trigger (replaces the queued-for-a-human path)', () => {
  it('true only for an agent-addressed confirm stop whose verdict is prevention-outstanding', () => {
    expect(isPreventionOutstandingParked({
      stopped: 'confirm',
      run: { pending: { of: CONFIRM_ACTORS.AGENT }, verdict: { verdict: VERDICTS.PREVENTION_OUTSTANDING } },
    })).toBe(true);
  });

  it('false for a human-addressed confirm stop carrying the same verdict — its own review:human ceremony is untouched', () => {
    expect(isPreventionOutstandingParked({
      stopped: 'confirm',
      run: { pending: { of: CONFIRM_ACTORS.HUMAN }, verdict: { verdict: VERDICTS.PREVENTION_OUTSTANDING } },
    })).toBe(false);
  });

  it('false for an agent-addressed confirm stop whose verdict is accept (the OTHER, unrelated predicate)', () => {
    expect(isPreventionOutstandingParked({
      stopped: 'confirm',
      run: { pending: { of: CONFIRM_ACTORS.AGENT }, verdict: { verdict: VERDICTS.ACCEPT } },
    })).toBe(false);
  });

  it('false for a non-confirm stop entirely', () => {
    expect(isPreventionOutstandingParked({
      stopped: 'complete',
      run: { verdict: { verdict: VERDICTS.PREVENTION_OUTSTANDING } },
    })).toBe(false);
  });

  it('false for a missing outcome', () => {
    expect(isPreventionOutstandingParked(null)).toBe(false);
    expect(isPreventionOutstandingParked(undefined)).toBe(false);
  });
});

describe('buildPreventionFilingInput — the file-item card the loop files for itself (#2749)', () => {
  const findings = [
    { file: 'scripts/guard-lane.mjs', line: 251, prevention: 'add a CLI-level test asserting LANE_GUARD_OFF=1 still denies a daemon-clone target', preventionCaptured: false },
    { file: 'scripts/guard-bash.mjs', line: 1774, prevention: 'add a chained/repeated -C case to the guard-bash fuzz suite', preventionCaptured: false },
    { file: 'scripts/guard-bash.mjs', line: 1852, prevention: 'realpath each resolved write operand before the prefix comparison', preventionCaptured: false },
    // an already-captured guard must NOT appear in the card at all.
    { file: 'scripts/guard-bash.mjs', line: 9999, prevention: 'already handled elsewhere', preventionCaptured: true },
  ];

  it('names the PR and both repos in the title, and files a story sized 3', () => {
    const input = buildPreventionFilingInput({ repo: 'web-everything/web-everything', pr: 2749, findings });
    expect(input.title).toContain('web-everything/web-everything#2749');
    expect(input.kind).toBe('story');
    expect(input.size).toBe('3');
  });

  it('scope is the union of every outstanding finding\'s file plus its test sibling, deduped, each carrying '
    + 'the #883 `we:` locus prefix (the write-time gate rejects a bare path)', () => {
    const input = buildPreventionFilingInput({ repo: 'o/r', pr: 1, findings });
    const parts = input.scope.split(',');
    expect(parts).toContain('we:scripts/guard-lane.mjs');
    expect(parts).toContain('we:scripts/guard-bash.mjs');
    expect(parts).toContain('we:scripts/__tests__/guard-lane.test.mjs');
    expect(parts).toContain('we:scripts/__tests__/guard-bash.test.mjs');
    // guard-bash.mjs appears twice in `findings` but must appear exactly once in scope.
    expect(parts.filter((p) => p === 'we:scripts/guard-bash.mjs')).toHaveLength(1);
    expect(parts.every((p) => p.startsWith('we:'))).toBe(true);
  });

  it('digest carries one numbered line per OUTSTANDING guard, with a we:-prefixed file:line and the prevention '
    + 'text verbatim, and OMITS an already-captured guard entirely', () => {
    const input = buildPreventionFilingInput({ repo: 'o/r', pr: 1, findings });
    expect(input.digest).toContain('we:scripts/guard-lane.mjs:251');
    expect(input.digest).toContain('add a CLI-level test asserting LANE_GUARD_OFF=1 still denies a daemon-clone target');
    expect(input.digest).toContain('we:scripts/guard-bash.mjs:1774');
    expect(input.digest).toContain('we:scripts/guard-bash.mjs:1852');
    expect(input.digest).not.toContain('already handled elsewhere');
  });

  it('#883 safety net: prefixes a BARE mention of a cited file\'s basename inside the prevention PROSE itself '
    + '(live example: PR #2749\'s real finding 3 text), without double-prefixing the already-prefixed file:line anchor', () => {
    const findingsWithBareProseMention = [
      {
        file: 'scripts/guard-bash.mjs', line: 1852,
        prevention: 'realpath each resolved write operand before the prefix comparison (mirroring how '
          + 'guard-lane.mjs already receives a pre-realpath\'d real from its caller)',
        preventionCaptured: false,
      },
      { file: 'scripts/guard-lane.mjs', line: 251, prevention: 'add the missing CLI-level test', preventionCaptured: false },
    ];
    const input = buildPreventionFilingInput({ repo: 'o/r', pr: 1, findings: findingsWithBareProseMention });
    expect(input.digest).not.toMatch(/[^:/]guard-lane\.mjs(?!`)/); // no bare mention survives anywhere
    expect(input.digest).toContain('mirroring how we:scripts/guard-lane.mjs already receives');
    expect(input.digest).toContain('we:scripts/guard-lane.mjs:251'); // the real anchor stays single-prefixed
    expect(input.digest).not.toContain('we:we:');
  });

  it('PR #2766 advisory: a FULL bare path in the prose (a test path, a file the card never cites) is prefixed too, '
    + 'so the write-time locus scan (`assertPublishableContent`) accepts the card instead of refusing it', () => {
    // Matrix: a bare basename of a cited file, a full relative path of a cited file, a test path absent from
    // finding.file, an uncited sibling source file, and an already-qualified path that must stay single-prefixed.
    const input = buildPreventionFilingInput({
      repo: 'o/r',
      pr: 1,
      findings: [{
        file: 'scripts/guard-lane.mjs', line: 10, preventionCaptured: false,
        prevention: 'add a case to scripts/__tests__/guard-lane.test.mjs, mirror scripts/guard-bash.mjs, '
          + 'reuse guard-lane.mjs as-is, and leave we:scripts/lane-pool.mjs alone',
      }],
    });
    expect(findUnmarkedLocusRefs(input.digest)).toEqual([]);
    expect(() => assertPublishableContent('backlog/x-card.md', `# t\n\n${input.digest}\n`)).not.toThrow();
    expect(input.digest).toContain('add a case to we:scripts/__tests__/guard-lane.test.mjs,');
    expect(input.digest).toContain('mirror we:scripts/guard-bash.mjs,');
    expect(input.digest).toContain('reuse we:scripts/guard-lane.mjs as-is');
    expect(input.digest).toContain('leave we:scripts/lane-pool.mjs alone');
    expect(input.digest).not.toContain('we:we:');
  });

  it('PR #2766 self-review: prefixes a path after a NON-repo colon, and never splices a prefix into a hyphenated '
    + 'longer basename', () => {
    const input = buildPreventionFilingInput({
      repo: 'o/r', pr: 1,
      findings: [{
        file: 'scripts/lane.mjs', line: 3, preventionCaptured: false,
        prevention: 'see Files:scripts/z.mjs, then mirror guard-lane.mjs like pre-lane.mjs and lane.mjs',
      }],
    });
    expect(findUnmarkedLocusRefs(input.digest)).toEqual([]);
    expect(input.digest).toContain('Files:we:scripts/z.mjs');
    // Uncited bare names are prefixed WHOLE (the detector flags them too); never `guard-we:scripts/lane.mjs`.
    expect(input.digest).toContain('mirror we:guard-lane.mjs like we:pre-lane.mjs and we:scripts/lane.mjs');
    expect(input.digest).not.toMatch(/-we:/);
  });

  it('PR #2766 advisory (antigravity): never splices a cited path into a LONGER name that only adds an '
    + 'extension, and still qualifies a cited name that ends a sentence', () => {
    const input = buildPreventionFilingInput({
      repo: 'o/r', pr: 1,
      findings: [{
        file: 'scripts/lane.mjs', line: 3, preventionCaptured: false,
        prevention: 'ignore lane.mjs.bak here, and fix lane.mjs.',
      }],
    });
    expect(input.digest).not.toContain('we:scripts/lane.mjs.bak');
    expect(input.digest).toContain('and fix we:scripts/lane.mjs.');
    expect(findUnmarkedLocusRefs(input.digest)).toEqual([]);
  });

  it('PR #2766 advisory (antigravity): a TOP-LEVEL file\'s test sibling is `__tests__/<stem>.test.mjs`, never '
    + 'a `./`-led path', () => {
    const input = buildPreventionFilingInput({
      repo: 'o/r', pr: 1,
      findings: [{ file: 'index.mjs', line: 1, prevention: 'pin it', preventionCaptured: false }],
    });
    expect(input.scope.split(',')).toEqual(['we:index.mjs', 'we:__tests__/index.test.mjs']);
  });

  it('PR #2766: names the reviewed head in the digest when given (the stable duplicate key), and nothing when not', () => {
    const head = 'c'.repeat(40);
    const withHead = buildPreventionFilingInput({ repo: 'o/r', pr: 1, findings, head });
    expect(withHead.digest).toContain(preventionHeadMarker(head));
    expect(() => assertPublishableContent('backlog/x-card.md', `# t\n\n${withHead.digest}\n`)).not.toThrow();
    expect(buildPreventionFilingInput({ repo: 'o/r', pr: 1, findings }).digest).not.toContain('reviewed head');
  });

  it('a finding that already cites a test file adds NO doubled `__tests__/__tests__/x.test.test.mjs` sibling '
    + '(live: PR #2759 / #2738 cited `scripts/lib/__tests__/*.test.mjs`)', () => {
    const input = buildPreventionFilingInput({
      repo: 'o/r', pr: 1,
      findings: [{ file: 'scripts/lib/__tests__/critical-work.test.mjs', line: 172, prevention: 'x', preventionCaptured: false }],
    });
    expect(input.scope).toBe('we:scripts/lib/__tests__/critical-work.test.mjs');
    expect(input.scope).not.toContain('__tests__/__tests__');
    expect(input.scope).not.toContain('.test.test.');
    for (const file of ['scripts/lib/__tests__/helpers/fake.mjs', 'scripts/lib/x.spec.mjs', 'scripts/lib/x.test.js']) {
      const one = buildPreventionFilingInput({
        repo: 'o/r', pr: 1, findings: [{ file, prevention: 'x', preventionCaptured: false }],
      });
      expect(one.scope).toBe(`we:${file}`);
    }
  });

  it('normalizes ordinary juror path forms (`./`, diff `a/`/`b/`, `:line[:col]`) and keeps dot-folders, '
    + 'rather than withholding them', () => {
    for (const [file, want] of [
      ['scripts/x.mjs:172', 'we:scripts/x.mjs'],
      ['scripts/x.mjs:172:5', 'we:scripts/x.mjs'],
      ['./scripts/x.mjs', 'we:scripts/x.mjs'],
      ['b/scripts/x.mjs', 'we:scripts/x.mjs'],
    ]) {
      const input = buildPreventionFilingInput({
        repo: 'o/r', pr: 1, findings: [{ file, prevention: 'x', preventionCaptured: false }],
      });
      expect(input.scope.split(',')[0]).toBe(want);
    }
    const gh = buildPreventionFilingInput({
      repo: 'o/r', pr: 1, findings: [{ file: '.github/workflows/ci.yml', prevention: 'x', preventionCaptured: false }],
    });
    expect(gh.scope.split(',')).toEqual(['we:.github/workflows/ci.yml']);
  });

  it('adds a `__tests__` sibling only for a JS/TS-family source file — never a phantom one for .yml/.sh/.json/.md', () => {
    for (const file of ['.github/workflows/ci.yml', 'scripts/run.sh', 'data/state.json', 'docs/agent/x.md']) {
      const input = buildPreventionFilingInput({
        repo: 'o/r', pr: 1, findings: [{ file, prevention: 'x', preventionCaptured: false }],
      });
      expect(input.scope.split(',')).toEqual([`we:${file}`]);
    }
    for (const [file, sibling] of [
      ['scripts/a.mjs', 'scripts/__tests__/a.test.mjs'],
      ['scripts/a.js', 'scripts/__tests__/a.test.mjs'],
      ['src/a.ts', 'src/__tests__/a.test.mjs'],
    ]) {
      const input = buildPreventionFilingInput({
        repo: 'o/r', pr: 1, findings: [{ file, prevention: 'x', preventionCaptured: false }],
      });
      expect(input.scope.split(',')).toEqual([`we:${file}`, `we:${sibling}`]);
    }
  });

  it('withholds a juror-authored `file` that is not a plain path (quote/newline/comma could inject frontmatter '
    + 'keys or split scope), from both scope and the digest anchor, while still filing the guard text', () => {
    for (const file of [
      'scripts/a.mjs"]\nstatus: resolved\ntags: ["pwned',
      'scripts/a.mjs,we:scripts/other.mjs',
      'scripts/a b.mjs',
      'scripts/a\\b.mjs',
      '../outside.mjs',
    ]) {
      const input = buildPreventionFilingInput({
        repo: 'o/r', pr: 1, findings: [{ file, line: 1, prevention: 'the guard', preventionCaptured: false }],
      });
      expect(input.scope).toBe('');
      expect(input.digest).toContain('(cited file withheld: not a plain path)');
      expect(input.digest).toContain('the guard');
      expect(input.digest).not.toContain('pwned');
    }
  });

  it('#883 safety net does not corrupt a hyphenated sibling whose name ENDS in another cited basename', () => {
    const input = buildPreventionFilingInput({
      repo: 'o/r', pr: 1,
      findings: [
        { file: 'scripts/foo.mjs', prevention: 'guard foo.mjs itself', preventionCaptured: false },
        { file: 'scripts/prefix-foo.mjs', prevention: 'see prefix-foo.mjs', preventionCaptured: false },
      ],
    });
    expect(input.digest).not.toContain('prefix-we:');
    expect(input.digest).toContain('`we:scripts/prefix-foo.mjs`');
    expect(input.digest).toContain('see we:scripts/prefix-foo.mjs');
    expect(input.digest).toContain('guard we:scripts/foo.mjs itself');
  });

  it('carries a supplied parent through unchanged, and defaults to empty (top-level) when none is given', () => {
    expect(buildPreventionFilingInput({ repo: 'o/r', pr: 1, findings, parent: '4075' }).parent).toBe('4075');
    expect(buildPreventionFilingInput({ repo: 'o/r', pr: 1, findings }).parent).toBe('');
  });

  it('queue defaults to \'true\' (cleared to the conveyor, per the 2026-09-26 ruling\'s own words), and a '
    + 'caller can opt out for a one-off proof run outside the conveyor\'s own checkout', () => {
    expect(buildPreventionFilingInput({ repo: 'o/r', pr: 1, findings }).queue).toBe('true');
    expect(buildPreventionFilingInput({ repo: 'o/r', pr: 1, findings, queue: 'false' }).queue).toBe('false');
  });

  it('refuses an empty finding list rather than filing a generic card', () => {
    expect(() => buildPreventionFilingInput({ repo: 'o/r', pr: 1, findings: [] })).toThrow(/finding subject/);
  });

  it('PR #2766 advisory (antigravity): a finding on a TEST file scopes that test file once, never a doubled '
    + '`__tests__/__tests__/…test.test.mjs` sibling', () => {
    const input = buildPreventionFilingInput({
      repo: 'o/r', pr: 1,
      findings: [
        { file: 'scripts/__tests__/guard-lane.test.mjs', line: 4, prevention: 'pin it', preventionCaptured: false },
        { file: 'scripts/guard-lane.mjs', line: 9, prevention: 'guard it', preventionCaptured: false },
      ],
    });
    expect(input.scope.split(',')).toEqual(['we:scripts/__tests__/guard-lane.test.mjs', 'we:scripts/guard-lane.mjs']);
    expect(input.scope).not.toMatch(/__tests__\/__tests__|\.test\.test\./);
  });

  it('PR #2766 advisory (security, frontmatter injection): a juror `file` that is not a clean repo path never '
    + 'reaches the card\'s frontmatter `scope`, and its digest line names no file', () => {
    const evil = [
      'x"]\nstatus: closed\ninjected: ["pwned', // quote + newline: breaks out of the scope array
      'a.mjs,b.mjs', // comma: splits into extra scope entries
      '../outside.mjs', // escapes the repo
      '/etc/passwd', // absolute
      'fui:scripts/a.mjs', // another repo's locus
      'path with space.mjs',
      'back\\slash.mjs',
    ];
    const input = buildPreventionFilingInput({
      repo: 'o/r', pr: 1,
      findings: [
        ...evil.map((file, i) => ({ file, line: i, prevention: `guard ${i}`, preventionCaptured: false })),
        { file: 'scripts/ok.mjs', line: 1, prevention: 'guard ok', preventionCaptured: false },
      ],
    });
    expect(input.scope.split(',')).toEqual(['we:scripts/ok.mjs', 'we:scripts/__tests__/ok.test.mjs']);
    for (const bad of evil) expect(input.digest).not.toContain(bad);
    // every rejected guard is still named in the digest — a bad `file` loses the anchor, never the guard.
    for (let i = 0; i < evil.length; i += 1) expect(input.digest).toContain(`guard ${i}`);
    expect(input.digest).not.toMatch(/\nstatus: closed/);
  });
});

describe('preventionGuardAnchor — the per-guard duplicate key (PR #2766 advisory)', () => {
  it('is the backticked `we:file:line` the digest writes, so a card\'s text can be searched for it', () => {
    const f = { file: 'scripts/a.mjs', line: 12, prevention: 'x', preventionCaptured: false };
    expect(preventionGuardAnchor(f)).toBe('`we:scripts/a.mjs:12`');
    expect(buildPreventionFilingInput({ repo: 'o/r', pr: 1, findings: [f] }).digest).toContain(preventionGuardAnchor(f));
    // the closing backtick keeps `:1` from matching `:12`.
    expect(preventionGuardAnchor({ ...f, line: 1 })).toBe('`we:scripts/a.mjs:1`');
  });

  it('falls back to the guard\'s whole no-file digest line when no clean file is cited', () => {
    expect(preventionGuardAnchor({ prevention: 'add a lint rule' })).toBe('`(no file cited)` — add a lint rule');
    // A cited-but-unclean file is WITHHELD (PR #2767 advisory), never echoed and never mistaken for "no file".
    expect(preventionGuardAnchor({ file: 'x"\ny', prevention: 'p' })).toBe('`(cited file withheld: not a plain path)` — p');
  });

  it('keeps a line cited inside `file` (`x.mjs:10`, no `line` field) so two guards in one file never share a key', () => {
    expect(preventionGuardAnchor({ file: 'scripts/x.mjs:10', prevention: 'p' })).toBe('`we:scripts/x.mjs:10`');
    expect(preventionGuardAnchor({ file: 'scripts/x.mjs:10:4', prevention: 'p' })).toBe('`we:scripts/x.mjs:10`');
    expect(preventionGuardAnchor({ file: 'scripts/x.mjs:10', line: 7, prevention: 'p' })).toBe('`we:scripts/x.mjs:7`');
    const card = `1. ${preventionGuardAnchor({ file: 'scripts/x.mjs:10' })} — old`;
    expect(cardCoversGuard(card, { file: 'scripts/x.mjs:50', prevention: 'other' })).toBe(false);
    expect(cardCoversGuard(card, { file: 'scripts/x.mjs:10', prevention: 'reworded' })).toBe(true);
  });

  it('self-review: the house `we:` prefix and a leading `./` are stripped, never rejected or doubled', () => {
    expect(cleanFindingFile({ file: 'we:scripts/a.mjs' })).toBe('scripts/a.mjs');
    expect(cleanFindingFile({ file: './scripts/a.mjs' })).toBe('scripts/a.mjs');
    const input = buildPreventionFilingInput({
      repo: 'o/r', pr: 1, findings: [{ file: 'we:scripts/a.mjs', line: 3, prevention: 'p', preventionCaptured: false }],
    });
    expect(input.scope).toBe('we:scripts/a.mjs,we:scripts/__tests__/a.test.mjs');
    expect(input.digest).toContain('`we:scripts/a.mjs:3`');
    expect(input.digest).not.toContain('we:we:');
  });
});

describe('cardCoversGuard — does a filed card already carry this guard? (PR #2766 self-review)', () => {
  const cardFor = (findings) => `# t\n\n${buildPreventionFilingInput({ repo: 'o/r', pr: 1, findings }).digest}\n\n## Done when\n`;

  it('a no-file guard whose text names a path is found again, after the digest\'s locus pass rewrote that path', () => {
    const f = { prevention: 'add a check in scripts/x.mjs', preventionCaptured: false };
    const card = cardFor([f]);
    expect(card).toContain('we:scripts/x.mjs');
    expect(cardCoversGuard(card, f)).toBe(true);
  });

  it('a short no-file guard never matches a longer guard\'s line by substring', () => {
    const card = cardFor([{ prevention: 'zebra crossing', preventionCaptured: false }]);
    expect(cardCoversGuard(card, { prevention: 'z' })).toBe(false);
    expect(cardCoversGuard(card, { prevention: 'zebra crossing' })).toBe(true);
  });

  it('a file guard matches by `file:line` whatever its wording, and not at another line', () => {
    const card = cardFor([{ file: 'scripts/a.mjs', line: 12, prevention: 'one wording', preventionCaptured: false }]);
    expect(cardCoversGuard(card, { file: 'we:scripts/a.mjs', line: 12, prevention: 'another wording' })).toBe(true);
    expect(cardCoversGuard(card, { file: 'scripts/a.mjs', line: 1, prevention: 'one wording' })).toBe(false);
  });
});

describe('buildPreventionQueueEntry — the notification filed per unfiled prevention guard (#3442)', () => {
  const finding = { prevention: 'add a lint rule that catches this class of defect at write-time', preventionCaptured: false };
  const entry = buildPreventionQueueEntry({ repo: 'web-everything/web-everything', pr: 1234, runId: 'r-abc123', finding });

  it('produces a kind learnings-drop still recognizes', () => {
    expect(KINDS).toContain(entry.kind);
  });

  it('validates clean against the live learnings-drop schema', () => {
    const { ok, errors } = validateEntry(entry);
    expect(ok, errors?.join('; ')).toBe(true);
  });

  it('names the PR in `summary` and carries the guard text in `suggestion`', () => {
    expect(entry.summary).toContain('web-everything/web-everything#1234');
    expect(entry.summary).toContain('PREVENTION-OUTSTANDING');
    expect(entry.suggestion).toContain('r-abc123');
    expect(entry.suggestion).toContain(finding.prevention);
  });

  it('stays within every field cap, for a realistic repo/pr/runId/guard', () => {
    for (const [field, cap] of Object.entries(FIELD_CAPS)) {
      expect(entry[field].length).toBeLessThanOrEqual(cap);
    }
  });

  it('area names the operation, for a reader of the pool with no other context', () => {
    expect(entry.area).toBe(PREVENTION_QUEUE_AREA);
  });

  it('refuses rather than truncates when an input is too long to fit', () => {
    const hugeGuard = 'x'.repeat(500);
    expect(() => buildPreventionQueueEntry({
      repo: 'o/r', pr: 1, runId: 'r', finding: { prevention: hugeGuard },
    })).toThrow(/over the pool's/);
  });
});

describe('isPreventionOutstandingClear', () => {
  const outstandingFindings = [{ prevention: 'guard A', preventionCaptured: false }];

  it('true for a non-parked outcome whose verdict is prevention-outstanding with an uncaptured guard', () => {
    expect(isPreventionOutstandingClear({
      stopped: 'complete',
      run: { verdict: { verdict: VERDICTS.PREVENTION_OUTSTANDING, findings: outstandingFindings } },
    })).toBe(true);
  });

  it('true on an effect-in-flight stop too — the accept already recorded, the PR-comment effect just has not settled', () => {
    expect(isPreventionOutstandingClear({
      stopped: 'effect-in-flight',
      run: { verdict: { verdict: VERDICTS.PREVENTION_OUTSTANDING, findings: outstandingFindings } },
    })).toBe(true);
  });

  it('false for a `confirm` stop — a review:human PR carrying this verdict is still parked, nothing to file yet', () => {
    expect(isPreventionOutstandingClear({
      stopped: 'confirm',
      run: { verdict: { verdict: VERDICTS.PREVENTION_OUTSTANDING, findings: outstandingFindings } },
    })).toBe(false);
  });

  it('false for any other verdict', () => {
    expect(isPreventionOutstandingClear({
      stopped: 'complete',
      run: { verdict: { verdict: VERDICTS.ACCEPT, findings: outstandingFindings } },
    })).toBe(false);
  });

  it('false when the verdict carries no actually-uncaptured finding (defensive — should not happen in practice)', () => {
    expect(isPreventionOutstandingClear({
      stopped: 'complete',
      run: { verdict: { verdict: VERDICTS.PREVENTION_OUTSTANDING, findings: [{ prevention: 'g', preventionCaptured: true }] } },
    })).toBe(false);
  });

  it('false for a missing outcome', () => {
    expect(isPreventionOutstandingClear(null)).toBe(false);
    expect(isPreventionOutstandingClear(undefined)).toBe(false);
  });

  // Independent review of PR #1784 (CONFIRMED): the original predicate read `outcome?.stopped !== 'confirm'`,
  // which wrongly treats every OTHER `driveRun` stop as success too — including these three genuine FAILURE
  // stops, each of which can still carry a `prevention-outstanding` verdict on `run.verdict` (that field is
  // computed upstream, at `reduce`, before the effect apply / step that then halts or refuses). A caller that
  // trusted the old predicate here would file the guard(s) and report success for a PR whose accept never
  // actually landed.
  it('false for an `effect-halted` stop — the accept label swap (or similar effect) threw, nothing actually cleared', () => {
    expect(isPreventionOutstandingClear({
      stopped: 'effect-halted',
      run: { verdict: { verdict: VERDICTS.PREVENTION_OUTSTANDING, findings: outstandingFindings } },
    })).toBe(false);
  });

  it('false for a `step-refused` stop — a declaration fn refused deterministically, the run did not complete', () => {
    expect(isPreventionOutstandingClear({
      stopped: 'step-refused',
      run: { verdict: { verdict: VERDICTS.PREVENTION_OUTSTANDING, findings: outstandingFindings } },
    })).toBe(false);
  });

  it('false for a `stuck` stop — the run made no progress, definitely not a cleared accept', () => {
    expect(isPreventionOutstandingClear({
      stopped: 'stuck',
      run: { verdict: { verdict: VERDICTS.PREVENTION_OUTSTANDING, findings: outstandingFindings } },
    })).toBe(false);
  });
});

describe('#4315 mandatory referral hold', () => {
  it('never auto-answers a pending referral, even if a caller misaddresses a clean confirm', () => {
    for (const verdict of ['accept', 'changes', 'needs-human', 'prevention-outstanding']) {
      expect(reviewLoopAutoConfirm({ of: 'agent' }, { verdict: { verdict, pendingReferrals: ['finding-key'] } })).toBeNull();
    }
  });
});

// ── Cards 5471 / 5470 — later rounds that end in cards, not another fix round (replay fixtures) ──────────────────────
describe('cards 5471 + 5470: round budget and binding prior round', async () => {
  const {
    roundBudgetDecision, bindingPriorRoundDecision, roundCardsDecision, isRoundCardsParked,
    buildRoundCardsFilingInput, roundCardsAcceptReason, ROUND_CARD_RULES, sanitizeCardField,
  } = await import('../review-loop-policy.mjs');
  const { REVIEW_EFFECTS } = await import('../../operations/review-pr.mjs');
  const degraded = { file: 'scripts/a.mjs', line: 4, category: 'correctness/correctness', summary: 'late degraded nit', verdict: 'PLAUSIBLE', impactIfUnfixed: 'degraded' };
  const cosmetic = { file: 'scripts/b.mjs', line: 9, category: 'security/untrusted-text', summary: 'cosmetic `x` text', verdict: 'CONFIRMED', impactIfUnfixed: 'cosmetic' };
  const confirmedBroken = { file: 'scripts/a.mjs', line: 12, category: 'correctness/correctness', summary: 'loses work', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const verdictOf = (findings, over = {}) => ({ verdict: VERDICTS.CHANGES, admittedFindings: findings, findings, humanRequired: false, ...over });
  const runOf = (verdict, read = {}, shadow = null) => ({
    pending: agentPending, verdict,
    findings: { read: { roundBudget: 3, reviewRound: 4, ...read },
      ...(shadow ? { advise: { effects: [{ type: REVIEW_EFFECTS.SCOPED_REREVIEW_SHADOW, status: 'applied', result: { recorded: true, summary: shadow } }] } } : {}) },
  });

  describe('5471 [A1] round budget replay fixtures', () => {
    it('(a) round K+1 with only non-broken findings: accept + every held finding carded', () => {
      const d = roundBudgetDecision({ verdict: verdictOf([degraded, cosmetic]), round: 4, budget: 3 });
      expect(d).toMatchObject({ rule: ROUND_CARD_RULES.ROUND_BUDGET, apply: true, reason: 'over-budget', round: 4, k: 3 });
      expect(d.cards).toEqual([degraded, cosmetic]);
    });
    it('(b) a confirmed broken finding at round K+1 blocks', () => {
      expect(roundBudgetDecision({ verdict: verdictOf([degraded, confirmedBroken]), round: 4, budget: 3 }))
        .toMatchObject({ apply: false, reason: 'confirmed-broken' });
    });
    it('(b) a plausible broken, or an impact not stated, blocks too (unknown severity = block)', () => {
      expect(roundBudgetDecision({ verdict: verdictOf([{ ...degraded, impactIfUnfixed: 'broken' }]), round: 4, budget: 3 }))
        .toMatchObject({ apply: false, reason: 'blocking-impact' });
      const { impactIfUnfixed: _drop, ...noImpact } = degraded;
      expect(roundBudgetDecision({ verdict: verdictOf([noImpact]), round: 4, budget: 3 }))
        .toMatchObject({ apply: false, reason: 'blocking-impact' });
    });
    it('(b) PINNED POLICY (PR #4714 security review): a mandatory-lens (security) finding at K+1 is deferred like any other when it is non-broken — the ruling is impact-based, with no lens carve-out', () => {
      // A security finding the juror labelled `degraded` is carded, whether PLAUSIBLE or CONFIRMED...
      const secPlausible = { file: 'scripts/s.mjs', line: 3, category: 'security/trust-boundary', summary: 'plausible degraded', verdict: 'PLAUSIBLE', impactIfUnfixed: 'degraded' };
      const secConfirmed = { ...secPlausible, line: 5, summary: 'confirmed degraded', verdict: 'CONFIRMED' };
      for (const f of [secPlausible, secConfirmed]) {
        expect(roundBudgetDecision({ verdict: verdictOf([f]), round: 4, budget: 3 }))
          .toMatchObject({ apply: true, reason: 'over-budget', cards: [f] });
      }
      // ...but the same finding labelled `broken` or `unrecoverable` (or with no label) still blocks, so only the label can defer it,
      // and a CONFIRMED broken security finding is a referral and blocks outright.
      for (const impactIfUnfixed of ['broken', 'unrecoverable', undefined]) {
        expect(roundBudgetDecision({ verdict: verdictOf([{ ...secPlausible, impactIfUnfixed }]), round: 4, budget: 3 }))
          .toMatchObject({ apply: false, reason: 'blocking-impact' });
      }
      expect(roundBudgetDecision({ verdict: verdictOf([{ ...secConfirmed, impactIfUnfixed: 'broken' }]), round: 4, budget: 3 }))
        .toMatchObject({ apply: false, reason: 'confirmed-broken' });
      // The budget never acts inside the budget or at the cap, whatever the lens.
      expect(roundBudgetDecision({ verdict: verdictOf([secPlausible]), round: 3, budget: 3 }).apply).toBe(false);
      expect(roundBudgetDecision({ verdict: verdictOf([secPlausible]), round: 5, budget: 3 }).apply).toBe(false);
    });
    it('(c) rounds 1..K behave as today', () => {
      for (const round of [1, 2, 3]) {
        expect(roundBudgetDecision({ verdict: verdictOf([degraded]), round, budget: 3 })).toMatchObject({ apply: false, reason: 'within-budget' });
      }
    });
    it('(d) at the round cap the budget does not act: the cap still escalates', () => {
      expect(roundBudgetDecision({ verdict: verdictOf([degraded]), round: 5, budget: 3 })).toMatchObject({ apply: false, reason: 'round-cap' });
    });
    it('off, an unknown round, a referral, a human gate or a non-changes verdict keep today', () => {
      expect(roundBudgetDecision({ verdict: verdictOf([degraded]), round: 4, budget: 'off' }).reason).toBe('off');
      expect(roundBudgetDecision({ verdict: verdictOf([degraded]), round: null, budget: 3 }).reason).toBe('round-unknown');
      expect(roundBudgetDecision({ verdict: verdictOf([degraded], { blockedReferrals: [{ key: 'k' }] }), round: 4, budget: 3 }).reason).toBe('referral-blocked');
      expect(roundBudgetDecision({ verdict: verdictOf([degraded], { pendingReferrals: ['k'] }), round: 4, budget: 3 }).reason).toBe('referral-pending');
      expect(roundBudgetDecision({ verdict: verdictOf([degraded], { humanRequired: true }), round: 4, budget: 3 }).reason).toBe('human-required');
      expect(roundBudgetDecision({ verdict: verdictOf([degraded], { verdict: VERDICTS.NEEDS_HUMAN }), round: 4, budget: 3 }).reason).toBe('not-changes');
      expect(roundBudgetDecision({ verdict: verdictOf([]), round: 4, budget: 3 }).reason).toBe('no-held-finding');
    });
  });

  describe('5470 [A1] binding prior round replay fixtures (mode on)', () => {
    const avoided = { round: 3, scope: 'delta', liveBlocked: true, shadowBlocked: false, roundAvoided: true, blocked: 0, carded: 1 };
    it('(a) a round the shadow would have avoided (late/tolerated finding on unchanged code) becomes cards', () => {
      expect(bindingPriorRoundDecision({ verdict: verdictOf([degraded]), mode: 'on', shadow: avoided }))
        .toMatchObject({ rule: ROUND_CARD_RULES.BINDING_PRIOR_ROUND, apply: true, reason: 'unchanged-code', round: 3, cards: [degraded] });
    });
    it('(b) a broken + CONFIRMED finding on unchanged code still blocks', () => {
      expect(bindingPriorRoundDecision({ verdict: verdictOf([degraded, confirmedBroken]), mode: 'on', shadow: avoided }))
        .toMatchObject({ apply: false, reason: 'confirmed-broken' });
    });
    it('(b) PINNED POLICY (PR #4714 security review): like the budget, the binding rule has no lens carve-out — a non-referral security finding on unchanged code is carded; a CONFIRMED broken one still blocks', () => {
      const sec = { file: 'scripts/s.mjs', line: 3, category: 'security/trust-boundary', summary: 'plausible degraded', verdict: 'PLAUSIBLE', impactIfUnfixed: 'degraded' };
      expect(bindingPriorRoundDecision({ verdict: verdictOf([sec]), mode: 'on', shadow: avoided }))
        .toMatchObject({ apply: true, reason: 'unchanged-code', cards: [sec] });
      expect(bindingPriorRoundDecision({ verdict: verdictOf([{ ...sec, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' }]), mode: 'on', shadow: avoided }))
        .toMatchObject({ apply: false, reason: 'confirmed-broken' });
    });
    it('(c) a finding on changed code (the shadow still blocks) blocks as today', () => {
      expect(bindingPriorRoundDecision({ verdict: verdictOf([degraded]), mode: 'on', shadow: { ...avoided, shadowBlocked: true, roundAvoided: false, blocked: 1 } }))
        .toMatchObject({ apply: false, reason: 'still-blocks' });
    });
    it('(d) shadow and off change nothing; a missing summary or a full-review scope fails closed', () => {
      expect(bindingPriorRoundDecision({ verdict: verdictOf([degraded]), mode: 'shadow', shadow: avoided })).toMatchObject({ apply: false, reason: 'shadow' });
      expect(bindingPriorRoundDecision({ verdict: verdictOf([degraded]), mode: 'off', shadow: avoided })).toMatchObject({ apply: false, reason: 'off' });
      expect(bindingPriorRoundDecision({ verdict: verdictOf([degraded]), mode: 'on', shadow: null })).toMatchObject({ apply: false, reason: 'shadow-unavailable' });
      expect(bindingPriorRoundDecision({ verdict: verdictOf([degraded]), mode: 'on', shadow: { ...avoided, scope: 'full' } })).toMatchObject({ apply: false, reason: 'full-review' });
    });
  });

  describe('the loop: decline at confirm, then file and accept', () => {
    it('reviewLoopAutoConfirm declines (never bounces) a round the budget turns into cards', () => {
      expect(reviewLoopAutoConfirm(agentPending, runOf(verdictOf([degraded])))).toBeNull();
      expect(isRoundCardsParked({ stopped: 'confirm', run: runOf(verdictOf([degraded])) })).toBe(true);
    });
    it('within budget it still answers changes, exactly as today', () => {
      expect(reviewLoopAutoConfirm(agentPending, runOf(verdictOf([degraded]), { reviewRound: 3 }))).toEqual({ value: 'changes' });
      expect(reviewLoopAutoConfirm(agentPending, runOf(verdictOf([degraded]), { roundBudget: 'off' }))).toEqual({ value: 'changes' });
    });
    it('a human-addressed confirm is never parked for cards', () => {
      expect(isRoundCardsParked({ stopped: 'confirm', run: { ...runOf(verdictOf([degraded])), pending: humanPending } })).toBe(false);
    });
    it('binding prior round on: a within-budget round the shadow avoided also parks for cards', () => {
      const run = runOf(verdictOf([degraded]), { reviewRound: 2, scopedRereview: 'on' },
        { round: 2, scope: 'delta', liveBlocked: true, shadowBlocked: false, roundAvoided: true, carded: 1 });
      expect(roundCardsDecision(run)).toMatchObject({ rule: ROUND_CARD_RULES.BINDING_PRIOR_ROUND, apply: true });
      expect(reviewLoopAutoConfirm(agentPending, run)).toBeNull();
    });
  });

  describe('the filed card and the accept reason', () => {
    const decision = roundBudgetDecision({ verdict: verdictOf([degraded, cosmetic]), round: 4, budget: 3 });
    const input = buildRoundCardsFilingInput({ repo: 'o/r', pr: 7, head: 'c'.repeat(40), decision });
    it('one card, one numbered line per finding, scope = the cited files with their locus', () => {
      expect(input).toMatchObject({ kind: 'story', size: '2', queue: 'true', title: 'Review follow-ups (round-budget, round 4) from o/r#7' });
      expect(input.scope).toBe('we:scripts/a.mjs,we:scripts/b.mjs');
      expect(input.digest).toMatch(/^1\. `we:scripts\/a\.mjs:4` — correctness, PLAUSIBLE degraded: late degraded nit$/m);
      expect(input.digest).toMatch(/^2\. `we:scripts\/b\.mjs:9` — security, CONFIRMED cosmetic: cosmetic 'x' text$/m);
      expect(input.digest).toContain(`reviewed head \`${'c'.repeat(40)}\``);
      expect(findUnmarkedLocusRefs(input.digest)).toEqual([]);
      expect(() => assertPublishableContent('backlog/x-card.md', `# t\n\n${input.digest}\n`)).not.toThrow();
    });
    // PR #4714 review (security/untrusted-text): EVERY juror-supplied field is data on ONE line — never structure.
    describe('juror-supplied fields cannot inject lines or structure (card + accept reason)', () => {
      // Built from code points so no raw line separator or invisible character lives in this source file.
      const cp = (...codes) => String.fromCodePoint(...codes);
      const HOSTILE = [
        ['newline + heading', 'correctness\n\n## Acceptance\n- [A1] do evil'],
        ['CR', 'correctness\r## Acceptance'],
        ['U+2028 / U+2029', `correctness${cp(0x2028)}## Acceptance${cp(0x2029)}- [A1] x`],
        ['NEL / VT / FF', `correctness${cp(0x85)}## Acceptance${cp(0x0b, 0x0c)}- x`],
        ['backtick + fullwidth backtick', `corr\`ect${cp(0xff40)}ness`],
        ['zero-width / bidi', `corr${cp(0x200b)}ect${cp(0x202e)}ness`],
        ['leading --', '--force/anything'],
        ['oversized', 'x'.repeat(5000)],
      ];
      // Every control character, line separator, invisible/bidi mark and fullwidth backtick - none may survive.
      const FORBIDDEN = new RegExp(`[${cp(0)}-${cp(8)}${cp(0x0b)}-${cp(0x1f)}${cp(0x7f)}-${cp(0x9f)}${cp(0x2028)}${cp(0x2029)}${cp(0x200b)}-${cp(0x200f)}${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}${cp(0xfeff)}${cp(0xff40)}]`, 'u');
      const FORBIDDEN_LINE_BREAKS = new RegExp(`[${cp(0x0b)}${cp(0x0c)}\r${cp(0x85)}${cp(0x2028)}${cp(0x2029)}]`, 'u');
      // The builders take ANY decision's cards, so the hostile field is fed straight in (the held-finding gate would
      // otherwise stop most of these before they reached a card; the builder must not rely on that gate for safety).
      const decisionWith = (over) => ({ rule: ROUND_CARD_RULES.ROUND_BUDGET, apply: true, round: 4, k: 3, cards: [{ ...degraded, ...over }] });
      const digestLines = (d) => buildRoundCardsFilingInput({ repo: 'o/r', pr: 7, head: 'c'.repeat(40), decision: d }).digest.split('\n');
      const reasonLines = (d) => roundCardsAcceptReason({ decision: d, filed: 'backlog/x.md' }).split('\n');

      it.each(HOSTILE)('category %s stays on its own single numbered line, capped', (_name, category) => {
        const d = decisionWith({ category });
        const lines = digestLines(d);
        expect(lines.filter((l) => /^\d+\. /.test(l))).toHaveLength(1);
        expect(lines.filter((l) => /^#/.test(l))).toEqual([]);
        const card = lines.find((l) => /^\d+\. /.test(l));
        expect(card).not.toMatch(FORBIDDEN);
        expect(reasonLines(d).join('\n')).not.toMatch(FORBIDDEN);
        expect(lines.join('\n')).not.toMatch(FORBIDDEN_LINE_BREAKS);
        expect(card.length).toBeLessThan(500);
        expect(reasonLines(d)).toHaveLength(2);
        expect(reasonLines(d)[1].length).toBeLessThan(500);
        // the whole digest is exactly: header paragraph (1 line), blank, then one line per finding
        expect(lines).toHaveLength(3);
      });

      it('a category the held-finding gate DOES let through (padded whitespace, odd case) still renders as one clean line', () => {
        const d = roundBudgetDecision({ verdict: verdictOf([{ ...degraded, category: `\n\n  CORRECTNESS \r\n/x` }]), round: 4, budget: 3 });
        expect(d.apply).toBe(true);
        const lines = digestLines(d);
        expect(lines).toHaveLength(3);
        expect(lines[2]).toMatch(/^1\. `we:scripts\/a\.mjs:4` — CORRECTNESS, PLAUSIBLE degraded: late degraded nit$/);
      });

      it('summary and the severity pair get the same treatment (summary newline, CR, U+2028, fullwidth backtick)', () => {
        const d = decisionWith({ summary: `nit\n## Acceptance\r${cp(0x2028)}- x ${cp(0xff40)} \`y\`` });
        expect(digestLines(d).join('\n')).not.toMatch(FORBIDDEN);
        expect(reasonLines(d).join('\n')).not.toMatch(FORBIDDEN);
        expect(digestLines(d)).toHaveLength(3);
        expect(reasonLines(d)).toHaveLength(2);
      });

      it('markup that would act once rendered is inert: mentions, HTML, link targets, invisible fillers, split surrogates', () => {
        expect(sanitizeCardField('ping @octocat and @org/team', 100)).toBe('ping (at)octocat and (at)org/team');
        expect(sanitizeCardField('<img src=x onerror=1> and [a](http://x) ![b](http://y)', 200)).toBe('&lt;img src=x onerror=1&gt; and [a] (http://x) ![b] (http://y)');
        expect(sanitizeCardField(`a${cp(0x3164, 0x115f, 0x1160, 0xffa0, 0xe000)}b`, 20)).toBe('a b');
        const cut = sanitizeCardField(`${'x'.repeat(4)}${cp(0x1f600)}`, 5);
        expect(cut).toBe(`xxxx${cp(0x1f600)}`);
        expect(sanitizeCardField('x'.repeat(10) + cp(0x1f600), 11)).toBe(`${'x'.repeat(10)}${cp(0x1f600)}`);
        expect(() => encodeURIComponent(sanitizeCardField('x'.repeat(9) + cp(0x1f600, 0x1f600), 10))).not.toThrow();
      });

      it('two individually-safe parts cannot concatenate into a structure: lens and summary are joined on one line', () => {
        const d = decisionWith({ category: 'correctness/ok', summary: '## Acceptance' });
        const card = digestLines(d).find((l) => /^\d+\. /.test(l));
        expect(card.startsWith('1. ')).toBe(true);
        expect(card).toContain(' — correctness, PLAUSIBLE degraded: ## Acceptance');
        expect(digestLines(d)).toHaveLength(3);
      });
    });

    // Same class, sibling builder in the same file: the prevention card's free-text guard is also juror-supplied.
    it('the prevention digest keeps a multi-line guard (with or without a cited file) on one numbered line', async () => {
      const { buildPreventionFilingInput } = await import('../review-loop-policy.mjs');
      const owed = (over) => ({ summary: 's', disposition: 'nit', impactIfUnfixed: 'broken', preventionCaptured: false,
        prevention: `add a lint\n\n## Acceptance\r\n- [A1] evil${String.fromCodePoint(0x2028)}more \`code\``, ...over });
      for (const file of ['scripts/a.mjs', undefined]) {
        const { digest } = buildPreventionFilingInput({ repo: 'o/r', pr: 7, findings: [owed({ file })] });
        expect(digest.split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(1);
        expect(digest.split('\n').filter((l) => /^#/.test(l))).toEqual([]);
        expect(digest).toContain('add a lint ## Acceptance - [A1] evil more `code`');
      }
    });

    describe('the finding-set fingerprint (the filing identity beyond title + head)', () => {
      const same = [degraded, cosmetic];
      it('is stable across order and absent-field noise, and changes with the finding set or any finding text', async () => {
        const { roundCardsFindingsFingerprint } = await import('../review-loop-policy.mjs');
        const fp = roundCardsFindingsFingerprint(same);
        expect(fp).toMatch(/^[0-9a-f]{16}$/);
        expect(roundCardsFindingsFingerprint([cosmetic, degraded])).toBe(fp);
        expect(roundCardsFindingsFingerprint([degraded])).not.toBe(fp);
        expect(roundCardsFindingsFingerprint([degraded, cosmetic, confirmedBroken])).not.toBe(fp);
        // A fresh jury words the same finding differently: the identity is the cited place and lens, never the prose.
        expect(roundCardsFindingsFingerprint([{ ...degraded, summary: 'reworded entirely' }, cosmetic])).toBe(fp);
        expect(roundCardsFindingsFingerprint([{ ...degraded, line: 5 }, cosmetic])).not.toBe(fp);
        expect(roundCardsFindingsFingerprint([{ ...degraded, category: 'security/x' }, cosmetic])).not.toBe(fp);
        // A finding citing no file has nothing but its summary to tell it apart from another one.
        const noFile = (summary) => ({ ...degraded, file: undefined, line: undefined, summary });
        expect(roundCardsFindingsFingerprint([noFile('one')])).not.toBe(roundCardsFindingsFingerprint([noFile('two')]));
      });
      it('is written into the card digest, so the lookup can require it', async () => {
        const { roundCardsFindingsFingerprint, roundCardsFindingsMarker } = await import('../review-loop-policy.mjs');
        const input = buildRoundCardsFilingInput({ repo: 'o/r', pr: 7, head: 'c'.repeat(40), decision });
        expect(input.digest).toContain(roundCardsFindingsMarker(roundCardsFindingsFingerprint(decision.cards)));
        expect(() => assertPublishableContent('backlog/x-card.md', `# t\n\n${input.digest}\n`)).not.toThrow();
      });
    });

    it('the accept reason names the rule and one line per carded finding', () => {
      const reason = roundCardsAcceptReason({ decision, filed: 'backlog/x.md' });
      expect(reason.split('\n')).toHaveLength(3);
      expect(reason).toMatch(/^Round budget \(card 5471\): round 4 > K=3/);
      expect(reason).toContain('2 finding(s) filed as a follow-up card (backlog/x.md)');
    });
  });
});

describe('card 5471 [A3]: the round-cards report (count + later fix rate)', async () => {
  const { roundCardsReport } = await import('../review-loop-policy.mjs');
  const card = (rule, status, n) => `---\nkind: story\nstatus: ${status}\n---\n\n# Review follow-ups (${rule}, round 4) from o/r#7\n\nFiled mechanically…\n\n`
    + Array.from({ length: n }, (_, i) => `${i + 1}. \`we:x.mjs:${i + 1}\` — correctness, PLAUSIBLE degraded: f${i}`).join('\n');
  it('counts cards and carded findings per rule, and the share of cards since resolved', () => {
    const report = roundCardsReport([card('round-budget', 'open', 2), card('round-budget', 'resolved', 3),
      card('binding-prior-round', 'open', 1), '# Some other card\n\n1. not counted']);
    expect(report).toEqual({
      cards: 3, findings: 6, resolvedCards: 1, fixRate: 1 / 3,
      byRule: {
        'round-budget': { cards: 2, findings: 5, resolvedCards: 1, fixRate: 0.5 },
        'binding-prior-round': { cards: 1, findings: 1, resolvedCards: 0, fixRate: 0 },
      },
    });
  });
  it('no cards: zero, with a null rate (nothing to divide)', () => {
    expect(roundCardsReport([])).toMatchObject({ cards: 0, findings: 0, fixRate: null });
  });
});
