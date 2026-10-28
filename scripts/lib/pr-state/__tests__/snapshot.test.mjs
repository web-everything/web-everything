// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readSnapshot, labelsDigest, commentVersion } from '../snapshot.mjs';

const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-10-28T12:00:00Z');
const UPDATED = '2026-10-28T11:59:00Z';
const IO_MEMBERS = ['graphql', 'netDiffAtHead', 'openReferrals', 'redTeam',
  'standingRulings', 'holdEventIds', 'humanOnlyHold'];

function fixture() {
  const comments = [
    { id: 'C2', author: { login: 'reviewer' }, body: 'Edited evidence',
      createdAt: '2026-10-28T11:00:00Z', lastEditedAt: UPDATED },
    { id: 'C1', author: { login: 'operator' }, body: 'Original evidence',
      createdAt: '2026-10-28T10:00:00Z', lastEditedAt: null },
  ];
  const connection = nodes => ({ nodes, pageInfo: { hasNextPage: false } });
  const pullRequest = {
    headRefOid: HEAD, updatedAt: UPDATED,
    labels: connection([{ name: 'review:human' }, { name: 'area:docs' }]),
    comments: connection(comments),
    reviews: connection([{ id: 'R1', author: { login: 'reviewer' },
      state: 'APPROVED', commit: { oid: HEAD } }]),
  };
  const calls = Object.fromEntries(IO_MEMBERS.map(key => [key, []]));
  const record = (key, result) => (...args) => {
    calls[key].push(args);
    return result;
  };
  const io = {
    graphql: record('graphql', { repository: { pullRequest } }),
    netDiffAtHead: record('netDiffAtHead', { files: ['docs/example.md'], diffLines: 12 }),
    openReferrals: record('openReferrals', ['finding:1']),
    redTeam: record('redTeam', { resultId: 'RT1', rulingNeeded: true }),
    standingRulings: record('standingRulings', ['ruling:1']),
    holdEventIds: record('holdEventIds', ['hold:1', 'hold:2']),
    humanOnlyHold: record('humanOnlyHold', true),
  };
  return { pullRequest, calls, io,
    input: { repo: 'example/project', pr: 42, expectedHead: HEAD, now: NOW, io } };
}

describe('readSnapshot', () => {
  it('returns the complete frozen snapshot from one GraphQL read', async () => {
    const f = fixture();
    const snapshot = await readSnapshot(f.input);
    expect(snapshot).toEqual({
      head: HEAD, labels: ['area:docs', 'review:human'], labelsVersion: UPDATED,
      comments: [
        { id: 'C1', author: 'operator', body: 'Original evidence',
          createdAt: '2026-10-28T10:00:00Z', lastEditedAt: null },
        { id: 'C2', author: 'reviewer', body: 'Edited evidence',
          createdAt: '2026-10-28T11:00:00Z', lastEditedAt: UPDATED },
      ],
      reviews: f.pullRequest.reviews.nodes,
      openReferrals: ['finding:1'], redTeam: { resultId: 'RT1', rulingNeeded: true },
      standingRulings: ['ruling:1'], holdEventIds: ['hold:1', 'hold:2'], humanOnlyHold: true,
      netDiff: { headSha: HEAD, files: ['docs/example.md'], diffLines: 12 }, now: NOW,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(f.calls.graphql).toHaveLength(1);
    expect(f.calls.graphql[0][0]).toEqual(expect.any(String));
    expect(f.calls.graphql[0][1]).toEqual(expect.any(Object));
    for (const key of ['openReferrals', 'redTeam', 'standingRulings', 'humanOnlyHold']) {
      expect(f.calls[key]).toEqual([[{ comments: snapshot.comments, head: HEAD }]]);
    }
    expect(f.calls.holdEventIds).toHaveLength(1);
  });

  it('reads the net diff at the snapshot SHA with headRef explicitly null', async () => {
    const f = fixture();
    const snapshot = await readSnapshot(f.input);
    expect(f.calls.netDiffAtHead).toEqual([[{ headSha: snapshot.head, headRef: null }]]);
    expect(snapshot.netDiff.headSha).toBe(snapshot.head);
  });

  it('comment and label input order changes neither snapshot nor digests', async () => {
    const first = fixture();
    const shuffled = fixture();
    shuffled.pullRequest.comments.nodes.reverse();
    shuffled.pullRequest.labels.nodes.reverse();
    const a = await readSnapshot(first.input);
    const b = await readSnapshot(shuffled.input);
    expect(b).toEqual(a);
    expect(labelsDigest(b.labels)).toBe(labelsDigest(a.labels));
    expect(commentVersion(b.comments)).toBe(commentVersion(a.comments));
  });

  it.each(['labels', 'comments', 'reviews'])('fails closed for truncated %s', async key => {
    const f = fixture();
    f.pullRequest[key].pageInfo.hasNextPage = true;
    await expect(async () => readSnapshot(f.input)).rejects.toThrow();
  });

  it.each(['headRefOid', 'updatedAt'])('fails closed without PR %s', async key => {
    const f = fixture();
    delete f.pullRequest[key];
    await expect(async () => readSnapshot(f.input)).rejects.toThrow();
  });

  it.each(['id', 'author', 'body', 'createdAt', 'lastEditedAt'])('fails closed without comment %s', async key => {
    const f = fixture();
    delete f.pullRequest.comments.nodes[0][key];
    await expect(async () => readSnapshot(f.input)).rejects.toThrow();
  });

  it('fails closed when the pinned net diff cannot be read', async () => {
    const f = fixture();
    f.io.netDiffAtHead = async () => { throw new Error('diff unreadable'); };
    await expect(async () => readSnapshot(f.input)).rejects.toThrow();
  });

  it.each([undefined, null, {}, 'docs/example.md'])(
    'fails closed for non-array diff files: %j', async files => {
      const f = fixture();
      f.io.netDiffAtHead = () => ({ files, diffLines: 12 });
      await expect(async () => readSnapshot(f.input)).rejects.toThrow();
    });

  it.each(IO_MEMBERS)('requires explicit io.%s', async key => {
    const f = fixture();
    delete f.io[key];
    await expect(async () => readSnapshot(f.input)).rejects.toThrow();
  });

  it('requires an explicit IO object', async () => {
    const f = fixture();
    delete f.input.io;
    await expect(async () => readSnapshot(f.input)).rejects.toThrow();
  });

  it.each([undefined, null, 1.5, NaN, Infinity, String(NOW)])(
    'rejects non-integer now: %j', async now => {
      const f = fixture();
      await expect(async () => readSnapshot({ ...f.input, now })).rejects.toThrow();
    });
});

describe('snapshot fence helpers', () => {
  const comments = [
    { id: 'C1', author: 'operator', body: 'First', createdAt: UPDATED, lastEditedAt: null },
    { id: 'C2', author: 'reviewer', body: 'Second', createdAt: UPDATED, lastEditedAt: UPDATED },
  ];

  it('labelsDigest is an order-insensitive string sensitive to label membership', () => {
    const digest = labelsDigest(['review:human', 'area:docs']);
    expect(typeof digest).toBe('string');
    expect(labelsDigest(['area:docs', 'review:human'])).toBe(digest);
    expect(labelsDigest(['review:human'])).not.toBe(digest);
    expect(labelsDigest(['review:human', 'area:code'])).not.toBe(digest);
  });

  it('commentVersion is an order-insensitive string', () => {
    expect(typeof commentVersion(comments)).toBe('string');
    expect(commentVersion([...comments].reverse())).toBe(commentVersion(comments));
  });

  it.each([
    ['id', 'C3'], ['body', 'Changed'], ['lastEditedAt', '2026-10-28T12:00:00Z'],
  ])('commentVersion changes when a comment %s changes', (key, value) => {
    const changed = comments.map(comment => ({ ...comment }));
    changed[0][key] = value;
    expect(commentVersion(changed)).not.toBe(commentVersion(comments));
  });

  it('commentVersion changes when a comment is added', () => {
    expect(commentVersion([...comments, { ...comments[0], id: 'C3' }]))
      .not.toBe(commentVersion(comments));
  });
});
