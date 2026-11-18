// Test helper: a run store whose record freezes a WRITE_UP for each given body file name. The sinks verify the staged
// verdict body against the run record, so fixtures that stage (or never stage) a body supply this. The frozen body is
// whatever was already staged under `root` for that run, else `fallback`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function frozenWriteUpStore(root, bodyFiles = ['o-n-7-verdict.md'], fallback = 'Accept') {
  return {
    read: (id) => ({
      id,
      effects: bodyFiles.map((bodyFile, i) => {
        let body = fallback;
        try { body = readFileSync(join(root ?? '', '.operations', 'review', id, bodyFile), 'utf8') || fallback; } catch { /* none staged */ }
        return { key: `${id}#0#${i}`, type: 'review.write-up', status: 'applied', payload: { bodyFile, body } };
      }),
    }),
  };
}
