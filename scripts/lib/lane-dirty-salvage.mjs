import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { laneLivenessGate, nearestAncestorMtimeMs, resolveSalvageQuietMs } from './lane-salvage.mjs';
import { LEASE_FILENAME, isLeaseStale, leaseBody } from './lane-lease.mjs';
import { laneGitHardeningEnv, scrubGitRepoEnv } from './lane-git-hardening.mjs';
import { salvageRefName } from './lane-pool-salvage-push.mjs';
import { SECRET_PATTERNS } from './secret-scrub.mjs';

const safePath = value => String(value).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ');
const digest = value => createHash('sha256').update(value).digest('hex');
const readLease = file => {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || !value.session || !Number.isFinite(Date.parse(value.acquiredAt))) throw Error();
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Error('unreadable lease; inspect manually');
  }
};

/** Bound both transport attempts and examination work; refusals leave transport capacity available. */
export async function salvageDirtyLanes({ lanes, max, salvage, log }) {
  let attempted = 0, examined = 0;
  for (const n of lanes) {
    if (attempted >= max || examined >= max * 4) {
      log(`gc dirty-salvage ${attempted >= max ? 'push cap' : 'examination bound'} reached; remaining lanes kept — raise LANE_POOL_GC_DIRTY_SALVAGE_MAX after inspection or salvage manually`);
      break;
    }
    examined++;
    const outcome = await salvage(n);
    if (outcome.pushAttempted || outcome.status === 'salvaged') attempted++;
    if (outcome.status === 'clean') continue;
    log(`gc dirty-salvage lane-${n}: ${outcome.status === 'salvaged' ? `salvaged ${outcome.ref} ${outcome.sha}` : `kept ${outcome.reason}`}`);
  }
}

/** One fail-closed preservation transaction. Reclaim/reprovision are the pool's existing provision paths.
 * The only durable writes before a verified push are the exclusive hold; WIP objects/index live in TMPDIR.
 * Unknown or oversized evidence needs operator salvage, never a destructive best effort.
 */
export async function salvageDirtyLane({ repo, n, dir, io, now = () => new Date(), dryRun = false,
  quarantined = false, quarantinePath = join(repo.poolDir, '.quarantine-state', `lane-${n}.json`),
  mapFile = process.env.LANE_POOL_DIRTY_SALVAGE_MAP || join(homedir(), '.claude', 'lane-salvage', 'dirty-salvage-map.jsonl'),
  livenessGate = laneLivenessGate, claimLane, releaseLane,
  reclaim, reprovision, journal, maxFiles = 25000, maxBytes = 64 * 1024 * 1024,
  maxHistoryObjects = 25000, maxHistoryBytes = maxBytes,
}) {
  const file = join(dir, '.git', LEASE_FILENAME);
  let hold = null, scratch = null, pushAttempted = false;
  const env = laneGitHardeningEnv({ ...scrubGitRepoEnv(process.env), GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_SHALLOW_FILE: '/dev/null', GIT_GRAFT_FILE: '/dev/null' });
  const git = (args, extra = {}) => execFileSync('git', args, {
    cwd: dir, env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], ...extra,
  });
  const gate = () => {
    let result = livenessGate({ dir, ignoreLeaseSession: hold?.session });
    // The shared gate's status-based quiet probe cannot read a missing HEAD: it deliberately
    // substitutes now, making the lane forever "recent". For quarantine ONLY, prove a stronger
    // quiet bound over every tracked/nonignored path and every existing HEAD/ref/reflog file.
    // Then rerun the same owner/cwd gate with that independently proven quiet period.
    if (quarantined && result?.eligible === false && /^lane content changed .*quiet period/.test(result.reason || '')) {
      const quietMs = resolveSalvageQuietMs();
      let newest = 0, count = 0;
      const observe = path => {
        if (++count > maxFiles) throw Error('quiet evidence exceeds file bound; salvage manually');
        let mtime;
        try { mtime = lstatSync(path).mtimeMs; }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          mtime = nearestAncestorMtimeMs(path, dir);
        }
        if (!Number.isFinite(mtime)) throw Error('unreadable quiet evidence; inspect manually');
        newest = Math.max(newest, mtime);
      };
      const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
      for (const path of paths) {
        if (isAbsolute(path) || path.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) throw Error('unsafe quiet path; salvage manually');
        observe(join(dir, path));
      }
      observe(join(dir, '.git', 'HEAD'));
      const refs = path => {
        let entries;
        try { entries = readdirSync(path, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) throw Error('symbolic ref directory; inspect manually');
          if (entry.isDirectory()) { if (++count > maxFiles) throw Error('quiet evidence exceeds file bound; salvage manually'); refs(join(path, entry.name)); }
          else observe(join(path, entry.name));
        }
      };
      refs(join(dir, '.git', 'refs'));
      refs(join(dir, '.git', 'logs'));
      if (!Number.isFinite(quietMs) || quietMs < 0 || Date.now() - newest < quietMs) throw Error('quarantined worktree is not provably quiet; wait for quiet period or salvage manually');
      result = livenessGate({ dir, ignoreLeaseSession: hold?.session, quietMs: 0 });
    }
    if (result?.eligible !== true) throw Error(result?.reason || 'unknown liveness; inspect manually');
  };
  const assertLease = () => {
    const current = readLease(file);
    if (!hold || JSON.stringify(current) !== JSON.stringify(hold) || isLeaseStale(current, Date.now())) throw Error('lease changed or expired; lane kept');
  };
  try {
    const existing = readLease(file);
    if (existing && !isLeaseStale(existing, Date.now())) return { status: 'kept', reason: 'live lease' };
    gate();
    if (!dryRun) {
      const session = `dirty-salvage-${process.pid}-${randomUUID()}`;
      if (claimLane) {
        if (!claimLane(session)) return { status: 'kept', reason: 'lease claim refused' };
      } else {
        // Never replace even an expired marker without the pool's atomic stale-lease machinery.
        writeFileSync(file, JSON.stringify(leaseBody({ session, purpose: 'dirty-salvage', acquiredAt: new Date().toISOString(), pid: process.pid })), { flag: 'wx' });
      }
      hold = readLease(file);
      if (hold?.session !== session) { hold = null; throw Error('lease changed during claim'); }
      assertLease(); gate();
    }
    const snapshot = () => {
      let parent = null;
      const head = git(['rev-parse', '--verify', 'HEAD']).trim();
      try {
        git(['rev-list', '--objects', '--missing=error', head]);
        parent = head;
      } catch { /* Only status can establish dirty paths without readable ancestry. */ }
      const probeDir = mkdtempSync(join(tmpdir(), 'lane-dirty-index-'));
      try {
        const probe = (args, extra = {}) => git(args, { ...extra, env: { ...env, GIT_INDEX_FILE: join(probeDir, 'index') } });
        const index = readFileSync(join(dir, '.git', 'index'));
        // Diff may refresh stat/cache metadata even during a read. Keep all index probes
        // isolated while fingerprinting the original index to detect concurrent edits.
        writeFileSync(join(probeDir, 'index'), index);
        const tracked = probe(['ls-files', '--stage', '-z']);
        if (tracked.split('\0').some(entry => entry && !/^(?:100644|100755|120000) [a-f0-9]+ 0\t/.test(entry))) throw Error('unmerged index or nested repository; salvage manually');
        const stagedEntries = tracked.split('\0').filter(Boolean).map(entry => {
          const tab = entry.indexOf('\t');
          const [mode, sha] = entry.slice(0, tab).split(' ');
          return { mode, sha, path: entry.slice(tab + 1) };
        });
        if (stagedEntries.length > maxFiles) throw Error('index snapshot exceeds file bound; salvage manually');
        // Enumerate the original entries, then rebuild only the disposable index. This drops
        // assume-unchanged, skip-worktree and cached stat/fsmonitor evidence so diff must inspect
        // tracked worktree content too. Original flags/index bytes remain untouched and guarded.
        probe(['read-tree', '--empty']);
        probe(['-c', 'core.ignoreStat=false', 'update-index', '-z', '--index-info'], { input: tracked });
        let changed, stagedPaths, status = null;
        if (parent) {
          changed = probe(['diff', '--name-only', '--no-ext-diff', '--no-textconv', '--no-renames', '-z', parent, '--']);
          stagedPaths = probe(['diff', '--cached', '--name-only', '--no-ext-diff', '--no-textconv', '--no-renames', '-z', parent, '--']).split('\0').filter(Boolean);
        } else {
          status = probe(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
          const records = status.split('\0');
          if (records.pop() !== '') throw Error('incomplete dirty status; inspect lane manually');
          const dirty = [], staged = [];
          for (let i = 0; i < records.length; i++) {
            const entry = records[i];
            if (!/^(?:[ MADRCUT?!]{2}) /.test(entry) || entry.length < 4) throw Error('unreadable dirty status; inspect lane manually');
            const xy = entry.slice(0, 2), path = entry.slice(3);
            if (xy.includes('U') || xy === '!!') throw Error('unmerged or unknown dirty status; inspect lane manually');
            dirty.push(path);
            if (xy[0] !== ' ' && xy !== '??') staged.push(path);
            // Porcelain -z emits destination first, then the original path for renames/copies.
            if (/[RC]/.test(xy)) {
              const source = records[++i];
              if (!source) throw Error('incomplete rename status; inspect lane manually');
              dirty.push(source);
              if (/[RC]/.test(xy[0])) staged.push(source);
            }
          }
          changed = dirty.join('\0');
          stagedPaths = [...new Set(staged)];
        }
        const untracked = parent ? probe(['ls-files', '--others', '--exclude-standard', '-z']) : '';
        const paths = [...new Set([...changed.split('\0'), ...stagedPaths, ...untracked.split('\0')].filter(Boolean))].sort();
        if (paths.length > maxFiles) throw Error('snapshot exceeds file bound; salvage manually or raise maxFiles after inspection');
        let bytes = 0;
        const files = paths.map(path => {
          if (isAbsolute(path) || path.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) throw Error('unsafe dirty path; salvage manually');
          const full = join(dir, path);
          let ancestorPath = dirname(full), ancestor;
          for (;;) {
            try { ancestor = realpathSync(ancestorPath); break; }
            catch (error) {
              if (error.code !== 'ENOENT' || ancestorPath === dirname(ancestorPath)) throw error;
              ancestorPath = dirname(ancestorPath);
            }
          }
          const rel = relative(realpathSync(dir), ancestor);
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Error('dirty path escapes lane; salvage manually');
          let stat;
          try { stat = lstatSync(full); } catch (error) { if (error.code === 'ENOENT') return { path, mode: null, data: null }; throw error; }
          if (!stat.isFile() && !stat.isSymbolicLink()) throw Error('nested repository or special file; salvage manually');
          bytes += stat.size;
          if (bytes > maxBytes) throw Error('snapshot exceeds byte bound; salvage manually or raise maxBytes after inspection');
          const data = stat.isSymbolicLink() ? Buffer.from(readlinkSync(full)) : readFileSync(full);
          bytes += Math.max(0, data.length - stat.size);
          if (bytes > maxBytes) throw Error('snapshot exceeds byte bound; salvage manually or raise maxBytes after inspection');
          return { path, mode: stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644', data };
        });
        // The index is independently authored content. Scan its changed blobs too, including
        // a staged value subsequently replaced (or reverted to HEAD) in the worktree.
        const entriesByPath = new Map(stagedEntries.map(entry => [entry.path, entry]));
        const stagedFiles = stagedPaths.map(path => {
          const entry = entriesByPath.get(path);
          if (!entry) return { path, data: null }; // staged deletion
          const size = Number(probe(['cat-file', '-s', entry.sha]).trim());
          if (!Number.isSafeInteger(size) || size < 0 || bytes + size > maxBytes) throw Error('index snapshot exceeds byte bound; salvage manually');
          const data = probe(['cat-file', 'blob', entry.sha], { encoding: null });
          bytes += data.length;
          if (bytes > maxBytes) throw Error('index snapshot exceeds byte bound; salvage manually');
          return { path, data };
        });
        const evidence = { head, parent, index: digest(index), tracked, untracked, status, files: files.map(f => [f.path, f.mode, f.data === null ? null : digest(f.data)]) };
        const fingerprint = digest(JSON.stringify(evidence));
        return { parent, files, stagedFiles, stagedEntries: parent ? stagedEntries : stagedEntries.filter(entry => stagedPaths.includes(entry.path)), fingerprint, evidence };
      } finally { rmSync(probeDir, { recursive: true, force: true }); }
    };
    const saved = snapshot();
    if (!saved.files.length) return { status: 'clean' };
    // Generic 'long base64/hex blob' patterns false-positive on ordinary code (SHAs, identifiers); the token-shaped ones stay.
    const credentialHit = data => SECRET_PATTERNS.filter(([, label]) => !/^long /.test(label)).some(([pattern]) => {
      pattern.lastIndex = 0;
      return pattern.test(data.toString('utf8'));
    });
    const hits = [...new Set([...saved.files, ...saved.stagedFiles]
      .filter(({ data }) => data && credentialHit(data)).map(({ path }) => safePath(path)))];
    if (hits.length) return { status: 'kept', reason: `credential-scan hit: ${hits.join(', ')}` };
    // A WIP parent uploads its entire reachable history, including files removed in later commits.
    // Only a freshly verified canonical-origin commit may exclude objects from this scan; local
    // tracking refs are not publication evidence. Unknown/unreadable/oversized history stays local.
    if (saved.parent) {
      if (!Number.isSafeInteger(maxHistoryObjects) || maxHistoryObjects < 0
        || !Number.isSafeInteger(maxHistoryBytes) || maxHistoryBytes < 0) throw Error('invalid history scan bound; salvage manually');
      const published = await io.remoteSha(repo.branch);
      if (published !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(published)) throw Error('unreadable origin history boundary; salvage manually');
      let boundary = null;
      if (published) {
        try { git(['cat-file', '-e', `${published}^{commit}`]); boundary = published; }
        catch { /* Without the published object locally, scan everything reachable instead. */ }
      }
      const listing = git(['rev-list', '--objects', '--missing=error', saved.parent, ...(boundary ? ['--not', boundary] : [])]);
      const objects = listing.trimEnd() ? listing.trimEnd().split('\n') : [];
      if (objects.length > maxHistoryObjects) throw Error('history scan exceeds object bound; salvage manually');
      let bytes = 0;
      for (const line of objects) {
        const match = /^([a-f0-9]{40}|[a-f0-9]{64})(?: (.*))?$/.exec(line);
        if (!match) throw Error('unreadable history object listing; salvage manually');
        const [, object, path] = match;
        const type = git(['cat-file', '-t', object]).trim();
        if (!['blob', 'commit', 'tree'].includes(type)) throw Error('unknown history object type; salvage manually');
        const size = Number(git(['cat-file', '-s', object]).trim());
        if (!Number.isSafeInteger(size) || size < 0 || bytes + size > maxHistoryBytes) throw Error('history scan exceeds byte bound; salvage manually');
        let data = git(['cat-file', type, object], { encoding: null });
        bytes += data.length;
        if (data.length !== size || bytes > maxHistoryBytes) throw Error('incomplete or oversized history scan; salvage manually');
        if (type === 'commit') {
          // Object identifiers are structural, not credential content. Scan every other header
          // (including signatures/identities) and the complete message without exposing any of it.
          const split = data.indexOf('\n\n');
          if (split < 0) throw Error('unreadable history commit; salvage manually');
          const headers = data.subarray(0, split).toString('utf8').split('\n')
            .filter(header => !/^(?:tree|parent) (?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(header));
          data = Buffer.concat([Buffer.from(`${headers.join('\n')}\n\n`), data.subarray(split + 2)]);
        }
        if (credentialHit(data)) return { status: 'kept', reason: `credential-scan hit: ${type === 'blob' && path ? safePath(path) : `(history ${type})`}` };
      }
    }
    // Dirty-only parentless refs cannot preserve committed work outside the dirty set.
    // Retain the original clone through the same backup/reprovision path as quarantine.
    const retainClone = quarantined || !saved.parent;
    if (dryRun) return { status: 'kept', reason: `would salvage ${saved.files.length} dirty file(s), verify push, then ${retainClone ? 're-provision' : 'reclaim'}` };
    if (typeof journal !== 'function' || typeof (retainClone ? reprovision : reclaim) !== 'function') throw Error('missing journal or provision path; inspect manually');
    assertLease();
    scratch = mkdtempSync(join(tmpdir(), 'lane-dirty-salvage-'));
    git(['init', '--bare', '--quiet', scratch]);
    // Push from this isolated repository: corrupt branch/stash refs in the lane never enter pack-objects.
    const laneObjects = git(['rev-parse', '--path-format=absolute', '--git-path', 'objects']).trim();
    writeFileSync(join(scratch, 'objects', 'info', 'alternates'), `${laneObjects}\n`);
    const buildEnv = { ...env, GIT_INDEX_FILE: join(scratch, 'wip-index'), GIT_OBJECT_DIRECTORY: join(scratch, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: laneObjects,
      GIT_AUTHOR_NAME: 'Lane salvage', GIT_AUTHOR_EMAIL: 'lane-salvage@localhost',
      GIT_COMMITTER_NAME: 'Lane salvage', GIT_COMMITTER_EMAIL: 'lane-salvage@localhost' };
    const build = (args, extra = {}) => git(args, { env: buildEnv, ...extra }).trim();
    const deletionBody = files => saved.parent ? '' : `\nDeleted paths (JSON):\n${JSON.stringify(files.filter(f => f.data === null).map(f => f.path))}\n`;
    let indexSha = null;
    if (saved.stagedFiles.length) {
      build(['read-tree', '--empty']);
      for (const { mode, sha, path } of saved.stagedEntries) build(['update-index', '--add', '--cacheinfo', mode, sha, path]);
      const indexTree = build(['write-tree']);
      indexSha = build(['commit-tree', indexTree, ...(saved.parent ? ['-p', saved.parent] : [])], {
        input: `salvage: lane-${n} staged files ${now().toISOString()}\n${deletionBody(saved.stagedFiles)}`,
      });
    }
    build(['read-tree', saved.parent || '--empty']);
    for (const { path, mode, data } of saved.files) {
      if (!mode) build(['update-index', '--force-remove', '--', path]);
      else {
        const sha = build(['hash-object', '--no-filters', '-w', '--stdin'], { input: data });
        build(['update-index', '--add', '--cacheinfo', mode, sha, path]);
      }
    }
    const tree = build(['write-tree']);
    const sha = build(['commit-tree', tree, ...(saved.parent ? ['-p', saved.parent] : [])], {
      input: `salvage: lane-${n} dirty files ${now().toISOString()}\n${deletionBody(saved.files)}`,
    });
    const ref = salvageRefName(n, now());
    const indexRef = indexSha ? `${ref}-index` : null;
    const preserved = [...(indexSha ? [{ lane: n, ref: indexRef, sha: indexSha }] : []), { lane: n, ref, sha }];
    // Both refs must be new and verified before the original index/worktree can be reset.
    for (const tip of preserved) {
      if (await io.remoteSha(tip.ref) !== null) throw Error('salvage ref occupied; retry next minute or salvage manually');
    }
    for (const tip of preserved) {
      pushAttempted = true;
      if ((await io.push(scratch, tip.ref, tip.sha, { createOnly: true }))?.ok !== true) throw Error('salvage push failed; lane kept');
      if (await io.remoteSha(tip.ref) !== tip.sha) throw Error('remote SHA verification failed; lane kept');
    }
    mkdirSync(dirname(mapFile), { recursive: true });
    appendFileSync(mapFile, preserved.map(tip => `${JSON.stringify(tip)}\n`).join(''));
    journal({ action: 'dirty-salvage-verified', reason: `verified ${preserved.map(tip => `${tip.ref}=${tip.sha}`).join(', ')}`, salvagedTo: ref });
    const assertUnchanged = () => {
      assertLease(); gate();
      const current = snapshot();
      if (current.fingerprint !== saved.fingerprint) {
        const changed = Object.keys(saved.evidence).filter(key => JSON.stringify(current.evidence[key]) !== JSON.stringify(saved.evidence[key]));
        throw Error(`dirty files, index or HEAD changed during salvage; lane kept (${changed.join(', ')})`);
      }
    };
    assertUnchanged();
    if (retainClone) reprovision({ assertLease, assertUnchanged });
    else reclaim({ assertLease, assertUnchanged });
    assertLease();
    if (git(['status', '--porcelain', '--untracked-files=all']).trim()) throw Error('provisioned lane is not clean; quarantine retained, inspect manually');
    git(['rev-list', '--objects', '--missing=error', 'HEAD']);
    if (quarantined) rmSync(quarantinePath); // only proven readable + clean lanes leave quarantine
    journal({ action: 'dirty-salvage-reset', reason: `reclaimed after verified ${ref}=${sha}`, salvagedTo: ref });
    return { status: 'salvaged', ref, sha, ...(indexSha ? { indexRef, indexSha } : {}) };
  } catch (error) {
    // Never emit git stderr: it may contain file contents or credentials from config/transport.
    const reason = error?.path || error?.stderr ? 'unreadable or failed git/filesystem evidence; inspect lane manually' : safePath(error?.message || 'salvage failed; inspect lane manually');
    return { status: 'kept', reason, ...(pushAttempted ? { pushAttempted: true } : {}) };
  } finally {
    if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* no lane state is stored here */ } }
    if (hold) {
      try {
        if (JSON.stringify(readLease(file)) === JSON.stringify(hold)) {
          if (releaseLane) releaseLane(hold);
          else rmSync(file);
        }
      } catch { /* A changed/unreadable lease is never ours to remove. */ }
    }
  }
}
