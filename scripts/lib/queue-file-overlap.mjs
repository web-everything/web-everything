/** Read-only ordering guard; unknown queue file lists never block admission. */
import { describeBlocker } from './merge-queue-stuck-dequeue.mjs';
import { execFileSync } from 'node:child_process';
import { graphql } from './merge-queue-adaptive-batching.mjs';

/** The caller excludes the candidate's own queue entry. `unknown` contains PR numbers. */
export function queueFileOverlap({ candidateFiles, queuedEntries, includeCards }) {
  const relevant = path => includeCards || !path.startsWith('backlog/');
  const candidate = new Set(candidateFiles.filter(relevant));
  const hits = [];
  const unknown = [];
  for (const entry of queuedEntries) {
    if (entry.files === null) { unknown.push(entry.num); continue; }
    const files = [...new Set(entry.files.filter(path => relevant(path) && candidate.has(path)))];
    const blocker = Object.fromEntries(['state', 'enqueuedAt', 'ci'].filter(key => entry[key] != null).map(key => [key, entry[key]]));
    if (files.length) hits.push({ num: entry.num, files, ...(Object.keys(blocker).length ? { blocker } : {}) });
  }
  return { overlap: hits.length > 0, with: hits, unknown };
}

/** GitHub's listing and gh pr view file lists are capped at 100 paths. */
export function completeListedFiles(files) {
  if (!Array.isArray(files) || files.length >= 100) return null;
  const paths = files.map(file => typeof file === 'string' ? file : file?.path);
  return paths.every(path => typeof path === 'string' && path.length > 0) ? paths : null;
}

export function readQueueEntryFiles({ repo, exec = execFileSync, resolveFiles }) {
  try {
    const [owner, name] = repo.split('/');
    const data = graphql(exec, 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){mergeQueue(branch:"main"){entries(first:100){pageInfo{hasNextPage} nodes{state enqueuedAt headCommit{oid statusCheckRollup{state}} pullRequest{number}}}}}}', [`owner=${owner}`, `name=${name}`]);
    const page = data.repository?.mergeQueue?.entries;
    if (!Array.isArray(page?.nodes)) throw new Error('unreadable merge queue');
    if (page.nodes.length > 100 || page.pageInfo?.hasNextPage !== false) throw new Error('merge queue has more than 100 entries');
    const entries = page.nodes.map(node => {
      const pr = node?.pullRequest;
      if (!Number.isInteger(pr?.number)) throw new Error('invalid merge queue entry');
      const view = JSON.parse(exec('gh', ['pr', 'view', String(pr.number), '--repo', repo, '--json', 'files,headRefName,baseRefName,headRefOid'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
      return { num: pr.number, files: resolveFiles ? resolveFiles({ num: pr.number, repo, view }) : completeListedFiles(view.files),
        ...Object.fromEntries(Object.entries({ state: node.state, enqueuedAt: node.enqueuedAt, ci: node.headCommit?.statusCheckRollup?.state }).filter(([, value]) => value != null)),
        ...(typeof view.headRefOid === 'string' ? { headSha: view.headRefOid } : {}) };
    });
    return { entries };
  } catch (e) { return { entries: [], error: String(e?.message ?? e).split('\n')[0] }; }
}

export function blockerSummary(hit, nowMs = Date.now()) {
  return describeBlocker({ ...hit?.blocker, num: hit?.num }, nowMs).replace(' in queue ', ' queued ');
}
