import { createSameContentProof, recordWaiverCarry } from '../lib/same-content-waiver-io.mjs';
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
  readFile = readFileSync, exec = execFileSync, fetchMain: fetchMainOpt, ancestor: ancestorOpt,
  liveFingerprint: liveFingerprintOpt, sameContent: sameContentOpt, recordCarry = recordWaiverCarry, carryLogPath, warn = message => console.warn(message),
} = {}) {
  const git = (...args) => String(exec('git', ['-C', repo, ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  })).trim();
  const sameContent = sameContentOpt || createSameContentProof({ repo, exec, env });
  let fullSha;
  try { fullSha = git('rev-parse', '--verify', '--end-of-options', `${sha || 'HEAD'}^{commit}`).toLowerCase(); } catch { /* refuse below */ }
  if (!validSha(fullSha)) return { ok: false, reason: 'canonical-audit-missing', record: null,
    message: 'cannot resolve the PR source to a full 40-hex sha; resolve it with git rev-parse, then run node scripts/operations/run.mjs codex-audit --base=origin/main --head=<fullsha>' };
  const refuse = (reason, detail) => ({ ok: false, reason, record: null, sha: fullSha,
    message: `${detail}. Run node scripts/operations/run.mjs codex-audit --base=origin/main --head=${fullSha}, then retry opening the PR.` });
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
      // fullSha was resolved locally above. A new lane ref need not exist on
      // origin until pr-land publishes it after admission.
      const fp = netDiffFingerprint(repo, 'origin/main', fullSha, { exec });
      if (!fp) throw new Error('empty fingerprint');
      return fp;
    } catch (e) { throw Object.assign(new Error(`live diff fingerprint unavailable (${String(e?.message || e).slice(0, 120)})`), { fingerprintLookup: true }); }
  });
  let evidence;
  try {
    const fp = liveFingerprint(records);
    evidence = canonicalAuditEvidence(records, fullSha, covers, fp, { sameContent });
    if (!evidence.ok && evidence.reason === 'weakened') {
      for (const entry of config.ruledWeakened) {
        if (entry.ref !== ref || !validSha(entry.sha) || (entry.sha.toLowerCase() !== fullSha && !sameContent(entry.sha.toLowerCase(), fullSha).carries)
          || !/^R\d+(?:\+R\d+)*$/.test(entry.ruling) || !Array.isArray(entry.findings)
          || !entry.findings.length || !entry.findings.every(f => typeof f === 'string' && f.trim())) continue;
        const carry = entry.sha.toLowerCase() !== fullSha ? sameContent(entry.sha.toLowerCase(), fullSha) : null;
        const waived = canonicalAuditEvidence(records, fullSha, covers, fp, { sameContent, ruledWeakened: {
          ...(carry ? { sameContentCarry: carry } : {}),
          ruledWeakened: { ruling: entry.ruling, findings: entry.findings }, record: { sha: fullSha, fingerprint: null },
        } });
        if (waived.ok && waived.record?.head === fullSha) {
          evidence = waived;
          if (carry && waived.record?.head === fullSha) try { recordCarry({ ref, from: entry.sha, to: fullSha, ruling: entry.ruling, matched: waived.record.findings, commits: carry.commits }, { env, ...(carryLogPath ? { path: carryLogPath } : {}) }); } catch { /* best effort */ }
          break;
        }
      }
    }
  } catch (e) {
    // R994: a fingerprint/veto lookup failure refuses; never fall back to an older exact-head pass.
    if (e?.fingerprintLookup) return refuse('canonical-audit-missing', `cannot verify newer WEAKENED audits for ${fullSha}: ${e.message}`);
    evidence = { ok: false, reason: 'no-record' };
  }
  // Evaluate every head's veto first, then require this head's own passing evidence to open.
  if (evidence.ok && evidence.record?.head === fullSha) return { ok: true, reason: null, message: '', record: evidence.record, sha: fullSha };
  return evidence.reason === 'weakened'
    ? refuse('canonical-audit-weakened', `latest canonical audit for ${fullSha} is WEAKENED and no ruledWeakened waiver matches ref+sha+findings`)
    : refuse('canonical-audit-missing', `no canonical codex-audit record for ${fullSha} with coverage of origin/main`);
}
