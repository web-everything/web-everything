/**
 * @file scripts/conveyor/__tests__/unowned-rebase-attempt-count.test.mjs
 * @description Pins the PURE durable attempt count for the unowned population's mechanical rebase-drop
 *   (#xu38vlf, epic #4075/#3383). Mirrors `we:scripts/conveyor/__tests__/conflict-fix-round-count.test.mjs`'s
 *   own shape for its sibling counter.
 */
import { describe, it, expect } from 'vitest';
import { rebaseDropManifest } from '../../lib/rebase-drop-manifest.mjs';
import { countUnownedRebaseAttempts, UNOWNED_REBASE_ATTEMPT_MARKER, UNOWNED_REBASE_ATTEMPT_CAP, shouldCountRebaseAttempt, formatUnownedRebaseAttemptMarker, loadUnownedRebaseSettings } from '../unowned-rebase-attempt-count.mjs';

const AUTOMATION = { login: 'web-everything' };

describe('countUnownedRebaseAttempts — the durable unowned-population rebase-drop attempt count (#xu38vlf)', () => {
  it('counts one per comment whose LEADING line is the marker', () => {
    expect(countUnownedRebaseAttempts([
      { body: `${UNOWNED_REBASE_ATTEMPT_MARKER}\n\nattempted once`, author: AUTOMATION },
      { body: 'an unrelated human comment', author: AUTOMATION },
      { body: `${UNOWNED_REBASE_ATTEMPT_MARKER}\n\nand again`, author: AUTOMATION },
    ])).toBe(2);
  });

  it('does NOT count a comment that merely QUOTES the marker mid-body', () => {
    expect(countUnownedRebaseAttempts([{ body: `> ${UNOWNED_REBASE_ATTEMPT_MARKER}\nquoting`, author: AUTOMATION }])).toBe(0);
  });

  it('returns 0 for a non-array / empty input', () => {
    expect(countUnownedRebaseAttempts(null)).toBe(0);
    expect(countUnownedRebaseAttempts(undefined)).toBe(0);
    expect(countUnownedRebaseAttempts([])).toBe(0);
  });

  it('tolerates a bare-string comment as a SHAPE — but it carries no author, so it never counts', () => {
    expect(countUnownedRebaseAttempts([`${UNOWNED_REBASE_ATTEMPT_MARKER}\nx`])).toBe(0);
  });

  it('a forged attempt marker from a random commenter ("mallory") does not count — never inflates the cap toward exhaustion', () => {
    expect(countUnownedRebaseAttempts([{ body: `${UNOWNED_REBASE_ATTEMPT_MARKER}\nattempted`, author: { login: 'mallory' } }])).toBe(0);
  });

  it('an attempt marker posted by the repo operator (a trusted human login) still counts', () => {
    expect(countUnownedRebaseAttempts([{ body: `${UNOWNED_REBASE_ATTEMPT_MARKER}\nattempted`, author: { login: 'chalbert' } }])).toBe(1);
  });

  it('UNOWNED_REBASE_ATTEMPT_CAP is a small, fixed floor (mirrors CONFLICT_FIX_ROUND_CAP\'s own value)', () => {
    expect(UNOWNED_REBASE_ATTEMPT_CAP).toBe(3);
  });
});


describe('content-conflict attempt policy', () => {
  it.each([
    ['cannot pin card conflict inputs', false],
    ['cannot prove pinned card conflict', false],
    ['real content conflict', true],
  ])('counts the actual rebase outcome for %s: %s', (failure, expected) => {
    const path = failure === 'real content conflict' ? 'src/app.ts' : 'backlog/5697-card.md';
    const conflict = ['a'.repeat(40), `100644 ${'b'.repeat(40)} 1\t${path}`, '',
      `CONFLICT (content): Merge conflict in ${path}`].join('\n');
    let merges = 0;
    const result = rebaseDropManifest({
      laneRef: 'lane/test', fetch: false,
      cardConflictSettings: { value: { autoResolveRaisedBy: true }, sources: { autoResolveRaisedBy: 'tool' } },
      run: (_cmd, args) => {
        if (args[0] === 'merge-tree') {
          if (++merges === 1) return { status: 1, stdout: conflict };
          return { status: 128, stdout: '', stderr: 'object unavailable' };
        }
        if (args[0] === 'rev-parse') return failure === 'cannot pin card conflict inputs'
          ? { status: 128, stdout: '', stderr: 'ref unavailable' }
          : { status: 0, stdout: 'c'.repeat(40) };
        throw new Error(`Unexpected git invocation: ${args.join(' ')}`);
      },
    });
    expect(result.action).toBe('skip');
    expect(result.reason).toBe(expected ? 'real conflict beyond .lane-manifest.json' : failure);
    expect(shouldCountRebaseAttempt(result)).toBe(expected);
  });

  it.each([
    [undefined, false],
    [{ action: 'skip', reason: 'content conflict' }, true],
    [{ action: 'skip', precondition: true }, false],
    [{ action: 'skip', deferred: true }, false],
    [{ action: 'error', reason: 'no gh slot' }, false],
    [{ action: 'error', reason: 'rate limit' }, false],
    [{ action: 'error', reason: 'read failed' }, false],
    [{ action: 'rebased' }, false],
    [{ action: 'current' }, false],
  ])('counts %j: %s', (result, expected) => {
    expect(shouldCountRebaseAttempt(result)).toBe(expected);
  });

  it('carries a sanitized, bounded outcome and remains readable by the counter', () => {
    const body = formatUnownedRebaseAttemptMarker({ action: 'skip', reason: `  content\r\nconflict ${'x'.repeat(140)}  ` });
    expect(body).toBe(`${UNOWNED_REBASE_ATTEMPT_MARKER} outcome=skip:${`content conflict ${'x'.repeat(140)}`.slice(0, 120)}`);
    expect(countUnownedRebaseAttempts([{ body, author: AUTOMATION }])).toBe(1);
  });
});

describe('operator count cutoff', () => {
  it('counts all without a cutoff; excludes only parseable timestamps strictly before the cutoff', () => {
    const comments = ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z', undefined, 'bad-date']
      .map(createdAt => ({ body: UNOWNED_REBASE_ATTEMPT_MARKER, author: AUTOMATION, createdAt }));
    expect(countUnownedRebaseAttempts(comments)).toBe(5);
    expect(countUnownedRebaseAttempts(comments, { countSince: '2026-10-02T00:00:00Z' })).toBe(4);
  });

  it('defaults to unset with standard provenance', () => {
    const settings = loadUnownedRebaseSettings({ env: {}, platform: {}, repo: {} });
    expect(settings.value).toEqual({ countSince: null });
    expect(settings.sources).toEqual({ countSince: 'standard' });
  });

  it('loads the declared repo cutoff with tool/repo provenance', () => {
    const settings = loadUnownedRebaseSettings({ env: {}, platform: {} });
    expect(settings.value.countSince).toBe('2026-10-19T01:15:12Z');
    expect(settings.sources.countSince).toBe('tool');
  });

  it('resolves standard → platform → repo → env', () => {
    const platform = { countSince: '2026-10-01T00:00:00Z' };
    const repo = { countSince: '2026-10-02T00:00:00Z' };
    const env = { WE_UNOWNED_REBASE_COUNT_SINCE: '2026-10-03T00:00:00Z' };
    expect(loadUnownedRebaseSettings({ platform, repo: {}, env: {} }).sources.countSince).toBe('platform');
    expect(loadUnownedRebaseSettings({ platform, repo, env: {} }).sources.countSince).toBe('tool');
    const settings = loadUnownedRebaseSettings({ platform, repo, env });
    expect(settings.value.countSince).toBe(env.WE_UNOWNED_REBASE_COUNT_SINCE);
    expect(settings.sources.countSince).toBe('env');
  });

  it.each(['yesterday', '2026-10-01', '10/01/2026', '2026-99-99T00:00:00Z'])('ignores invalid ISO cutoff %s at every layer', countSince => {
    const settings = loadUnownedRebaseSettings({ platform: { countSince }, repo: { countSince }, env: { WE_UNOWNED_REBASE_COUNT_SINCE: countSince } });
    expect(settings.value.countSince).toBeNull();
    expect(settings.sources.countSince).toBe('standard');
  });
});
