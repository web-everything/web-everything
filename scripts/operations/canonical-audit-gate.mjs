/** Canonical codex-audit admission shared by every PR producer. No docs-only exemption. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { canonicalAuditEvidence, validSha } from './prototype-load.mjs';
import { loadRuledWeakened } from './prototype-load-io.mjs';
import { readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { readAuditSettings, resolveAuditRecordPath } from './codex-audit-io.mjs';
import { mainMergeCarry, mainMergeGitEnv } from '../lib/main-merge-carry.mjs';
import { carriesAcross, netDiffFingerprint } from '../lib/net-diff-fingerprint.mjs';
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
  liveFingerprint: liveFingerprintOpt, warn = message => console.warn(message),
} = {}) {
  const gitEnv = mainMergeGitEnv(env);
  const fingerprintExec = (cmd, args, options) => exec(cmd, ['-c', 'core.commitGraph=false', ...args], { ...options, env: gitEnv });
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
  const liveFingerprint = liveFingerprintOpt || (evidence => {
    const same = value => typeof value === 'string' && value.toLowerCase() === fullSha;
    if (!evidence.some(r => r?.fingerprint && (r.head || r.sha) && !same(r.sha) && !same(r.head))) return null;
    try {
      fetchMain();
      // fullSha was resolved locally above. A new lane ref need not exist on
      // origin until pr-land publishes it after admission.
      const fp = netDiffFingerprint(repo, 'origin/main', fullSha, { exec: fingerprintExec });
      if (!fp) throw new Error('empty fingerprint');
      return fp;
    } catch (e) { throw Object.assign(new Error(`live diff fingerprint unavailable (${String(e?.message || e).slice(0, 120)})`), { fingerprintLookup: true }); }
  });
  const carryMemo = new Map();
  const carryFor = auditedSha => {
    if (!carryMemo.has(auditedSha)) {
      try {
        fetchMain();
        carryMemo.set(auditedSha, mainMergeCarry({ repo, auditedSha, head: fullSha, exec, env: gitEnv }));
      } catch { carryMemo.set(auditedSha, { ok: false }); }
    }
    return carryMemo.get(auditedSha);
  };
  let carryRuling = null;
  let evidence;
  try {
    const fp = liveFingerprint(records);
    evidence = canonicalAuditEvidence(records, fullSha, covers, fp);
    if (!evidence.ok && evidence.reason === 'weakened') {
      for (const entry of config.ruledWeakened) {
        // Preserve the existing exact-head waiver path; historical waivers are checked separately below.
        if (entry.ref !== ref || !validSha(entry.sha) || entry.sha.toLowerCase() !== fullSha
          || !/^R\d+(?:\+R\d+)*$/.test(entry.ruling) || !Array.isArray(entry.findings)
          || !entry.findings.length || !entry.findings.every(f => typeof f === 'string' && f.trim())) continue;
        const waived = canonicalAuditEvidence(records, fullSha, covers, fp, { ruledWeakened: {
          ruledWeakened: { ruling: entry.ruling, findings: entry.findings }, record: { sha: fullSha, fingerprint: null },
        } });
        if (waived.ok) { evidence = waived; break; }
      }
    }
    if (!evidence.ok && evidence.reason === 'weakened') {
      for (const entry of config.ruledWeakened) {
        if (entry.ref !== ref || !validSha(entry.sha) || entry.sha.toLowerCase() === fullSha
          || !/^R\d+(?:\+R\d+)*$/.test(entry.ruling) || !Array.isArray(entry.findings)
          || !entry.findings.length || !entry.findings.every(f => typeof f === 'string' && f.trim())
          || !carriesAcross(entry.fingerprint, fp)) continue;
        const carry = carryFor(entry.sha.toLowerCase());
        if (!carry.ok || !carriesAcross(entry.fingerprint, carry.fingerprint)) continue;
        const waived = canonicalAuditEvidence(records, fullSha, covers, carry.fingerprint, { ruledWeakened: {
          ruledWeakened: { ruling: entry.ruling, findings: entry.findings },
          // Bind this ruling to its own head; a fingerprint-wide ruling would also waive sibling vetoes.
          record: { sha: entry.sha, fingerprint: null },
        } });
        // Only the named historical verdict may be admitted by this waiver.
        if (waived.ok && waived.record.head.toLowerCase() === entry.sha.toLowerCase()
          && carriesAcross(waived.record.fingerprint, carry.fingerprint)) {
          evidence = waived; carryRuling = entry.ruling; break;
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
  if (evidence.ok) {
    const carry = carryFor(evidence.record?.head?.toLowerCase());
    if (carry.ok && carriesAcross(evidence.record?.fingerprint, carry.fingerprint)) {
      // A merge head's own negative evidence must not disappear just because it
      // lacks the fingerprint used to select carried records.
      const intermediateHeads = new Set(carry.chain.filter(head => head !== fullSha));
      const unwaived = records.find(record => intermediateHeads.has(record.head.toLowerCase())
        && record.verdict === 'WEAKENED' && !config.ruledWeakened.some(entry =>
          entry.ref === ref && validSha(entry.sha) && entry.sha.toLowerCase() === record.head.toLowerCase()
          && /^R\d+(?:\+R\d+)*$/.test(entry.ruling) && Array.isArray(entry.findings)
          && entry.findings.length > 0 && entry.findings.every(f => typeof f === 'string' && f.trim())
          && canonicalAuditEvidence([record], record.head, covers, null, { ruledWeakened: {
            ruledWeakened: { ruling: entry.ruling, findings: entry.findings },
            record: { sha: entry.sha, fingerprint: null },
          } }).ok));
      if (unwaived) return { ok: false, reason: 'canonical-audit-weakened', record: null, sha: fullSha,
        message: `Main-merge carry refused: intermediate head ${unwaived.head} has an unwaived WEAKENED audit. Ask the operator to resolve this evidence or restore a non-revoked waiver matching that head's ref, sha and exact findings.` };
      return {
        ok: true, reason: null, message: '', record: evidence.record, sha: fullSha,
        carried: { kind: 'carried-across-main-merge', from: carry.from, to: carry.to,
          mainParent: carry.mainParent, fingerprint: carry.fingerprint, ruling: carryRuling },
      };
    }
  }
  const eligible = records.some(r => r.head.toLowerCase() !== fullSha && carryFor(r.head.toLowerCase()).ok
    && carriesAcross(r.fingerprint, carryFor(r.head.toLowerCase()).fingerprint));
  if (eligible) return { ok: false, reason: evidence.reason === 'weakened' ? 'canonical-audit-weakened' : 'canonical-audit-missing',
    record: null, sha: fullSha, message: `Main-merge carry applies to ${fullSha}; do not re-audit. Restore a non-revoked waiver matching the audited ref, sha, fingerprint and exact findings, or ask the operator to resolve newer evidence.` };
  return evidence.reason === 'weakened'
    ? refuse('canonical-audit-weakened', `latest canonical audit for ${fullSha} is WEAKENED and no ruledWeakened waiver matches ref+sha+findings`)
    : refuse('canonical-audit-missing', `no canonical codex-audit record for ${fullSha} with coverage of origin/main`);
}
