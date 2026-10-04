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
import { GH_ARGV, PR_STATE_FIELDS, createGhProvider, writeOrder } from '../review-label-provider.mjs';

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
