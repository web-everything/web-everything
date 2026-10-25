/** Host-wide, exact-content verification records; all IO is best-effort and fails closed. */
import { realpathSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { computeWorkingTreeHash } from './verify-lane-gate.mjs';
import { pinnedMergeBase } from '../readiness/test-selection.mjs';
import { shouldRecordGreen } from './lane-verify.mjs';

export const SHARED_RECORD_DIR_ENV = 'WE_VERIFY_SHARED_RECORD_DIR';
export const SHARED_RECORD_GATE = 'default';
/** Lazy, like verify-settings.mjs: some test environments load modules under a non-file URL. */
const defaultSettingsPath = () => resolve(dirname(fileURLToPath(import.meta.url)), '../verify-settings.json');

export function resolveSharedRecordDir({ env = process.env, coordinationRoot, settingsPath, home = homedir() } = {}) {
  const absoluteDir = (value) => {
    if (typeof value !== 'string') return null;
    if (value.startsWith('~/')) return resolve(home, value.slice(2));
    return isAbsolute(value) ? value : null;
  };
  const override = absoluteDir(env[SHARED_RECORD_DIR_ENV]);
  if (override) return { dir: override, source: 'env' };
  try {
    const configured = absoluteDir(JSON.parse(readFileSync(settingsPath ?? defaultSettingsPath(), 'utf8'))?.sharedRecordDir);
    if (configured) return { dir: configured, source: 'file' };
  } catch { /* Missing or malformed settings fall through. */ }
  return { dir: join(coordinationRoot ?? resolveCoordinationRoot({ env }), 'verify-shared'), source: 'default' };
}

export function normalizeRepoScope(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  url = url.trim();
  const remote = url.match(/^(?:git@github\.com:|https?:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (remote) return `github:${remote[1]}/${remote[2]}`.toLowerCase();
  if (isAbsolute(url)) {
    try { return `file:${realpathSync(url)}`; } catch { return `file:${resolve(url)}`; }
  }
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|[^@/\s]+@[^:/\s]+:)/i.test(url)) {
    return `url:${url.replace(/\/+$/, '')}`; // never strip `.git`: `repo` and `repo.git` may be distinct repos on a non-GitHub host
  }
  return null;
}

export function repoScopeOf(runGit) {
  try { return normalizeRepoScope(runGit(['remote', 'get-url', 'origin']).trim()); } catch { return null; }
}

/** Identity of the same checkout/base used by computeWorkingTreeHash. Errors fail closed. */
export function checkoutIdentity(runGit, { fileMode } = {}) {
  const unavailable = { treeHash: null, mergeBase: null, headTree: null, clean: null };
  try {
    const clean = runGit(['status', '--porcelain', '--untracked-files=all']).trim() === '';
    const mergeBase = pinnedMergeBase({ runGit });
    const headTree = runGit(['rev-parse', 'HEAD^{tree}']).trim();
    const treeHash = computeWorkingTreeHash({ runGit, fileMode });
    if (!/^[0-9a-f]{40}$/.test(mergeBase ?? '') || !/^[0-9a-f]{40}$/.test(headTree) || !treeHash) return unavailable;
    return { treeHash, mergeBase, headTree, clean };
  } catch { return unavailable; }
}

export function sharedRecordPath({ dir, sha, treeHash, mergeBase, headTree, gate, scope }) {
  if (typeof dir !== 'string' || !isAbsolute(dir) || typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)
    || !/^[0-9a-f]{40}$/.test(mergeBase ?? '') || !/^[0-9a-f]{40}$/.test(headTree ?? '')
    || typeof treeHash !== 'string' || !/^[0-9a-f]{64}$/.test(treeHash) || gate !== SHARED_RECORD_GATE
    || typeof scope !== 'string' || !scope.trim()) return null;
  const scopeHash = createHash('sha256').update(scope).digest('hex').slice(0, 16);
  return join(dir, `${sha}.${treeHash}.${mergeBase}.${headTree}.${gate}.${scopeHash}.json`);
}

export const shouldWriteSharedRecord = shouldRecordGreen;

export function writeSharedRecord({ dir, sha, treeHash, mergeBase, headTree, gate, scope, record }) {
  let tmp;
  let fd;
  try {
    const path = sharedRecordPath({ dir, sha, treeHash, mergeBase, headTree, gate, scope });
    if (!path) return { ok: false, error: 'invalid shared record key or directory' };
    mkdirSync(dir, { recursive: true });
    tmp = join(dir, `.verify.${process.pid}.${randomUUID()}.tmp`);
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ ...record, sha, treeHash, mergeBase, headTree, gate, scope, status: 'green', version: 1 }) + '\n');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (tmp) { try { unlinkSync(tmp); } catch { /* renamed or best effort */ } }
  }
}

export function readSharedRecord({ dir, sha, treeHash, mergeBase, headTree, clean, gate, scope, runGit, fileMode }) {
  try {
    if (runGit) ({ treeHash, mergeBase, headTree, clean } = checkoutIdentity(runGit, { fileMode }));
    if (clean !== true) return null;
    const path = sharedRecordPath({ dir, sha, treeHash, mergeBase, headTree, gate, scope });
    if (!path) return null;
    const rec = JSON.parse(readFileSync(path, 'utf8'));
    if (!rec || Object.getPrototypeOf(rec) !== Object.prototype || rec.sha !== sha || rec.treeHash !== treeHash
      || rec.mergeBase !== mergeBase || rec.headTree !== headTree
      || ('suites' in rec && typeof rec.suites !== 'string') || rec.gate !== gate || rec.scope !== scope || rec.status !== 'green' || rec.skipped || rec.corrupt || rec.version !== 1) return null;
    return { record: rec, path };
  } catch { return null; }
}

export function recordSharedGreen({ env = process.env, repo, runGit, sha, treeHash, status, defaultGate, admissionFallback, cleanTree, skipped, suites, log = (m) => process.stderr.write(m) }) {
  let dir = '(unresolved)';
  let source = 'default';
  const report = (outcome) => { try { log(`verify-lane: shared verify record ${outcome} → ${dir} (store source: ${source})\n`); } catch { /* Logging cannot affect verification. */ } };
  const skip = (reason) => { report(`skipped (${reason})`); return { ok: false, skipped: reason }; };
  try {
    ({ dir, source } = resolveSharedRecordDir({ env }));
    if (!shouldWriteSharedRecord({ status, defaultGate, admissionFallback, cleanTree, skipped, treeHash })) return skip('not a clean default-gate green');
    if (!env[SHARED_RECORD_DIR_ENV] && !(typeof repo === 'string' && repo.includes(`${sep}.lanes${sep}`))) return skip('outside a lane without a store override');
    const scope = repoScopeOf(runGit);
    if (!scope) return skip('repository scope unavailable');
    const identity = checkoutIdentity(runGit);
    if (identity.clean !== true || !identity.mergeBase || !identity.headTree || !identity.treeHash) return skip('checkout is not clean or identity unavailable');
    if (identity.treeHash !== treeHash) return skip('checkout tree hash changed');
    const { mergeBase, headTree } = identity;
    const result = writeSharedRecord({ dir, sha, treeHash, mergeBase, headTree, gate: SHARED_RECORD_GATE, scope,
      record: { repo, suites, recordedAt: new Date().toISOString() } });
    if (result.ok) { dir = result.path; report('written'); }
    else report(`FAILED (${result.error})`);
    return result;
  } catch (error) {
    const result = { ok: false, error: String(error?.message ?? error) };
    report(`FAILED (${result.error})`);
    return result;
  }
}

export function sharedFinishGuardFallback({ localVerdict, headSha, readShared, decide }) {
  if (localVerdict.ok || localVerdict.status !== 'absent') return localVerdict;
  let found;
  try { found = readShared({ headSha }); } catch { return localVerdict; }
  if (!found) return localVerdict;
  try {
    const v = decide(found.record);
    return v.ok && v.status === 'green' ? { ...v, source: 'shared-store', sharedRecordPath: found.path,
      detail: v.detail + ' — accepted from the host-wide shared verify record (sha, tree hash, merge base, HEAD tree, gate and scope all match)' } : localVerdict;
  } catch { return localVerdict; }
}
