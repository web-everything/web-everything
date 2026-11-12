// Client side of the git-bundle remote transport (R593, ladder step 4 of remote-exec-git-sync).
// With `remote.transport=git-bundle` and a runner that advertises `gitBundle:1`, a run that needs git
// ships a verified bundle (public-main..HEAD, or a full bundle when no common base exists) over the same
// rsync channel instead of making Forge fetch an unpushed HEAD from GitHub. The default stays `rsync`.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { classifyManifestPath, credentialTextFinding, credentialBufferFinding, credentialContentFinding, credentialContentWarning, excludedDotFile, secretFileName, unsafeComponentName } from './forge-exec-manifest.mjs';

export const REMOTE_TRANSPORTS = Object.freeze(['rsync', 'git-bundle']);
export const DEFAULT_REMOTE_TRANSPORT = 'rsync';
export const GIT_BUNDLE_CAPABILITY = 1;
/** Must match the runner's BUNDLE_MAX_BYTES; a bigger bundle falls back instead of being shipped. */
export const BUNDLE_MAX_BYTES = 512 * 1024 * 1024;
/** Same ceiling as the remote.bundle.mainMaxAgeMin setting (1440 min); the runner refuses anything above it. */
export const MAIN_MAX_AGE_CEILING_MS = 1440 * 60_000;

const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** Anything but an exact `git-bundle` is the rsync default. */
export function resolveTransport(value) { return value === 'git-bundle' ? 'git-bundle' : DEFAULT_REMOTE_TRANSPORT; }

/** True only for a runner that explicitly advertises the bundle capability. */
export function runnerSupportsBundle(capabilities) { return capabilities?.gitBundle === GIT_BUNDLE_CAPABILITY; }

export function bundleError(code, detail) { return Object.assign(new Error(`git bundle: ${code}`), { code, detail }); }

async function digestFile(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = createReadStream(path);
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * Decide and build the bundle for `head`. `runnerBase` is the Forge mirror's main tip from its prepare reply.
 * Modes: none (Forge already has `head`), incremental (`^merge-base`), full (no usable base).
 * The caller owns `directory` and removes it.
 */
export async function planBundle({ cwd, head, runnerBase, exec, directory }) {
  if (!REVISION.test(head ?? '')) throw bundleError('invalid-head');
  const git = (args) => exec({ file: 'git', args, cwd });
  let prerequisite = null;
  if (REVISION.test(runnerBase ?? '')) {
    const known = await git(['cat-file', '-e', `${runnerBase}^{commit}`]);
    if (known.code === 0) {
      const mb = await git(['merge-base', head, runnerBase]);
      const sha = String(mb.stdout ?? '').trim();
      if (mb.code === 0 && REVISION.test(sha)) prerequisite = sha;
    }
  }
  if (prerequisite === head) return { mode: 'none', tip: head, warnings: [] };
  // R559: the same credential policy as the rsync path, over EVERY commit in the bundled range (a secret
  // committed and later deleted still travels in the pack). Fail closed before any bundle is built or sent.
  const warnings = [];
  const hit = await scanBundleRange({ cwd, head, prerequisite, exec, warnings });
  if (hit) throw bundleError('bundle-credential-hit', `${hit.path}: ${hit.finding}`);
  const file = join(directory, 'git.bundle');
  // R559: bundle the exact scanned sha through a unique temporary ref, never the live HEAD (which may have moved
  // after the scan). The ref is removed again whatever happens.
  const ref = `refs/we/bundle-${randomBytes(8).toString('hex')}`;
  const pinned = await git(['update-ref', ref, head]);
  if (pinned.code !== 0) throw bundleError('bundle-create-failed', 'pin-ref');
  try {
    const created = await git(['bundle', 'create', file, ref, ...(prerequisite ? [`^${prerequisite}`] : [])]);
    if (created.code !== 0) throw bundleError('bundle-create-failed', String(created.stderr ?? '').slice(-200));
  } finally { await git(['update-ref', '-d', ref]); }
  const info = await stat(file);
  if (!info.isFile() || info.size <= 0 || info.size > BUNDLE_MAX_BYTES) throw bundleError('bundle-size-unsupported');
  // The Mac proves its own file is internally consistent before spending bandwidth on it.
  const verified = await git(['bundle', 'verify', file]);
  if (verified.code !== 0) throw bundleError('bundle-self-verify-failed');
  // The shipped tip must equal the scanned sha, and be the only head in the file.
  const listed = await git(['bundle', 'list-heads', file]);
  const lines = bytes(listed.stdout).toString('utf8').split('\n').filter(Boolean);
  if (listed.code !== 0 || lines.length !== 1 || lines[0].split(' ')[0] !== head) throw bundleError('bundle-tip-mismatch');
  return { mode: prerequisite ? 'incremental' : 'full', warnings, tip: head, file, bytes: info.size, sha256: await digestFile(file),
    ...(prerequisite ? { base: prerequisite } : {}) };
}

/** The wire evidence the runner re-checks; the file path is never transmitted. */
export function bundleEvidence(plan) {
  return plan.mode === 'none' ? { mode: 'none' } : { mode: plan.mode, sha256: plan.sha256, bytes: plan.bytes };
}

export async function makeBundleDirectory() { return mkdtemp(join(tmpdir(), 'forge-exec-bundle-')); }
export async function removeBundleDirectory(directory) { if (directory) await rm(directory, { recursive: true, force: true }); }

/** Runner capability cache: written by the client at prepare time, read by routing before any connection. */
export const CAPABILITY_TTL_MS = 60 * 60_000;
export function capabilityRecord({ host, capabilities, nowMs }) {
  return { host, gitBundle: runnerSupportsBundle(capabilities) ? GIT_BUNDLE_CAPABILITY : 0, atMs: nowMs };
}
export function capabilityAdvertisesBundle(record, { host, nowMs, ttlMs = CAPABILITY_TTL_MS }) {
  return !!record && record.host === host && record.gitBundle === GIT_BUNDLE_CAPABILITY
    && Number.isFinite(record.atMs) && nowMs - record.atMs >= 0 && nowMs - record.atMs <= ttlMs;
}

/** R807: 'no' only for a fresh record of this host saying gitBundle is absent; expired, missing, foreign or future records
 *  are 'unknown' (prepare re-checks and refuses safely), so an expired cache cannot lock git-needing runs local forever. */
export function capabilityBundleVerdict(record, { host, nowMs, ttlMs = CAPABILITY_TTL_MS }) {
  if (capabilityAdvertisesBundle(record, { host, nowMs, ttlMs })) return 'yes';
  const fresh = !!record && record.host === host && Number.isFinite(record.atMs) && nowMs - record.atMs >= 0 && nowMs - record.atMs <= ttlMs;
  return fresh && record.gitBundle !== GIT_BUNDLE_CAPABILITY ? 'no' : 'unknown';
}

const SCAN_BATCH_BYTES = 3 * 1024 * 1024; // below the client's 4 MiB capture limit
const NUL = 0;
function splitNul(buffer) {
  const out = []; let start = 0;
  for (let i = 0; i < buffer.length; i++) if (buffer[i] === NUL) { out.push(buffer.subarray(start, i)); start = i + 1; }
  if (start < buffer.length) out.push(buffer.subarray(start));
  return out;
}
/** Split a -U3 diff after its first hunk header: added lines, and context+added lines (each newline-terminated, no prefix). */
function splitDiffLines(raw) {
  const added = [], context = []; let start = -1, removed = false, line = 0, from = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i !== raw.length && raw[i] !== 10) continue;
    const first = raw[from];
    if (start < 0 && first === 0x40 && raw[from + 1] === 0x40) start = line;
    else if (start >= 0) {
      const text = raw.subarray(from + 1, i);
      if (first === 0x2b) { added.push(text, Buffer.from('\n')); context.push(text, Buffer.from('\n')); }
      else if (first === 0x20) context.push(text, Buffer.from('\n'));
      else if (first === 0x2d) removed = true;
    }
    line++; from = i + 1;
  }
  return { start, removed, added: Buffer.concat(added), context: Buffer.concat(context) };
}
const SIGNATURE_ARMOR = /-----(?:BEGIN|END) (?:PGP SIGNATURE|SSH SIGNATURE|SIGNED MESSAGE)-----/g;
const bytes = (value) => Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');

/**
 * R559: scan every bundled commit's additions beyond the prerequisite tree (or the whole history when it is null).
 * Path policy is the manifest's own exclusion policy; content uses its raw token patterns.
 * Returns the first {path, finding} or null; throws bundle-credential-scan-too-large instead of skipping.
 */
export async function scanBundleRange({ cwd, head, prerequisite, exec, warnings = [], maxBlobs = 20000, maxTotalBytes = 128 * 1024 * 1024, bundleScan, env = process.env }) {
  // R905: 'changed-lines' (default) scans only the ADDED lines of a modified blob in an incremental scan; 'whole-blob' is the off switch.
  const mode = cascadePolicy('bundleScan', bundleScan, { standard: 'changed-lines', envValues: { '': env.WE_BUNDLE_SCAN || undefined }, valid: v => v === 'changed-lines' || v === 'whole-blob', env }).value;
  const changedLines = Boolean(prerequisite) && mode !== 'whole-blob';
  const modified = []; // {label, path, oldSha, newSha}: modified blobs scanned by added lines only
  // The pack carries the RAW stored objects. --no-replace-objects keeps refs/replace/* from showing the scan a clean substitute.
  const git = (args, input) => exec({ file: 'git', args: ['--no-replace-objects', ...args], cwd, ...(input === undefined ? {} : { input }) });
  const range = prerequisite ? `${prerequisite}..${head}` : head;
  // Grafts and shallow files cut history out of rev-list/log but NOT out of `git bundle create` (it still packs the cut-off
  // objects), so a repo carrying either cannot be scanned faithfully: refuse rather than scan a truncated view.
  const shallow = await git(['rev-parse', '--is-shallow-repository']);
  if (shallow.code !== 0 || bytes(shallow.stdout).toString('utf8').trim() !== 'false') throw bundleError('bundle-credential-scan-failed', 'shallow-repository');
  const graftPath = await git(['rev-parse', '--git-path', 'info/grafts']);
  if (graftPath.code !== 0 || existsSync(resolve(cwd, bytes(graftPath.stdout).toString('utf8').trim()))) throw bundleError('bundle-credential-scan-failed', 'grafts-file');
  const prerequisiteEntries = new Set();
  if (prerequisite) {
    let tree;
    try { tree = await git(['ls-tree', '-r', '-t', '-z', '--full-tree', prerequisite]); }
    catch { throw bundleError('bundle-credential-scan-failed'); }
    if (tree.code !== 0 || tree.stdout == null) throw bundleError('bundle-credential-scan-failed');
    const out = bytes(tree.stdout);
    if (out.length && out.at(-1) !== NUL) throw bundleError('bundle-credential-scan-failed');
    for (const entry of splitNul(out)) {
      const tab = entry.indexOf(9);
      const meta = entry.subarray(0, tab).toString('ascii');
      const match = /^[0-7]{6} (?:blob|tree|commit) ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/.exec(meta);
      if (tab < 0 || !match || tab === entry.length - 1) throw bundleError('bundle-credential-scan-failed');
      prerequisiteEntries.add(`${entry.subarray(tab + 1).toString('latin1')}\0${meta.slice(0, 6)}\0${match[1]}`);
    }
  }
  // Enumerate the full bundled ancestry: a merged branch can add and delete a credential
  // before its merge, leaving no trace in the merge's first-parent diff.
  const revs = await git(['rev-list', '--root', range]);
  // Missing or unterminated output is unknown evidence, never an empty range (which would skip all scanning).
  if (revs.code !== 0 || revs.stdout == null) throw bundleError('bundle-credential-scan-failed');
  const revText = bytes(revs.stdout).toString('utf8');
  if (revText && !revText.endsWith('\n')) throw bundleError('bundle-credential-scan-failed');
  const commits = revText.split('\n').filter(Boolean);
  if (commits.length > maxBlobs) throw bundleError('bundle-credential-scan-too-large');
  if (commits.some(sha => !REVISION.test(sha))) throw bundleError('bundle-credential-scan-failed');
  // -t lists tree (directory) entries too: without it an EMPTY subtree entry (crafted with mktree) has no file below it
  // and never shows up, yet its name travels in the pack.
  // Keep the separate-diff default for full bundles. Incremental scans explicitly visit ALL
  // bundled commits without walking, diffing each merge against parent 1. Thus both side-branch
  // history and merge resolutions remain visible, independent of user config.
  let log;
  try {
    log = prerequisite && !commits.length ? { code: 0, stdout: Buffer.alloc(0) }
      : await git(['log', '--raw', '-t', '--ignore-submodules=none', '-z', '--no-renames', '--no-abbrev', '--root', '--diff-merges=separate', ...(prerequisite ? ['--first-parent', '--diff-merges=first-parent', '--no-walk=unsorted'] : []), '--no-relative', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--diff-filter=d', '--format=', ...(prerequisite ? commits : [range])]);
  } catch { throw bundleError('bundle-credential-scan-failed'); }
  if (log.code !== 0 || log.stdout == null) throw bundleError('bundle-credential-scan-failed');
  // Commit messages (and author/committer identity lines) travel in the pack too. Tags are not bundled: only the pinned ref is.
  const messages = await git(['log', '-z', '--root', '--format=%an%n%ae%n%cn%n%ce%n%B', range]);
  if (messages.code !== 0 || messages.stdout == null) throw bundleError('bundle-credential-scan-failed');
  for (const message of splitNul(bytes(messages.stdout))) {
    // Same scanner as blobs (secret assignments included); a message is plain text.
    let finding = credentialTextFinding(message.toString('latin1')) ?? credentialTextFinding(message.toString('utf8'));
    try { finding ??= credentialContentFinding(Buffer.from('commit-message.txt'), message); } catch { finding ??= 'content-scan-error'; }
    if (finding) return { path: 'commit-message', finding };
    const warning = credentialContentWarning(Buffer.from('commit-message.txt'), message);
    if (warning) warnings.push({ path: 'commit-message', finding: warning });
  }
  // The formatted log above shows only author/committer/message. Extended headers (multiline gpgsig, mergetag, encoding, ...)
  // also travel in the pack, so scan the COMPLETE raw object of every commit in the range.
  if (commits.length) {
    const commitCheck = await git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], commits.join('\n') + '\n');
    if (commitCheck.code !== 0) throw bundleError('bundle-credential-scan-failed');
    const commitSizes = new Map(); let commitTotal = 0;
    for (const line of bytes(commitCheck.stdout).toString('utf8').split('\n')) {
      if (!line) continue;
      const [sha, type, size] = line.split(' ');
      if (type !== 'commit' || !Number.isSafeInteger(Number(size))) throw bundleError('bundle-credential-scan-failed');
      commitSizes.set(sha, Number(size)); commitTotal += Number(size);
    }
    if (commitSizes.size !== commits.length || commitTotal > maxTotalBytes || [...commitSizes.values()].some(size => size > SCAN_BATCH_BYTES)) throw bundleError('bundle-credential-scan-too-large');
    let group = [], groupBytes = 0;
    const flushCommits = async () => {
      if (!group.length) return null;
      const read = await git(['cat-file', '--batch'], group.join('\n') + '\n');
      if (read.code !== 0) throw bundleError('bundle-credential-scan-failed');
      const out = bytes(read.stdout); let offset = 0;
      for (const sha of group) {
        const newline = out.indexOf(10, offset);
        if (newline < 0) throw bundleError('bundle-credential-scan-failed');
        const [got, type, size] = out.subarray(offset, newline).toString('utf8').split(' ');
        if (got !== sha || type !== 'commit') throw bundleError('bundle-credential-scan-failed');
        // Only the signature armor delimiters are neutralised (a signed commit is legitimate); every other header byte is scanned.
        const raw = Buffer.from(out.subarray(newline + 1, newline + 1 + Number(size)).toString('latin1').replace(SIGNATURE_ARMOR, 'SIGNATURE-ARMOR'), 'latin1');
        offset = newline + 1 + Number(size) + 1;
        let finding = credentialTextFinding(raw.toString('latin1')) ?? credentialTextFinding(raw.toString('utf8'));
        try { finding ??= credentialContentFinding(Buffer.from('commit-object.txt'), raw); } catch { finding ??= 'content-scan-error'; }
        if (finding) return { path: 'commit-object', finding };
        const warning = credentialContentWarning(Buffer.from('commit-object.txt'), raw);
        if (warning) warnings.push({ path: 'commit-object', finding: warning });
      }
      group = []; groupBytes = 0;
      return null;
    };
    for (const sha of commits) {
      if (groupBytes + commitSizes.get(sha) + 64 > SCAN_BATCH_BYTES) { const hit = await flushCommits(); if (hit) return hit; }
      group.push(sha); groupBytes += commitSizes.get(sha) + 64; // + the 'sha type size' header line
    }
    const hit = await flushCommits(); if (hit) return hit;
  }
  const tokens = splitNul(bytes(log.stdout));
  const excludedWarnings = [];
  const blobs = new Map(); // sha -> Map(path key -> {label, path}): the policy scan is path-dependent, so EVERY path adding a blob is scanned
  let pathCount = 0;
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i].toString('latin1');
    if (!meta) continue; // only a bare separator between commits may be skipped; any other token must be a header or its path
    // Fail closed: separate and first-parent merge diffs emit ":old new oldsha newsha status". A combined header ("::", several old
    // modes/hashes) means the config-independent invocation was not honoured; never parse it as an ordinary diff.
    // A token that is not a header (and was not consumed as a path below) is unknown output: refuse, never skip.
    const fields = meta.split(' ');
    if (!meta.startsWith(':') || meta.startsWith('::') || fields.length !== 5 || !/^[0-7]{6}$/.test(fields[0].slice(1)) || !/^[0-7]{6}$/.test(fields[1])
      || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(fields[3]) || !/^[ADMT]$/.test(fields[4])) throw bundleError('bundle-credential-scan-failed');
    const [, newMode, oldSha, newSha] = fields;
    const path = tokens[++i];
    if (!path) throw bundleError('bundle-credential-scan-failed');
    // A mode-only change can turn public regular-file bytes into a prohibited symlink.
    if (prerequisiteEntries.has(`${path.toString('latin1')}\0${newMode}\0${newSha}`)) continue;
    const label = path.toString('utf8');
    // Tree entries (file AND directory names) travel in the pack: a token in a name is a leak whatever the blob holds.
    // Every path that adds an entry in the range is listed here, including ones a later commit deleted.
    const pathFinding = credentialTextFinding(path.toString('latin1')) ?? credentialTextFinding(label);
    if (pathFinding) return { path: 'tree-entry-name', finding: pathFinding }; // never echo the secret-bearing name
    if (newMode === '160000' || newMode === '120000') return { path: label, finding: newMode === '160000' ? 'gitlink' : 'symlink' };
    let policy;
    try { policy = classifyManifestPath(path); } catch { throw bundleError('bundle-credential-scan-failed'); }
    // Judge names on the manifest's normalized view (NFKC, marks stripped, lower case), as main did: an accented
    // Latin name (composed or decomposed) ships. Format characters (bidi overrides), which that view strips, block.
    const dotFile = newMode !== '040000' && excludedDotFile(policy.names.at(-1));
    if (policy.names.some(secretFileName) || policy.names.some(unsafeComponentName) || /\p{Cf}/u.test(label) || dotFile) return { path: label, finding: 'excluded-path' };
    if (policy.excluded) excludedWarnings.push({ path: label, finding: 'excluded-path' });
    // A directory entry carries no blob: its name was scanned and classified above, its files are read under their own paths.
    if (newMode === '040000') continue;
    if (changedLines && fields[4] === 'M' && /^0{40}(0{24})?$/.test(oldSha) === false) {
      modified.push({ label, path, oldSha, newSha });
      pathCount++;
      if (modified.length > maxBlobs || pathCount > maxBlobs) throw bundleError('bundle-credential-scan-too-large');
      continue;
    }
    const paths = blobs.get(newSha) ?? new Map();
    blobs.set(newSha, paths);
    const key = path.toString('latin1');
    if (!paths.has(key)) { paths.set(key, { label, path }); pathCount++; }
    if (blobs.size > maxBlobs || pathCount > maxBlobs) throw bundleError('bundle-credential-scan-too-large');
  }
  // Modified blobs: the old content already shipped, so only lines this range ADDS are new exposure. A binary or unreadable
  // diff falls back to the whole blob; a failed diff refuses.
  const wholeFallback = [];
  const seenDiff = new Set();
  for (const m of modified) {
    const key = `${m.oldSha}\0${m.newSha}\0${m.path.toString('latin1')}`;
    if (seenDiff.has(key)) continue;
    seenDiff.add(key);
    const diff = await git(['diff', '-U3', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', m.oldSha, m.newSha]);
    if (diff.code !== 0 || diff.stdout == null) throw bundleError('bundle-credential-scan-failed');
    const raw = bytes(diff.stdout);
    if (raw.length > SCAN_BATCH_BYTES) throw bundleError('bundle-credential-scan-too-large');
    if (raw.includes(0) || /^Binary files /m.test(raw.toString('latin1')) || /^GIT binary patch/m.test(raw.toString('latin1'))) { wholeFallback.push(m); continue; }
    const lines = splitDiffLines(raw);
    if (lines.start < 0) { wholeFallback.push(m); continue; } // no hunks (mode-only change): scan whole, fail closed
    const added = lines.added;
    // A replacement inside multi-line context (a block scalar under `password: |`) needs that context to be seen.
    const contextual = lines.removed ? lines.context : null;
    const finding = credentialBufferFinding(added);
    let policy = null;
    try { policy = credentialContentFinding(m.path, added); } catch { policy = 'content-scan-error'; }
    let hit = policy ?? finding;
    if (!hit && contextual) {
      hit = credentialBufferFinding(contextual);
      try { hit ??= credentialContentFinding(m.path, contextual); } catch { hit ??= 'content-scan-error'; }
    }
    if (hit) return { path: m.label, finding: hit };
    const warning = credentialContentWarning(m.path, added) ?? (contextual ? credentialContentWarning(m.path, contextual) : null);
    if (warning) warnings.push({ path: m.label, finding: warning });
  }
  for (const m of wholeFallback) {
    const paths = blobs.get(m.newSha) ?? new Map();
    blobs.set(m.newSha, paths);
    paths.set(m.path.toString('latin1'), { label: m.label, path: m.path });
  }
  const shas = [...blobs.keys()];
  // Modified blobs are not read whole, but their size still counts against the same caps.
  const sized = [...new Set([...shas, ...modified.map(m => m.newSha)])];
  if (!sized.length) { warnings.push(...excludedWarnings); return null; }
  const check = await git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], sized.join('\n') + '\n');
  if (check.code !== 0) throw bundleError('bundle-credential-scan-failed');
  const sizes = new Map(); let total = 0;
  for (const line of bytes(check.stdout).toString('utf8').split('\n')) {
    if (!line) continue;
    const [sha, type, size] = line.split(' ');
    if (type !== 'blob' || !Number.isSafeInteger(Number(size))) throw bundleError('bundle-credential-scan-failed');
    sizes.set(sha, Number(size)); total += Number(size);
  }
  if (sizes.size !== sized.length || total > maxTotalBytes || [...sizes.values()].some(size => size > SCAN_BATCH_BYTES)) throw bundleError('bundle-credential-scan-too-large');
  let batch = [], batchBytes = 0;
  const flush = async () => {
    if (!batch.length) return null;
    const read = await git(['cat-file', '--batch'], batch.join('\n') + '\n');
    if (read.code !== 0) throw bundleError('bundle-credential-scan-failed');
    const out = bytes(read.stdout); let offset = 0;
    for (const sha of batch) {
      const newline = out.indexOf(10, offset);
      const [got, type, size] = out.subarray(offset, newline).toString('utf8').split(' ');
      if (got !== sha || type !== 'blob') throw bundleError('bundle-credential-scan-failed');
      const content = out.subarray(newline + 1, newline + 1 + Number(size));
      offset = newline + 1 + Number(size) + 1;
      const finding = credentialBufferFinding(content);
      // Apply both policy levels to every added blob, including excluded paths in history.
      for (const { label, path } of blobs.get(sha).values()) {
        let policy = null;
        try { policy = credentialContentFinding(path, content); } catch { policy = 'content-scan-error'; }
        const hit = policy ?? finding;
        if (hit) return { path: label, finding: hit };
        const warning = credentialContentWarning(path, content);
        if (warning) warnings.push({ path: label, finding: warning });
      }
    }
    batch = []; batchBytes = 0;
    return null;
  };
  for (const sha of shas) {
    if (batchBytes + sizes.get(sha) > SCAN_BATCH_BYTES) { const hit = await flush(); if (hit) return hit; }
    batch.push(sha); batchBytes += sizes.get(sha);
  }
  const hit = await flush();
  if (!hit) warnings.push(...excludedWarnings);
  return hit;
}

/** R559: 'fresh' only when the runner reported the mirror's main age and it is within the bound. */
export function mainFreshness(capabilities, maxAgeMs) {
  const age = capabilities?.gitBundleMainAgeMs;
  if (!Number.isFinite(age) || age < 0 || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 'unknown';
  return age <= maxAgeMs ? 'fresh' : 'stale';
}
