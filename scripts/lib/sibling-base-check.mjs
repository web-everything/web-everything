import { configKeyCandidates, LANE_CONFIG_LIST_ARGS, laneHistoryProofEnv, scrubInheritedGitEnv } from './lane-git-hardening.mjs';

// Hydration must not turn a history read into a lane-selected command. Inspect
// all scopes, including included files and global config selected through HOME.
// A file transport also starts upload-pack locally. Includes can select a
// different protected pack hook in that repository, so they require prehydration.
const HYDRATION_COMMAND_CONFIG = /^(remote\..+\.(uploadpack|vcs)|core\.gitproxy|uploadpack\.packobjectshook|include\.path|includeif\..+\.path|url\..+\.(insteadof|pushinsteadof))$/is;

/** Constrain the injected Git port to history reads before dispatching dynamic argv. */
export function createSiblingHistoryReader(readGit) {
  return args => {
    if (!Array.isArray(args) || !['rev-parse', 'check-ref-format', 'rev-list', 'cherry'].includes(args[0])) {
      throw new Error('Unsupported sibling history command');
    }
    const env = laneHistoryProofEnv(scrubInheritedGitEnv(process.env));
    const limits = { timeout: 5000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
    // Patch IDs need blobs that a partial clone may not yet have. Only the
    // deferred patch read may hydrate them; ancestry reads remain local-only.
    if (args[0] === 'cherry') {
      try { return readGit(args, { ...limits, env: { ...env } }); }
      catch { /* A partial clone may need one bounded hydration retry. */ }
      delete env.GIT_EXEC_PATH;
      delete env.GIT_PROXY_COMMAND;
      // This environment allowlist overrides protocol.*.allow in every scope.
      // file is the built-in local transport, also used by hermetic clone fixtures.
      env.GIT_ALLOW_PROTOCOL = 'file:https:http:ssh:git';
      const config = readGit([...LANE_CONFIG_LIST_ARGS], { ...limits, env: { ...env } });
      const parts = config ? config.split('\0') : [];
      if (config && parts.pop() !== '') throw new Error('incomplete hydration config');
      if (parts.length % 2) throw new Error('invalid hydration config');
      for (let i = 0; i < parts.length; i += 2) {
        // A key-only entry is a valid Git boolean with an implicit true value.
        if (!['system', 'global', 'local', 'worktree', 'command'].includes(parts[i])
          || !parts[i + 1]) throw new Error('invalid hydration config');
        if (configKeyCandidates(parts[i + 1]).some(key => HYDRATION_COMMAND_CONFIG.test(key))) {
          throw new Error('unsafe hydration transport config');
        }
      }
      env.GIT_NO_LAZY_FETCH = '0';
    }
    return readGit(args, { ...limits, env });
  };
}

/**
 * Refuse incorporated open sibling tips with shared unlanded commits. Divergent
 * overlap (including a sibling advanced after the cut) cannot prove ownership.
 * Returns sibling counts, or an unreadable refusal; never prescribes a rebase.
 */
export function checkSiblingBase({ git, base = 'main', sha = 'HEAD', branch = '', openPrs }) {
  let readingPr = '';
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
    // Traverse the complete proposed ancestry before considering PR tips. In a
    // non-shallow graph a tip absent from this set cannot be incorporated, whether
    // it is locally available, unfetched, or from a fork. Do not resolve unrelated
    // objects or fetch them. A missing ancestor or a bounded-read failure refuses.
    const ancestors = new Set(lines(read(['rev-list', head, '--'])).map(oid));
    if (!ancestors.has(head)) throw new Error('incomplete proposed ancestry');
    // Exclude exact main ancestry first. Patch evidence is needed only after a
    // non-exempt incorporated sibling shares at least one of these commits.
    const commits = lines(read(['rev-list', `${baseOid}..${head}`, `^${main}`, '--'])).map(oid);
    let landed;
    const siblings = [];
    for (const pr of openPrs) {
      if (!ancestors.has(pr.headRefOid)) continue;
      readingPr = ` for PR #${pr.number} (${pr.headRefOid})`;
      const sibling = pin(pr.headRefOid);
      if (base !== 'main' && base === pr.headRefName && pr.isCrossRepository === false) continue;
      // A child's shared commits came from this branch, including before a parent review fix.
      // Follow declared bases so deeper stacks work without trusting fork branch-name collisions.
      if (descendants.has(pr.number)) continue;
      const reachable = new Set(lines(read(['rev-list', sibling, `^${main}`, '--'])).map(oid));
      const shared = commits.filter(commit => reachable.has(commit));
      if (!shared.length) continue;
      if (!landed) {
        landed = new Set();
        for (const row of lines(read(['cherry', main, head]))) {
          if (!/^[+-] [a-f0-9]{40}$/.test(row)) throw new Error('invalid patch evidence');
          if (row.startsWith('-')) landed.add(row.slice(2));
        }
      }
      // Merge commits have no cherry row and remain conservatively unlanded.
      const count = shared.filter(commit => !landed.has(commit)).length;
      if (!count) continue;
      siblings.push({ number: pr.number, headRefName: pr.headRefName, count });
    }
    return siblings;
  } catch {
    return { reason: 'sibling-base-unreadable', detail: `Sibling ancestry or open PR evidence is unreadable or incomplete${readingPr}; restore complete non-shallow history, local origin/main, base and incorporated sibling commit objects, and promisor remote access for missing blobs, then retry --check. Hydration requires a built-in transport without custom uploadpack, vcs, gitProxy, pack hooks, config includes or URL rewrites; otherwise hydrate the blobs separately. If the read exceeds its time/output limit, ask a human to inspect the branch history.` };
  }
}
