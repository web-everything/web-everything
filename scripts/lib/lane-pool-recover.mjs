import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isUnderTest } from './under-test.mjs';
import { laneGitHardeningEnv, scrubGitRepoEnv } from './lane-git-hardening.mjs';

const clean = (value, max = 2000) => String(value).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').slice(0, max);
const message = e => clean(e?.message || e);
const processOptions = { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 };

// An automatic override is bound to the bytes actually copied, not merely the same path names.
// Oversized/unreadable cards stay in the lane for manual inspection rather than receiving override.
function cardDigest(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('backup card is unreadable or exceeds 8 MiB; inspect the lane manually');
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) throw new Error('backup card changed while reading');
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyRecoveryBackup({ laneDir, proof, manifestPath }) {
  try {
    if (typeof proof === 'function') proof = proof();
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('invalid backup manifest');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (proof?.error || manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object'
      || !Array.isArray(proof.unpreservedFiles) || !Array.isArray(proof.unpreservedCommitShas)
      || proof.unpreservedCommitShas.length) throw new Error('incomplete backup evidence');
    for (const file of proof.unpreservedFiles) {
      if (!qualifiesForCardBackup({ preserved: false, unpreservedFiles: [file], unpreservedCommitShas: [] })
        || !Object.hasOwn(manifest.files, file) || !/^[a-f0-9]{64}$/.test(manifest.files[file])
        || cardDigest(join(laneDir, file)) !== manifest.files[file]) throw new Error('content changed after backup');
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: `recovery backup verification failed: ${message(e)}; inspect the lane or retry recovery` }; }
}

export function classifyLaneNames(names, hardMax) {
  const valid = [], rejected = [];
  for (const name of names) {
    if (!/^lane-(0|[1-9]\d*)$/.test(name) || /[\r\n]/.test(name)) rejected.push({ name, why: 'not-integer' });
    else {
      const n = Number(name.slice(5));
      if (!Number.isSafeInteger(n) || n < 1 || n > hardMax) rejected.push({ name, why: 'out-of-range' });
      else valid.push(n);
    }
  }
  return { valid: [...new Set(valid)].sort((a, b) => a - b), rejected };
}

export function nextLaneNumbers(lanes, hardMax, count) {
  const used = new Set(lanes), result = [];
  for (let n = 1; n <= hardMax && result.length < count; n++) if (!used.has(n)) result.push(n);
  return result;
}

export function capState(lanes, hardMax) {
  return { count: lanes.length, hardMax, atCap: lanes.length >= hardMax };
}

export function qualifiesForCardBackup(proof) {
  return !proof?.error && proof?.preserved === false
    && Array.isArray(proof.unpreservedCommitShas) && proof.unpreservedCommitShas.length === 0
    && Array.isArray(proof.unpreservedFiles) && proof.unpreservedFiles.length > 0
    && proof.unpreservedFiles.every(file => /^backlog\/[^/]+\.md$/.test(file) && file !== 'backlog/.md' && file.endsWith('.md'));
}

/** IO is injected so an incomplete copy or patch write can never authorize reclaim. */
export async function backupLaneContent({ lane, laneDir, backupRoot, io }) {
  const dir = join(backupRoot, `lane-${lane}-preserve`), files = [];
  try {
    await io.mkdirp(dir);
    for (const file of await io.untracked(laneDir)) {
      const src = join(laneDir, file), rel = relative(resolve(laneDir), resolve(src));
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('unsafe backup path');
      const dst = join(dir, rel);
      await io.mkdirp(dirname(dst));
      await io.copyFile(src, dst);
      if (!await io.exists(dst) || await io.size(src) !== await io.size(dst)) throw new Error(`backup verification failed: ${file}`);
      files.push(dst);
    }
    const stashes = await io.stashCount(laneDir);
    if (!Number.isSafeInteger(stashes) || stashes < 0) throw new Error('unreadable stash count');
    for (let i = 0; i < stashes; i++) {
      const patch = await io.stashPatch(laneDir, i), path = join(dir, `stash-${i}.patch`);
      if (typeof patch !== 'string') throw new Error('unreadable stash patch');
      await io.writeFile(path, patch);
      if (!await io.exists(path) || await io.size(path) !== Buffer.byteLength(patch)) throw new Error(`stash backup verification failed: ${i}`);
    }
    return { ok: true, dir, files, stashes };
  } catch (e) { return { ok: false, dir, error: message(e) }; }
}

function recoveryBudget() {
  const raw = process.env.LANE_POOL_RECOVER_BUDGET_MS;
  return raw !== undefined && raw.trim() && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 240_000;
}

export async function recoverPool({ lanes, io, budgetMs = recoveryBudget(), now = Date.now }) {
  const result = { reclaimed: [], keptUnpushed: [], keptLeased: [], skipped: [], backedUp: [], budgetExhausted: false };
  const start = now();
  for (let i = 0; i < lanes.length; i++) {
    if (now() - start >= budgetMs) {
      result.skipped.push(...lanes.slice(i));
      result.budgetExhausted = true;
      break;
    }
    const n = lanes[i];
    try {
      if (await io.isLeased(n)) { result.keptLeased.push(n); continue; }
      const proof = await io.proof(n);
      if (proof?.error) throw new Error(proof.error);
      const override = qualifiesForCardBackup(proof);
      const preserved = proof?.preserved === true && Array.isArray(proof.unpreservedFiles)
        && proof.unpreservedFiles.length === 0 && Array.isArray(proof.unpreservedCommitShas) && proof.unpreservedCommitShas.length === 0;
      if (!preserved && !override) throw new Error(proof?.reason || 'incomplete preservation proof');
      const backup = await io.backup(n);
      if (backup?.ok !== true) throw new Error(`backup failed: ${backup?.error || 'verification incomplete'}`);
      result.backedUp.push(n);
      if (await io.isLeased(n)) { result.keptLeased.push(n); continue; }
      // Override is ONLY for card-only evidence after verified backup. realRecoverIo supplies a
      // content manifest that reclaim verifies under its lease before the destructive reset.
      const reclaimed = await io.reclaim(n, { override });
      if (reclaimed?.reclaimed === true) result.reclaimed.push(n);
      else throw new Error(reclaimed?.error || 'reclaim refused');
    } catch (e) { result.keptUnpushed.push({ lane: n, reason: message(e) }); }
  }
  return result;
}

export function diagnosePool({ verdictByLane = {}, keptUnpushed = [], rejected = [], keptLeased = [], skipped = [], budgetExhausted = false }) {
  const verdictCounts = {};
  for (const verdict of Object.values(verdictByLane)) verdictCounts[verdict] = (verdictCounts[verdict] || 0) + 1;
  const unpushedLanes = keptUnpushed.map(row => row.lane).sort((a, b) => a - b);
  const rejectedNames = rejected.map(row => row.name);
  const summary = clean(`Full pool: ${Object.entries(verdictCounts).map(([v, n]) => `${v}: ${n}`).join(', ')}; unpushed lanes ${unpushedLanes.join(', ')}; leased ${keptLeased.length}; skipped ${skipped.length}${budgetExhausted ? ' (recovery budget exhausted; run gc again or inspect lanes)' : ''}; ignored ${rejectedNames.join(', ')}`);
  return { verdictCounts, unpushedLanes, rejectedNames, summary };
}

export function buildNeedsYouItem({ repoName, diagnosis, nowIso = new Date().toISOString() }) {
  return { key: `lane-pool-full:${repoName}`, repo: clean(repoName, 200), kind: 'needs-you', pr: 0,
    head: 'lane-pool-full', reason: clean(diagnosis.summary, 100), title: clean(`Lane pool full: ${diagnosis.summary}`, 200), at: nowIso };
}

export async function emitFullPoolNeedsYou({ repoName, diagnosis, publish }) {
  try {
    if (!publish && isUnderTest() && !process.env.WE_NEEDS_YOU_FEED) throw new Error('test attention publishing requires a private WE_NEEDS_YOU_FEED');
    const publisher = publish || (await import('../operations/needs-you-feed.mjs')).publishAttention;
    await publisher(buildNeedsYouItem({ repoName, diagnosis }));
  } catch (e) { console.error(`lane-pool recovery: attention publish failed: ${message(e)}`); }
}

export async function collectVerdicts({ lanePoolDir, runWhois = execFileSync }) {
  try {
    const script = fileURLToPath(new URL('../lane-whois.mjs', import.meta.url));
    const raw = await runWhois(process.execPath, [script, '--json', `--pool-root=${dirname(lanePoolDir)}`, `--name=${basename(lanePoolDir)}`], { ...processOptions, timeout: 480_000 });
    const report = JSON.parse(String(raw));
    return Object.fromEntries(report.lanes.filter(row => Number.isInteger(row.lane) && typeof row.verdict === 'string').map(row => [row.lane, row.verdict]));
  } catch { return {}; }
}

export function realRecoverIo({ repo, lanePoolPath, backupRoot = process.env.WE_LANE_BACKUP_ROOT || join(homedir(), 'workspace', '.operations', 'backup'), isLeased, runGit = execFileSync }) {
  const proofs = new Map(), backups = new Map();
  const run = (args, env = {}) => spawnSync(process.execPath, [lanePoolPath, 'reclaim', ...args, `--repo=${repo.referencePath}`,
    ...Object.entries({ origin: repo.originUrl, reference: repo.referencePath, name: repo.name, branch: repo.branch })
      .filter(([, value]) => value != null).map(([key, value]) => `--${key}=${value}`)], { ...processOptions, env: { ...process.env, ...env } });
  const gitEnv = laneGitHardeningEnv({ ...scrubGitRepoEnv(process.env), GIT_OPTIONAL_LOCKS: '0' });
  const git = (dir, args) => runGit('git', args, { ...processOptions, cwd: dir, env: gitEnv });
  const backupIo = {
    untracked: dir => {
      // -z keeps spaces, newlines, and quoted paths literal; ?? entries are the only copied paths.
      const entries = git(dir, ['status', '--porcelain', '--untracked-files=all', '-z']).split('\0'), files = [];
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].startsWith('?? ')) files.push(entries[i].slice(3));
        if (/^[RC]|^.[RC]/.test(entries[i])) i++; // rename/copy source is a separate NUL record
      }
      return files;
    },
    stashCount: dir => git(dir, ['stash', 'list', '--format=%gd']).split('\n').filter(Boolean).length,
    stashPatch: (dir, i) => git(dir, ['stash', 'show', '-p', `stash@{${i}}`]),
    mkdirp: path => mkdirSync(path, { recursive: true }),
    copyFile: (src, dst) => {
      if (!lstatSync(src).isFile()) throw new Error('backup refuses non-regular untracked content');
      copyFileSync(src, dst);
    },
    writeFile: (path, value) => writeFileSync(path, value),
    exists: existsSync, size: path => lstatSync(path).size,
  };
  return {
    isLeased,
    proof: n => {
      backups.delete(n);
      const result = run([`--lane=${n}`, '--dry-run', '--json']);
      try {
        const stdout = result.stdout || '';
        const proof = JSON.parse(stdout.slice(stdout.indexOf('{')));
        if (result.error || proof.kept || typeof proof.preserved !== 'boolean') return { error: message(result.error || proof.keptReason || 'lane kept or incomplete proof') };
        proofs.set(n, proof);
        return proof;
      } catch { return { error: message(result.error || result.stderr || 'reclaim returned no JSON proof') }; }
    },
    backup: async n => {
      backups.delete(n);
      // Each attempt gets a fresh directory: never overwrite an earlier lane's preserved content.
      const root = join(backupRoot, repo.name);
      mkdirSync(root, { recursive: true });
      const proof = proofs.get(n);
      // A top-level card can also be a tracked edit; preserve it alongside all ?? entries.
      const io = { ...backupIo, untracked: dir => [...new Set([...backupIo.untracked(dir),
        ...(qualifiesForCardBackup(proof) ? proof.unpreservedFiles : [])])] };
      const laneDir = join(repo.poolDir, `lane-${n}`);
      const backup = await backupLaneContent({ lane: n, laneDir, backupRoot: mkdtempSync(join(root, 'recover-')), io });
      if (!backup.ok || !qualifiesForCardBackup(proof)) return backup;
      try {
        const files = Object.fromEntries(proof.unpreservedFiles.map(file => [file, cardDigest(join(backup.dir, file))]));
        const manifestPath = join(backup.dir, 'reclaim-proof.json');
        writeFileSync(manifestPath, JSON.stringify({ version: 1, files }), { flag: 'wx' });
        const verified = verifyRecoveryBackup({ laneDir, proof, manifestPath });
        if (!verified.ok) return { ...backup, ...verified };
        backups.set(n, manifestPath);
        return { ...backup, manifestPath };
      } catch (e) { return { ...backup, ok: false, error: message(e) }; }
    },
    reclaim: (n, { override }) => {
      if (override && !backups.has(n)) return { reclaimed: false, error: 'verified card backup is required' };
      const result = run([`--lane=${n}`, ...(override ? ['--override'] : []), '--reason=auto-recover: content backed up'],
        override ? { WE_LANE_RECOVERY_BACKUP: backups.get(n) } : {});
      return { reclaimed: result.status === 0 && !result.error && /lane-\d+: reclaimed\b/i.test(`${result.stdout}\n${result.stderr}`), error: result.error ? message(result.error) : clean(result.stderr || result.stdout || 'reclaim refused') };
    },
  };
}
