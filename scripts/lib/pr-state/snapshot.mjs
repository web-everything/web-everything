// One read, one consistent state; downstream authority is bound to this frozen snapshot.
import { createHash } from 'node:crypto';

export function requireEvidence(ok, field) {
  if (!ok) throw new Error(`Incomplete or invalid PR evidence: ${field}; refresh evidence before retrying`);
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}(?![\s\S])/.test(value);
const timestamp = value => text(value) && Number.isFinite(Date.parse(value));
export function requireInteger(value, field) {
  requireEvidence(Number.isSafeInteger(value) && value >= 0, field);
}
function strings(values, field) {
  requireEvidence(Array.isArray(values), field);
  for (const value of values) requireEvidence(text(value), `${field} entry`);
}
function commentsValid(comments) {
  requireEvidence(Array.isArray(comments), 'comments');
  const ids = new Set();
  for (const c of comments) {
    requireEvidence(object(c) && text(c.id) && !ids.has(c.id), 'comment.id (unique)');
    ids.add(c.id);
    // Explicit null is a deleted GitHub user; undefined still signals a partial read.
    requireEvidence(c.author === null || text(c.author), 'comment.author');
    requireEvidence(typeof c.body === 'string', 'comment.body');
    requireEvidence(timestamp(c.createdAt), 'comment.createdAt');
    requireEvidence(c.lastEditedAt === null || timestamp(c.lastEditedAt), 'comment.lastEditedAt');
  }
}
function reviewsValid(reviews) {
  requireEvidence(Array.isArray(reviews), 'reviews');
  const ids = new Set();
  for (const r of reviews) {
    requireEvidence(object(r) && text(r.id) && !ids.has(r.id), 'review.id (unique)');
    ids.add(r.id);
    requireEvidence(r.author === null || text(r.author?.login), 'review.author.login');
    requireEvidence(['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state), 'review.state');
    requireEvidence(r.commit === null || sha(r.commit?.oid), 'review.commit.oid');
  }
}
export function validateSnapshot(s) {
  requireEvidence(object(s), 'snapshot');
  requireEvidence(sha(s.head), 'head');
  strings(s.labels, 'labels');
  requireEvidence(timestamp(s.labelsVersion), 'labelsVersion');
  commentsValid(s.comments);
  reviewsValid(s.reviews);
  for (const field of ['openReferrals', 'standingRulings', 'holdEventIds']) strings(s[field], field);
  requireEvidence(object(s.redTeam) && (s.redTeam.resultId === null || text(s.redTeam.resultId)), 'redTeam.resultId');
  requireEvidence(typeof s.redTeam.rulingNeeded === 'boolean', 'redTeam.rulingNeeded');
  requireEvidence(!s.redTeam.rulingNeeded || s.redTeam.resultId !== null, 'redTeam ruling result');
  requireEvidence(typeof s.humanOnlyHold === 'boolean', 'humanOnlyHold');
  requireEvidence(object(s.netDiff) && sha(s.netDiff.headSha), 'netDiff.headSha');
  strings(s.netDiff.files, 'netDiff.files');
  requireInteger(s.netDiff.diffLines, 'netDiff.diffLines');
  requireInteger(s.now, 'now');
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function labelsDigest(labels) {
  strings(labels, 'labels');
  return hash([...new Set(labels)].sort());
}
export function commentVersion(comments) {
  commentsValid(comments);
  return hash(comments.map(c => [c.id, c.author, c.body, c.createdAt, c.lastEditedAt])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function connection(pr, field) {
  const c = pr[field];
  requireEvidence(object(c) && c.pageInfo?.hasNextPage === false && Array.isArray(c.nodes),
    `${field} pagination incomplete (requires hasNextPage=false and nodes)`);
  return c.nodes;
}
const QUERY = `query PRState($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    headRefOid updatedAt
    labels(first:100) { nodes { name } pageInfo { hasNextPage } }
    comments(first:100) { nodes { id author { login } body createdAt lastEditedAt } pageInfo { hasNextPage } }
    reviews(first:100) { nodes { id author { login } state commit { oid } } pageInfo { hasNextPage } }
  } }
}`;

export async function readSnapshot({ repo, pr, expectedHead, now, io } = {}) {
  requireEvidence(typeof repo === 'string' && /^[^/\s]+\/[^/\s]+(?![\s\S])/.test(repo), 'repo owner/name');
  requireInteger(pr, 'pr');
  requireEvidence(pr > 0 && pr <= 2147483647, 'pr number');
  requireEvidence(sha(expectedHead), 'expectedHead');
  requireInteger(now, 'now');
  const readers = ['graphql', 'netDiffAtHead', 'openReferrals', 'redTeam', 'standingRulings', 'holdEventIds', 'humanOnlyHold'];
  for (const key of readers) requireEvidence(typeof io?.[key] === 'function', `io.${key}`);
  const [owner, name] = repo.split('/');
  const response = await io.graphql(QUERY, { owner, name, number: pr });
  requireEvidence(object(response) && !Object.hasOwn(response, 'errors'), 'GraphQL response errors');
  const p = response.repository?.pullRequest;
  requireEvidence(object(p), 'repository.pullRequest');
  const head = p.headRefOid;
  requireEvidence(sha(head) && head === expectedHead, 'headRefOid differs from expectedHead or is unreadable');
  const labelsVersion = p.updatedAt;
  requireEvidence(timestamp(labelsVersion), 'updatedAt');
  const labels = connection(p, 'labels').map(l => {
    requireEvidence(text(l?.name), 'label.name');
    return l.name;
  }).sort();
  const comments = connection(p, 'comments').map(c => {
    requireEvidence(object(c), 'comment');
    // Validate before normalization so a null login cannot become a deleted author.
    requireEvidence(c.author === null || (object(c.author) && text(c.author.login)), 'comment.author.login');
    return { id: c.id, author: c.author === null ? null : c.author?.login, body: c.body, createdAt: c.createdAt,
      lastEditedAt: c.lastEditedAt }; // GraphQL always returns it (null = never edited); absent = partial read
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  commentsValid(comments);
  const reviews = structuredClone(connection(p, 'reviews'));
  reviewsValid(reviews);
  const context = freeze({ comments, head });
  const derived = {};
  for (const key of readers.slice(2)) derived[key] = structuredClone(await io[key](context));
  const diff = structuredClone(await io.netDiffAtHead({ headSha: head, headRef: null }));
  requireEvidence(object(diff), 'netDiff');
  requireEvidence(!Object.hasOwn(diff, 'headSha') || diff.headSha === head, 'netDiff head mismatch');
  const snapshot = { head, labels, labelsVersion, comments, reviews,
    ...derived, netDiff: { ...diff, headSha: head }, now };
  validateSnapshot(snapshot);
  return freeze(snapshot);
}
