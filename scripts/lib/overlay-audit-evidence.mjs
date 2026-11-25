/** Canonical, exact-head evidence for standing overlay admission and inspection. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { readPlatformPreferences } from './policy-cascade.mjs';
import { scrubGitRepoEnv } from './lane-git-hardening.mjs';
import { readAuditSettings, resolveAuditRecordPath } from '../operations/codex-audit-io.mjs';
import { readStore, storePath, validateEntry, withdrawnRevocations } from '../operations/ruled-weakened-store.mjs';
import { jsonLines, canonicalAuditEvidence, mergeRuledWeakened, waiverForHead } from '../operations/prototype-load.mjs';

const fullSha = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/i.test(value);
const prototypeSettingsPath = fileURLToPath(new NodeURL('../settings/prototype-load.json', import.meta.url));
// Main's overlay reader derives a file from a clone; an inventory must read each discovered file directly.
export function overlayDir(env = process.env) {
  const override = env.WE_DAEMON_OVERLAY_DIR;
  return (typeof override === 'string' && override.trim()) || join(env.HOME || homedir(), '.claude', 'daemon-overlays');
}
export function readInventoryState(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (!state || typeof state.clone !== 'string' || !state.clone.trim() || !Array.isArray(state.overlays)
      || state.overlays.some(entry => !entry || typeof entry !== 'object'
        || (entry.sha !== undefined && !fullSha(entry.sha)))) return { corrupt: true };
    return state;
  } catch { return { corrupt: true }; }
}
/** Name the evidence an operator must supply. */
export function describeMissing(sha) {
  return `no NOT WEAKENED canonical audit record and no waiver in ruled-weakened.jsonl or prototypeLoad.ruledWeakened settings for ${typeof sha === 'string' ? sha : 'invalid SHA'}`;
}

/** Read-only canonical coverage; unknown Git state grants no coverage. Never fetches. */
export function mainCovers(base, { cwd = process.cwd(), env = process.env } = {}) {
  if (!fullSha(base)) return false;
  try {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', base, 'origin/main'], {
      cwd, env: { ...scrubGitRepoEnv(env), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
      encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
    });
    return !result.error && result.status === 0;
  } catch { return false; }
}

/** Canonical evaluation. Supplying covers keeps evaluation pure; default IO is read-only Git. */
export function auditEvidenceFor(sha, { auditRecords = [], waivers = [], ref, covers = mainCovers } = {}) {
  const missing = { ok: false, kind: null, detail: describeMissing(sha) };
  if (!fullSha(sha)) return missing;
  const covered = base => { try { return !!covers(base); } catch { return false; } };
  const evaluate = ruledWeakened => canonicalAuditEvidence(auditRecords, sha, covered, null, { ruledWeakened });
  if (evaluate().ok) return { ok: true, kind: 'audit', detail: `NOT WEAKENED canonical audit record for ${sha}` };
  for (const entry of waivers) {
    // Settings rulings have the prototype loader's schema; only ledger entries require actor/quote/at.
    const settingsWaiver = entry?.layer === 'tool' || entry?.layer === 'platform';
    if (!(settingsWaiver ? waiverForHead([entry], { branch: ref, sha }) : validateEntry(entry))
      || !fullSha(entry.sha) || entry.ref !== ref || entry.sha.toLowerCase() !== sha.toLowerCase()) continue;
    if (evaluate({ record: entry, ruledWeakened: entry }).ok)
      return { ok: true, kind: 'waiver', detail: `waiver in ${settingsWaiver ? `${entry.layer} prototypeLoad.ruledWeakened settings` : 'ruled-weakened.jsonl'} for ${ref} ${sha}` };
  }
  return missing;
}

/** Read settings and shared ledgers using their existing readers/resolvers. Unreadable evidence grants nothing. */
export function loadAuditEvidence({ env = process.env, fs = { readFileSync }, cwd = process.cwd() } = {}) {
  let auditRecords = [], waivers = [];
  if (typeof env.HOME !== 'string' || !env.HOME.trim()) return { auditRecords, waivers };
  try {
    const path = resolveAuditRecordPath(readAuditSettings((path, encoding) => fs.readFileSync(path, encoding)), { home: env.HOME, cwd });
    const body = fs.readFileSync(path, 'utf8');
    const records = jsonLines(body);
    if (records.length === body.split(/\r?\n/).filter(line => line.trim()).length) auditRecords = records;
  } catch { /* Missing, corrupt or unreadable audit ledger: no audit evidence. */ }
  try {
    let damaged = false;
    const store = readStore({ path: storePath(env), fs, warn: () => { damaged = true; } });
    const revoked = withdrawnRevocations({ env, fs, warn: message => {
      damaged = true;
      console.warn(`${message}; no waiver evidence admitted until the request log is repaired.`);
    } });
    if (!damaged) {
      const platform = readPlatformPreferences({ env, readFile: (path, encoding) => fs.readFileSync(path, encoding) });
      let tool;
      try { tool = JSON.parse(fs.readFileSync(prototypeSettingsPath, 'utf8'))?.ruledWeakened; }
      catch { /* Missing or unreadable tool settings supply no waivers. */ }
      waivers = mergeRuledWeakened(platform.prefs.prototypeLoad?.ruledWeakened, tool, console.warn)
        .filter(entry => !revoked(entry));
      // Keep the loader's tool > platform > store precedence for the same ref/SHA/ruling.
      const key = entry => JSON.stringify([entry.ref, entry.sha.toLowerCase(), entry.ruling]);
      const seen = new Set(waivers.map(key));
      if (!store.error) waivers = [...waivers, ...store.entries.filter(entry => !revoked(entry) && !seen.has(key(entry)))];
    }
  } catch { /* Missing or unreadable waiver ledger: no waiver evidence. */ }
  return { auditRecords, waivers };
}
