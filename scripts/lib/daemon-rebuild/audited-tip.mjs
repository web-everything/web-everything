import { execFileSync } from 'node:child_process';
import { laneHistoryProofEnv } from '../lane-git-hardening.mjs';
import { createSameContentProof } from '../same-content-waiver-io.mjs';
import { checkCanonicalAuditForOpen } from '../../operations/canonical-audit-gate.mjs';
/** unaudited-tip — fail closed to the adopted head when audit evidence is unavailable. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveOverlayFollowTip } from '../daemon-overlays.mjs';
import { verifyRev } from './shared.mjs';
import { readPlatformPreferences } from '../policy-cascade.mjs';
import { mergeRuledWeakened, readyEvidence } from '../../operations/prototype-load.mjs';

const TOOL_SETTINGS = new URL('../../settings/prototype-load.json', import.meta.url);

export function makeAuditedTipGate(env = process.env, { repo = process.cwd(), exec = execFileSync, canonicalAudit = checkCanonicalAuditForOpen } = {}) {
  if (resolveOverlayFollowTip(env) === 'follow') return null;
  let snapshot;
  const proofExec = (file, args, options) => exec(file, args, { ...options,
    env: laneHistoryProofEnv({ ...env, ...options?.env }),
  });
  const sameContent = createSameContentProof({ repo, exec: proofExec, env });
  return (ref, sha) => {
    // Snapshot lazily, once per gate, so every decision in a plan sees the same evidence.
    if (snapshot === undefined) {
      snapshot = { records: [], ruledWeakened: [] };
      try {
        let tool = {};
        try { tool = JSON.parse(readFileSync(TOOL_SETTINGS, 'utf8')); } catch { /* an explicit env path still works */ }
        const path = env.WE_FIX_READY_PATH || tool.readyRecordPath;
        const expanded = path === '~' ? homedir() : path.replace(/^~\//, `${homedir()}/`);
        for (const line of readFileSync(expanded, 'utf8').split('\n')) {
          try { snapshot.records.push(JSON.parse(line)); } catch { /* Bad JSONL lines supply no evidence. */ }
        }
        // The operator allowlist is the same union prototype-load uses; a WEAKENED record is only ever evidence
        // when an entry binds its exact ref, sha, ruling and disclosed findings.
        const platform = readPlatformPreferences({ env, warn: () => {} });
        snapshot.ruledWeakened = mergeRuledWeakened(platform.prefs.prototypeLoad?.ruledWeakened, tool.ruledWeakened);
      } catch { /* unaudited-tip: unreadable evidence never authorizes a moving tip. */ }
    }
    // The canonical admission judge decides (latest record for the exact ref+sha wins; a red or unruled-WEAKENED
    // record never authorizes). A history-carried waiver must also pass the canonical admission gate.
    if (typeof ref !== 'string' || typeof sha !== 'string') return false;
    const ready = readyEvidence(snapshot.records, { branch: ref, sha }, snapshot.ruledWeakened, null, { sameContent });
    if (!ready) return false;
    if (!ready.sameContentCarry) return true;
    const audit = canonicalAudit({ repo, ref, sha, env, exec: proofExec, fetchMain: () => {}, sameContent });
    return audit.ok === true && JSON.stringify(audit.record?.findings) === JSON.stringify(ready.record.auditDisclosed);
  };
}

/** True when main already has the tip: an ancestor, or a squash-merge that adds nothing (the tree is main's own). */
export function tipInMain(git, mainSha, sha) {
  if (!mainSha || !sha) return false;
  if (git(['merge-base', '--is-ancestor', sha, mainSha]).status === 0) return true;
  const m = git(['merge-tree', '--write-tree', '--no-messages', mainSha, sha]);
  const t = String(m.stdout ?? '').split('\n')[0].trim();
  return m.status === 0 && !!t && t === verifyRev(git, `${mainSha}^{tree}`);
}

/**
 * PURE: the refs whose applied tip a build must NOT be adopted with, judged against the audit evidence NOW.
 * Mirrors the plan's own exemptions, so a build the live plan would mint is never refused here: a head applied with
 * `pinnedFrom` (the audited adopted head), a tip the running head or main already carries or has (`carries`, `inMain`),
 * and a registration with no adopted history (`auditAdopted` lists the refs that have one; unknown list = fail closed).
 * `held` are the tips the live plan reports as held back (`overlay-unaudited-tip` alerts). No gate (follow mode) = nothing to revoke.
 */
export function revokedAppliedTips({
  applied, auditedTip, held = [], carries = () => false, inMain = () => false, prevHead, mainSha, auditAdopted,
}) {
  return (applied ?? [])
    .filter((a) => {
      if (!a?.ref || !a.sha || a.pinnedFrom) return false;
      if (held.some((x) => x.detail.ref === a.ref && x.detail.newTip === a.sha)) return true;
      if (typeof auditedTip !== 'function') return false;
      if (carries(a.sha, prevHead) || carries(a.sha, mainSha) || inMain(a.sha)) return false;
      if (Array.isArray(auditAdopted) && !auditAdopted.includes(a.ref)) return false; // never adopted: the plan applies it unaudited
      return auditedTip(a.ref, a.sha) !== true;
    })
    .map((a) => a.ref);
}
