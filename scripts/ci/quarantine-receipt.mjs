/**
 * Queue quarantine receipts (dependency-free: refresh-timings runs from a bare scripts/ci copy).
 * A receipt names the execution it belongs to — commit, run, attempt, job and time — because a partial
 * rerun keeps earlier attempts' artifacts: an identity-free receipt could let old execution satisfy a
 * newer attempt's reuse proof and age bound. ci.yml's queue-reuse-record step mirrors the validator.
 */
export function quarantineReceiptText(out, env = process.env, now = () => new Date()) {
  return `${JSON.stringify({
    v: 1, decision: out?.reuseSafe === true ? 'unquarantined' : 'unknown-or-quarantined',
    sha: env.GITHUB_SHA ?? null, run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    job: env.GITHUB_JOB ?? null, executed_at: now().toISOString(),
  })}\n`;
}

/** Authorizes reuse only for the exact commit, run and attempt; anything else (incl. legacy text) is refused. */
export function validQuarantineReceipt(text, { sha, runId, attempt } = {}) {
  try {
    const r = JSON.parse(text);
    const id = value => Number.isSafeInteger(value) && value > 0;
    return r?.v === 1 && r.decision === 'unquarantined' && typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha)
      && r.sha === sha.toLowerCase() && id(runId) && r.run_id === runId && id(attempt) && r.run_attempt === attempt
      && typeof r.executed_at === 'string' && Number.isFinite(Date.parse(r.executed_at));
  } catch { return false; }
}
