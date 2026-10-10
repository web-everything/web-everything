/**
 * @file review-label-provider.test.mjs — the forge port (#x8xf5rl).
 *
 * TWO DIFFERENT PROPERTIES, and conflating them is how a refactor of a merge-safety path goes wrong:
 *
 *   1. THE ADAPTER IS FAITHFUL — the argv `gh` receives is byte-identical to what `review-set-label.mjs`
 *      executed inline before the port existed. Asserted here, against literals, so a "tidy-up" of the argv
 *      builder cannot silently change the command that runs against a live PR.
 *   2. THE CALLER'S ORDERING IS RIGHT — pinned in `we:scripts/__tests__/review-set-label.test.mjs` against a
 *      stub provider, because that is a property of the caller, not of `gh`.
 *
 * `writeOrder` is tested here rather than there because it is pure and belongs with the port it ships beside;
 * the CALLER's use of it is what the other file asserts.
 */

import { describe, it, expect } from 'vitest';
import { GH_ARGV, PR_COMMENTS_PAGE_SIZE, PR_STATE_FIELDS, createGhProvider, writeOrder, clampLabelDescription, GITHUB_LABEL_DESCRIPTION_MAX } from '../review-label-provider.mjs';

describe('clampLabelDescription', () => {
  it('exports the GitHub limit and preserves strings up to that limit', () => {
    expect(GITHUB_LABEL_DESCRIPTION_MAX).toBe(100);
    for (const value of ['', 'short description ', 'x'.repeat(100)]) {
      expect(clampLabelDescription(value)).toBe(value);
    }
  });

  it('returns an empty string for non-strings', () => {
    for (const value of [undefined, null, 42, true, {}, []]) {
      expect(clampLabelDescription(value)).toBe('');
    }
  });

  it('trims trailing whitespace from the cut before appending an ellipsis', () => {
    expect(clampLabelDescription('x'.repeat(97) + ' \tmore')).toBe('x'.repeat(97) + '…');
    expect(clampLabelDescription('x'.repeat(101))).toBe('x'.repeat(99) + '…');
  });
});

describe('GH_ARGV is byte-identical to the pre-port inline calls', () => {
  it('reads PR state in ONE call, with every field the label arc needs', () => {
    // The field list grows only when a field RIDES THIS CALL rather than costing a hop — `body` (#2844),
    // `state` (#2953), `createdAt` (#3067), `comments` (#x9krtkb). This assertion is what makes each addition
    // deliberate: it fails on any change, so a field cannot appear here without someone deciding it should.
    expect(GH_ARGV.readPrState('o/n', 7)).toEqual([
      'pr', 'view', '7', '--repo', 'o/n', '--json', 'labels,headRefOid,headRefName,baseRefName,state,body,createdAt,title,comments,isDraft',
    ]);
  });

  it('re-reads labels with the narrow query the post-swap readback used', () => {
    expect(GH_ARGV.readLabels('o/n', 7)).toEqual(['pr', 'view', '7', '--repo', 'o/n', '--json', 'labels']);
  });

  it('swaps labels with one --add-label and one --remove-label PER removal', () => {
    expect(GH_ARGV.setLabels('o/n', 7, { add: 'review:accepted', remove: ['review:pending', 'checking'] }))
      .toEqual([
        'pr', 'edit', '7', '--repo', 'o/n', '--add-label', 'review:accepted',
        '--remove-label', 'review:pending', '--remove-label', 'checking',
      ]);
  });

  it('omits --remove-label entirely when there is nothing to remove', () => {
    expect(GH_ARGV.setLabels('o/n', 7, { add: 'review:accepted' }))
      .toEqual(['pr', 'edit', '7', '--repo', 'o/n', '--add-label', 'review:accepted']);
  });

  it('omits --add-label entirely for a remove-only call (no `add` supplied)', () => {
    expect(GH_ARGV.setLabels('o/n', 7, { remove: ['review-status:reviewing'] }))
      .toEqual(['pr', 'edit', '7', '--repo', 'o/n', '--remove-label', 'review-status:reviewing']);
  });

  // --body-file, never --body: the verdict body carries newlines and emoji.
  it('posts the comment by FILE', () => {
    expect(GH_ARGV.postComment('o/n', 7, '/tmp/x.md'))
      .toEqual(['pr', 'comment', '7', '--repo', 'o/n', '--body-file', '/tmp/x.md']);
  });

  it('names the state fields once, so a stub cannot drift from the real read', () => {
    expect(PR_STATE_FIELDS).toEqual(['labels', 'headRefOid', 'headRefName', 'baseRefName', 'state', 'body', 'createdAt', 'title', 'comments', 'isDraft']);
  });

  it('creates a label with --force — create-or-update, never an error on one that already exists', () => {
    expect(GH_ARGV.ensureLabel('o/n', 'review-round:3'))
      .toEqual(['label', 'create', 'review-round:3', '--repo', 'o/n', '--color', 'ededed', '--description', '', '--force']);
  });

  it('ensureLabel accepts an optional color/description override', () => {
    expect(GH_ARGV.ensureLabel('o/n', 'review-status:reviewing', { color: 'c5def5', description: 'a reviewer is actively working this PR' }))
      .toEqual(['label', 'create', 'review-status:reviewing', '--repo', 'o/n', '--color', 'c5def5', '--description', 'a reviewer is actively working this PR', '--force']);
  });

  it('clamps the ruling-needed description to GitHub’s limit', () => {
    const description = 'AI review parked with confirmed findings that need an operator ruling on the current head (auto-managed)';
    const argv = GH_ARGV.ensureLabel('o/n', 'advisory:ruling-needed', { description });
    const value = argv[argv.indexOf('--description') + 1];
    expect(value.length).toBeLessThanOrEqual(100);
    expect(value.endsWith('…')).toBe(true);
    expect(value).toBe(description.slice(0, 99) + '…');
  });
});

describe('the gh adapter', () => {
  it('parses the PR state it is handed back', () => {
    const p = createGhProvider({ exec: () => JSON.stringify({ labels: [{ name: 'review:pending' }], state: 'OPEN' }) });
    expect(p.readPrState('o/n', 7).labels).toEqual([{ name: 'review:pending' }]);
  });

  it('returns [] rather than undefined when a PR carries no labels', () => {
    const p = createGhProvider({ exec: () => JSON.stringify({}) });
    expect(p.readLabels('o/n', 7)).toEqual([]);
  });

  it('writes the comment body to a file, passes THAT file, and removes it after', () => {
    const wrote = [];
    const removed = [];
    let seenArgv = null;
    const p = createGhProvider({
      exec: (argv) => { seenArgv = argv; return ''; },
      writeFile: (path, body) => wrote.push({ path, body }),
      removeFile: (path) => removed.push(path),
      tmpDir: '/tmpdir',
    });
    p.postComment('o/n', 7, '# hello\n\nwith newlines 🎉');
    expect(wrote[0].body).toBe('# hello\n\nwith newlines 🎉');
    expect(seenArgv[seenArgv.indexOf('--body-file') + 1]).toBe(wrote[0].path);
    expect(removed).toEqual([wrote[0].path]);
  });

  // A failed post must not leave the body behind — it can be large, and it is the adapter's litter.
  it('still removes the temp file when the post THROWS', () => {
    const removed = [];
    const p = createGhProvider({
      exec: () => { throw new Error('gh pr comment failed'); },
      writeFile: () => {}, removeFile: (path) => removed.push(path), tmpDir: '/tmpdir',
    });
    expect(() => p.postComment('o/n', 7, 'x')).toThrow(/gh pr comment failed/);
    expect(removed).toHaveLength(1);
  });

  it('trims the repo slug it derives for a caller that omitted --repo', () => {
    const p = createGhProvider({ exec: () => 'web-everything/web-everything\n' });
    expect(p.currentRepo()).toBe('web-everything/web-everything');
  });

  it('ensureLabel shells the exact argv GH_ARGV builds', () => {
    let seenArgv = null;
    const p = createGhProvider({ exec: (argv) => { seenArgv = argv; return ''; } });
    p.ensureLabel('o/n', 'review-round:3');
    expect(seenArgv).toEqual(GH_ARGV.ensureLabel('o/n', 'review-round:3'));
  });

  it('readPrFiles shells --method GET (load-bearing: an -F param silently flips gh to POST, which pulls/files 404s on)', () => {
    expect(GH_ARGV.readPrFiles('o/n', 2223)).toEqual([
      'api', '--paginate', '--method', 'GET', '-F', 'per_page=100', 'repos/o/n/pulls/2223/files', '--jq', '.[].filename',
    ]);
  });

  it('readPrFiles splits gh\'s newline-joined jq output into a trimmed array', () => {
    const p = createGhProvider({ exec: () => 'scripts/a.mjs\nscripts/b.mjs\n' });
    expect(p.readPrFiles('o/n', 2223)).toEqual(['scripts/a.mjs', 'scripts/b.mjs']);
  });

  it('readPrFiles returns an empty array, never throws, on blank output', () => {
    const p = createGhProvider({ exec: () => '' });
    expect(p.readPrFiles('o/n', 2223)).toEqual([]);
  });

  // PR #4631 (operator ruling a): no label-timeline reader exists — a hold's origin is its LABEL, never its history.
  it('there is no label-timeline reader (the carry never infers a hold\'s origin from events)', () => {
    expect(GH_ARGV.readHoldLabelEvents).toBeUndefined();
    expect(createGhProvider({ exec: () => '' }).readHoldLabelEvents).toBeUndefined();
  });

  it('readPrReviews pages the dedicated reviews endpoint with --method GET and parses one JSON review per line (PR #4631 round 3)', () => {
    const argv = GH_ARGV.readPrReviews('o/n', 9);
    expect(argv.slice(0, 7)).toEqual(['api', '--paginate', '--method', 'GET', '-F', 'per_page=100', 'repos/o/n/pulls/9/reviews']);
    const line = '{"state":"CHANGES_REQUESTED","submitted_at":"2026-10-09T16:00:00Z","user":{"login":"x"}}';
    expect(createGhProvider({ exec: () => `${line}\n${line}\n` }).readPrReviews('o/n', 9)).toHaveLength(2);
    expect(createGhProvider({ exec: () => '' }).readPrReviews('o/n', 9)).toEqual([]);
  });

  it('readComments pages the issue-comments endpoint and returns the gh-view shape (author.login / body / createdAt)', () => {
    const argv = GH_ARGV.readComments('o/n', 9);
    expect(argv.slice(0, 7)).toEqual(['api', '--paginate', '--method', 'GET', '-F', 'per_page=100', 'repos/o/n/issues/9/comments']);
    expect(argv.join(' ')).toContain('createdAt: .created_at');
    const line = '{"author":{"login":"x"},"body":"b","createdAt":"2026-10-09T16:00:00Z"}';
    expect(createGhProvider({ exec: () => `${line}\n${line}\n${line}\n` }).readComments('o/n', 9)).toHaveLength(3);
    expect(() => createGhProvider({ exec: () => { throw new Error('gh failed'); } }).readComments('o/n', 9)).toThrow(/gh failed/);
    expect(PR_COMMENTS_PAGE_SIZE).toBe(100);
  });

  it('readPrReviews throws on a malformed line or a gh failure (never "no reviews")', () => {
    expect(() => createGhProvider({ exec: () => 'not json\n' }).readPrReviews('o/n', 9)).toThrow();
    expect(() => createGhProvider({ exec: () => { throw new Error('gh failed'); } }).readPrReviews('o/n', 9)).toThrow(/gh failed/);
  });
});

/**
 * The #2964 ordering, as a pure function. The REASONS are asymmetric, which is why this is not a constant:
 * an orphan comment is inert, an orphan LABEL disarms the #2409 staleness gate.
 */
describe('writeOrder', () => {
  it('puts the COMMENT first when the acceptance is not already live', () => {
    expect(writeOrder({ acceptanceAlreadyLive: false })).toEqual(['comment', 'swap']);
  });

  it('puts the SWAP first when it is', () => {
    expect(writeOrder({ acceptanceAlreadyLive: true })).toEqual(['swap', 'comment']);
  });

  it('treats an ABSENT flag as not-live — the conservative branch, since that is the fail-open direction', () => {
    expect(writeOrder()).toEqual(['comment', 'swap']);
    expect(writeOrder({})).toEqual(['comment', 'swap']);
  });
});
