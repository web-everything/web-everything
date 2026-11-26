/** Durable identity and branch lookup for single-owner ruling cards. All unknown reads stop filing. */
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { cardOnlyEligibility } from '../lib/card-batch-policy.mjs';

const SHA = /^[a-f0-9]{40}$/;
const MAX_LOOKUP_REFS = 1024;
export { rulingBranch } from '../lib/ruling-card-key.mjs';
import { rulingBranch } from '../lib/ruling-card-key.mjs';

export function cardRulingKey(content) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter) throw new Error('unreadable card frontmatter');
  const data = yaml.load(frontmatter[1]);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('unreadable card frontmatter');
  if (data.rulingKey !== undefined) rulingBranch(data.rulingKey);
  return data.rulingKey;
}

export function lookupRulingCard({ root, rulingKey, git = (...args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
}) } = {}) {
  try {
    const branch = rulingBranch(rulingKey), ref = `refs/heads/${branch}`;
    const readCards = sha => {
      if (!SHA.test(sha)) throw new Error('invalid branch commit');
      const raw = String(git('ls-tree', '-r', '-z', sha, '--', 'backlog/'));
      if (raw && !raw.endsWith('\0')) throw new Error('truncated branch tree');
      const blobs = new Map();
      for (const row of raw ? raw.slice(0, -1).split('\0') : []) {
        const entry = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(row);
        if (!entry) throw new Error('malformed branch tree');
        const [, mode, type, blob, path] = entry;
        if (!/^backlog\/[^/]+\.md$/.test(path)) continue;
        if (mode !== '100644' || type !== 'blob') throw new Error('unreadable regular card');
        blobs.set(path, blob);
      }
      // Search immutable objects in one process; do not spawn a child for every unrelated backlog card.
      let keyed;
      try { keyed = String(git('grep', '-l', '-z', '--fixed-strings', 'rulingKey', sha, '--', ':(top,glob)backlog/*.md')); }
      catch (error) {
        if (error.status !== 1 || String(error.stdout ?? '') || String(error.stderr ?? '')) throw error;
        keyed = '';
      }
      if (keyed && !keyed.endsWith('\0')) throw new Error('truncated ruling-key search');
      const matches = [];
      for (const hit of keyed ? keyed.slice(0, -1).split('\0') : []) {
        const prefix = `${sha}:`;
        if (!hit.startsWith(prefix) || !blobs.has(hit.slice(prefix.length))) throw new Error('invalid ruling-key search path');
        const path = hit.slice(prefix.length);
        if (cardRulingKey(String(git('cat-file', 'blob', blobs.get(path)))) === rulingKey) matches.push(path);
      }
      if (matches.length > 1) throw new Error('duplicate ruling keys; use the existing consolidate path');
      return matches[0] ?? null;
    };
    const ownCard = sha => {
      const rel = readCards(sha);
      if (!rel) throw new Error('per-ruling branch exists without its keyed card');
      const base = String(git('merge-base', '--all', 'origin/main', sha)).trim();
      if (!SHA.test(base)) throw new Error('ambiguous ruling branch baseline');
      if (String(git('diff', '--name-status', '-z', '--no-renames', '--ignore-submodules=none', '--no-ext-diff', base, sha)) !== `A\0${rel}\0`)
        throw new Error('per-ruling branch is not a single added card');
      return { ok: true, card: { rel, branch, sha } };
    };
    const local = String(git('for-each-ref', '--format=%(objectname) %(refname)', ref,
      'refs/heads/lane/card-batch-*', 'refs/remotes/origin/lane/card-batch-*')).trim();
    const localRows = local ? local.split('\n').map(line => {
      const m = /^([a-f0-9]{40}) (refs\/(?:heads|remotes\/origin)\/lane\/[^\s]+)$/.exec(line);
      if (!m) throw new Error('malformed local branch evidence');
      return { sha: m[1], ref: m[2] };
    }) : [];
    if (localRows.length > MAX_LOOKUP_REFS) throw new Error('too many ruling/batch refs; inspect or consolidate legacy branches before retrying');
    const owned = localRows.find(row => row.ref === ref);
    if (owned) return ownCard(owned.sha);
    for (const row of localRows) {
      if (!/\/lane\/card-batch-/.test(row.ref)) throw new Error('unexpected local ruling ref');
      if (readCards(row.sha)) throw new Error(`legacy batch-branch card on ${row.ref}; stop and consolidate, never copy`);
    }
    // A successful, complete listing proves remote absence. Auth/transport failures prove nothing.
    const remote = String(git('ls-remote', '--refs', 'origin', ref, 'refs/heads/lane/card-batch-*')).trim();
    const rows = remote ? remote.split('\n').map(line => {
      const m = /^([a-f0-9]{40})\t(refs\/heads\/lane\/[^\s]+)$/.exec(line);
      if (!m || (m[2] !== ref && !m[2].startsWith('refs/heads/lane/card-batch-'))) throw new Error('malformed origin branch evidence');
      return { sha: m[1], ref: m[2] };
    }) : [];
    if (rows.length > MAX_LOOKUP_REFS) throw new Error('too many ruling/batch refs; inspect or consolidate legacy branches before retrying');
    if (new Set(rows.map(row => row.ref)).size !== rows.length) throw new Error('duplicate remote ref evidence');
    const fetch = sha => {
      git('fetch', '--no-tags', '--no-write-fetch-head', 'origin', sha);
      if (String(git('rev-parse', '--verify', `${sha}^{commit}`)).trim() !== sha) throw new Error('unverified origin commit');
    };
    const remoteOwn = rows.find(row => row.ref === ref);
    if (remoteOwn) { fetch(remoteOwn.sha); return ownCard(remoteOwn.sha); }
    for (const row of rows) {
      fetch(row.sha);
      if (readCards(row.sha)) throw new Error(`legacy batch-branch card on origin/${row.ref}; stop and consolidate, never copy`);
    }
    return { ok: true, card: null };
  } catch (error) {
    return { ok: false, reason: `ruling-key lookup failed: ${String(error?.message ?? error).split('\n')[0]}; nothing filed` };
  }
}

/** Publication uses a private index. Adopt only its exact card blob in the lane's real index. */
function reconcileRulingCard({ lane, rel, sha, exec }) {
  const git = (...args) => String(exec('git', ['-C', lane, ...args], { timeout: 30000 }));
  const refuse = () => { throw new Error('ruling checkout evidence differs or is unreadable; preserve the lane/card and inspect before retrying'); };
  const tree = git('ls-tree', '-z', sha, '--', rel);
  const entry = /^100644 blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(tree);
  if (!entry || entry[2] !== rel) refuse();
  const blob = entry[1], expectedIndex = `100644 ${blob} 0\t${rel}\0`;
  const index = git('ls-files', '--stage', '-z', '--', rel);
  if (index && index !== expectedIndex) refuse();
  const path = join(lane, rel);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    // A reused branch can have no worktree copy yet. A tracked deletion is local work, not absence.
    if (error.code === 'ENOENT' && !index) return;
    throw error;
  }
  if (!stat.isFile() || (stat.mode & 0o111)
    || realpathSync(dirname(path)) !== join(realpathSync(lane), 'backlog')) refuse();
  if (git('hash-object', '--no-filters', '--', rel).trim() !== blob) refuse();
  if (!index) git('update-index', '--add', '--cacheinfo', '100644', blob, rel);
}

/** Runs inside an acquired lane. file-item durably preserves the branch before verify/open. */
export async function landRulingInLane(input, { lane, laneRunMjs, exec, lookup, parse, submit, scratchFile, writeFile, sourceRoot,
  timeouts = { file: 120000, verify: 4200000, open: 2700000 } }) {
  const fail = (step, reason, rel = null) => ({ ok: false, step, reason, rel });
  let found;
  try { found = await lookup(input.rulingKey, { lane }); }
  catch (error) { return fail('ruling-lookup', `unreadable ruling key: ${error.message}; nothing filed`); }
  if (found?.ok !== true) return fail('ruling-lookup', found?.reason ?? 'ruling-key lookup unavailable; nothing filed');
  const branch = rulingBranch(input.rulingKey);
  const reused = Boolean(found.card);
  let rel = found.card?.rel;
  if (!rel) {
    let filed;
    try {
      filed = parse(exec('node', [laneRunMjs, 'file-item', `--title=${input.title}`, `--kind=${input.kind}`,
        `--size=${input.size}`, `--digest=${input.digest}`, `--scope=${input.scope}`, `--queue=${input.queue}`,
        `--rulingKey=${input.rulingKey}`, ...(input.parent ? [`--parent=${input.parent}`] : []), '--json'], { cwd: lane, timeout: timeouts.file }));
    } catch (error) { return fail('file-item', String(error.message).split('\n')[0]); }
    rel = filed?.verdict?.rel;
    if (!rel) return fail('file-item', 'file-item produced no card path');
    // Never trust only the operation verdict: prove the keyed branch actually survived publication.
    try { found = await lookup(input.rulingKey, { lane }); }
    catch (error) { return fail('ruling-lookup', error.message, rel); }
    if (found?.ok !== true || found.card?.rel !== rel) return fail('ruling-lookup', found?.reason ?? 'filed card branch unavailable; preserve the lane and retry', rel);
  }
  if (!cardOnlyEligibility([{ path: rel, mode: '100644', status: 'A' }]).ok) return fail('ruling-lookup', 'invalid ruling card path', rel);
  try {
    // A local-only branch in the caller clone is still the same ruling, never another filing.
    if (sourceRoot && sourceRoot !== lane) {
      try { exec('git', ['-C', lane, 'cat-file', '-e', `${found.card.sha}^{commit}`], { timeout: 30000 }); }
      catch {
        exec('git', ['-C', lane, 'fetch', '--no-tags', '--no-write-fetch-head', sourceRoot, found.card.sha], { timeout: 30000 });
        const imported = String(exec('git', ['-C', lane, 'rev-parse', '--verify', `${found.card.sha}^{commit}`], { timeout: 30000 })).trim();
        if (imported !== found.card.sha) return fail('ruling-lookup', 'cannot verify the preserved ruling commit; nothing filed', rel);
      }
    }
    reconcileRulingCard({ lane, rel, sha: found.card.sha, exec });
    exec('git', ['-C', lane, 'checkout', '--detach', found.card.sha], { timeout: 30000 });
    const verified = parse(exec('node', [laneRunMjs, 'verify', `--checkout=${lane}`, '--mode=run', '--json'], { cwd: lane, timeout: timeouts.verify }));
    if (!verified?.verdict?.ok) return fail('verify', 'gate not green', rel);
  } catch (error) { return fail('verify', String(error.message).split('\n')[0], rel); }
  const body = scratchFile('pr-body.md');
  writeFile(body, `Mechanically filed ruling card.\n\n${input.digest}\n\nprep: waived — card-only mechanical filing\n`, 'utf8');
  try {
    const opened = parse(exec('node', [laneRunMjs, 'open-pr', `--ref=${branch}`, `--sha=${found.card.sha}`,
      '--base=main', `--bodyFile=${body}`, '--mode=label-on-green', '--requireVerified=true', '--json'], { cwd: lane, timeout: timeouts.open }));
    const result = submit(opened ?? {});
    if (result?.outcome !== 'opened') return fail('open-pr', result?.reason ?? 'PR was not opened', rel);
    return { ok: true, step: 'done', rel, pr: result.pr, url: result.url, reused };
  } catch (error) { return fail('open-pr', String(error.message).split('\n')[0], rel); }
}
