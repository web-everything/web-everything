/** Canonical codex-audit admission shared by every PR producer. No docs-only exemption. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { canonicalAuditEvidence, validSha } from './prototype-load.mjs';
import { loadRuledWeakened } from './prototype-load-io.mjs';
import { withdrawnRevocations } from './ruled-weakened-store.mjs';
import { readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { readAuditSettings, resolveAuditRecordPath } from './codex-audit-io.mjs';
import { mainMergeCarry, mainMergeGitEnv } from '../lib/main-merge-carry.mjs';
import { carriesAcross, netDiffFingerprint } from '../lib/net-diff-fingerprint.mjs';
import { findAudit, QUESTION_HASH, isAcceptedQuestionHash, resolvePriorQuestionHashes } from './codex-audit.mjs';

// Keep multi-waiver evaluation local to PR admission. Prototype readiness retains
// its single-ruling evaluator; all validated head-specific waivers participate here.
const text = value => typeof value === 'string' ? value : '';
const lowerSha = value => typeof value === 'string' ? value.toLowerCase() : value;
function openPrAuditEvidence(records, sha, covers = () => true, liveFp = null, auditOptions = {}) {
  // R503: an audit of an older head also speaks for this head when its stored net-diff fingerprint equals the live one.
  // No stored or live fingerprint, or any difference, means no carry (a real code change always re-audits).
  // Eligibility is per RECORD: each carried record must itself hold the matching fingerprint, so one carried record
  // can never lend its head's other (unfingerprinted or foreign) records.
  // Precedence (R503 red team rounds 1–2):
  //  - per head and base, only the LATEST valid verdict counts (findAudit), over ALL that head's records — fingerprint
  //    or not — so a superseded WEAKENED never blocks forever, and an unsuperseded one is never hidden;
  //  - the live head's own verdicts decide whenever it has any, and a carried pass can never outrank them;
  //  - a carried head's latest WEAKENED blocks unless the live head has a NEWER verdict of its own (a fresh re-audit).
  // Shas compare case-insensitively (validSha accepts either case), so the live head always finds its own verdicts.
  sha = lowerSha(sha);
  // Copy a record only when lower-casing changes it, so the returned evidence keeps the caller's record identity.
  const original = new Map();
  const list = (Array.isArray(records) ? records : []).map((r) => {
    if (!r || typeof r !== 'object' || (lowerSha(r.head) === r.head && lowerSha(r.base) === r.base)) return r;
    const copy = { ...r, head: lowerSha(r.head), base: lowerSha(r.base) };
    original.set(copy, r);
    return copy;
  });
  const decisions = (head) => [...new Set(list.filter((r) => r?.head === head && r.base !== head).map((r) => r.base))]
    .map((base) => ({ base, record: findAudit(list, { head, base, questionHash: QUESTION_HASH, ...auditOptions }) })).filter((d) => d.record);
  const own = decisions(sha);
  // Only string heads carry (main #6353): a non-string head that stringifies to a sha never aliases a real one, and
  // findAudit refuses non-string head/base, so a non-string base never decides either.
  const carriedHeads = new Set(list.filter((r) => typeof r?.head === 'string' && r.head !== sha && validSha(r.head) && carriesAcross(r.fingerprint, liveFp)).map((r) => r.head));
  const carried = [...carriedHeads].flatMap(decisions);
  // Only an own verdict that could itself pass (its base is in main) is a re-audit that supersedes a carried WEAKENED:
  // a newer audit of a narrow, uncovered base never hides it behind an older covered pass.
  // Ask covers() once per base: a flaky second answer must never let the pass loop disagree with this check.
  const coverMemo = new Map();
  const covered = (base) => { if (!coverMemo.has(base)) coverMemo.set(base, !!covers(base)); return coverMemo.get(base); };
  const rulings = Array.isArray(auditOptions.ruledWeakened) ? auditOptions.ruledWeakened : [auditOptions.ruledWeakened];
  const usedRulings = new Set();
  const ruled = (record) => rulings.some(gate => {
    if (!/^R\d+(?:\+R\d+)*(?![\s\S])/.test(gate?.ruledWeakened?.ruling)) return false;
    const matches = gate?.ruledWeakened && record.questionHash === QUESTION_HASH
      // The ruled audit is the gate record's own (exact sha), or the carried audit of the same net diff: readiness
      // appended by an earlier carry names the NEW sha, and must keep binding to the audit it was carried from.
      && (record.head === lowerSha(gate.record?.sha ?? sha)
        || (carriesAcross(record.fingerprint, liveFp) && (!gate.record || carriesAcross(gate.record.fingerprint, liveFp))))
      && Array.isArray(record.findings)
      && JSON.stringify(record.findings) === JSON.stringify(gate.ruledWeakened.findings)
      && covered(record.base);
    if (matches) for (const ruling of gate.ruledWeakened.ruling.split('+')) usedRulings.add(ruling);
    return matches;
  });
  // Unruled own WEAKENED stops before git; a matching ruling still needs canonical base coverage.
  if (own.some((d) => d.record.verdict === 'WEAKENED' && !ruled(d.record))) return { ok: false, reason: 'weakened' };
  // Round 3: a live-head WEAKENED that findAudit cannot use (contradictory findings, unparsable time) must not vanish
  // and leave the live head looking unaudited, which would let a carried pass decide. Only a foreign question is ignored.
  // The same holds for a PRIOR-question WEAKENED still inside its accepted window (round 5): it is a real negative
  // verdict on this head that findAudit may reject (contradictory findings), so the veto judges it by the same
  // acceptance rule, with the same defaults, and an expired or unknown hash stays ignored.
  const { priorQuestionHashes = resolvePriorQuestionHashes(), now = Date.now() } = auditOptions ?? {};
  // The veto holds per BASE, not only when the live head has no decision at all (a usable pass on base X must not hide
  // an unusable WEAKENED on base Y). A base with a usable decision is judged by findAudit alone, so a superseded record
  // never blocks forever. A CARRIED head is deliberately not widened: "carry veto follows findAudit" (round 4) pins that
  // an unusable record on a carried head never blocks the carry.
  if (list.some((r) => r?.head === sha && r.base !== sha && r.verdict === 'WEAKENED'
    // An unparsable time cannot place the record outside its window, so it is judged by the hash's own expiry alone
    // (fail closed, matching a current-question record, which blocks whatever its time).
    && isAcceptedQuestionHash(r.questionHash, { priorQuestionHashes, now, at: Number.isFinite(Date.parse(text(r.at))) ? r.at : undefined }) && !own.some((d) => d.base === r.base))) return { ok: false, reason: 'weakened' };
  // Round 6: a carried head's PRIOR-question WEAKENED that findAudit would accept on its own can be hidden by an unusable
  // current-question record for the same head+base (findAudit lets even an unusable current record block the prior
  // fallback, which is right for a PASS but fail-open for a NEGATIVE verdict). Such a record keeps vetoing, judged by
  // the same supersede rule as any carried WEAKENED; a base with a usable decision of its own is left to findAudit.
  // The latest PRIOR-question record for that head+base decides (a later prior NOT WEAKENED re-audit supersedes it), judged
  // with the same already-resolved hashes and clock as the veto above.
  const priorOnly = list.filter((r) => r?.questionHash !== QUESTION_HASH);
  const hiddenWeak = priorOnly.filter((r) => r?.verdict === 'WEAKENED' && typeof r.head === 'string' && carriedHeads.has(r.head) && r.base !== r.head
    && !carried.some((d) => d.record.head === r.head && d.base === r.base)
    && findAudit(priorOnly, { ...auditOptions, head: r.head, base: r.base, questionHash: QUESTION_HASH, priorQuestionHashes, now }) === r).map((record) => ({ base: record.base, record }));
  const carriedWeak = [...carried, ...hiddenWeak].filter((d) => d.record.verdict === 'WEAKENED' && !ruled(d.record));
  if (carriedWeak.length) {
    const ownAt = Math.max(-Infinity, ...own.filter((d) => covered(d.base)).map((d) => Date.parse(text(d.record.at))));
    if (carriedWeak.some((d) => !(Date.parse(text(d.record.at)) < ownAt))) return { ok: false, reason: 'weakened' };
  }
  // A pass counts only when covers(base) proves its base is in main; a carried pass must itself hold the fingerprint.
  const passes = own.length ? own : carried.filter((d) => carriesAcross(d.record.fingerprint, liveFp));
  let pass = null;
  for (const { base, record } of passes) {
    // A current-question record for this head+base (usable or not) blocks a PRIOR-question pass, even when carry
    // eligibility dropped it (no or differing fingerprint): judge against ALL records, fail closed.
    if (record.questionHash !== QUESTION_HASH
      && list.some((r) => r?.head === record.head && r.base === base && r.questionHash === QUESTION_HASH)) continue;
    if (covered(base) && (!pass || Date.parse(text(record.at)) >= Date.parse(text(pass.at)))) pass = record;
  }
  return pass ? { ok: true, record: original.get(pass) ?? pass, rulings: [...usedRulings] } : { ok: false, reason: 'no-record' };
}

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
  let records, config, isRevoked;
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
    isRevoked = withdrawnRevocations({ fs: { readFileSync: readFile }, env: { ...env, HOME: home }, warn });
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
  let evidence, fp;
  try {
    fp = liveFingerprint(records);
    evidence = canonicalAuditEvidence(records, fullSha, covers, fp);
    if (!evidence.ok && evidence.reason === 'weakened') {
      const rulings = [];
      for (const entry of config.ruledWeakened) {
        if (entry.ref !== ref || !validSha(entry.sha)
          || !/^R\d+(?:\+R\d+)*(?![\s\S])/.test(entry.ruling) || !Array.isArray(entry.findings)
          || !entry.findings.length || !entry.findings.every(f => typeof f === 'string' && f.trim())) continue;
        if (entry.sha.toLowerCase() !== fullSha) {
          if (!carriesAcross(entry.fingerprint, fp)) continue;
          const carry = carryFor(entry.sha.toLowerCase());
          if (!carry.ok || !carriesAcross(entry.fingerprint, carry.fingerprint)) continue;
        }
        rulings.push({
          ruledWeakened: { ruling: entry.ruling, findings: entry.findings },
          // Bind this ruling to its own head; a fingerprint-wide ruling would also waive sibling vetoes.
          record: { sha: entry.sha, fingerprint: null },
        });
      }
      // All valid waivers participate in the same veto evaluation. Never combine
      // findings or remove records: canonical precedence still judges every audit.
      evidence = openPrAuditEvidence(records, fullSha, covers, fp, { ruledWeakened: rulings });
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
      // The source waiver was checked on load. Every destination/intermediate
      // head must independently remain free of withdrawal or damaged evidence.
      const revokedHead = carry.chain.find(sha => isRevoked({ ref, sha }));
      if (revokedHead) return { ok: false, reason: 'canonical-audit-weakened', record: null, sha: fullSha,
        message: `Main-merge carry refused: head ${revokedHead} is withdrawn or its withdrawal evidence is unreadable/malformed. Ask the operator to resolve the withdrawal evidence before retrying.` };
      // Judge each merge head/base, including fingerprintless evidence, with
      // canonical eligibility and precedence. Different bases may have separate waivers.
      const intermediateHeads = new Set([carry.from, ...carry.chain.filter(head => head !== fullSha)]);
      const intermediateDecisions = new Map();
      for (const record of records) {
        const head = record.head.toLowerCase(), base = record.base.toLowerCase();
        if (!intermediateHeads.has(head)) continue;
        const key = `${head}:${base}`;
        if (!intermediateDecisions.has(key)) intermediateDecisions.set(key, { head, records: [] });
        intermediateDecisions.get(key).records.push(record);
      }
      const provenanceRulings = new Set(evidence.rulings ?? []);
      for (const { head, records: headRecords } of intermediateDecisions.values()) {
        if (canonicalAuditEvidence(headRecords, head, covers).reason !== 'weakened') continue;
        const waiver = config.ruledWeakened.find(entry =>
          entry.ref === ref && validSha(entry.sha) && entry.sha.toLowerCase() === head
          && carriesAcross(entry.fingerprint, fp) && carriesAcross(entry.fingerprint, carry.fingerprint)
          && /^R\d+(?:\+R\d+)*(?![\s\S])/.test(entry.ruling) && Array.isArray(entry.findings)
          && entry.findings.length > 0 && entry.findings.every(f => typeof f === 'string' && f.trim())
          && canonicalAuditEvidence(headRecords, head, covers, null, { ruledWeakened: {
            ruledWeakened: { ruling: entry.ruling, findings: entry.findings },
            record: { sha: entry.sha, fingerprint: null },
          } }).ok);
        if (!waiver) return { ok: false, reason: 'canonical-audit-weakened', record: null, sha: fullSha,
          message: `Main-merge carry refused: intermediate head ${head} has an unwaived WEAKENED audit. Ask the operator to resolve this evidence or restore a non-revoked waiver matching that head's ref, sha, fingerprint and exact findings.` };
        for (const ruling of waiver.ruling.split('+')) provenanceRulings.add(ruling);
      }
      return {
        ok: true, reason: null, message: '', record: evidence.record, sha: fullSha,
        carried: { kind: 'carried-across-main-merge', from: carry.from, to: carry.to,
          mainParent: carry.mainParent, fingerprint: carry.fingerprint, rulings: [...provenanceRulings], ruling: [...provenanceRulings].join('+') || null },
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

/** Shared provenance text for every PR producer. */
export function auditCarryNotice(c) {
  return `carried-across-main-merge ${c.from.slice(0, 8)}..${c.to.slice(0, 8)} fp ${c.fingerprint.slice(0, 8)} ruling ${c.ruling ?? 'none'}\n`;
}
export function auditCarryNote(c) {
  return `\n<!-- audit-carry: carried-across-main-merge ${c.from}..${c.to} -->\nMain-merge audit carry preserves the lane diff; CI still runs on the merged head.\n`;
}
