#!/usr/bin/env node
/**
 * @file rewaive-plan.mjs — DELTA-AUDIT v2 S1. Read-only planner for a waived PR whose head moved (CI-heal push).
 * It admits NOTHING and carries NOTHING: every new head needs a FULL audit and a human approval (waive.sh).
 * It only (1) names the exact audit command and (2) composes the waiver request from the new head's OWN findings.
 *   node scripts/operations/rewaive-plan.mjs --ref=<lane> [--json] [--file-request]
 * Exit: 0 ok/plan, 1 refuse (or --file-request while not in state "request"), 3 request op missing/failed.
 * Basis rule (no search, no fallback): walk the first-parent chain from tip's parent; the FIRST commit with ANY raw
 * audit record is B. B must be a full WEAKENED audit with a non-revoked waiver whose findings are byte-equal.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wellFormedAudit } from './canonical-audit-gate.mjs';
import { loadRuledWeakened } from './prototype-load-io.mjs';
import { readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { readAuditSettings, resolveAuditRecordPath } from './codex-audit-io.mjs';
import { QUESTION_HASH } from './codex-audit.mjs';

const SHA = /^[0-9a-f]{40}$/;
const MAX_WALK = 8; // a constant, not a setting
const RULING = /^R\d+[A-Za-z]?$/;
const refuse = (reason, extra = {}) => ({ state: 'refuse', reason, ...extra });
const sameFindings = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length > 0
  && a.length === b.length && a.every((x, i) => typeof x === 'string' && x === b[i]);
const isFull = r => !Object.hasOwn(r, 'basis');

/** Pure planner. Every doubt is a refuse; no timestamp is compared; the git chain decides order. */
export function planRewaive({ ref, tip, chain, merges, records, waivers, revoked = () => false, wellFormed = wellFormedAudit,
  baseOk = () => false }) {
  if (!SHA.test(String(tip)) || !Array.isArray(chain) || chain[0] !== tip || !chain.every(s => SHA.test(s))) return refuse('bad-chain');
  if (!Array.isArray(records) || !records.every(wellFormed)) return refuse('malformed-records');
  const recordsFor = sha => records.filter(r => String(r.head).toLowerCase() === sha);
  // Every record for B and H must be a current-question FULL audit under ONE base that main covers (and is not the head itself).
  const evidenceOk = (sha, recs) => recs.every(r => r.questionHash === QUESTION_HASH && isFull(r)
    && String(r.base).toLowerCase() === String(recs[0].base).toLowerCase()) && String(recs[0].base).toLowerCase() !== sha
    && baseOk(String(recs[0].base).toLowerCase());
  const baseSha = chain.slice(1).find(sha => recordsFor(sha).length > 0);
  if (!baseSha) return refuse('no-waived-ancestor');
  if (!Array.isArray(merges) || merges.length) return refuse('merge-in-delta');
  const baseRecords = recordsFor(baseSha), last = baseRecords[baseRecords.length - 1];
  if (!evidenceOk(baseSha, baseRecords) || last.verdict !== 'WEAKENED' || !last.findings.length) return refuse('basis-not-full-weakened', { basis: baseSha });
  const waiver = (waivers || []).find(w => w && w.ref === ref && String(w.sha).toLowerCase() === baseSha
    && typeof w.ruling === 'string' && RULING.test(w.ruling) && !revoked(w) && sameFindings(w.findings, last.findings));
  if (!waiver) return refuse('basis-not-waived', { basis: baseSha });
  const own = recordsFor(tip), head = own[own.length - 1];
  if (!head) return { state: 'audit-needed', basis: baseSha,
    command: `node scripts/operations/run.mjs codex-audit --base=origin/main --head=${tip}` };
  if (!evidenceOk(tip, own)) return refuse('head-evidence-unusable', { basis: baseSha });
  if (head.verdict === 'NOT WEAKENED') return { state: 'not-needed', basis: baseSha };
  if (head.verdict !== 'WEAKENED' || !head.findings.length) return refuse('head-record-unusable', { basis: baseSha });
  return { state: 'request', basis: baseSha, request: { ref, sha: tip, ruling: waiver.ruling, findings: [...head.findings],
    reason: `ci-heal re-waiver; supersedes ${baseSha}` } };
}

/** Advisory only (stdout table). Never feeds the request. */
export function classifyFindings(findings, { changed = [], added = [] } = {}, waivedFindings = []) {
  return findings.map(text => {
    const file = /([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+):\d+/.exec(text)?.[1] ?? null;
    const same = waivedFindings.indexOf(text);
    return { file, class: !file ? 'unparsed' : added.includes(file) ? 'new-file' : changed.includes(file) ? 'edited-file' : 'unchanged-file',
      sameTextAsWaived: same < 0 ? null : same };
  });
}

function defaultLoaders({ env, repo }) {
  const home = typeof env.HOME === 'string' && env.HOME.trim() ? env.HOME : homedir();
  const full = { ...env, HOME: home };
  const tool = readAuditSettings();
  const loadRecords = () => String(readFileSync(resolveAuditRecordPath(tool, { home, cwd: repo }), 'utf8'))
    .split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
  const loadWaivers = () => {
    // Any warning (damaged revocation log, unreadable store) means uncertain evidence: refuse, never authorize.
    const warnings = [], warn = m => warnings.push(String(m));
    const platform = readPlatformPreferences({ env: full, readFile: readFileSync, warn });
    if (platform.errors.length) throw new Error('platform preferences unreadable');
    const list = loadRuledWeakened({ platform: platform.prefs.prototypeLoad?.ruledWeakened, tool: tool.ruledWeakened,
      fs: { readFileSync }, env: full, warn });
    if (warnings.length) throw new Error(`waiver evidence warnings: ${warnings[0].slice(0, 100)}`);
    return list;
  };
  return { loadRecords, loadWaivers };
}

/** IO wrapper: pinned git env, read-only git, then the pure planner. Any throw is a refuse. */
export function runPlan({ repo, ref, env = process.env, exec: proc = execFileSync, loadRecords, loadWaivers, revoked, baseOk: baseOkIn, maxWalk = MAX_WALK }) {
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(String(ref)) || String(ref).includes('..')) return refuse('bad-ref');
    const loaders = loadRecords && loadWaivers ? { loadRecords, loadWaivers } : defaultLoaders({ env, repo });
    const base = { PATH: env.PATH, HOME: env.HOME, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const gitDir = String(proc('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'], { env: base, encoding: 'utf8' })).trim();
    const genv = { ...base, GIT_DIR: gitDir, GIT_WORK_TREE: repo };
    const query = (...args) => String(proc('git', args, { cwd: repo, env: genv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).trim();
    const lines = query('ls-remote', 'origin', `refs/heads/${ref}`).split('\n').filter(Boolean);
    if (lines.length !== 1) return refuse('ls-remote-not-one-line');
    const [remoteSha, remoteName] = lines[0].split('\t');
    if (!SHA.test(remoteSha) || remoteName !== `refs/heads/${ref}`) return refuse('ls-remote-bad-line');
    try { query('fetch', '--quiet', 'origin', `refs/heads/${ref}`); } catch { /* objects may already be local; verify below */ }
    const tip = query('rev-parse', '--verify', '--end-of-options', `${remoteSha}^{commit}`).toLowerCase();
    if (tip !== remoteSha) return refuse('tip-mismatch');
    const chain = query('rev-list', '--first-parent', `--max-count=${maxWalk + 1}`, tip).split('\n').filter(Boolean);
    const records = loaders.loadRecords(), waivers = loaders.loadWaivers();
    // The merges check needs B, which is only known after the walk: ask the pure planner first with none, then verify.
    try { query('fetch', '--quiet', 'origin', 'main'); } catch { /* an unrefreshed main only makes baseOk stricter */ }
    const baseOk = baseOkIn || (b => { try { query('merge-base', '--is-ancestor', b, 'origin/main'); return true; } catch { return false; } });
    const first = planRewaive({ ref, tip, chain, merges: [], records, waivers, revoked, baseOk });
    if (!first.basis) return first;
    const merges = query('rev-list', '--merges', `${first.basis}..${tip}`).split('\n').filter(Boolean);
    const out = planRewaive({ ref, tip, chain, merges, records, waivers, revoked, baseOk });
    if (out.state === 'request') {
      const names = (...a) => query('diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', ...a, `${out.basis}..${tip}`)
        .split('\n').filter(Boolean);
      const baseRecs = records.filter(r => String(r.head).toLowerCase() === out.basis);
      out.table = classifyFindings(out.request.findings, { changed: names(), added: names('--diff-filter=A') },
        baseRecs[baseRecs.length - 1].findings);
    }
    return out;
  } catch (error) {
    return refuse('error', { detail: String(error?.message || error).slice(0, 200) });
  }
}

export function runCli({ argv, repo = process.cwd(), env = process.env, loadRecords, loadWaivers, baseOk, stdout = s => process.stdout.write(s),
  spawn = spawnSync } = {}) {
  const flag = n => argv.find(a => a === `--${n}` || a.startsWith(`--${n}=`));
  const ref = flag('ref')?.split('=').slice(1).join('=');
  const out = runPlan({ repo, ref, env, loadRecords, loadWaivers, baseOk });
  const text = argv.includes('--json') ? JSON.stringify(out) : [`state: ${out.state}${out.reason ? ` (${out.reason})` : ''}`,
    ...(out.command ? [out.command] : []), ...(out.table || []).map(t => `${t.class}\t${t.file ?? '-'}\tsameTextAsWaived=${t.sameTextAsWaived}`)].join('\n');
  stdout(`${text}\n`);
  if (!argv.includes('--file-request')) return { code: out.state === 'refuse' ? 1 : 0, plan: out };
  if (out.state !== 'request') return { code: 1, plan: out };
  const op = join(env.HOME || homedir(), 'workspace/.operations/handoff/waive-request.mjs');
  if (!existsSync(op)) return { code: 3, plan: out };
  const r = spawn(process.execPath, [op, '--json=-'], { input: JSON.stringify(out.request), encoding: 'utf8', env: { PATH: env.PATH, HOME: env.HOME } });
  return { code: r.status === 0 ? 0 : 3, plan: out };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(runCli({ argv: process.argv.slice(2) }).code);
