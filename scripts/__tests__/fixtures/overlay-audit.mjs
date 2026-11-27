import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { QUESTION_HASH } from '../../operations/codex-audit.mjs';

/** Existing overlay scenarios supply explicit passing evidence for each fixture candidate. */
export function recordPassingOverlayAudit({ home, head, base }) {
  const dir = join(home, 'workspace/.operations/coordination');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'audits.jsonl'), JSON.stringify({
    head, base, verdict: 'NOT WEAKENED', findings: [], questionHash: QUESTION_HASH, at: new Date().toISOString(),
  }) + '\n');
}
