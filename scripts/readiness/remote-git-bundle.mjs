// Client side of the git-bundle remote transport (R593, ladder step 4 of remote-exec-git-sync).
// With `remote.transport=git-bundle` and a runner that advertises `gitBundle:1`, a run that needs git
// ships a verified bundle (public-main..HEAD, or a full bundle when no common base exists) over the same
// rsync channel instead of making Forge fetch an unpushed HEAD from GitHub. The default stays `rsync`.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { classifyManifestPath, credentialTextFinding } from './forge-exec-manifest.mjs';

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
  if (prerequisite === head) return { mode: 'none', tip: head };
  // R559: the same credential policy as the rsync path, over EVERY commit in the bundled range (a secret
  // committed and later deleted still travels in the pack). Fail closed before any bundle is built or sent.
  const hit = await scanBundleRange({ cwd, head, prerequisite, exec });
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
  return { mode: prerequisite ? 'incremental' : 'full', tip: head, file, bytes: info.size, sha256: await digestFile(file),
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

const SCAN_BATCH_BYTES = 3 * 1024 * 1024; // below the client's 4 MiB capture limit
const NUL = 0;
function splitNul(buffer) {
  const out = []; let start = 0;
  for (let i = 0; i < buffer.length; i++) if (buffer[i] === NUL) { out.push(buffer.subarray(start, i)); start = i + 1; }
  if (start < buffer.length) out.push(buffer.subarray(start));
  return out;
}
const bytes = (value) => Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');

/**
 * R559: scan every blob a bundle of `prerequisite..head` (or the whole history when `prerequisite` is null)
 * would carry. Path policy is the manifest's own exclusion policy; content uses its raw token patterns.
 * Returns the first {path, finding} or null; throws bundle-credential-scan-too-large instead of skipping.
 */
export async function scanBundleRange({ cwd, head, prerequisite, exec, maxBlobs = 20000, maxTotalBytes = 128 * 1024 * 1024 }) {
  const git = (args, input) => exec({ file: 'git', args, cwd, ...(input === undefined ? {} : { input }) });
  const range = prerequisite ? `${prerequisite}..${head}` : head;
  const log = await git(['log', '--raw', '-z', '--no-renames', '--no-abbrev', '--root', '-m', '--diff-filter=d', '--format=', range]);
  if (log.code !== 0) throw bundleError('bundle-credential-scan-failed');
  // Commit messages (and author/committer identity lines) travel in the pack too. Tags are not bundled: only the pinned ref is.
  const messages = await git(['log', '-z', '--root', '--format=%an%n%ae%n%cn%n%ce%n%B', range]);
  if (messages.code !== 0) throw bundleError('bundle-credential-scan-failed');
  for (const message of splitNul(bytes(messages.stdout))) {
    const finding = credentialTextFinding(message.toString('latin1')) ?? credentialTextFinding(message.toString('utf8'));
    if (finding) return { path: 'commit-message', finding };
  }
  const tokens = splitNul(bytes(log.stdout));
  const blobs = new Map(); // sha -> first path
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i].toString('latin1');
    if (!meta.startsWith(':')) continue;
    const [, newMode, , newSha] = meta.split(' ');
    const path = tokens[++i];
    if (!path) throw bundleError('bundle-credential-scan-failed');
    const label = path.toString('utf8');
    if (newMode === '160000' || newMode === '120000') return { path: label, finding: newMode === '160000' ? 'gitlink' : 'symlink' };
    let excluded;
    try { excluded = classifyManifestPath(path).excluded; } catch { excluded = true; }
    if (excluded) return { path: label, finding: 'excluded-path' };
    if (!blobs.has(newSha)) blobs.set(newSha, label);
    if (blobs.size > maxBlobs) throw bundleError('bundle-credential-scan-too-large');
  }
  const shas = [...blobs.keys()];
  if (!shas.length) return null;
  const check = await git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], shas.join('\n') + '\n');
  if (check.code !== 0) throw bundleError('bundle-credential-scan-failed');
  const sizes = new Map(); let total = 0;
  for (const line of bytes(check.stdout).toString('utf8').split('\n')) {
    if (!line) continue;
    const [sha, type, size] = line.split(' ');
    if (type !== 'blob' || !Number.isSafeInteger(Number(size))) throw bundleError('bundle-credential-scan-failed');
    sizes.set(sha, Number(size)); total += Number(size);
  }
  if (sizes.size !== shas.length || total > maxTotalBytes || [...sizes.values()].some(size => size > SCAN_BATCH_BYTES)) throw bundleError('bundle-credential-scan-too-large');
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
      const finding = credentialTextFinding(content.toString('latin1')) ?? credentialTextFinding(content.toString('utf8'));
      if (finding) return { path: blobs.get(sha), finding };
    }
    batch = []; batchBytes = 0;
    return null;
  };
  for (const sha of shas) {
    if (batchBytes + sizes.get(sha) > SCAN_BATCH_BYTES) { const hit = await flush(); if (hit) return hit; }
    batch.push(sha); batchBytes += sizes.get(sha);
  }
  return flush();
}

/** R559: 'fresh' only when the runner reported the mirror's main age and it is within the bound. */
export function mainFreshness(capabilities, maxAgeMs) {
  const age = capabilities?.gitBundleMainAgeMs;
  if (!Number.isFinite(age) || age < 0 || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 'unknown';
  return age <= maxAgeMs ? 'fresh' : 'stale';
}
