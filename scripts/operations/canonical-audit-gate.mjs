/** Canonical codex-audit admission shared by every PR producer. No docs-only exemption. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { canonicalAuditEvidence, validSha } from './prototype-load.mjs';
import { loadRuledWeakened } from './prototype-load-io.mjs';
import { readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { readAuditSettings, resolveAuditRecordPath } from './codex-audit-io.mjs';
import { netDiffFingerprint } from '../lib/net-diff-fingerprint.mjs';
import { findAudit, QUESTION_HASH } from './codex-audit.mjs';

const isTestOnlyPath = path => /\.test\.(?:mjs|js|ts)$/.test(path);

// The shared evaluator skips unusable records. At admission, corrupt evidence must
// refuse before that skip can expose an older pass (including a carried pass).
function wellFormedAudit(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !validSha(record.head) || !validSha(record.base)
    || typeof record.questionHash !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/i.test(record.questionHash)
    || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))
    || (record.fingerprint != null && (typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/i.test(record.fingerprint)))
    || !Array.isArray(record.findings) || !record.findings.every(f => typeof f === 'string')) return false;
  // Validate verdict/contradiction syntax with the canonical parser, even for a
  // historical question. The original hash still determines evidence eligibility.
  const candidate = { ...record, head: record.head.toLowerCase(), base: record.base.toLowerCase(), questionHash: QUESTION_HASH };
  return findAudit([candidate], { head: candidate.head, base: candidate.base, questionHash: QUESTION_HASH, priorQuestionHashes: [] }) === candidate;
}

export function checkCanonicalAuditForOpen({ repo = process.cwd(), ref, sha, env = process.env,
  readFile = readFileSync, exec = execFileSync, fetchMain: fetchMainOpt, refreshMain = false, ancestor: ancestorOpt,
  liveFingerprint: liveFingerprintOpt, warn = message => console.warn(message),
} = {}) {
  const gitEnv = { ...env, GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined,
    GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' };
  const git = (...args) => String(exec('git', ['-C', repo, ...args], {
    env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  })).trim();
  let fullSha;
  try { fullSha = git('rev-parse', '--verify', '--end-of-options', `${sha || 'HEAD'}^{commit}`).toLowerCase(); } catch { /* refuse below */ }
  if (!validSha(fullSha)) return { ok: false, reason: 'canonical-audit-missing', record: null,
    message: 'cannot resolve the PR source to a full 40-hex sha; resolve it with git rev-parse, then run node scripts/operations/run.mjs codex-audit --base=origin/main --head=<fullsha>' };
  const refuse = (reason, detail) => ({ ok: false, reason, record: null, sha: fullSha,
    message: `${detail}. Run node scripts/operations/run.mjs codex-audit --base=origin/main --head=${fullSha}, then retry opening the PR.` });
  let fetchAttempted = false, fetched = false, fetchError;
  const fetchMain = () => {
    if (!fetchAttempted) {
      fetchAttempted = true;
      try { (fetchMainOpt || (() => git('fetch', 'origin', 'main')))(); fetched = true; }
      catch (error) { fetchError = String(error?.stderr || error?.message || error).trim(); }
    }
    if (!fetched) throw new Error(`main not refreshed: ${fetchError || 'origin/main fetch unavailable; retry when main can be read'}`);
  };
  // A preflight may read refs but must never admit evidence against an unrefreshed main.
  if (refreshMain) {
    try { fetchMain(); }
    catch (error) { return refuse('canonical-audit-missing', error.message); }
  }
  let records, config;
  try {
    // Same settings source and path resolution as the audit writer (codex-audit-io.mjs): the file beside
    // these scripts, never <repo>/scripts/settings — a sibling-repo target has none (#7011).
    const tool = readAuditSettings(readFile);
    const platform = readPlatformPreferences({ env, readFile, warn });
    if (platform.errors.length) throw new Error('platform preferences unreadable');
    // Same waiver layers as prototype-load (tool, platform, then the operator ops store), so an operator
    // `ruled-weakened-add` ruling admits here too (#7011 round 3). An unreadable store grants nothing.
    // The writer resolves `~` with os.homedir(); an unset/blank HOME falls back to it too (never a
    // relative join), so both resolve the same record file and the ops store stays readable.
    const home = typeof env.HOME === 'string' && env.HOME.trim() ? env.HOME : homedir();
    config = { ruledWeakened: loadRuledWeakened({ platform: platform.prefs.prototypeLoad?.ruledWeakened,
      tool: tool.ruledWeakened, fs: { readFileSync: readFile }, env: { ...env, HOME: home }, warn }) };
    const contents = readFile(resolveAuditRecordPath(tool, { home, cwd: repo }), 'utf8');
    try {
      records = String(contents).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    } catch {
      return refuse('canonical-audit-missing', 'the audit record file has an unreadable/truncated line');
    }
    if (!records.every(wellFormedAudit)) {
      return refuse('canonical-audit-missing', 'the audit record file has a malformed record; inspect and repair the audit record file');
    }
  } catch {
    return refuse('canonical-audit-missing', `no canonical codex-audit record for ${fullSha} (audit evidence or settings unreadable)`);
  }
  const ancestor = ancestorOpt || ((base, head) => { git('merge-base', '--is-ancestor', base, head); return true; });
  const covers = base => { try { fetchMain(); return ancestor(base, 'origin/main'); } catch { return false; } };
  const liveFingerprint = liveFingerprintOpt || ((evidence, head = fullSha) => {
    const same = value => typeof value === 'string' && value.toLowerCase() === head;
    if (!evidence.some(r => r?.fingerprint && (r.head || r.sha) && !same(r.sha) && !same(r.head))) return null;
    try {
      fetchMain();
      // fullSha was resolved locally above. A new lane ref need not exist on
      // origin until pr-land publishes it after admission.
      const fp = netDiffFingerprint(repo, 'origin/main', head, {
        exec: (cmd, args, options) => exec(cmd, args, { ...options, env: gitEnv }),
      });
      if (!fp) throw new Error('empty fingerprint');
      return fp;
    } catch (e) { throw Object.assign(new Error(`live diff fingerprint unavailable (${String(e?.message || e).slice(0, 120)})`), { fingerprintLookup: true }); }
  });
  // Unknown means no carry: any git failure, a non-merge head, or an unrelated audited head refuses.
  const mergesIn = (auditedHead) => {
    try {
      if (!validSha(auditedHead) || auditedHead.toLowerCase() === fullSha) return false;
      // Exactly two parents: the audited head first, the second already inside origin/main (a merge FROM main).
      const parts = git('rev-list', '--parents', '-n', '1', fullSha).split(/\s+/).filter(Boolean).map(s => s.toLowerCase());
      if (parts.length !== 3 || parts[0] !== fullSha || parts[1] !== auditedHead.toLowerCase() || !validSha(parts[2])) return false;
      fetchMain();
      return ancestor(parts[2], 'origin/main');
    } catch { return false; }
  };
  // Carry reads immutable trees, with replacements/grafts disabled. Overflow or unreadable
  // evidence refuses; the existing refusal tells the operator to audit the current head.
  const testCarry = waivedSha => {
    try {
      const pinnedEnv = { ...gitEnv };
      const run = (...args) => String(exec('git', ['-C', repo, ...args], {
        env: pinnedEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: 5000,
      }));
      pinnedEnv.GIT_DIR = run('rev-parse', '--absolute-git-dir').trim();
      if (!pinnedEnv.GIT_DIR) return null;
      pinnedEnv.GIT_WORK_TREE = repo;
      run('merge-base', '--is-ancestor', waivedSha, fullSha);
      const delta = run('diff', '--name-status', '-z', '-M', '--no-renames', '--no-ext-diff',
        '--no-textconv', '--ignore-submodules=none', '--no-relative', `${waivedSha}..${fullSha}`, '--');
      if (delta.length > 1024 * 1024 || !delta.endsWith('\0')) return null;
      const parts = delta.slice(0, -1).split('\0'), files = [];
      if (parts.length % 2 || parts.length > 256) return null;
      for (let i = 0; i < parts.length; i += 2) {
        const path = parts[i + 1];
        if (!/^[AM]$/.test(parts[i]) || !isTestOnlyPath(path)) return null;
        if (parts[i] === 'M') {
          const stat = run('diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
            '--ignore-submodules=none', '--no-relative', `${waivedSha}..${fullSha}`, '--', path).split('\t');
          if (stat.length !== 3 || !/^\d+$/.test(stat[0]) || stat[1] !== '0' || stat[2] !== `${path}\0`) return null;
        }
        files.push(path);
        const segments = path.split('/'), name = segments.pop(), dir = segments.pop() || '.';
        const queries = [['-e', name, '-e', name.replace(/\.[^.]+$/, '')],
          ...['import.meta.glob', 'readdirSync'].map(loader => ['--all-match', '-e', dir, '-e', loader])];
        for (const query of queries) {
          let hits;
          try { hits = run('grep', '-l', '-z', '-F', ...query, fullSha, '--'); }
          catch (error) { if (error.status === 1) continue; throw error; }
          if (hits.length > 1024 * 1024 || !hits.endsWith('\0') || hits.slice(0, -1).split('\0').some(hit =>
            !hit.startsWith(`${fullSha}:`) || !isTestOnlyPath(hit.slice(41)))) return null;
        }
      }
      return { waivedSha, head: fullSha, files };
    } catch { return null; }
  };
  let evidence;
  try {
    const fp = liveFingerprint(records);
    evidence = canonicalAuditEvidence(records, fullSha, covers, fp);
    if (!evidence.ok) {
      for (const entry of config.ruledWeakened) {
        if (entry.ref !== ref || !validSha(entry.sha)
          || !/^R\d+(?:\+R\d+)*$/.test(entry.ruling) || !Array.isArray(entry.findings)
          || !entry.findings.length || !entry.findings.every(f => typeof f === 'string' && f.trim())) continue;
        const waivedSha = entry.sha.toLowerCase();
        if (waivedSha !== fullSha && evidence.reason !== 'no-record') continue;
        const carry = waivedSha === fullSha ? null : testCarry(waivedSha);
        // A current-head audit always decides; an older waiver cannot supersede it.
        if (waivedSha !== fullSha && (!carry || records.some(r => r.head.toLowerCase() === fullSha))) continue;
        const waivedFp = carry ? liveFingerprint(records, waivedSha) : fp;
        if (carry && canonicalAuditEvidence(records, waivedSha, covers, waivedFp).reason !== 'weakened') continue;
        const waived = canonicalAuditEvidence(records, waivedSha, covers, waivedFp, { ruledWeakened: {
            ruledWeakened: { ruling: entry.ruling, findings: entry.findings }, record: { sha: waivedSha, fingerprint: null },
          } });
        if (waived.ok && carry && waived.record?.head.toLowerCase() === waivedSha) {
          return { ok: true, reason: null, message: '', record: waived.record, sha: fullSha, carry };
        }
        if (waived.ok && !carry) { evidence = waived; break; }
      }
    }
  } catch (e) {
    // R994: a fingerprint/veto lookup failure refuses; never fall back to an older exact-head pass.
    if (e?.fingerprintLookup) return refuse('canonical-audit-missing', `cannot verify newer WEAKENED audits for ${fullSha}: ${e.message}`);
    evidence = { ok: false, reason: 'no-record' };
  }
  // Evaluate every head's veto first, then require this head's own passing evidence to open.
  if (evidence.ok && evidence.record?.head === fullSha) return { ok: true, reason: null, message: '', record: evidence.record, sha: fullSha };
  // Merge-from-main carry (R503 reuse): evidence.ok for another head already means its stored net-diff fingerprint
  // equals the live one. It admits only when the live head is a merge commit that contains that audited head.
  if (evidence.ok && mergesIn(evidence.record?.head)) return { ok: true, reason: null, message: '', record: evidence.record, sha: fullSha };
  return evidence.reason === 'weakened'
    ? refuse('canonical-audit-weakened', `latest canonical audit for ${fullSha} is WEAKENED and no ruledWeakened waiver matches ref+sha+findings`)
    : refuse('canonical-audit-missing', `no canonical codex-audit record for ${fullSha} with coverage of origin/main`);
}
