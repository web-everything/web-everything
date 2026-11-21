/** A complete shrinking review history with changed-file evidence for grant admission. */
export function convergingRead() {
  const findings = [
    ['src/a.mjs:1', 'alpha parser drops the trailing record'],
    ['src/b.mjs:2', 'beta cache never expires entries'],
    ['src/c.mjs:3', 'gamma retry loop spins forever'],
    ['src/d.mjs:4', 'delta timeout unit mismatch in header'],
  ];
  const comments = [findings.slice(0, 3), findings.slice(3)].map((round, i) => ({
    author: { login: 'web-everything' }, createdAt: `2026-10-01T10:0${i}:00Z`, viewerDidAuthor: false,
    body: '🔁 review — changes requested\n\nRecorded by agent (unattended review-loop) via the declared `review-pr` operation.\n\n### Findings\n'
      + round.map(([location, summary]) => `- \`${location}\` — ${summary}\n`).join(''),
  }));
  return { comments, commentsTotal: comments.length, files: ['src/q.mjs'] };
}
