/** Git transport supplies the same commit author/message inputs as gh's commits connection. */
import { execFileSync } from 'node:child_process';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True only when `origin` is exactly `github.com/<repoSlug>` (https, scp-style or ssh URL). */
export function isGithubRemoteFor(remoteUrl, repoSlug) {
  const remote = String(remoteUrl).trim().replace(/\.git$/, '');
  return new RegExp(`^(?:https://(?:[^@/]+@)?github\\.com/|git@github\\.com:|ssh://git@github\\.com/)${escapeRe(repoSlug)}$`).test(remote);
}

export function readGitPrCommits(repoSlug, head, { cwd = process.cwd(), git = execFileSync, headRefOid, baseRefOid, baseRefName, localOnly = false } = {}) {
  // Both expected object identities are required, including for stacked/release bases.
  // Ambient remote-tracking refs never define the range.
  if (!/^[a-f0-9]{40}$/.test(headRefOid ?? '') || !/^[a-f0-9]{40}$/.test(baseRefOid ?? '') || !baseRefName) return null;
  if (!head || !/^[\w./-]+$/.test(head) || head.startsWith('-') || head.includes('..')) return null;
  const run = (args) => String(git('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  }));
  try {
    // Never read a sibling repo's refs as if they belonged to the requested repo.
    if (!isGithubRemoteFor(run(['remote', 'get-url', 'origin']), repoSlug)) return null;
    run(['check-ref-format', `refs/heads/${head}`]);
    if (run(['rev-parse', '--is-shallow-repository']).trim() !== 'false') return null;
    for (const oid of [headRefOid, baseRefOid]) {
      let resolved;
      try { resolved = run(['rev-parse', '--verify', `${oid}^{commit}`]).trim(); }
      catch {
        if (localOnly) return null;
        run(['fetch', '--no-tags', 'origin', oid]);
        resolved = run(['rev-parse', '--verify', `${oid}^{commit}`]).trim();
      }
      if (resolved !== oid) return null;
    }
    const commits = gitRangeCommits(baseRefOid, headRefOid, { run });
    Object.defineProperties(commits, { headOid: { value: headRefOid }, baseOid: { value: baseRefOid }, complete: { value: true } });
    return commits;
  } catch { return null; }
}

/** Shared NUL-delimited parser; the caller owns the trusted executor and exact object identities. */
export function gitRangeCommits(base, head, { run } = {}) {
  const raw = run(['log', '-z', '--format=%H%x00%an%x00%ae%x00%B%x00%(trailers:key=Co-Authored-By,valueonly,separator=%x1f)', `${base}..${head}`, '--']);
    const fields = raw.split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 5) throw new Error('malformed-git-log');
    const commits = [];
    for (let i = 0; i < fields.length; i += 5) {
      const [oid, name, email, message, trailers] = fields.slice(i, i + 5);
      if (!/^[a-f0-9]{40}$/.test(oid)) throw new Error('malformed-git-commit-oid');
      const nl = message.indexOf('\n');
      const authors = [{ name, email }];
      for (const trailer of trailers.split('\x1f')) {
        const m = trailer.trim().match(/^(.*?)\s*<([^>]+)>$/);
        if (m) authors.push({ name: m[1], email: m[2] });
      }
      commits.push({ oid, authors, messageHeadline: nl < 0 ? message : message.slice(0, nl), messageBody: nl < 0 ? '' : message.slice(nl + 1) });
    }
    return commits;
}
