/**
 * @file scripts/operations/referral-findings.mjs
 * @description Read-only finding keys and standing rulings for the operator's next ruling.
 */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { OPERATOR_RULING_RESULTS } from '../lib/jury-core.mjs';

export const REFERRAL_FINDINGS_OP = 'referral-findings';
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/** Reuse the ruling reader's finding sets; never interpret comment markers here. */
export function assessReferralFindings(read, { repo, pr }) {
  if (read.malformed) throw new Error('malformed referral thread; repair it before ruling');
  const disputed = read.disputed ?? [];
  const groups = {
    open: read.open,
    ruled: (read.ruled ?? []).filter((r) => !disputed.some((d) => d.runId === r.runId && d.key === r.key)),
    disputed,
  };
  const findings = Object.entries(groups).flatMap(([group, targets]) => targets.map((f) => {
    const standing = [...(f.standing ?? [])].reverse();
    const prefix = `node scripts/run-fresh.mjs record-referral-ruling --repo=${quote(repo)} --pr=${pr}`
      + ` --finding=${quote(f.key)}${group === 'ruled' ? ` --supersedes=${quote(f.standing.at(-1).id)}` : ''}`;
    const operator = ` --actor=<login> --channel=<where> --reason="<operator's words>"`;
    const command = `${prefix} --ruling=<${OPERATOR_RULING_RESULTS.filter((r) => r !== 'card').join('|')}>${operator}`;
    const cardCommand = `${prefix} --ruling=card --card=<we:backlog path>${operator}`;
    return { group, finding: f.key, file: f.file, line: f.line, summary: f.summary,
      standing, rulingIds: standing.map((r) => r.id), ...(group === 'disputed' ? { blockIds: f.blockIds } : {}), command, cardCommand };
  }));
  return { repo, pr, head: read.head, findings };
}

export function referralFindingsOperation({ readRulingContext } = {}) {
  if (typeof readRulingContext !== 'function') throw new TypeError('referral-findings needs a readRulingContext reader');
  return op(REFERRAL_FINDINGS_OP, {
    input: { repo: 'string', pr: 'number' },
    verdictFrom: 'assess',
    read: compute({ reads: ['input.repo', 'input.pr'], fn: ({ input }) => {
      if (!/^[^/\s]+\/[^/\s]+$/.test(input.repo) || !Number.isSafeInteger(input.pr) || input.pr <= 0) {
        throw new Error('--repo=<owner/repo> and a positive integer --pr are required');
      }
      return readRulingContext(input);
    } }),
    assess: compute({ reads: ['findings.read', 'input.repo', 'input.pr'],
      fn: ({ findings, input }) => assessReferralFindings(findings.read, input) }),
  });
}
