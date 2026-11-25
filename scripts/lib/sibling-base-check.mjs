import { laneHistoryProofEnv, scrubInheritedGitEnv } from './lane-git-hardening.mjs';

/** Constrain the injected Git port to history reads before dispatching dynamic argv. */
export function createSiblingHistoryReader(readGit) {
  return args => {
    if (!Array.isArray(args) || !['rev-parse', 'check-ref-format', 'rev-list', 'cherry'].includes(args[0])) {
      throw new Error('Unsupported sibling history command');
    }
    return readGit(args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024,
      env: laneHistoryProofEnv(scrubInheritedGitEnv(process.env)) });
  };
}

/** Read-only ancestry/patch evidence. Returns sibling counts, or an unreadable refusal. */
export function checkSiblingBase({ git, base = 'main', sha = 'HEAD', branch = '', openPrs }) {
  try {
    const read = createSiblingHistoryReader(git);
    const oid = value => {
      if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('invalid commit identity');
      return value;
    };
    const pin = ref => oid(read(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim());
    const lines = text => text.trim() ? text.trim().split('\n') : [];
    if (!Array.isArray(openPrs)) throw new Error('incomplete open PR evidence');
    if (typeof branch !== 'string') throw new Error('invalid branch evidence');
    if (branch) read(['check-ref-format', `refs/heads/${branch}`]);
    const localPrs = new Map();
    for (const pr of openPrs) {
      if (!Number.isSafeInteger(pr?.number) || pr.number <= 0
        || typeof pr.headRefName !== 'string' || typeof pr.baseRefName !== 'string') throw new Error('invalid PR evidence');
      read(['check-ref-format', `refs/heads/${pr.headRefName}`]);
      read(['check-ref-format', `refs/heads/${pr.baseRefName}`]);
      oid(pr.headRefOid);
      if (pr.isCrossRepository === false) {
        if (localPrs.has(pr.headRefName)) throw new Error('ambiguous stack evidence');
        localPrs.set(pr.headRefName, pr);
      }
    }
    const descendants = new Set();
    for (const pr of localPrs.values()) {
      const seen = new Set([pr.headRefName]);
      let parent = pr.baseRefName;
      while (parent !== branch && localPrs.has(parent)) {
        if (seen.has(parent)) throw new Error('cyclic stack evidence');
        seen.add(parent);
        parent = localPrs.get(parent).baseRefName;
      }
      if (branch && parent === branch) descendants.add(pr.number);
    }
    if (read(['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw new Error('incomplete shallow history');
    read(['check-ref-format', `refs/remotes/origin/${base}`]);
    const head = pin(sha), main = pin('refs/remotes/origin/main');
    const baseOid = pin(`refs/remotes/origin/${base}`);
    // Exclude exact main ancestry first; cherry excludes patch-equivalent squash landings.
    // Merge commits have no cherry row and remain conservatively unlanded.
    const commits = lines(read(['rev-list', `${baseOid}..${head}`, `^${main}`, '--'])).map(oid);
    const landed = new Set();
    for (const row of lines(read(['cherry', main, head]))) {
      if (!/^[+-] [a-f0-9]{40}$/.test(row)) throw new Error('invalid patch evidence');
      if (row.startsWith('-')) landed.add(row.slice(2));
    }
    const unlanded = commits.filter(commit => !landed.has(commit));
    const siblings = [];
    for (const pr of openPrs) {
      const sibling = pin(pr.headRefOid);
      if (base !== 'main' && base === pr.headRefName && pr.isCrossRepository === false) continue;
      // A child's shared commits came from this branch, including before a parent review fix.
      // Follow declared bases so deeper stacks work without trusting fork branch-name collisions.
      if (descendants.has(pr.number)) continue;
      const reachable = new Set(lines(read(['rev-list', sibling, `^${main}`, '--'])).map(oid));
      const count = unlanded.filter(commit => reachable.has(commit)).length;
      if (count) siblings.push({ number: pr.number, headRefName: pr.headRefName, count });
    }
    return siblings;
  } catch {
    return { reason: 'sibling-base-unreadable', detail: 'Sibling ancestry or open PR evidence is unreadable or incomplete; restore complete non-shallow history, local origin/main, base and sibling commit objects and retry --check. If the read exceeds its time/output limit, ask a human to inspect the branch history.' };
  }
}
