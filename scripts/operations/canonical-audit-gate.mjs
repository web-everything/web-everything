/** Canonical codex-audit admission shared by every PR producer. No docs-only exemption. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { canonicalAuditEvidence, validSha } from './prototype-load.mjs';
import { loadRuledWeakened } from './prototype-load-io.mjs';
import { readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { readAuditSettings, resolveAuditRecordPath } from './codex-audit-io.mjs';
import { netDiffFingerprint, testOnlyAdditiveDelta } from '../lib/net-diff-fingerprint.mjs';
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
  readFile = readFileSync, exec = execFileSync, fetchMain: fetchMainOpt, refreshMain = false, ancestor: ancestorOpt,
  liveFingerprint: liveFingerprintOpt, warn = message => console.warn(message), now = () => Date.now(),
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
  let evidence;
  try {
    const fp = liveFingerprint(records);
    evidence = canonicalAuditEvidence(records, fullSha, covers, fp);
    if (!evidence.ok && evidence.reason === 'weakened') {
      for (const entry of config.ruledWeakened) {
        // Waivers stay exact-head only: a carried head needs its own waiver.
        if (entry.ref !== ref || !validSha(entry.sha) || entry.sha.toLowerCase() !== fullSha
          || !/^R\d+(?:\+R\d+)*$/.test(entry.ruling) || !Array.isArray(entry.findings)
          || !entry.findings.length || !entry.findings.every(f => typeof f === 'string' && f.trim())) continue;
        const waived = canonicalAuditEvidence(records, fullSha, covers, fp, { ruledWeakened: {
          ruledWeakened: { ruling: entry.ruling, findings: entry.findings }, record: { sha: fullSha, fingerprint: null },
        } });
        if (waived.ok) { evidence = waived; break; }
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
  // Test-only additive carry: a passing audit of an ANCESTOR head carries when the delta to this head only ADDS
  // lines to test files (see testOnlyAdditiveDelta). Never after a WEAKENED verdict; the audited head must itself
  // pass with covered base and no own-head verdict may exist for this head.
  if (!evidence.ok && evidence.reason !== 'weakened') {
    try {
      // Only the NEWEST audited ancestor may carry (an older pass must never outrank a later verdict), and this
      // head must have no verdict of its own. The ancestor is judged with its own stored fingerprint so matching
      // negative evidence still vetoes.
      if (records.some(r => String(r.head).toLowerCase() === fullSha)) throw new Error('own verdict exists');
      const isAncestor = h => { try { git('merge-base', '--is-ancestor', h, fullSha); return true; } catch { return false; } };
      const newest = [...records].reverse().find(r => isAncestor(String(r.head).toLowerCase()));
      const head = newest && String(newest.head).toLowerCase();
      const audited = head && canonicalAuditEvidence(records, head, covers, newest.fingerprint ?? null);
      if (audited?.ok && audited.record?.head === head && testOnlyAdditiveDelta(repo, head, fullSha, { exec }).ok) {
        const et = new Date(now()).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
        warn(`carried: test-only additive delta ${head}..${fullSha} (${et} ET)`);
        return { ok: true, reason: null, message: '', record: audited.record, sha: fullSha, carried: { head, kind: 'test-only-additive' } };
      }
    } catch { /* unknown means no carry */ }
  }
  return evidence.reason === 'weakened'
    ? refuse('canonical-audit-weakened', `latest canonical audit for ${fullSha} is WEAKENED and no ruledWeakened waiver matches ref+sha+findings`)
    : refuse('canonical-audit-missing', `no canonical codex-audit record for ${fullSha} with coverage of origin/main`);
}
