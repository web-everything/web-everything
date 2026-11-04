// Client side of the git-bundle remote transport (R593, ladder step 4 of remote-exec-git-sync).
// With `remote.transport=git-bundle` and a runner that advertises `gitBundle:1`, a run that needs git
// ships a verified bundle (public-main..HEAD, or a full bundle when no common base exists) over the same
// rsync channel instead of making Forge fetch an unpushed HEAD from GitHub. The default stays `rsync`.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REMOTE_TRANSPORTS = Object.freeze(['rsync', 'git-bundle']);
export const DEFAULT_REMOTE_TRANSPORT = 'rsync';
export const GIT_BUNDLE_CAPABILITY = 1;
/** Must match the runner's BUNDLE_MAX_BYTES; a bigger bundle falls back instead of being shipped. */
export const BUNDLE_MAX_BYTES = 512 * 1024 * 1024;

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
  const file = join(directory, 'git.bundle');
  // `HEAD` (not a bare sha) so the bundle records a named head the runner can verify against the tip.
  const created = await git(['bundle', 'create', file, 'HEAD', ...(prerequisite ? [`^${prerequisite}`] : [])]);
  if (created.code !== 0) throw bundleError('bundle-create-failed', String(created.stderr ?? '').slice(-200));
  const info = await stat(file);
  if (!info.isFile() || info.size <= 0 || info.size > BUNDLE_MAX_BYTES) throw bundleError('bundle-size-unsupported');
  // The Mac proves its own file is internally consistent before spending bandwidth on it.
  const verified = await git(['bundle', 'verify', file]);
  if (verified.code !== 0) throw bundleError('bundle-self-verify-failed');
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
