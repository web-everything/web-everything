/**
 * Indexed scan of `review-pr-*` run records for one repo/PR/head.
 *
 * Why: the drain's red-team evidence read and the saved-result provenance check each parsed EVERY review-pr run
 * (6.4k files, 1.5 GB, measured 2026-10-19) on every call, ~4.7 s per scan, several scans per candidate per pass.
 * That made the merge cascade take 10-28 minutes for 1-5 PRs.
 *
 * What it keeps: a small in-process index from each file's stat identity (dev, inode, size, mtime, ctime in ns) to
 * the four fields the callers match on. Unchanged files are not re-parsed. A changed, new or unreadable file is
 * read again through `readRun`, so its errors (corrupt or vanished record) reach the caller exactly as before.
 * Matching files are always read fresh from disk, and returned in `listRunIds` order. The match is case-insensitive,
 * so it is a superset of each caller's own predicate; callers still apply their exact checks to the fresh record.
 */
import { statSync } from 'node:fs';
import { listRunIds, readRun, runPath } from '../operations/run-store.mjs';

const index = new Map();
const MAX_ENTRIES = 50_000;
const sigOf = st => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
const keyOf = run => (run?.op === 'review-pr' && typeof run.input?.repo === 'string'
  ? { repo: run.input.repo.toLowerCase(), pr: Number(run.input?.pr), rev: String(run.findings?.read?.netBasis?.rev ?? '').toLowerCase() }
  : null);

/** @returns {{ id: string, run: object }[]} review-pr runs that may match, each freshly read. Throws as `readRun` does. */
export function readMatchingReviewRuns({ runsDir, repo, pr, head, list = listRunIds, read = readRun, stat = statSync }) {
  const want = { repo: String(repo ?? '').toLowerCase(), pr: Number(pr), rev: String(head ?? '').toLowerCase() };
  const hits = [];
  for (const id of list(runsDir).filter(id => id.startsWith('review-pr-'))) {
    const cacheKey = `${runsDir}\0${id}`;
    let sig = null;
    try { sig = sigOf(stat(runPath(id, runsDir), { bigint: true })); } catch { /* readRun below reports it */ }
    const cached = sig && index.get(cacheKey);
    if (cached && cached.sig === sig) {
      const k = cached.key;
      if (k && k.repo === want.repo && k.pr === want.pr && k.rev === want.rev) hits.push({ id, run: read(id, runsDir) });
      continue;
    }
    const run = read(id, runsDir); // a corrupt or vanished record throws here, as the full scan did
    const key = keyOf(run);
    if (sig) {
      if (index.size >= MAX_ENTRIES) index.delete(index.keys().next().value);
      index.set(cacheKey, { sig, key });
    }
    if (key && key.repo === want.repo && key.pr === want.pr && key.rev === want.rev) hits.push({ id, run });
  }
  return hits;
}
