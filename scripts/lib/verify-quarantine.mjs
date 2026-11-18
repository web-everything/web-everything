import { decideCiSkip, validateQuarantineList } from './red-main-quarantine.mjs';
import { verificationInfrastructureFailure } from './lane-verify.mjs';
import { remoteInfrastructureFailure } from './verify-remote-routing.mjs';

/** Complete test-only red evidence, checked before doing any quarantine IO. PURE. */
export function quarantineEligible(phaseResults) {
  if (!Array.isArray(phaseResults) || !phaseResults.length) return false;
  if (phaseResults.some(p => !Number.isInteger(p?.result?.exitCode) || p.result.exitCode < 0
    || p.result.signal || p.result.timedOut || p.result.infrastructure
    || verificationInfrastructureFailure(p.result) || remoteInfrastructureFailure(p.result))) return false;
  const red = phaseResults.filter(p => p.result.exitCode !== 0);
  return red.length > 0 && red.every(p => {
    const d = p.result.failureDetails;
    return p.phase === 'vitest' && d && !d.truncated && Array.isArray(d.tests) && d.tests.length > 0
      && d.tests.every(t => typeof t?.file === 'string' && /^[\w./@-]+$/.test(t.file)
        && !t.file.startsWith('/') && !t.file.includes('..')
        && (t.name === null || typeof t.name === 'string'));
  });
}

/** Post-hoc CI-equivalent whole-file quarantine verdict. Unknown evidence stays red. PURE. */
export function quarantinedVerdict({ phaseResults, read, changedFiles, now, touchesDiff } = {}) {
  const no = why => ({ excused: false, files: [], why });
  try {
    if (!quarantineEligible(phaseResults)) return no('not a complete vitest-only red');
    if (!Number.isFinite(now) || read?.ok !== true || !validateQuarantineList(read.list).ok) return no('quarantine list unreadable or malformed');
    if (!Array.isArray(changedFiles) || !changedFiles.every(f => typeof f === 'string' && f.length > 0)) return no('changed files unknown');
    const decision = decideCiSkip({ mode: read.list.mode, read, changedFiles, now,
      ctx: { known: true, onMain: false, prNumber: null }, job: null });
    const files = [...new Set(phaseResults.filter(p => p.result.exitCode !== 0)
      .flatMap(p => p.result.failureDetails.tests.map(t => t.file)))];
    if (!files.every(f => decision.skip.includes(f))) return no(`not every failing file is quarantined; ${decision.why}`);
    // An unchanged test can still expose a regression in edited source. Only a proven
    // outside answer authorizes quarantine; unknown, missing or thrown evidence stays red.
    if (changedFiles.length && (typeof touchesDiff !== 'function' || !files.every(f => touchesDiff(f) === false))) {
      return no('failing test reaches changed source or dependency evidence is unknown — keeping red');
    }
    return { excused: true, files, why: decision.why };
  } catch {
    return no('quarantine evidence unreadable or malformed');
  }
}
