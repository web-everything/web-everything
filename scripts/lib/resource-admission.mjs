/**
 * @file we:scripts/lib/resource-admission.mjs
 * One pure resource policy and best-effort IO for shadow comparisons. Thresholds
 * come from CPU idle, NOT load average: macOS disk waits inflate load with idle CPU.
 * Cascade: standard → Platform Forever preference → tool override, per field.
 * This library returns observations only; callers retain their existing gates.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { isValidPolicyLayer, resolveResourcePolicy, decideAdmission } from './resource-policy.mjs';
import { readDeclaredSettings, LEGACY_SETTINGS_PATH } from './settings-files.mjs';
// The pure policy + decision live in we:scripts/lib/resource-policy.mjs so a read-only declaring module (the
// resource-status operation) can import them without reaching fs.
export { RESOURCE_POLICY_STANDARD, RESOURCE_POLICY_KINDS, resolveResourcePolicy, decideAdmission } from './resource-policy.mjs';

// ── SNAPSHOT STORAGE. Lives HERE (the light reader every gate imports), not in the sampler: the sampler pulls in
// we:scripts/readiness/heavy-admission.mjs for its slot count, and heavy-admission imports this file for its
// shadow call — keeping storage here keeps that import one-way.
export function resourcePaths(root = resolveCoordinationRoot()) {
  const dir = join(root, 'resource');
  return { dir, snapshot: join(dir, 'snapshot.json'), history: join(dir, 'history.jsonl'), shadow: join(dir, 'shadow.jsonl') };
}
/** Bound by BYTES (one stat per append), never by re-reading the file each time: the sampler appends every ~10 s. */
export const RESOURCE_LOG_MAX_BYTES = 8 * 1024 * 1024;
/** Serialize append/trim so concurrent shadow callers cannot lose a row during rotation. */
export function appendResourceLog(path, row, { maxBytes = RESOURCE_LOG_MAX_BYTES } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  withFileLock(path + '.lock', () => {
    appendFileSync(path, JSON.stringify(row) + '\n', 'utf8');
    if (statSync(path).size <= maxBytes) return;
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    writeFileSync(path, lines.slice(-Math.max(1, Math.floor(lines.length / 2))).join('\n') + '\n', 'utf8');
  }, { timeoutMs: 500 });
}
/** The snapshot itself is the contract; history is best-effort evidence and never fails the write. */
export function writeSnapshot(snapshot, { root } = {}) {
  const paths = resourcePaths(root);
  mkdirSync(paths.dir, { recursive: true });
  writeJsonAtomic(paths.snapshot, snapshot);
  try { appendResourceLog(paths.history, snapshot); } catch { /* history is evidence only */ }
}
export function readSnapshot({ root } = {}) {
  try { return JSON.parse(readFileSync(resourcePaths(root).snapshot, 'utf8')); } catch { return null; }
}

// Resolved lazily: some test harnesses load modules from a non-file URL, where a top-level fileURLToPath throws.
const repoRootOf = () => fileURLToPath(new URL('../../', import.meta.url));
export function loadResourcePolicy({ env = process.env, repoRoot, home = homedir() } = {}) {
  const sources = { platform: null, tool: null };
  // x6nuodj: a default param here threw under a non-file module URL and admit() then decided on NO snapshot (hold
  // every heavy kind). Resolve it in the body: an unresolvable repo root only drops the tool layer, named in errors.
  if (repoRoot === undefined) {
    try { repoRoot = repoRootOf(); } catch (error) { (sources.errors ??= []).push({ source: 'tool', path: null, error: String(error?.message ?? error) }); }
  }
  const readLayer = (source, path) => {
    try {
      const file = JSON.parse(readFileSync(path, 'utf8'));
      if (file === null || typeof file !== 'object' || Array.isArray(file)) throw Error('expected an object');
      if (!Object.hasOwn(file, 'resourceAdmission')) return undefined;
      if (!isValidPolicyLayer(file.resourceAdmission)) throw Error('invalid resourceAdmission policy');
      sources[source] = path;
      return file.resourceAdmission;
    } catch (error) {
      if (error?.code !== 'ENOENT') (sources.errors ??= []).push({ source, path, error: String(error?.message ?? error) });
      return undefined;
    }
  };
  const platform = readLayer('platform', env.WE_PLATFORM_PREFERENCES || join(home, '.claude', 'platform-preferences.json'));
  if (repoRoot === undefined) return { policy: resolveResourcePolicy({ platform }), sources };
  // The tool layer is the merged scripts/ settings (legacy shared file + scripts/settings/*.json), so a feature file can
  // carry `resourceAdmission` too. The legacy file sits beside the settings dir, so it is derived from it, not named here.
  const settingsDir = join(repoRoot, 'scripts', 'settings');
  const declared = readDeclaredSettings({ dir: settingsDir, legacyPath: join(dirname(settingsDir), basename(LEGACY_SETTINGS_PATH)) });
  const pathOf = (name) => (name.startsWith('settings/') ? join(settingsDir, name.slice('settings/'.length)) : join(dirname(settingsDir), name));
  for (const { source, error } of declared.errors) (sources.errors ??= []).push({ source: 'tool', path: pathOf(source), error });
  let tool;
  if (Object.hasOwn(declared.settings, 'resourceAdmission')) {
    const owners = [...new Set(Object.entries(declared.owners).filter(([leaf]) => leaf.startsWith('resourceAdmission')).map(([, o]) => o))];
    const path = pathOf(owners[owners.length - 1] ?? basename(LEGACY_SETTINGS_PATH));
    if (isValidPolicyLayer(declared.settings.resourceAdmission)) { sources.tool = path; tool = declared.settings.resourceAdmission; }
    else (sources.errors ??= []).push({ source: 'tool', path, error: 'invalid resourceAdmission policy' });
  }
  return { policy: resolveResourcePolicy({ platform, tool }), sources };
}
function audit(root, row) {
  try { appendResourceLog(resourcePaths(root).shadow, row); } catch { /* Observability must not change a gate. */ }
}
function auditRow({ gate, kind, oldVerdict, oldReason, nowMs }, decision) {
  return { at: new Date(nowMs).toISOString(), gate, kind, old: { verdict: oldVerdict, reason: oldReason },
    new: { verdict: decision.verdict, reason: decision.reason, snapshotAge: decision.snapshotAge, unknown: decision.unknown },
    agree: oldVerdict === decision.verdict };
}
export function admit({ kind, env = process.env, nowMs = Date.now(), root, policy } = {}) {
  let decision;
  try {
    root ??= resolveCoordinationRoot({ env });
    decision = decideAdmission({ kind, snapshot: readSnapshot({ root }), policy: policy ?? loadResourcePolicy({ env }).policy, nowMs });
  } catch {
    decision = decideAdmission({ kind, snapshot: null, nowMs });
  }
  // Unknown is always audited, including direct callers and WE_RESOURCE_SHADOW=off.
  if (decision.unknown) {
    try { audit(root, auditRow({ gate: 'resource-admission', kind, oldVerdict: null, oldReason: null, nowMs }, decision)); } catch { /* best effort */ }
  }
  return decision;
}
/** Return comparison evidence only. An off switch skips all reads and logging. */
export function shadowAdmission({ gate, kind, oldVerdict, oldReason, env = process.env, nowMs = Date.now(), root, log = line => process.stderr.write(line) } = {}) {
  // Either the caller's env or this process's env can switch it off: gates often pass a hand-built env, and a test
  // suite stubs only process.env — neither must leak shadow rows into the real coordination root.
  if (env.WE_RESOURCE_SHADOW === 'off' || process.env.WE_RESOURCE_SHADOW === 'off') return undefined;
  const decision = admit({ kind, env, nowMs, root });
  try {
    root ??= resolveCoordinationRoot({ env });
    audit(root, auditRow({ gate, kind, oldVerdict, oldReason, nowMs }, decision));
  } catch { /* best effort */ }
  try {
    log('resource-shadow gate=' + gate + ' kind=' + kind + ' old verdict: ' + oldVerdict + ' (' + oldReason +
      ') | new verdict: ' + decision.verdict + ' (' + decision.reason + ', snapshot age ' + decision.snapshotAge + 's)\n');
  } catch { /* A closed stderr or failing logger must not affect admission. */ }
  return decision;
}
