/**
 * Read-only standing-overlay audit inventory.
 * Usage: node scripts/daemon-overlay-audit-check.mjs [--json] [--overlay-dir=<dir>]
 * Text: UNAUDITED <cloneName> <ref> sha=<sha|unresolved> [moved-from=<sha>] added=<ISO> age=<N>d missing=<evidence>
 *       UNREADABLE <file>, or OK <n> overlays audited. Exit 1 for any incomplete evidence.
 * JSON: array of {clone, ref, sha, addedAt, ageDays, ok, kind}; unreadable files go to stderr.
 * Never fetches, changes Git refs, or writes state.
 */
import { readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { overlayDir, readInventoryState, auditEvidenceFor, loadAuditEvidence, mainCovers } from './lib/overlay-audit-evidence.mjs';
import { safeRegistrationRef } from './operations/prototype-load.mjs';

const fullSha = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/i.test(value);
const clean = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');

/** Inspect registrations using injected evidence, time and read-only SHA resolution. Pure with supplied resolver and covers. */
export function checkOverlays({ states, evidence, resolveSha, covers, now = new Date() }) {
  return states.flatMap(state => state.overlays.map(entry => {
    let sha;
    try { sha = resolveSha(state.clone, entry.ref); } catch { sha = null; }
    if (!fullSha(sha)) sha = null;
    const movedFrom = entry.sha && (sha === null || entry.sha.toLowerCase() !== sha.toLowerCase()) ? entry.sha : null;
    const result = auditEvidenceFor(sha, { ...evidence, ref: entry.ref,
      covers: base => covers ? covers(base, state.clone) : mainCovers(base, { cwd: state.clone }),
    });
    const at = Date.parse(entry.addedAt);
    return { clone: state.clone, ref: entry.ref, sha, ...(movedFrom ? { movedFrom } : {}), addedAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
      ageDays: Number.isFinite(at) ? Math.max(0, Math.floor((Number(new Date(now)) - at) / 86400000)) : null,
      ok: result.ok, kind: result.kind };
  }));
}

function localSha(clone, ref, env) {
  if (!safeRegistrationRef(ref)) return null;
  const result = spawnSync('git', ['-C', clone, 'rev-parse', '--verify', `refs/remotes/origin/${ref}`], {
    env: { ...env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
  });
  return result.status === 0 && !result.error ? result.stdout.trim() : null;
}

/** Run the read-only CLI; missing directories are empty, unreadable files fail closed. */
export function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.some(arg => arg !== '--json' && !arg.startsWith('--overlay-dir='))) {
    process.stderr.write('usage: node scripts/daemon-overlay-audit-check.mjs [--json] [--overlay-dir=<dir>]\n');
    return 2;
  }
  const json = argv.includes('--json');
  const dir = argv.find(arg => arg.startsWith('--overlay-dir='))?.slice(14) || overlayDir(env);
  const states = [];
  let unreadable = false, files = [];
  const report = file => {
    unreadable = true;
    (json ? process.stderr : process.stdout).write(`UNREADABLE ${clean(file)}\n`);
  };
  try { files = readdirSync(dir).filter(file => /^[0-9a-f]{16}\.json$/.test(file)).sort(); }
  catch (error) { if (error.code !== 'ENOENT') report(dir); }
  for (const name of files) {
    const file = join(dir, name);
    const state = readInventoryState(file);
    if (state.corrupt || !state.clone || state.overlays.some(entry => !entry || !safeRegistrationRef(entry.ref))) report(file);
    else states.splice(states.length, 0, state);
  }
  const results = checkOverlays({ states, evidence: loadAuditEvidence({ env }), resolveSha: (clone, ref) => localSha(clone, ref, env),
    covers: (base, clone) => mainCovers(base, { cwd: clone, env }),
  });
  if (json) process.stdout.write(`${JSON.stringify(results)}\n`);
  else {
    for (const entry of results.filter(entry => !entry.ok)) {
      process.stdout.write(`UNAUDITED ${clean(basename(entry.clone))} ${clean(entry.ref)} sha=${entry.sha || 'unresolved'}${entry.movedFrom ? ` moved-from=${clean(entry.movedFrom)}` : ''} added=${entry.addedAt || 'unknown'} age=${entry.ageDays ?? 'unknown'}d missing=audit+waiver\n`);
    }
    if (!unreadable && results.every(entry => entry.ok)) process.stdout.write(`OK ${results.length} overlays audited\n`);
  }
  return unreadable || results.some(entry => !entry.ok) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
