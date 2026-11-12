/** Append-only operator reset of the restart counter for exactly repo#pr@head. Never dispatches work.
 * CLI: node scripts/conveyor/pr-stall-reset.mjs --repo=owner/repo --pr=11 --head=<40-hex>
 *   --actor=<operator> --reason=<inspection> --ruling=R804
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFileLock } from '../lib/atomic-json-file.mjs';
import { appendAudit, RESET_RULINGS, stallSweepDir } from './pr-stall-sweep.mjs';

export function resetRestartCounter({ dir, repo, pr, head, actor, reason, ruling, now = Date.now() } = {}) {
  const text = v => typeof v === 'string' && v.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(v);
  if (!text(dir) || !text(repo) || !/^[\w.-]+\/[\w.-]+$/.test(repo)
    || !Number.isSafeInteger(pr) || pr <= 0
    || typeof head !== 'string' || head.length !== 40 || !/^[0-9a-f]{40}$/.test(head)
    || ![actor, reason, ruling].every(text) || !Number.isFinite(now)) {
    throw new Error('reset requires dir, repo, positive pr, 40-hex head, actor, reason, ruling and valid time');
  }
  if (!RESET_RULINGS.includes(ruling)) throw new Error(`reset ruling must be one of ${RESET_RULINGS.join(', ')}`);
  const record = { phase: 'operator-reset', repo, pr, head, prHead: `${repo}#${pr}@${head}`,
    actor, reason, ruling, ts: new Date(now).toISOString() };
  mkdirSync(dir, { recursive: true });
  withFileLock(join(dir, '.lock'), () => appendAudit(dir, now, [record]), { timeoutMs: 0 });
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = {};
    for (const arg of process.argv.slice(2)) {
      const match = /^--(repo|pr|head|actor|reason|ruling)=(.*)$/.exec(arg);
      if (!match || Object.hasOwn(input, match[1])) throw new Error('expected unique --repo, --pr, --head, --actor, --reason, --ruling');
      input[match[1]] = match[2];
    }
    if (!/^[1-9]\d*$/.test(input.pr ?? '')) throw new Error('positive --pr is required');
    resetRestartCounter({ ...input, pr: Number(input.pr), dir: stallSweepDir() });
  } catch (error) {
    console.error(`pr-stall-reset: ${String(error?.message ?? error).replace(/[\x00-\x1f\x7f]/g, ' ')}`);
    process.exitCode = 1;
  }
}
