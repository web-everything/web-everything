/** Canonical codex-audit admission shared by every PR producer. No docs-only exemption. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalAuditEvidence, mergeRuledWeakened, jsonLines, validSha } from './prototype-load.mjs';
import { readPlatformPreferences, resolveCascade } from '../lib/policy-cascade.mjs';
import { netDiffFingerprint } from '../lib/net-diff-fingerprint.mjs';

export function checkCanonicalAuditForOpen({ repo = process.cwd(), ref, sha, env = process.env,
  readFile = readFileSync, exec = execFileSync, fetchMain: fetchMainOpt, ancestor: ancestorOpt,
  liveFingerprint: liveFingerprintOpt, warn = message => console.warn(message),
} = {}) {
  const git = (...args) => String(exec('git', ['-C', repo, ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  })).trim();
  let fullSha;
  try { fullSha = git('rev-parse', '--verify', '--end-of-options', `${sha || 'HEAD'}^{commit}`).toLowerCase(); } catch { /* refuse below */ }
  if (!validSha(fullSha)) return { ok: false, reason: 'canonical-audit-missing', record: null,
    message: 'cannot resolve the PR source to a full 40-hex sha; resolve it with git rev-parse, then run node scripts/operations/run.mjs codex-audit --base=origin/main --head=<fullsha>' };
  const refuse = (reason, detail) => ({ ok: false, reason, record: null, sha: fullSha,
    message: `${detail}. Run node scripts/operations/run.mjs codex-audit --base=origin/main --head=${fullSha}, then retry opening the PR.` });
  let records, config;
  try {
    const tool = JSON.parse(readFile(join(repo, 'scripts/settings/prototype-load.json'), 'utf8'));
    const platform = readPlatformPreferences({ env, readFile, warn });
    if (platform.errors.length) throw new Error('platform preferences unreadable');
    config = { ...resolveCascade({ platform: platform.prefs.prototypeLoad, tool }).value,
      ruledWeakened: mergeRuledWeakened(platform.prefs.prototypeLoad?.ruledWeakened, tool.ruledWeakened, warn) };
    const path = config.auditRecordPath;
    records = jsonLines(readFile(path.startsWith('~/') ? join(env.HOME, path.slice(2)) : path, 'utf8'));
  } catch {
    return refuse('canonical-audit-missing', `no canonical codex-audit record for ${fullSha} (audit evidence or settings unreadable)`);
  }
  let fetchAttempted = false, fetched = false;
  const fetchMain = () => {
    if (!fetchAttempted) {
      fetchAttempted = true;
      try { (fetchMainOpt || (() => git('fetch', 'origin', 'main')))(); fetched = true; } catch { /* no coverage */ }
    }
    if (!fetched) throw new Error('origin/main fetch unavailable; retry when main can be read');
  };
  const ancestor = ancestorOpt || ((base, head) => { git('merge-base', '--is-ancestor', base, head); return true; });
  const covers = base => { try { fetchMain(); return ancestor(base, 'origin/main'); } catch { return false; } };
  const liveFingerprint = liveFingerprintOpt || (evidence => {
    const same = value => typeof value === 'string' && value.toLowerCase() === fullSha;
    if (!evidence.some(r => r?.fingerprint && (r.head || r.sha) && !same(r.sha) && !same(r.head))) return null;
    try {
      fetchMain();
      git('fetch', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`);
      return netDiffFingerprint(repo, 'origin/main', fullSha, { exec }) || null;
    } catch { return null; }
  });
  // Opening requires this exact head even when prototype admission could carry an older fingerprint.
  const exact = records.filter(r => typeof r?.head === 'string' && r.head.toLowerCase() === fullSha);
  let evidence;
  try {
    const fp = liveFingerprint(records);
    evidence = canonicalAuditEvidence(exact, fullSha, covers, fp);
    if (!evidence.ok && evidence.reason === 'weakened') {
      for (const entry of config.ruledWeakened) {
        if (entry.ref !== ref || !validSha(entry.sha) || entry.sha.toLowerCase() !== fullSha
          || !/^R\d+(?:\+R\d+)*$/.test(entry.ruling) || !Array.isArray(entry.findings)
          || !entry.findings.length || !entry.findings.every(f => typeof f === 'string' && f.trim())) continue;
        const waived = canonicalAuditEvidence(exact, fullSha, covers, fp, { ruledWeakened: {
          ruledWeakened: { ruling: entry.ruling, findings: entry.findings }, record: { sha: fullSha, fingerprint: null },
        } });
        if (waived.ok) { evidence = waived; break; }
      }
    }
  } catch { evidence = { ok: false, reason: 'no-record' }; }
  if (evidence.ok) return { ok: true, reason: null, message: '', record: evidence.record, sha: fullSha };
  return evidence.reason === 'weakened'
    ? refuse('canonical-audit-weakened', `latest canonical audit for ${fullSha} is WEAKENED and no ruledWeakened waiver matches ref+sha+findings`)
    : refuse('canonical-audit-missing', `no canonical codex-audit record for ${fullSha} with coverage of origin/main`);
}
